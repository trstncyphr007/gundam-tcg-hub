import { createTransport } from 'nodemailer';
import type { ApiConfig } from './config.js';

export interface MagicLinkArgs {
  email: string;
  url: string;
}

export interface Logger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Sends the one-time sign-in link. With SMTP configured it emails (Mailpit locally);
 * without it, the link is logged for local development only. Production requires SMTP:
 * logging sign-in links on a real deployment would be a credential leak (SR-X.20).
 */
export function createMagicLinkSender(
  config: ApiConfig,
  logger: Logger,
): (args: MagicLinkArgs) => Promise<void> {
  if (!config.SMTP_URL) {
    if (config.NODE_ENV === 'production') {
      throw new Error('SMTP_URL is required in production: refusing to log sign-in links');
    }
    return ({ email, url }) => {
      logger.warn({ email, url }, 'magic link (dev only, no SMTP configured)');
      return Promise.resolve();
    };
  }

  const transport = createTransport(config.SMTP_URL);
  return async ({ email, url }) => {
    await transport.sendMail({
      to: email,
      from: config.EMAIL_FROM,
      subject: 'Your sign-in link',
      text: `Sign in: ${url}\n\nThis link works once and expires in 15 minutes.\nIf you did not request it, ignore this email.`,
    });
  };
}
