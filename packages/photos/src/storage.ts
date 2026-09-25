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
  const bucketRequest = async (method: string): Promise<Response> => {
    const signed = signRequest({
      credentials: config.credentials,
      method,
      endpoint: config.endpoint,
      path: config.bucket,
    });
    return fetch(signed.url, {
      method,
      headers: signed.headers,
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
