import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { type Storage, StorageError, createStorage } from './storage.js';
import { uriEncode } from './sigv4.js';

/**
 * Object storage, against a real S3 server (SR-5.5, open item O4).
 *
 * **Zenko CloudServer rather than a mock, on purpose.** The thing under test here is a
 * hand-written implementation of AWS Signature Version 4, and the only question that matters is
 * whether a real server accepts it. `adobe/s3mock` and LocalStack do not verify signatures at
 * all, so every test below would pass against a signing function that returned the empty
 * string — which is worse than no test, because it would look like evidence.
 *
 * CloudServer is a genuine S3 implementation with real authentication. When it accepts a
 * request, the signature was right; when it rejects one, it was not.
 */
const ACCESS_KEY = 'accessKey1';
const SECRET_KEY = 'verySecretKey1';
const BUCKET = 'gth-photos-test';

let container: StartedTestContainer;
let storage: Storage;
let endpoint: string;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

beforeAll(async () => {
  container = await new GenericContainer('zenko/cloudserver:latest')
    .withEnvironment({
      S3BACKEND: 'mem',
      REMOTE_MANAGEMENT_DISABLE: '1',
      SCALITY_ACCESS_KEY_ID: ACCESS_KEY,
      SCALITY_SECRET_ACCESS_KEY: SECRET_KEY,
    })
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();

  endpoint = `http://${container.getHost()}:${String(container.getMappedPort(8000))}`;
  storage = createStorage({
    endpoint,
    bucket: BUCKET,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: 'us-east-1' },
  });

  // The same call local development makes. If the signature were wrong it would fail here,
  // which is a far more useful place to find out than thirteen tests failing one after another
  // for a reason none of them names.
  await storage.ensureBucket();
}, 180_000);

afterAll(async () => {
  await container.stop();
});

/**
 * The CORS policy, checked the way a browser checks it: by sending a preflight.
 *
 * The presigned upload is made **by the browser, to another origin**, so before the PUT the
 * browser sends an `OPTIONS` and obeys the answer. A bucket with no policy 404s that, the PUT
 * is never sent, and `fetch` rejects with an opaque error in a console. Every other test in
 * this file passes regardless, because none of them is a browser and a server never sends a
 * preflight — which is exactly how the marketplace shipped an upload that could not work.
 */
describe('letting a browser use the presigned URL', () => {
  const ORIGIN = 'http://127.0.0.1:3000';

  async function preflight(
    origin: string,
    requestHeaders: string,
  ): Promise<{ status: number; allowOrigin: string | null }> {
    const response = await fetch(`${endpoint}/${BUCKET}/uploads/probe`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': requestHeaders,
      },
    });
    return {
      status: response.status,
      allowOrigin: response.headers.get('access-control-allow-origin'),
    };
  }

  it('refuses a preflight until a policy exists', async () => {
    // A fresh bucket, so this is the state every deployment starts in.
    const virgin = createStorage({
      endpoint,
      bucket: 'gth-photos-no-cors',
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: 'us-east-1' },
    });
    await virgin.ensureBucket();

    const response = await fetch(`${endpoint}/gth-photos-no-cors/uploads/probe`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'PUT' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the site to PUT once the policy is set', async () => {
    await storage.putCorsPolicy([ORIGIN]);
    expect(await preflight(ORIGIN, 'content-type')).toMatchObject({
      status: 200,
      allowOrigin: ORIGIN,
    });
  });

  /**
   * The failure that cost an afternoon.
   *
   * Chromium names `content-length` in the preflight even for a page that never set it, and a
   * policy enumerating allowed headers refused the whole upload for it. The origin is the
   * control; the header list is not, and this asserts we are not treating it as one.
   */
  it('does not care which headers the browser names', async () => {
    await storage.putCorsPolicy([ORIGIN]);
    expect(await preflight(ORIGIN, 'content-length,content-type')).toMatchObject({
      status: 200,
      allowOrigin: ORIGIN,
    });
  });

  it('still refuses somebody else’s site', async () => {
    await storage.putCorsPolicy([ORIGIN]);
    const { allowOrigin } = await preflight('https://evil.test', 'content-type');
    expect(allowOrigin).not.toBe('https://evil.test');
  });

  it('refuses to write a policy that would allow nobody', async () => {
    await expect(storage.putCorsPolicy([])).rejects.toBeInstanceOf(StorageError);
  });
});

describe('the signature a real server accepts', () => {
  it('writes an object and reads it back', async () => {
    // The round trip that proves SigV4 works. Nothing here is faked: a wrong signing key, a
    // wrong canonical request or a mis-encoded path all end as a 403 from the server.
    await storage.putObject('photos/round-trip.jpg', bytes('hello'), 'image/jpeg');
    expect(new TextDecoder().decode(await storage.getObject('photos/round-trip.jpg'))).toBe(
      'hello',
    );
  });

  it('refuses a request signed with the wrong secret', async () => {
    // The other half: the server is genuinely checking, so the tests above mean something.
    const wrong = createStorage({
      endpoint,
      bucket: BUCKET,
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: 'not-the-secret',
        region: 'us-east-1',
      },
    });
    await expect(wrong.getObject('photos/round-trip.jpg')).rejects.toThrow(StorageError);
  });

  it('signs a key with characters that need encoding', async () => {
    // AWS's percent-encoding is not `encodeURIComponent`, and a canonical path that differs
    // from the server's by one byte is a signature mismatch with an unhelpful message.
    const key = 'photos/a b+c~d.jpg';
    await storage.putObject(key, bytes('encoded'), 'image/jpeg');
    expect(new TextDecoder().decode(await storage.getObject(key))).toBe('encoded');
  });

  it('reports a missing object rather than returning nothing', async () => {
    await expect(storage.getObject('photos/never-existed.jpg')).rejects.toThrow(StorageError);
  });
});

describe('deleting', () => {
  it('removes an object', async () => {
    await storage.putObject('photos/temporary.jpg', bytes('gone soon'), 'image/jpeg');
    await storage.deleteObject('photos/temporary.jpg');
    await expect(storage.getObject('photos/temporary.jpg')).rejects.toThrow(StorageError);
  });

  it('is happy to delete something that is already not there', async () => {
    // The pipeline deletes an original it may already have deleted after a crash, and that
    // retry must not fail. The state asked for is "not present", and it is.
    await expect(storage.deleteObject('photos/never-existed.jpg')).resolves.toBeUndefined();
  });
});

describe('a presigned upload', () => {
  it('lets a browser PUT exactly what the URL was signed for', async () => {
    const body = bytes('a photograph, allegedly');
    const { url } = storage.presignUpload({
      key: 'uploads/presigned-1',
      contentType: 'image/jpeg',
      contentLength: body.length,
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) },
      body,
    });
    expect(response.status).toBe(200);

    // And the bytes really are in the bucket, read back through the signed path.
    expect(new TextDecoder().decode(await storage.getObject('uploads/presigned-1'))).toBe(
      'a photograph, allegedly',
    );
  });

  it('refuses a body of a different length than was signed for', async () => {
    /**
     * The condition that makes a presigned PUT safe to hand out.
     *
     * Without `content-length` in the signed headers, a URL issued for a 40 kB JPEG is a URL
     * for putting four gigabytes of anything in the bucket. The server checks the header
     * against the signature, so this is not advice.
     */
    const { url } = storage.presignUpload({
      key: 'uploads/presigned-2',
      contentType: 'image/jpeg',
      contentLength: 10,
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', 'content-length': '40' },
      body: bytes('x'.repeat(40)),
    });
    expect(response.ok, 'a longer body than was signed for was accepted').toBe(false);
  });

  it('refuses a content type other than the one signed for', async () => {
    const body = bytes('<!DOCTYPE html>');
    const { url } = storage.presignUpload({
      key: 'uploads/presigned-3',
      contentType: 'image/jpeg',
      contentLength: body.length,
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html', 'content-length': String(body.length) },
      body,
    });
    expect(response.ok, 'a different content type than was signed for was accepted').toBe(false);
  });

  it('will not sign an upload larger than the ceiling', () => {
    // Refused before a URL exists, so there is nothing to misuse. The byte inspection checks
    // the same ceiling again on the bytes themselves, because a claimed length is a claim.
    expect(() =>
      storage.presignUpload({
        key: 'uploads/too-big',
        contentType: 'image/jpeg',
        contentLength: 11 * 1024 * 1024,
      }),
    ).toThrow(StorageError);
  });
});

describe('a presigned view', () => {
  it('serves a processed copy without credentials', async () => {
    await storage.putObject('photos/viewable.jpg', bytes('displayable'), 'image/jpeg');
    const { url } = storage.presignView('photos/viewable.jpg');

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('displayable');
  });

  it('is refused once tampered with', async () => {
    // A signed URL is not a secret URL: changing the key it points at invalidates it, which is
    // what stops one person's link becoming a key to the whole bucket.
    const { url } = storage.presignView('photos/viewable.jpg');
    const elsewhere = url.replace('viewable.jpg', 'round-trip.jpg');
    expect((await fetch(elsewhere)).ok).toBe(false);
  });
});

describe('the encoding AWS actually wants', () => {
  it('leaves the unreserved set alone and upper-cases the rest', () => {
    expect(uriEncode('abcXYZ019-_.~')).toBe('abcXYZ019-_.~');
    expect(uriEncode('a b')).toBe('a%20b');
    // `encodeURIComponent` leaves these four alone, which would produce a canonical request
    // that differs from the server's.
    expect(uriEncode("!*'()")).toBe('%21%2A%27%28%29');
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode('a/b', false)).toBe('a/b');
  });
});
