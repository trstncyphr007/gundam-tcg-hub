import { endsCleanly, hasExif, inspectImage, sniffImageType } from '@gth/security';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { DISPLAY_MAX_DIMENSION, ReencodeError, displaySize, reencodePhoto } from './reencode.js';

/**
 * What survives being turned back into a picture (SR-5.5, T10, AC-5.3).
 *
 * These use real codecs on real encoded bytes, not hand-built headers. That is the difference
 * between this file and `@gth/security`'s: there, the subject was parsing bytes that are not
 * what they claim, and building them by hand was the point. Here the subject is what a decoder
 * and an encoder do to a file, and a decoder cannot be fooled by a fixture that was never
 * decodable.
 *
 * So each test starts from an image this file actually encoded, then does something hostile to
 * it, then checks the hostility is gone.
 */

/** A recognisable picture: a red field with a green square, so resampling can be seen to work. */
function pixels(width: number, height: number, alpha = 255): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const inSquare =
        x > width / 4 && x < (width * 3) / 4 && y > height / 4 && y < (height * 3) / 4;
      data.set([inSquare ? 0 : 220, inSquare ? 200 : 20, 20, alpha], at);
    }
  }
  return data;
}

function realJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array(encodeJpeg({ data: pixels(width, height), width, height }, 90).data);
}

function realPng(width: number, height: number, alpha = 255): Uint8Array {
  const png = new PNG({ width, height });
  pixels(width, height, alpha).copy(png.data);
  return new Uint8Array(PNG.sync.write(png));
}

/** Decode a produced JPEG and read the pixel in the middle of it. */
function centrePixel(jpeg: Uint8Array): { r: number; g: number; b: number } {
  const decoded = decodeJpeg(Buffer.from(jpeg), { formatAsRGBA: true });
  const at = (Math.floor(decoded.height / 2) * decoded.width + Math.floor(decoded.width / 2)) * 4;
  return {
    r: decoded.data.at(at) ?? 0,
    g: decoded.data.at(at + 1) ?? 0,
    b: decoded.data.at(at + 2) ?? 0,
  };
}

function bytesOf(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i));
  return out;
}

/** Splice an APP1 `Exif` segment in straight after SOI, the way a camera would. */
function withExif(jpeg: Uint8Array): Uint8Array {
  const payload = [
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // little-endian TIFF header
    // One tag's worth of plausible filler, standing in for a GPS block.
    ...bytesOf('GPS 51.5074 N 0.1278 W'),
  ];
  const length = payload.length + 2;
  const segment = [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload];
  return Uint8Array.from([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

/** Add a tEXt chunk before IEND, which is where a payload hides *inside* a valid PNG. */
function withTextChunk(png: Uint8Array, text: string): Uint8Array {
  const data = [...bytesOf('Comment'), 0x00, ...bytesOf(text)];
  const chunk = [
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...bytesOf('tEXt'),
    ...data,
    0,
    0,
    0,
    0,
  ];
  // IEND is the last twelve bytes; the chunk goes in front of it.
  const cut = png.length - 12;
  return Uint8Array.from([...png.subarray(0, cut), ...chunk, ...png.subarray(cut)]);
}

describe('what comes out', () => {
  it('is a JPEG, whatever went in', () => {
    // One output format means one decoder path for anything we serve and one Content-Type to
    // pin. A PNG that stayed a PNG would be a second answer to "what is a stored photo".
    expect(sniffImageType(reencodePhoto(realPng(400, 300)).bytes)).toBe('jpeg');
    expect(sniffImageType(reencodePhoto(realJpeg(400, 300)).bytes)).toBe('jpeg');
  });

  it('is an image our own inspection is happy to accept', () => {
    // The output has to pass the gate the input passed, or the pipeline has produced something
    // it would have refused on the way in.
    const out = reencodePhoto(realJpeg(1200, 900));
    expect(() => inspectImage(out.bytes)).not.toThrow();
    expect(endsCleanly(out.bytes)).toBe(true);
  });

  it('reports the size it actually produced', () => {
    const out = reencodePhoto(realJpeg(800, 600));
    const decoded = inspectImage(out.bytes);
    expect({ width: decoded.width, height: decoded.height }).toEqual({
      width: out.width,
      height: out.height,
    });
  });

  it('shares no bytes with what it was given', () => {
    // The whole security argument in one assertion. Not a subsequence, not a prefix: a
    // different file, built from pixels.
    const input = realJpeg(400, 300);
    const out = reencodePhoto(input);
    expect(Buffer.from(out.bytes).includes(Buffer.from(input.subarray(20, 60)))).toBe(false);
  });
});

describe('what does not survive', () => {
  it('drops EXIF, which is where somebody’s address lives', () => {
    /**
     * AC-5.3's second half. A photograph taken at home carries the GPS coordinates of the
     * seller's house, and a marketplace that publishes those has done something considerably
     * worse than leak an email address.
     */
    const carrying = withExif(realJpeg(600, 400));
    expect(hasExif(carrying), 'the fixture should have EXIF to begin with').toBe(true);

    expect(hasExif(reencodePhoto(carrying).bytes)).toBe(false);
  });

  it('drops a payload hidden inside the image', () => {
    /**
     * The case `@gth/security` is explicitly honest about letting through: a tEXt chunk sits
     * before the terminator, so it has none of the shape `endsCleanly` looks for.
     *
     * This is the control that removes it, and it does so without recognising it — a comment
     * chunk is not a pixel, so it is never read.
     */
    const smuggling = withTextChunk(realPng(500, 400), '<script>alert(1)</script>');
    expect(Buffer.from(smuggling).includes('alert(1)')).toBe(true);

    const out = reencodePhoto(smuggling);
    expect(Buffer.from(out.bytes).includes('alert(1)')).toBe(false);
    expect(Buffer.from(out.bytes).includes('Comment')).toBe(false);
  });

  it('drops a passenger glued on after the image ends', () => {
    // Refused by the inspection long before it reaches here. Tested anyway, because the two
    // controls are meant to be independent and a defence that only works when the other one
    // already worked is not a second defence.
    const polyglot = Uint8Array.from([
      ...realJpeg(400, 300),
      ...bytesOf('<?php system($_GET[0]);'),
    ]);
    const out = reencodePhoto(polyglot);
    expect(Buffer.from(out.bytes).includes('<?php')).toBe(false);
  });
});

describe('the size it is stored at', () => {
  it('caps the longest side and keeps the shape', () => {
    expect(displaySize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(displaySize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
  });

  it('never enlarges a small photograph', () => {
    // Upscaling adds no evidence and plenty of bytes.
    expect(displaySize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it('leaves one that is exactly at the limit alone', () => {
    // The boundary, which is where an off-by-one puts a 1600-pixel image through a pointless
    // resample or lets a 1601-pixel one through untouched.
    expect(displaySize(DISPLAY_MAX_DIMENSION, 900)).toEqual({
      width: DISPLAY_MAX_DIMENSION,
      height: 900,
    });
    expect(displaySize(DISPLAY_MAX_DIMENSION + 1, 800).width).toBe(DISPLAY_MAX_DIMENSION);
  });

  it('actually resizes the picture, not just the number', () => {
    const out = reencodePhoto(realJpeg(2400, 1800));
    expect(Math.max(out.width, out.height)).toBe(DISPLAY_MAX_DIMENSION);
    expect(out.height).toBe(1200);
  });

  it('is smaller than the original it came from', () => {
    const original = realJpeg(2400, 1800);
    expect(reencodePhoto(original).bytes.length).toBeLessThan(original.length);
  });
});

describe('transparency, which a JPEG cannot carry', () => {
  it('composites onto white rather than onto black', () => {
    /**
     * A fully transparent PNG would decode to RGB values nobody chose. Compositing over white
     * is the answer that looks like a photograph; the default — multiplying by an alpha of
     * zero and keeping the result — produces a black rectangle.
     */
    const out = reencodePhoto(realPng(300, 300, 0));
    const centre = centrePixel(out.bytes);

    // Near white on every channel. Black would be the result of the obvious implementation,
    // which multiplies by an alpha of zero and keeps what it gets.
    expect(centre.r).toBeGreaterThan(240);
    expect(centre.g).toBeGreaterThan(240);
    expect(centre.b).toBeGreaterThan(240);
  });

  it('leaves an opaque image alone', () => {
    // The green square in the middle of the fixture, still green. Compositing must not tint
    // a photograph that had nothing to composite.
    const centre = centrePixel(reencodePhoto(realPng(300, 300)).bytes);
    expect(centre.g).toBeGreaterThan(centre.r);
    expect(centre.g).toBeGreaterThan(centre.b);
  });
});

describe('files it refuses', () => {
  it('refuses something that is not an image at all', () => {
    const text = Uint8Array.from(bytesOf('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD'));
    expect(() => reencodePhoto(text)).toThrow(ReencodeError);
    try {
      reencodePhoto(text);
    } catch (error) {
      expect((error as ReencodeError).reason).toBe('unsupported_format');
    }
  });

  it('refuses a JPEG the decoder cannot make sense of', () => {
    // A real SOI marker and then nothing that follows the format. The decoder's own exception
    // is caught and turned into a typed refusal, because a route should not be answering with
    // whatever a decoding library felt like throwing.
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...bytesOf('not a jpeg')]);
    try {
      reencodePhoto(broken);
      expect.unreachable('a broken JPEG was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ReencodeError);
      expect((error as ReencodeError).reason).toBe('undecodable');
      expect((error as ReencodeError).cause).toBeDefined();
    }
  });

  it('refuses a file with the right signature and nothing behind it', () => {
    // A decoder handed this gives up, and it gives up as a typed refusal rather than as
    // whatever exception the library felt like throwing.
    const pretending = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    try {
      reencodePhoto(pretending);
      expect.unreachable('a truncated PNG was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ReencodeError);
      expect((error as ReencodeError).reason).toBe('undecodable');
      // The library's own error is kept underneath, for a log that has to explain itself.
      expect((error as ReencodeError).cause).toBeDefined();
    }
  });
});
