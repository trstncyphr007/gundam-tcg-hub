/**
 * Create the photo bucket and let a browser use it (SR-5.5).
 *
 * Two things an operator does once, and that local development and CI need done for them:
 *
 * 1. the bucket exists;
 * 2. it carries a CORS policy naming the site, so the browser's preflight for a presigned PUT
 *    is answered instead of 404'd.
 *
 * The second is not optional and was missing entirely until an end-to-end test went looking.
 * Nothing on a server can notice it: every server-side call to object storage works perfectly
 * without a CORS policy, because a server is not a browser and never sends a preflight.
 *
 * Deliberately a command rather than something the API does at boot. A bucket in production
 * has a lifecycle policy, versioning and access rules that belong to whoever owns the account;
 * an application that rewrites that configuration every time it starts is one that will
 * eventually overwrite something it did not know was there. In production this is run once,
 * by hand, against R2 — the same call, different credentials.
 */
import { createStorage } from '../storage.js';

/** Named rather than looked up: a computed key into `process.env` is a sink, and a literal is not. */
function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; this command needs the object storage configuration`);
  }
  return value;
}

async function main(): Promise<void> {
  const bucket = required('S3_BUCKET', process.env['S3_BUCKET']);
  const storage = createStorage({
    endpoint: required('S3_ENDPOINT', process.env['S3_ENDPOINT']),
    bucket,
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID', process.env['S3_ACCESS_KEY_ID']),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY', process.env['S3_SECRET_ACCESS_KEY']),
      region: process.env['S3_REGION'] ?? 'us-east-1',
    },
  });

  await storage.ensureBucket();
  console.log(`bucket ${bucket} is present`);

  /**
   * The origin the *browser* is on, which is the site, not the API.
   *
   * `APP_BASE_URL` rather than a wildcard: `*` would let any page anywhere spend a signed URL
   * it had somehow obtained, and the signature is the only thing between a link and the
   * bucket. Extra origins can be listed in `PHOTO_CORS_ORIGINS`, comma separated, for a
   * deployment served on more than one name.
   */
  const origins = [
    ...new Set(
      [
        new URL(required('APP_BASE_URL', process.env['APP_BASE_URL'])).origin,
        ...(process.env['PHOTO_CORS_ORIGINS'] ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== '')
          .map((value) => new URL(value).origin),
      ].filter((value) => value !== ''),
    ),
  ];

  await storage.putCorsPolicy(origins);
  console.log(`CORS policy set for ${origins.join(', ')}`);
}

await main();
