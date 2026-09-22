/** Delivery outcome. Failures are values, not exceptions: one bad channel must not stop fan-out. */
export type DeliveryOutcome =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean }
  | { ok: 'skipped'; reason: string };

export interface RestockMessage {
  productName: string;
  retailerName: string;
  url: string;
  priceCents: number | null;
  currency: string;
  detectedAt: Date;
}

export interface Recipient {
  email: string;
  displayName: string | null;
}

export interface Transport {
  send: (message: RestockMessage, recipient: Recipient) => Promise<DeliveryOutcome>;
}

const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com']);

/**
 * Webhook URLs are attacker-influenced input once users can supply them, so this is an
 * SSRF guard (SR-1.1): https only, and only Discord's own hosts.
 *
 * This is the only place in the platform that makes an outbound HTTP request, and Semgrep
 * rule `gth-no-outbound-http` keeps it that way. An exact-host allowlist of a domain nobody
 * but Discord controls is why DNS rebinding does not apply here: there is no attacker-chosen
 * name to re-resolve (ADR-030).
 */
export function isAllowedDiscordWebhook(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (!DISCORD_WEBHOOK_HOSTS.has(url.hostname)) return false;
  return url.pathname.startsWith('/api/webhooks/');
}

export function formatPrice(priceCents: number | null, currency: string): string {
  if (priceCents === null) return 'price unknown';
  return `${(priceCents / 100).toFixed(2)} ${currency}`;
}

export function buildPlainText(message: RestockMessage): string {
  return [
    `Back in stock: ${message.productName}`,
    `Retailer: ${message.retailerName}`,
    `Price: ${formatPrice(message.priceCents, message.currency)}`,
    `Link: ${message.url}`,
    '',
    'You are receiving this because you set up a restock watch.',
  ].join('\n');
}

export interface FetchLike {
  (
    input: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
      redirect: 'error';
    },
  ): Promise<{
    ok: boolean;
    status: number;
  }>;
}

/** Posts to a Discord webhook. Content is plain text; Discord renders no HTML. */
export function createDiscordWebhookTransport(options: {
  webhookUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Transport {
  const { webhookUrl, fetchImpl, timeoutMs = 5000 } = options;
  const doFetch: FetchLike = fetchImpl ?? globalThis.fetch;

  return {
    send: async (message) => {
      if (!isAllowedDiscordWebhook(webhookUrl)) {
        return { ok: false, reason: 'webhook url rejected by allowlist', retryable: false };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await doFetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: buildPlainText(message), flags: 4 }),
          signal: controller.signal,
          // The allowlist checks where the request *starts*. A redirect would decide where it
          // ends, unchecked — so none are followed (SR-1.1). A webhook never needs one.
          redirect: 'error',
        });
        if (response.ok) return { ok: true };
        // 4xx (except 429) means the webhook is gone or malformed: do not retry forever.
        const retryable = response.status === 429 || response.status >= 500;
        return { ok: false, reason: `discord responded ${String(response.status)}`, retryable };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.name : 'discord request failed',
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface MailSender {
  sendMail: (mail: {
    to: string;
    from: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }) => Promise<unknown>;
}

export function createEmailTransport(options: {
  mailer: MailSender;
  from: string;
  unsubscribeUrl: string;
}): Transport {
  return {
    send: async (message, recipient) => {
      try {
        await options.mailer.sendMail({
          to: recipient.email,
          from: options.from,
          subject: `Back in stock: ${message.productName}`,
          text: buildPlainText(message),
          // One-click unsubscribe keeps us out of spam folders and is good manners (SR-1.12).
          headers: { 'List-Unsubscribe': `<${options.unsubscribeUrl}>` },
        });
        return { ok: true };
      } catch (error) {
        // Never echo the address into the error: delivery logs are operator-facing.
        return {
          ok: false,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'smtp send failed',
          retryable: true,
        };
      }
    },
  };
}

/** Channels that exist in the schema but are not implemented yet. */
export function createUnsupportedTransport(channel: string): Transport {
  return {
    send: () => Promise.resolve({ ok: 'skipped', reason: `${channel} not implemented yet` }),
  };
}
