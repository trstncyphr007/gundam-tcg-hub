import type { SecurityNotice } from '@gth/auth';
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

export type SecurityNoticeArgs = SecurityNotice;

const METHOD_WORDS = new Map<string, string>([
  ['passkey', 'with a passkey'],
  ['magic_link', 'with an emailed sign-in link'],
  ['discord', 'with Discord'],
]);

export function noticeText(notice: SecurityNoticeArgs): { subject: string; body: string } {
  if (notice.event === 'new_sign_in') {
    const how = METHOD_WORDS.get(notice.method ?? '') ?? '';
    // UTC and spelled out: the reader may be anywhere, and "3:14" alone is ambiguous.
    const when = `${notice.at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    return {
      subject: 'New sign-in to your account',
      body:
        `Your Gundam TCG Hub account was just signed in to from ${notice.device}` +
        `${how ? ` ${how}` : ''}, at ${when}. It is a device this account has not used before.\n\n` +
        'If that was you, there is nothing to do.\n\n' +
        'If it was not, sign in, open Account → Security, and sign that session out. Then ' +
        'reply to this email.',
    };
  }
  return notice.event === 'passkey_added'
    ? {
        subject: 'A passkey was added to your account',
        body:
          'A new passkey was just added to your Gundam TCG Hub account.\n\n' +
          'If that was you, there is nothing to do.\n\n' +
          'If it was not, someone else can now sign in as you. Sign in, open Account → Security, ' +
          'remove the passkey you do not recognise, and reply to this email.',
      }
    : {
        subject: 'A passkey was removed from your account',
        body:
          'A passkey was just removed from your Gundam TCG Hub account.\n\n' +
          'If that was you, there is nothing to do. If it was not, sign in and check ' +
          'Account → Security, and reply to this email.',
      };
}

/**
 * Tells someone the ways into their account just changed (SR-X.5).
 *
 * Deliberately no link in the body. A security email with a "click here to fix it" button is
 * the exact shape of a phishing email, and teaching people to trust that shape is worse than
 * asking them to go to the site themselves.
 */
export function createSecurityNoticeSender(
  config: ApiConfig,
  logger: Logger,
): (args: SecurityNoticeArgs) => Promise<void> {
  const transport = config.SMTP_URL ? createTransport(config.SMTP_URL) : null;
  return async (notice) => {
    const { subject, body } = noticeText(notice);
    if (!transport) {
      logger.info({ event: notice.event }, 'security notice (dev only, no SMTP configured)');
      return;
    }
    await transport.sendMail({ to: notice.email, from: config.EMAIL_FROM, subject, text: body });
  };
}
