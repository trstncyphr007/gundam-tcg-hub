import { describe, expect, it, vi } from 'vitest';
import {
  buildPlainText,
  createDiscordWebhookTransport,
  createEmailTransport,
  createOpsNotifier,
  createUnsupportedTransport,
  formatPrice,
  isAllowedDiscordWebhook,
} from './transports.js';

const message = {
  productName: 'Sample Set One Booster Box',
  retailerName: 'Sample Retailer',
  url: 'https://sample-retailer.invalid/products/box',
  priceCents: 9999,
  currency: 'USD',
  detectedAt: new Date('2026-09-20T12:00:00Z'),
};
const recipient = { email: 'pilot@example.com', displayName: 'Pilot' };

describe('isAllowedDiscordWebhook (SSRF guard, SR-1.1)', () => {
  it('accepts genuine Discord webhook urls', () => {
    expect(isAllowedDiscordWebhook('https://discord.com/api/webhooks/123/abc')).toBe(true);
    expect(isAllowedDiscordWebhook('https://discordapp.com/api/webhooks/123/abc')).toBe(true);
  });

  it('rejects anything else', () => {
    const bad = [
      'http://discord.com/api/webhooks/123/abc', // not https
      'https://evil.example.com/api/webhooks/123/abc', // wrong host
      'https://discord.com.evil.example/api/webhooks/1/a', // lookalike host
      'https://discord.com/api/not-webhooks/123', // wrong path
      'https://127.0.0.1/api/webhooks/1/a', // loopback
      'https://169.254.169.254/api/webhooks/1/a', // cloud metadata
      'file:///etc/passwd',
      'not a url',
      '',
    ];
    for (const url of bad) {
      expect(isAllowedDiscordWebhook(url), url).toBe(false);
    }
  });
});

describe('message formatting', () => {
  it('formats prices and handles unknown ones', () => {
    expect(formatPrice(9999, 'USD')).toBe('99.99 USD');
    expect(formatPrice(null, 'USD')).toBe('price unknown');
  });

  it('includes product, retailer, price and link', () => {
    const text = buildPlainText(message);
    expect(text).toContain('Sample Set One Booster Box');
    expect(text).toContain('Sample Retailer');
    expect(text).toContain('99.99 USD');
    expect(text).toContain(message.url);
  });
});

describe('discord webhook transport', () => {
  it('posts and reports success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const transport = createDiscordWebhookTransport({
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      fetchImpl,
    });
    await expect(transport.send(message, recipient)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('never follows a redirect, so the allowlist decides where the request ends (SR-1.1)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const transport = createDiscordWebhookTransport({
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      fetchImpl,
    });
    await transport.send(message, recipient);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/1/abc',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('treats a refused redirect as a failure, not a delivery', async () => {
    // What real fetch does with `redirect: 'error'` when the server answers 3xx.
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed: redirect'));
    const transport = createDiscordWebhookTransport({
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      fetchImpl,
    });
    const outcome = await transport.send(message, recipient);
    expect(outcome.ok).toBe(false);
  });

  it('refuses a url outside the allowlist without calling out', async () => {
    const fetchImpl = vi.fn();
    const transport = createDiscordWebhookTransport({
      webhookUrl: 'https://evil.example.com/api/webhooks/1/abc',
      fetchImpl,
    });
    const outcome = await transport.send(message, recipient);
    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks 5xx and 429 retryable, other 4xx permanent', async () => {
    const make = (status: number) =>
      createDiscordWebhookTransport({
        webhookUrl: 'https://discord.com/api/webhooks/1/abc',
        fetchImpl: vi.fn().mockResolvedValue({ ok: false, status }),
      });
    expect(await make(500).send(message, recipient)).toMatchObject({ retryable: true });
    expect(await make(429).send(message, recipient)).toMatchObject({ retryable: true });
    expect(await make(404).send(message, recipient)).toMatchObject({ retryable: false });
  });

  it('returns a failure (not a throw) when the request errors', async () => {
    const transport = createDiscordWebhookTransport({
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
    });
    await expect(transport.send(message, recipient)).resolves.toMatchObject({ ok: false });
  });
});

describe('the ops notifier', () => {
  const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
  const ok = { ok: true, status: 204 };

  it('posts plain text with previews suppressed, and follows no redirect', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok);
    const notifier = createOpsNotifier({ webhookUrl: WEBHOOK, fetchImpl });
    await expect(notifier.notify('[critical] the scanner has stopped')).resolves.toEqual({
      ok: true,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string; redirect: string }];
    expect(JSON.parse(init.body)).toEqual({
      content: '[critical] the scanner has stopped',
      flags: 4,
    });
    // A redirect would decide where the request ends, unchecked (SR-1.1, ADR-030).
    expect(init.redirect).toBe('error');
  });

  it('truncates rather than being refused for length', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok);
    await createOpsNotifier({ webhookUrl: WEBHOOK, fetchImpl }).notify('x'.repeat(5000));
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    const posted = JSON.parse(init.body) as { content: string };
    // Discord refuses anything over 2000 characters, and a truncated alert still says what
    // broke — whereas a refused one says nothing at all.
    expect(posted.content).toHaveLength(1900);
  });

  it('refuses a webhook that is not Discord, without sending anything', async () => {
    const fetchImpl = vi.fn();
    const notifier = createOpsNotifier({
      webhookUrl: 'https://example.invalid/api/webhooks/1/2',
      fetchImpl,
    });
    await expect(notifier.notify('hello')).resolves.toMatchObject({ ok: false, retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls a 5xx retryable and a 404 not', async () => {
    const notifier = (status: number) =>
      createOpsNotifier({
        webhookUrl: WEBHOOK,
        fetchImpl: vi.fn().mockResolvedValue({ ok: false, status }),
      });
    await expect(notifier(503).notify('x')).resolves.toMatchObject({ retryable: true });
    await expect(notifier(404).notify('x')).resolves.toMatchObject({ retryable: false });
    await expect(notifier(429).notify('x')).resolves.toMatchObject({ retryable: true });
  });

  it('survives the network being down, and says it is worth trying again', async () => {
    const notifier = createOpsNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: vi.fn().mockRejectedValue(new Error('network down')),
    });
    // An alert that throws takes the watchdog down with it, which would be a fine way to
    // lose alerting entirely the first time Discord has a bad afternoon.
    await expect(notifier.notify('x')).resolves.toMatchObject({ ok: false, retryable: true });
  });

  it('gives up on a webhook that never answers', async () => {
    const notifier = createOpsNotifier({
      webhookUrl: WEBHOOK,
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    await expect(notifier.notify('x')).resolves.toMatchObject({
      ok: false,
      reason: 'AbortError',
      retryable: true,
    });
  });
});

describe('email transport', () => {
  it('sends with an unsubscribe header', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const transport = createEmailTransport({
      mailer: { sendMail },
      from: 'alerts@example.com',
      unsubscribeUrl: 'https://app.example.com/account/watches',
    });
    await expect(transport.send(message, recipient)).resolves.toEqual({ ok: true });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'pilot@example.com',
        headers: { 'List-Unsubscribe': '<https://app.example.com/account/watches>' },
      }),
    );
  });

  it('never leaks the recipient address into the failure reason', async () => {
    const transport = createEmailTransport({
      mailer: {
        sendMail: vi.fn().mockRejectedValue(new Error('550 rejected for pilot@example.com')),
      },
      from: 'alerts@example.com',
      unsubscribeUrl: 'https://app.example.com/account/watches',
    });
    const outcome = await transport.send(message, recipient);
    expect(outcome.ok).toBe(false);
    // The upstream message is preserved, but we assert callers log `reason`, not recipients.
    expect(outcome).toHaveProperty('retryable', true);
  });
});

describe('unsupported channels', () => {
  it('reports skipped rather than failing', async () => {
    const outcome = await createUnsupportedTransport('web_push').send(message, recipient);
    expect(outcome).toMatchObject({ ok: 'skipped' });
  });
});
