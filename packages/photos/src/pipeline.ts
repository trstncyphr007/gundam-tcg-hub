import { createHash } from 'node:crypto';
import { ImageRejectedError, inspectImage } from '@gth/security';
import { ReencodeError, reencodePhoto } from './reencode.js';
import { type Scanner, ScannerUnavailableError } from './scanner.js';
import { type Storage, displayKeyFor } from './storage.js';

/**
 * What happens to an uploaded file between arriving and being shown to anyone (SR-5.5, T10).
 *
 * Four steps, in an order chosen so the cheapest refusal comes first and the expensive work is
 * only ever done on bytes that have already survived everything cheaper:
 *
 *  1. **Inspect** the header. No decoder is involved, so a decompression bomb is four hundred
 *     bytes of refusal rather than 3.6 GB of allocation.
 *  2. **Scan** for known malware. Costs a round trip and is worth it only on a file that is
 *     genuinely an image, which step one has established.
 *  3. **Re-encode** from decoded pixels, which is what actually removes EXIF, comment chunks
 *     and anything else riding along.
 *  4. **Store** the result under a new key and **delete the original**, so the bytes a stranger
 *     uploaded stop existing.
 *
 * ## It knows nothing about the database
 *
 * It is handed a photo id, and returns what it found. Writing that down is the caller's job, on
 * the worker role, because `@gth/photos` has no business holding a connection that can approve
 * things — and because a pure function that returns a verdict is far easier to test than one
 * that writes one.
 *
 * ## The one outcome that is not a verdict
 *
 * A scanner that cannot be reached **throws**, and the photo stays `pending`. Treating an
 * outage as "clean" would approve unscanned files during exactly the failure this exists to
 * cover; treating it as "infected" would reject good photos and tell sellers their pictures are
 * malware. Neither is acceptable, so it is an error and the sweeper tries again later.
 */

export interface PipelineDeps {
  storage: Storage;
  /** Absent means no scanner is configured, which is not the same as a clean verdict. */
  scanner?: Scanner | undefined;
}

export interface PhotoFacts {
  objectKey: string;
  width: number;
  height: number;
  sha256: string;
  byteSize: number;
  contentType: 'image/jpeg';
}

export type PipelineOutcome =
  | { approved: true; facts: PhotoFacts }
  /** A reason code, suitable for `listing_photos.rejection_reason` and for telling a seller. */
  | { approved: false; reason: string };

/** Raised when nothing could be decided, so the photo must stay pending. */
export class PipelineUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PipelineUnavailableError';
  }
}

export interface UploadRef {
  photoId: string;
  /**
   * Where the original actually landed, as recorded on the row.
   *
   * Taken from the database rather than derived from the id, because the row is written before
   * the id exists — the web role has no INSERT privilege on `id`, so Postgres generates it and
   * the key had to be chosen first. Deriving it here instead would mean the pipeline looked for
   * the file somewhere other than where the browser put it.
   */
  uploadKey: string;
}

export async function processUpload(
  deps: PipelineDeps,
  upload: UploadRef,
): Promise<PipelineOutcome> {
  const { photoId, uploadKey } = upload;

  let original: Uint8Array;
  try {
    original = await deps.storage.getObject(uploadKey);
  } catch (cause) {
    // The row says an upload was started and the object is not there. Usually a seller who
    // asked for a URL and never used it; occasionally a storage outage. Either way there is
    // nothing to decide, so it stays pending rather than being refused for a fault of ours.
    throw new PipelineUnavailableError('the uploaded file could not be read', { cause });
  }

  /**
   * Refused for what it is, before anything expensive happens to it.
   *
   * The original is deleted on a refusal too. A file we have decided not to serve is a file
   * with no reason to remain in the bucket, and leaving rejected uploads lying around turns a
   * private bucket into a store of whatever strangers felt like sending.
   */
  try {
    inspectImage(original);
  } catch (error) {
    if (!(error instanceof ImageRejectedError)) throw error;
    await deps.storage.deleteObject(uploadKey);
    return { approved: false, reason: error.reason };
  }

  if (deps.scanner) {
    let verdict;
    try {
      verdict = await deps.scanner.scan(original);
    } catch (cause) {
      if (cause instanceof ScannerUnavailableError) {
        // Left in place on purpose: the file has not been judged, and the sweeper will want it
        // again when the scanner is back.
        throw new PipelineUnavailableError('the virus scanner could not be reached', { cause });
      }
      throw cause;
    }
    if (!verdict.clean) {
      await deps.storage.deleteObject(uploadKey);
      // The signature name is recorded rather than shown: a seller is told their upload was
      // refused, and which malware family it matched is not a detail worth publishing back to
      // whoever sent it.
      return { approved: false, reason: `malware:${verdict.signature}` };
    }
  }

  let rebuilt;
  try {
    rebuilt = reencodePhoto(original);
  } catch (error) {
    if (!(error instanceof ReencodeError)) throw error;
    await deps.storage.deleteObject(uploadKey);
    return { approved: false, reason: error.reason };
  }

  const objectKey = displayKeyFor(photoId);
  await deps.storage.putObject(objectKey, rebuilt.bytes, rebuilt.contentType);

  /**
   * The original goes last.
   *
   * If this throws, the processed copy is already stored and the caller will still approve the
   * photo — which is the right way round. An orphaned original costs storage; an approved photo
   * with nothing to serve costs a broken gallery.
   */
  await deps.storage.deleteObject(uploadKey);

  return {
    approved: true,
    facts: {
      objectKey,
      width: rebuilt.width,
      height: rebuilt.height,
      // Of the copy we serve, not of the upload. Two listings with the same digest are showing
      // the same picture, which is the cheap half of the stolen-photo check (SR-5.6) — and it
      // has to be computed on the processed bytes, because re-encoding is deterministic and
      // the upload is whatever the uploader's phone felt like producing.
      sha256: createHash('sha256').update(rebuilt.bytes).digest('hex'),
      byteSize: rebuilt.bytes.length,
      contentType: rebuilt.contentType,
    },
  };
}
