import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, written out (SR-5.5).
 *
 * ## Why this is here rather than `@aws-sdk/client-s3`
 *
 * Four operations are needed — presign a PUT, read an object, write an object, delete one — and
 * the SDK that provides them brings roughly forty packages with it. This project has a stated
 * position on dependencies (SR-0.9, `minimumReleaseAge`, `trustPolicy`), and forty packages to
 * reach one host with four verbs is a poor trade.
 *
 * SigV4 is also a good candidate for writing out: it is a fixed, published algorithm that does
 * not change, it is pure `node:crypto`, and **it fails loudly**. A signature that is wrong is a
 * request the server rejects, not a silent weakening — so the failure mode of getting this
 * wrong is "uploads do not work", which is the kind of bug that cannot hide.
 *
 * The tests run it against a real MinIO, because an implementation of a signing algorithm that
 * has only ever been checked against its own expectations has been checked against nothing.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * AWS's own percent-encoding, which is not `encodeURIComponent`.
 *
 * The unreserved set is exactly `A-Za-z0-9-_.~`; everything else is percent-encoded with
 * **upper-case** hex. `encodeURIComponent` leaves `!*'()` alone and would produce a canonical
 * request that differs from the server's by a handful of bytes — which is a signature mismatch
 * and an error message that says nothing about why.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of value) {
    const isUnreserved =
      (char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '-' ||
      char === '_' ||
      char === '.' ||
      char === '~';
    if (isUnreserved) {
      out += char;
    } else if (char === '/' && !encodeSlash) {
      out += '/';
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** `20260925T114530Z` and `20260925`, which are the only two date formats SigV4 uses. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(credentials: Credentials, dateStamp: string): Buffer {
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, credentials.region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, 'aws4_request');
}

function credentialScope(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/${SERVICE}/aws4_request`;
}

/** Sorted, `&`-joined, both sides encoded. The order is part of what is signed. */
function canonicalQuery(params: Map<string, string>): string {
  return [...params.entries()]
    .map(([key, value]): [string, string] => [uriEncode(key), uriEncode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export interface CanonicalParts {
  method: string;
  /** Already-encoded path, beginning with `/`. */
  path: string;
  query: Map<string, string>;
  headers: Map<string, string>;
  /** `UNSIGNED-PAYLOAD` for a presigned URL, a real digest for a signed request. */
  payloadHash: string;
}

function canonicalRequest(parts: CanonicalParts): { canonical: string; signedHeaders: string } {
  const entries = [...parts.headers.entries()]
    .map(([key, value]): [string, string] => [key.toLowerCase(), value.trim()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = entries.map(([key, value]) => `${key}:${value}\n`).join('');
  const signedHeaders = entries.map(([key]) => key).join(';');

  const canonical = [
    parts.method,
    parts.path,
    canonicalQuery(parts.query),
    canonicalHeaders,
    signedHeaders,
    parts.payloadHash,
  ].join('\n');

  return { canonical, signedHeaders };
}

function sign(
  credentials: Credentials,
  amzDate: string,
  dateStamp: string,
  canonical: string,
): string {
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope(dateStamp, credentials.region),
    sha256Hex(canonical),
  ].join('\n');
  return hmac(signingKey(credentials, dateStamp), stringToSign).toString('hex');
}

export interface PresignInput {
  credentials: Credentials;
  method: string;
  /** Origin only, e.g. `http://127.0.0.1:9000`. */
  endpoint: string;
  /** Unencoded object path, e.g. `bucket/uploads/abc`. */
  path: string;
  expiresInSeconds: number;
  /**
   * Headers the client must then send **exactly**.
   *
   * This is the whole point of presigning with conditions rather than handing out a blank
   * write: a URL signed for `content-type: image/jpeg` and `content-length: 40312` cannot be
   * used to put four gigabytes of something else in the bucket. The server checks them against
   * the signature, so they are not advice.
   */
  signedHeaders?: Map<string, string> | undefined;
  now?: Date | undefined;
}

/**
 * A URL that authorises one request, for a short time, under stated conditions.
 *
 * `UNSIGNED-PAYLOAD` because the body does not exist yet — the point of a presigned PUT is that
 * the bytes go from the browser to the bucket without passing through us. What bounds it is the
 * expiry and the signed headers, not knowledge of the content.
 */
export function presignUrl(input: PresignInput): string {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const url = new URL(input.endpoint);

  const headers = new Map<string, string>([['host', url.host]]);
  for (const [key, value] of input.signedHeaders ?? []) headers.set(key.toLowerCase(), value);

  const signedHeaderList = [...headers.keys()]
    .map((key) => key.toLowerCase())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(';');

  const query = new Map<string, string>([
    ['X-Amz-Algorithm', ALGORITHM],
    [
      'X-Amz-Credential',
      `${input.credentials.accessKeyId}/${credentialScope(dateStamp, input.credentials.region)}`,
    ],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaderList],
  ]);

  const encodedPath = `/${input.path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')}`;
  const { canonical } = canonicalRequest({
    method: input.method,
    path: encodedPath,
    query,
    headers,
    payloadHash: 'UNSIGNED-PAYLOAD',
  });

  const signature = sign(input.credentials, amzDate, dateStamp, canonical);
  query.set('X-Amz-Signature', signature);

  return `${url.origin}${encodedPath}?${canonicalQuery(query)}`;
}

export interface SignedRequestInput {
  credentials: Credentials;
  method: string;
  endpoint: string;
  path: string;
  body?: Uint8Array | undefined;
  extraHeaders?: Map<string, string> | undefined;
  now?: Date | undefined;
}

/** Headers for a request we make ourselves, with the payload hashed because we have it. */
export function signRequest(input: SignedRequestInput): {
  url: string;
  headers: Record<string, string>;
} {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const url = new URL(input.endpoint);
  const payloadHash = sha256Hex(input.body ?? new Uint8Array(0));

  const headers = new Map<string, string>([
    ['host', url.host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
  ]);
  for (const [key, value] of input.extraHeaders ?? []) headers.set(key.toLowerCase(), value);

  const encodedPath = `/${input.path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')}`;
  const { canonical, signedHeaders } = canonicalRequest({
    method: input.method,
    path: encodedPath,
    query: new Map(),
    headers,
    payloadHash,
  });

  const signature = sign(input.credentials, amzDate, dateStamp, canonical);
  const credential = `${input.credentials.accessKeyId}/${credentialScope(dateStamp, input.credentials.region)}`;

  return {
    url: `${url.origin}${encodedPath}`,
    headers: {
      ...Object.fromEntries([...headers.entries()].filter(([key]) => key !== 'host')),
      authorization: `${ALGORITHM} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
