import { createHash } from 'node:crypto';
import { type Credentials, presignUrl, signRequest } from './sigv4.js';

/**
 * The private bucket photos live in (SR-5.5, open item O4).
 *
 * Four operations, one host, and no URL anywhere in it that a request can influence — the
 * endpoint and the bucket come from configuration, and the key is built from ids we generated.
 * That is what earns this module its Semgrep exception: the SSRF questions `gth-no-outbound-http`
 * exists to ask have the same answer here as for the Stripe module and the Discord transport,
 * which is that there is nothing to point at.
 *
 * ## Why the bytes do not come through us
 *
 * A presigned PUT sends the file from the browser straight to the bucket. Ten megabytes per
 * photo through the API would be ten megabytes of request body to buffer, a timeout to tune and
 * a denial-of-service surface that costs nothing to abuse — and it would buy nothing, because
 * we do not trust the bytes on arrival either way. The pipeline reads them afterwards, from
 * storage, where they can be read at our pace.
 *
 * What bounds the upload is the signature: the URL is good for a few minutes, for one key, for
 * one content type, at one exact length.
 *
 * ## Nothing here is ever served to a browser
 *
 * `objectUrl` produces a short-lived signed GET, and it is used for the **processed** copy
 * only. The original is deleted once the pipeline is done with it; there is no code path that
 * hands out a link to an upload.
 */

export interface StorageConfig {
  /** Origin of the S3-compatible service, e.g. `http://127.0.0.1:9000`. */
  endpoint: string;
  bucket: string;
  credentials: Credentials;
}

export class StorageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Ten megabytes, matching `@gth/security`'s ceiling. Signed, so it is not a suggestion. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Long enough to pick a file and upload it on a slow connection; short enough to matter. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Long enough to render a gallery, short enough that a copied link stops working. */
export const VIEW_URL_TTL_SECONDS = 5 * 60;

/** How long a browser may cache the preflight. An hour of not asking again. */
export const CORS_MAX_AGE_SECONDS = 3600;

/** Five characters, because a policy document is not a place to discover a sixth. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export interface Storage {
  /**
   * Create the bucket if it is not there.
   *
   * Deliberately **not** called on startup. In production a bucket is an operator's decision,
   * with its own lifecycle policy, versioning and access rules; an application that quietly
   * creates one on boot is one that will eventually create it in the wrong account with the
   * wrong settings and nobody will notice. This exists so local development and the tests are
   * one call rather than a page of instructions.
   */
  ensureBucket: () => Promise<void>;

  /**
   * Allow a browser to use the presigned URLs at all (SR-5.5).
   *
   * **Without this the whole upload design does not work, and nothing on a server can tell.**
   * A presigned PUT is made by the browser to another origin with a `content-type` header, so
   * the browser first sends a preflight `OPTIONS`; a bucket with no CORS configuration answers
   * that with 404, the browser refuses to send the PUT, and `fetch` rejects in a console
   * nobody is reading. Every server-side test passes, because none of them is a browser.
   *
   * The origins are ours, from configuration — the site the upload page is served from. Not a
   * wildcard: `*` would let any page on the internet spend a signed URL it had somehow
   * obtained, and the signature is the only thing standing between a link and the bucket.
   */
  putCorsPolicy: (allowedOrigins: readonly string[]) => Promise<void>;
  /** A URL the browser may PUT one file to, under stated conditions. */
  presignUpload: (input: { key: string; contentType: string; contentLength: number }) => {
    url: string;
    expiresInSeconds: number;
  };
  /** A short-lived URL for a processed copy. Never for an upload. */
  presignView: (key: string) => { url: string; expiresInSeconds: number };
  getObject: (key: string) => Promise<Uint8Array>;
  putObject: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  deleteObject: (key: string) => Promise<void>;
}

/**
 * Keys are built here, from ids we generated, and never from anything a request supplied.
 *
 * A key assembled from user input is a path traversal waiting to happen — `../` in an object
 * key does not escape a bucket the way it escapes a filesystem, but it does let one listing's
 * upload land on another's object. The photo id is a UUID from the database.
 */
export function uploadKeyFor(token: string): string {
  return `uploads/${token}`;
}

export function displayKeyFor(photoId: string): string {
  return `photos/${photoId}.jpg`;
}

export function createStorage(config: StorageConfig): Storage {
  const pathFor = (key: string): string => `${config.bucket}/${key}`;

  const request = async (
    method: string,
    key: string,
    body?: Uint8Array,
    contentType?: string,
  ): Promise<Response> => {
    const extraHeaders = new Map<string, string>();
    if (contentType !== undefined) extraHeaders.set('content-type', contentType);

    const signed = signRequest({
      credentials: config.credentials,
      method,
      endpoint: config.endpoint,
      path: pathFor(key),
      ...(body === undefined ? {} : { body }),
      extraHeaders,
    });

    // See the module header: fixed host from configuration, key built from our own ids, no
    // user-supplied URL anywhere (ADR-030). Semgrep's `gth-no-outbound-http` excepts this file
    // by name, the way it excepts the Stripe module and the Discord transport.
    const response = await fetch(signed.url, {
      method,
      headers: signed.headers,
      ...(body === undefined ? {} : { body }),
      // No redirects. Object storage has no legitimate reason to redirect us, and following
      // one is how a fixed host stops being fixed.
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    return response;
  };

  /** The bucket itself is a path with no key, so it does not go through `pathFor`. */
  const bucketRequest = async (
    method: string,
    options: { query?: Map<string, string>; body?: Uint8Array; contentType?: string } = {},
  ): Promise<Response> => {
    const extraHeaders = new Map<string, string>();
    if (options.contentType !== undefined) extraHeaders.set('content-type', options.contentType);
    if (options.body !== undefined) {
      // S3 requires Content-MD5 on the bucket sub-resource writes, and it is signed along with
      // everything else, so a body that changed in flight fails the signature rather than the
      // checksum. Belt and braces, and the API refuses the request without it.
      extraHeaders.set('content-md5', createHash('md5').update(options.body).digest('base64'));
    }

    const signed = signRequest({
      credentials: config.credentials,
      method,
      endpoint: config.endpoint,
      path: config.bucket,
      ...(options.query ? { query: options.query } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
      extraHeaders,
    });
    return fetch(signed.url, {
      method,
      headers: signed.headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  };

  return {
    ensureBucket: async () => {
      const response = await bucketRequest('PUT');
      // 409 covers both `BucketAlreadyExists` and `BucketAlreadyOwnedByYou`. Either way the
      // bucket is there, which is the state that was asked for.
      if (!response.ok && response.status !== 409) {
        throw new StorageError(response.status, `could not create the bucket ${config.bucket}`);
      }
    },

    putCorsPolicy: async (allowedOrigins) => {
      if (allowedOrigins.length === 0) {
        throw new StorageError(400, 'a CORS policy with no origins would block every upload');
      }
      /**
       * Built by hand rather than with an XML library, because it is six tags and the values
       * are ours. `escapeXml` is still applied: an origin comes from configuration, and
       * configuration that can inject markup into a policy document is a policy somebody else
       * can write.
       *
       * `PUT` for the upload and `GET` for the processed copy the gallery shows. No `POST`,
       * no `DELETE`: a browser has no business doing either to this bucket.
       *
       * `content-type` is the only allowed request header because it is the only one the
       * presigned PUT signs. `ExposeHeader` is absent deliberately — the page needs the
       * status, not the object's metadata.
       */
      const rules = allowedOrigins
        .map((origin) => `<AllowedOrigin>${escapeXml(origin)}</AllowedOrigin>`)
        .join('');
      const body = new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<CORSConfiguration>' +
          '<CORSRule>' +
          rules +
          '<AllowedMethod>PUT</AllowedMethod>' +
          '<AllowedMethod>GET</AllowedMethod>' +
          /*
           * Any request header, from those origins only.
           *
           * The origin list is the control here; the header list is not, and treating it as
           * one costs an afternoon. A browser decides for itself which headers it names in the
           * preflight — Chromium lists `content-length` even when a page never sets it — and a
           * policy that enumerates them refuses the upload for a reason that appears nowhere
           * except a browser console. What a header name cannot do is authorise anything: the
           * signature does that, and it is computed over the headers that are actually sent.
           */
          '<AllowedHeader>*</AllowedHeader>' +
          `<MaxAgeSeconds>${String(CORS_MAX_AGE_SECONDS)}</MaxAgeSeconds>` +
          '</CORSRule>' +
          '</CORSConfiguration>',
      );

      const response = await bucketRequest('PUT', {
        query: new Map([['cors', '']]),
        body,
        contentType: 'application/xml',
      });
      if (!response.ok) {
        throw new StorageError(
          response.status,
          `could not set the CORS policy on ${config.bucket}`,
        );
      }
    },

    presignUpload: ({ key, contentType, contentLength }) => {
      if (contentLength <= 0 || contentLength > MAX_UPLOAD_BYTES) {
        throw new StorageError(400, 'that file is larger than 10 MB');
      }
      const url = presignUrl({
        credentials: config.credentials,
        method: 'PUT',
        endpoint: config.endpoint,
        path: pathFor(key),
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
        // Both signed, so the browser must send exactly these. A URL issued for a 40 kB JPEG
        // cannot be used to store four gigabytes of anything else.
        signedHeaders: new Map([
          ['content-type', contentType],
          ['content-length', String(contentLength)],
        ]),
      });
      return { url, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
    },

    presignView: (key) => ({
      url: presignUrl({
        credentials: config.credentials,
        method: 'GET',
        endpoint: config.endpoint,
        path: pathFor(key),
        expiresInSeconds: VIEW_URL_TTL_SECONDS,
      }),
      expiresInSeconds: VIEW_URL_TTL_SECONDS,
    }),

    getObject: async (key) => {
      const response = await request('GET', key);
      if (!response.ok) {
        throw new StorageError(response.status, `could not read ${key}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    putObject: async (key, body, contentType) => {
      const response = await request('PUT', key, body, contentType);
      if (!response.ok) {
        throw new StorageError(response.status, `could not write ${key}`);
      }
    },

    deleteObject: async (key) => {
      const response = await request('DELETE', key);
      // 404 is success for a delete: the object is not there, which is the state asked for.
      // The pipeline deletes an original it may already have deleted after a crash, and that
      // retry should not fail.
      if (!response.ok && response.status !== 404) {
        throw new StorageError(response.status, `could not delete ${key}`);
      }
    },
  };
}
