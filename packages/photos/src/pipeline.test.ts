import { encode as encodeJpeg } from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { PipelineUnavailableError, processUpload } from './pipeline.js';
import { ScannerUnavailableError } from './scanner.js';
import type { Scanner } from './scanner.js';
import type { Storage } from './storage.js';

/**
 * The order of the four steps, and what happens when one of them says no.
 *
 * Fakes here, deliberately, and this is the one place in this package where that is the right
 * choice. `storage.test.ts` and `scanner.test.ts` prove the real things work against real
 * servers; what is left to check is the **orchestration** — that a refusal at step one means
 * step two never runs, that a scanner outage is not a verdict, that the original is deleted on
 * every path. Those are questions about control flow, and a real bucket would only make them
 * slower to ask.
 *
 * The route tests in `apps/api` then run the whole thing against real infrastructure. Three
 * levels, each asking something the others cannot.
 */

const PHOTO_ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD_KEY = 'uploads/abc';

function realJpeg(width = 400, height = 300): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([180, 60, 60, 255], i);
  return new Uint8Array(encodeJpeg({ data, width, height }, 90).data);
}

interface Recorder {
  storage: Storage;
  got: string[];
  put: string[];
  deleted: string[];
}

function fakeStorage(object: Uint8Array | Error): Recorder {
  const got: string[] = [];
  const put: string[] = [];
  const deleted: string[] = [];
  return {
    got,
    put,
    deleted,
    storage: {
      ensureBucket: () => Promise.resolve(),
      presignUpload: () => ({ url: 'https://bucket.test/put', expiresInSeconds: 900 }),
      presignView: () => ({ url: 'https://bucket.test/get', expiresInSeconds: 300 }),
      getObject: (key) => {
        got.push(key);
        return object instanceof Error ? Promise.reject(object) : Promise.resolve(object);
      },
      putObject: (key) => {
        put.push(key);
        return Promise.resolve();
      },
      deleteObject: (key) => {
        deleted.push(key);
        return Promise.resolve();
      },
    },
  };
}

function fakeScanner(result: 'clean' | 'infected' | 'down'): Scanner & { calls: number } {
  const scanner = {
    calls: 0,
    ping: () => Promise.resolve(result !== 'down'),
    scan: () => {
      scanner.calls += 1;
      if (result === 'down') return Promise.reject(new ScannerUnavailableError('no answer'));
      return Promise.resolve(
        result === 'clean'
          ? { clean: true as const }
          : { clean: false as const, signature: 'Eicar-Test-Signature' },
      );
    },
  };
  return scanner;
}

const upload = { photoId: PHOTO_ID, uploadKey: UPLOAD_KEY };

describe('a photograph that passes every step', () => {
  it('stores a processed copy and deletes the original', async () => {
    const fake = fakeStorage(realJpeg());
    const outcome = await processUpload(
      { storage: fake.storage, scanner: fakeScanner('clean') },
      upload,
    );

    expect(outcome.approved).toBe(true);
    expect(fake.got).toEqual([UPLOAD_KEY]);
    expect(fake.put).toEqual([`photos/${PHOTO_ID}.jpg`]);
    // The bytes a stranger uploaded stop existing.
    expect(fake.deleted).toEqual([UPLOAD_KEY]);
  });

  it('reports the digest of the copy it stored, not of the upload', async () => {
    /**
     * It has to be the processed bytes: re-encoding is deterministic, so two sellers showing
     * the same picture produce the same digest even from different originals. The upload is
     * whatever their phone felt like producing, and hashing that would find nothing.
     */
    const fake = fakeStorage(realJpeg());
    const outcome = await processUpload(
      { storage: fake.storage, scanner: fakeScanner('clean') },
      upload,
    );
    if (!outcome.approved) throw new Error('expected approval');

    expect(outcome.facts.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(outcome.facts.contentType).toBe('image/jpeg');
    expect(outcome.facts.byteSize).toBeGreaterThan(0);
  });

  it('works with no scanner configured, because one is optional', async () => {
    // Optional, but its absence is not permission to skip the step — there is simply no step
    // to skip. Configuring it is what an operator does; the pipeline does not pretend either way.
    const fake = fakeStorage(realJpeg());
    const outcome = await processUpload({ storage: fake.storage }, upload);
    expect(outcome.approved).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses a file that is not an image, without asking the scanner', async () => {
    /**
     * The order is the point. Inspecting a header costs nothing; a scan costs a round trip.
     * A file that is not an image should never get as far as being scanned.
     */
    const fake = fakeStorage(new TextEncoder().encode('<!DOCTYPE html>'));
    const scanner = fakeScanner('clean');
    const outcome = await processUpload({ storage: fake.storage, scanner }, upload);

    expect(outcome).toEqual({ approved: false, reason: 'not_an_image' });
    expect(scanner.calls, 'the scanner was asked about a file that is not an image').toBe(0);
    // Still deleted: a file we have decided not to serve has no reason to stay in the bucket.
    expect(fake.deleted).toEqual([UPLOAD_KEY]);
    expect(fake.put).toEqual([]);
  });

  it('refuses a polyglot before scanning it', async () => {
    const polyglot = Uint8Array.from([...realJpeg(), ...new TextEncoder().encode('<?php ?>')]);
    const fake = fakeStorage(polyglot);
    const scanner = fakeScanner('clean');
    const outcome = await processUpload({ storage: fake.storage, scanner }, upload);

    expect(outcome).toEqual({ approved: false, reason: 'trailing_data' });
    expect(scanner.calls).toBe(0);
  });

  it('refuses what the scanner recognises, and records what it was', async () => {
    const fake = fakeStorage(realJpeg());
    const outcome = await processUpload(
      { storage: fake.storage, scanner: fakeScanner('infected') },
      upload,
    );

    expect(outcome).toEqual({ approved: false, reason: 'malware:Eicar-Test-Signature' });
    expect(fake.deleted).toEqual([UPLOAD_KEY]);
    // Nothing was stored, so there is nothing to serve and nothing to clean up later.
    expect(fake.put).toEqual([]);
  });
});

describe('when nothing can be decided', () => {
  it('leaves the file alone if the scanner cannot be reached', async () => {
    /**
     * The failure that matters most. Treating an outage as clean approves unscanned files
     * during exactly the failure the scanner exists to cover; treating it as infected tells
     * sellers their photographs are malware.
     *
     * So: it throws, nothing is written, and — importantly — the original is **not** deleted,
     * because the sweeper will want it when the scanner is back.
     */
    const fake = fakeStorage(realJpeg());
    await expect(
      processUpload({ storage: fake.storage, scanner: fakeScanner('down') }, upload),
    ).rejects.toThrow(PipelineUnavailableError);

    expect(fake.deleted, 'an unjudged upload was deleted').toEqual([]);
    expect(fake.put).toEqual([]);
  });

  it('leaves the row pending if the upload cannot be read', async () => {
    // Usually a seller who asked for a URL and never used it; occasionally a storage outage.
    // Either way there is nothing to decide, so it is not refused for a fault of ours.
    const fake = fakeStorage(new Error('no such key'));
    await expect(processUpload({ storage: fake.storage }, upload)).rejects.toThrow(
      PipelineUnavailableError,
    );
    expect(fake.deleted).toEqual([]);
  });
});
