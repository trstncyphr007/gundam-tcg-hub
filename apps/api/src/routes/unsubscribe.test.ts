import { asUser, createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { signLink } from '@gth/security';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { UNSUBSCRIBE_PURPOSE } from './unsubscribe.js';

/**
 * One-click unsubscribe (SR-1.12, RFC 8058).
 *
 * The link goes to somebody with no session, from a mail client that will never have one. The
 * signature is the whole of the authorisation, so most of this is about what happens when the
 * signature is wrong — and about it stopping the emails without throwing away the watch.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let productId: string;
let watchId: string;

/** The link carries both ids, signed together — see `unsubscribeUrl`. */
const link = (id: string, owner = 'unsub-user'): string =>
  signLink(UNSUBSCRIBE_PURPOSE, `${owner}|${id}`, config.TOKEN_PEPPER);

/** Read as the owner, for the same reason the fixture writes as them: the table is FORCE'd. */
async function channelsOf(id: string): Promise<string[]> {
  return asUser(tdb.db, 'unsub-user', async (tx) => {
    const rows = await tx.execute<{ channels: string[] }>(
      `select channels from app.watch_subscriptions where id = '${id}'`,
    );
    return rows[0]?.channels ?? [];
  });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const [product] = await tdb.db.execute<{ id: string }>(
    `select id from app.sealed_products limit 1`,
  );
  productId = String(product?.id);
  await tdb.db.execute(
    `insert into app.users (id, name, email) values ('unsub-user', 'U', 'u@example.com')`,
  );
  webPool = createDb({ url: tdb.urlFor('web'), max: 3 });
  app = await buildApp(config, { db: tdb.db, writeDb: webPool.db });
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

beforeEach(async () => {
  // `watch_subscriptions` is FORCE'd, so even the owner writes nothing without declaring whose
  // rows these are — the same path a request takes.
  watchId = await asUser(tdb.db, 'unsub-user', async (tx) => {
    await tx.execute(`delete from app.watch_subscriptions where user_id = 'unsub-user'`);
    const rows = await tx.execute<{ id: string }>(
      `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
       values ('unsub-user', '${productId}', array['email','web_push']::app.alert_channel[])
       returning id`,
    );
    return String(rows[0]?.id);
  });
});

describe('one click, no session', () => {
  it('stops the emails for that watch and keeps the watch', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/unsubscribe?t=${link(watchId)}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // The watch survives. "Stop sending me this" is not "forget what I asked about", and one
    // click from a mail client should not be able to throw away a choice somebody made.
    expect(await channelsOf(watchId)).toEqual(['web_push']);
  });

  it('removes a watch whose only channel was email', async () => {
    // **The case the UI actually creates.** Every watch made with the Watch button has exactly
    // one channel, and `watch_subscriptions_channels_not_empty` means emptying it is a
    // constraint violation — which this answered with a 500 until a run against the real
    // server found it. The fixture above has two channels, so every test was passing.
    const onlyEmail = await asUser(tdb.db, 'unsub-user', async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        `insert into app.watch_subscriptions (user_id, retailer_product_id, channels)
         select 'unsub-user', id, array['email']::app.alert_channel[]
           from app.retailer_products limit 1
         returning id`,
      );
      return String(rows[0]?.id);
    });

    const res = await app.inject({ method: 'POST', url: `/v1/unsubscribe?t=${link(onlyEmail)}` });

    expect(res.statusCode).toBe(200);
    // Gone, rather than left in a state the schema says cannot exist. They stop being emailed,
    // which is what they asked for, and the Watch button puts it back.
    expect(await channelsOf(onlyEmail)).toEqual([]);
  });

  it('accepts the form body a mail client sends (RFC 8058)', async () => {
    // The one-click POST carries `List-Unsubscribe=One-Click` as a form body. Fastify refuses
    // a content type it cannot parse, so this would have been a 415 without the parser.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/unsubscribe?t=${link(watchId)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    expect(res.statusCode).toBe(200);
    expect(await channelsOf(watchId)).toEqual(['web_push']);
  });

  it('is safe to click twice, and to retry', async () => {
    const url = `/v1/unsubscribe?t=${link(watchId)}`;
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(200);
    expect(await channelsOf(watchId)).toEqual(['web_push']);
  });

  it('says the same thing to a forged link as to a real one', async () => {
    // A stranger guessing tokens must not be able to tell a near miss from a wrong one, and
    // must not learn whether a watch exists.
    const real = await app.inject({ method: 'POST', url: `/v1/unsubscribe?t=${link(watchId)}` });
    const forged = await app.inject({
      method: 'POST',
      url: `/v1/unsubscribe?t=${watchId}.not-a-signature`,
    });
    const missing = await app.inject({ method: 'POST', url: '/v1/unsubscribe' });

    expect(forged.statusCode).toBe(real.statusCode);
    expect(forged.body).toBe(real.body);
    expect(missing.statusCode).toBe(real.statusCode);
  });

  it('changes nothing when the signature is wrong', async () => {
    await app.inject({ method: 'POST', url: `/v1/unsubscribe?t=${watchId}.not-a-signature` });
    expect(await channelsOf(watchId)).toEqual(['email', 'web_push']);
  });

  it('will not act on a link signed for something else', async () => {
    const wrongPurpose = signLink('delete:account', `unsub-user|${watchId}`, config.TOKEN_PEPPER);
    await app.inject({ method: 'POST', url: `/v1/unsubscribe?t=${wrongPurpose}` });
    expect(await channelsOf(watchId)).toEqual(['email', 'web_push']);
  });

  it("will not let one person's signature reach another person's watch", async () => {
    // The ids are signed together, so a stranger cannot take a link of their own and swap the
    // watch id into it. And even a validly-signed mismatch is refused by the update itself,
    // which requires the two to agree.
    const mismatched = signLink(
      UNSUBSCRIBE_PURPOSE,
      `someone-else|${watchId}`,
      config.TOKEN_PEPPER,
    );
    const res = await app.inject({ method: 'POST', url: `/v1/unsubscribe?t=${mismatched}` });

    expect(res.statusCode).toBe(200);
    expect(await channelsOf(watchId)).toEqual(['email', 'web_push']);
  });
});

describe('a person clicking the link in the message', () => {
  it('is shown what will happen and asked once, rather than it just happening', async () => {
    // A GET must not change anything: mail clients and security scanners fetch links in
    // messages without anybody having read them.
    const res = await app.inject({ method: 'GET', url: `/v1/unsubscribe?t=${link(watchId)}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form method="post"');
    expect(await channelsOf(watchId)).toEqual(['email', 'web_push']);
  });

  it('is told plainly when a link is broken, rather than being lied to', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/unsubscribe?t=rubbish' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('not valid');
  });

  it('is never cached or indexed: the URL is the credential', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/unsubscribe?t=${link(watchId)}` });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toContain('noindex');
  });
});
