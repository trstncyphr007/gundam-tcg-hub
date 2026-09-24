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
  /**
   * Whose watch, and which one. Both go into the email's unsubscribe link, signed together
   * (SR-1.12): the reader has no session, and the row cannot be read without knowing the
   * owner, so the owner travels with the link.
   */
  userId: string;
  subscriptionId: string;
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

export function buildPlainText(message: RestockMessage, unsubscribeUrl?: string): string {
  return [
    `Back in stock: ${message.productName}`,
    `Retailer: ${message.retailerName}`,
    `Price: ${formatPrice(message.priceCents, message.currency)}`,
    `Link: ${message.url}`,
    '',
    'You are receiving this because you set up a restock watch.',
    // In the body as well as the header: a header is for the mail client, and plenty of
    // readers look for the word instead. It says which product, because it stops the emails
    // for that one watch and leaves the rest alone.
    ...(unsubscribeUrl === undefined
      ? []
      : [`Stop emails about ${message.productName}: ${unsubscribeUrl}`]),
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

/**
 * Posting a line to the ops channel (SR-X.22).
 *
 * It lives in this file rather than beside the watchdog that uses it, because this file is the
 * one place in the platform allowed to make an outbound request — Semgrep rule
 * `gth-no-outbound-http` fails CI on a second one (ADR-030). Keeping the exception singular is
 * worth more than keeping the code next to its caller.
 *
 * Plain text, no embeds, no mentions: an alert that pings a phone at 4am should say what broke
 * and nothing else. Discord renders no HTML, and `flags: 4` suppresses link previews, so a URL
 * in a message cannot unfurl something unexpected into the channel.
 */
export interface OpsNotifier {
  notify: (text: string) => Promise<DeliveryOutcome>;
}

export function createOpsNotifier(options: {
  webhookUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): OpsNotifier {
  const { webhookUrl, fetchImpl, timeoutMs = 5000 } = options;
  const doFetch: FetchLike = fetchImpl ?? globalThis.fetch;

  return {
    notify: async (text) => {
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
          // Discord refuses anything over 2000 characters; a truncated alert still says what
          // broke, whereas a refused one says nothing at all.
          body: JSON.stringify({ content: text.slice(0, 1900), flags: 4 }),
          signal: controller.signal,
          redirect: 'error',
        });
        if (response.ok) return { ok: true };
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
  /** The signed, session-free link that stops emails for one watch (SR-1.12, RFC 8058). */
  unsubscribeUrl: (userId: string, subscriptionId: string) => string;
}): Transport {
  return {
    send: async (message, recipient) => {
      const unsubscribe = options.unsubscribeUrl(recipient.userId, recipient.subscriptionId);
      try {
        await options.mailer.sendMail({
          to: recipient.email,
          from: options.from,
          subject: `Back in stock: ${message.productName}`,
          text: buildPlainText(message, unsubscribe),
          headers: {
            'List-Unsubscribe': `<${unsubscribe}>`,
            // Without this, `List-Unsubscribe` is a link to somewhere, not one-click
            // unsubscribing — and Gmail now expects one-click from anyone sending in volume.
            // Getting that wrong puts restock alerts in spam, which defeats the feature
            // without anybody being told (RFC 8058).
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
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
