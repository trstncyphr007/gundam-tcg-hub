import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Turning an uploaded file back into a picture (SR-5.5, T10, AC-5.3).
 *
 * This is the control that `@gth/security`'s inspection is only the filter for. Everything an
 * uploaded file carries that is not a pixel — EXIF, colour profiles, comment chunks, appended
 * passengers, the second file somebody glued on the end — is simply **not read**. The output is
 * built from a decoded pixel buffer and nothing else, so it cannot contain what it was never
 * given.
 *
 * That is why it works without having to be clever. A filter has to recognise the attack; this
 * does not, because it copies nothing across. Whatever survives being decoded to RGBA and
 * encoded back to JPEG was, by definition, a picture.
 *
 * ## Always out as JPEG
 *
 * Whatever came in. One output format means one decoder path for anything we serve, one
 * `Content-Type` to pin, and no question about what a stored object is. A PNG's transparency is
 * composited onto white, which is the right answer for a photograph of a card and the only
 * available one for a format with no alpha channel.
 *
 * ## Why not sharp
 *
 * The plan names it (§5, SR-5.5) and `pnpm-workspace.yaml` already excludes it: `@img/sharp-*`
 * carries LGPL-3.0 libvips, which is not on the licence allowlist the `licenses` CI gate
 * enforces. Reversing that is a legal decision rather than a convenience one.
 *
 * So: `jpeg-js` and `pngjs`, both pure JavaScript, three packages between them and no native
 * code. They are perhaps ten times slower than libvips, which costs nothing that matters — this
 * runs in a background job rather than a request, and a photograph takes well under a second
 * either way. A pure-JS decoder also fails differently on hostile input: the worst case is an
 * exception or a slow loop in a process that is already bounded, rather than memory corruption
 * in a C library.
 */

/**
 * Longest side of a stored photo.
 *
 * Enough to judge a corner, an edge or a surface scratch, which is what the photo requirement
 * exists for. Beyond it the extra pixels are bandwidth for every viewer and evidence for
 * nobody — and the original, which had them, is deleted rather than kept.
 */
export const DISPLAY_MAX_DIMENSION = 1600;

/** Visually indistinguishable from the original at this size, and a fraction of the bytes. */
export const DISPLAY_JPEG_QUALITY = 82;

/**
 * Belt to the inspection's braces.
 *
 * `@gth/security` refuses anything over 24 megapixels before this is called. These are passed
 * to the decoder anyway, because "the caller checked" is a sentence that stops being true the
 * first time somebody adds a second caller.
 */
const DECODER_MAX_MEGAPIXELS = 25;
const DECODER_MAX_MEMORY_MB = 512;

export type ReencodeFailure =
  /** Neither decoder recognised it. The inspection should have caught this first. */
  | 'unsupported_format'
  /** A decoder was handed it and gave up: malformed, or only pretending to be an image. */
  | 'undecodable'
  /** It decoded to something with no pixels in it. */
  | 'empty_image';

export class ReencodeError extends Error {
  constructor(
    readonly reason: ReencodeFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReencodeError';
  }
}

export interface Reencoded {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Always this. A stored object's type is ours to state, never the upload's to suggest. */
  contentType: 'image/jpeg';
}

interface Pixels {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row-major. */
  data: Uint8Array;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, i) => bytes.at(i) === byte);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.at(0) === 0xff && bytes.at(1) === 0xd8;
}

/**
 * Decode to raw pixels, or refuse.
 *
 * Both decoders are wrapped, because both throw on input they dislike and a raw exception out
 * of a decoding library is not something a route should be answering with.
 */
function decode(bytes: Uint8Array): Pixels {
  if (isPng(bytes)) {
    try {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    } catch (cause) {
      throw new ReencodeError('undecodable', 'that PNG could not be read', { cause });
    }
  }

  if (isJpeg(bytes)) {
    try {
      const jpeg = decodeJpeg(Buffer.from(bytes), {
        formatAsRGBA: true,
        /**
         * Tolerant on purpose.
         *
         * Real cameras and real editors emit JPEGs with small structural oddities, and refusing
         * those would be refusing photographs rather than attacks. It is affordable precisely
         * because nothing from the input reaches the output anyway: this decoder's job is to
         * extract pixels, not to certify the file.
         */
        tolerantDecoding: true,
        maxResolutionInMP: DECODER_MAX_MEGAPIXELS,
        maxMemoryUsageInMB: DECODER_MAX_MEMORY_MB,
      });
      return { width: jpeg.width, height: jpeg.height, data: new Uint8Array(jpeg.data) };
    } catch (cause) {
      throw new ReencodeError('undecodable', 'that JPEG could not be read', { cause });
    }
  }

  throw new ReencodeError('unsupported_format', 'that file is not a JPEG or a PNG');
}

/**
 * Average the source pixels that fall inside each destination pixel.
 *
 * A box filter, which is the right one for making something smaller: it reads every source
 * pixel exactly once, so detail is averaged away rather than thrown away. Nearest-neighbour
 * would be faster and would turn the fine print on a card into aliasing artefacts — which is
 * the one thing a condition photograph exists to show.
 *
 * Alpha is composited onto white here rather than in a second pass, because a card photographed
 * against a transparent background does not exist, and a screenshot with a transparent corner
 * would otherwise come out black.
 */
function resample(source: Pixels, width: number, height: number): Pixels {
  const out = new Uint8Array(width * height * 4);
  const xRatio = source.width / width;
  const yRatio = source.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < source.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < source.width; sx += 1) {
          const at = (sy * source.width + sx) * 4;
          // Over white, so a transparent pixel reads as white rather than as black.
          const alpha = (source.data.at(at + 3) ?? 255) / 255;
          r += (source.data.at(at) ?? 0) * alpha + 255 * (1 - alpha);
          g += (source.data.at(at + 1) ?? 0) * alpha + 255 * (1 - alpha);
          b += (source.data.at(at + 2) ?? 0) * alpha + 255 * (1 - alpha);
          n += 1;
        }
      }

      // `.set()` rather than four index assignments: the offset is computed, and an index
      // expression with a computed key is the shape the lint rule exists to ask about.
      const to = (y * width + x) * 4;
      out.set(
        n === 0
          ? [255, 255, 255, 255]
          : [Math.round(r / n), Math.round(g / n), Math.round(b / n), 255],
        to,
      );
    }
  }
  return { width, height, data: out };
}

/** The size a photo is stored at: the longest side capped, the shape kept. */
export function displaySize(
  width: number,
  height: number,
  max = DISPLAY_MAX_DIMENSION,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  // Never enlarged. Upscaling a small photograph adds no evidence and plenty of bytes.
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Rebuild an uploaded file as a picture, and nothing else.
 *
 * The output shares no bytes with the input. That sentence is the whole security argument: a
 * payload in a comment segment, a second file after the terminator, and the GPS coordinates of
 * somebody's house are all things the input had and the output was never told about.
 */
export function reencodePhoto(bytes: Uint8Array): Reencoded {
  const decoded = decode(bytes);
  if (decoded.width < 1 || decoded.height < 1 || decoded.data.length === 0) {
    throw new ReencodeError('empty_image', 'that image has no pixels');
  }

  const target = displaySize(decoded.width, decoded.height);
  /**
   * Resampled even when the size is unchanged, because that pass is also what flattens alpha
   * onto white. Skipping it for an already-small PNG would produce a different result than the
   * same PNG one pixel larger — the kind of inconsistency nobody finds until it ships.
   */
  const pixels = resample(decoded, target.width, target.height);

  const encoded = encodeJpeg(
    { data: Buffer.from(pixels.data), width: pixels.width, height: pixels.height },
    DISPLAY_JPEG_QUALITY,
  );

  return {
    bytes: new Uint8Array(encoded.data),
    width: pixels.width,
    height: pixels.height,
    contentType: 'image/jpeg',
  };
}
