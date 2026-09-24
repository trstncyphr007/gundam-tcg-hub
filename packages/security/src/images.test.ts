import { describe, expect, it } from 'vitest';
import {
  type ImageRejection,
  ImageRejectedError,
  endsCleanly,
  hasExif,
  inspectImage,
  readImageHeader,
  sniffImageType,
} from './images.js';

/**
 * Hostile input, one file at a time (SR-5.5, T10, AC-5.3).
 *
 * Every image below is built byte by byte rather than loaded from a fixture. That is
 * deliberate: a fixture is a file somebody once made and nobody has read since, and the whole
 * subject here is what happens when the bytes are not what they claim. Building them makes the
 * awkward cases — a Huffman table sitting where a frame header should be, a chunk length that
 * points backwards — something a test can *write*, rather than something it hopes it downloaded.
 */

/** A PNG, as small as one can be and still parse. CRCs are not checked, so they are not real. */
function png(
  width: number,
  height: number,
  options: {
    chunks?: { type: string; data?: number[] }[];
    trailing?: number[];
    omitEnd?: boolean;
  } = {},
): Uint8Array {
  const bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): void => {
    bytes.push(
      (data.length >>> 24) & 0xff,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff,
    );
    for (let i = 0; i < type.length; i += 1) bytes.push(type.charCodeAt(i));
    bytes.push(...data);
    bytes.push(0, 0, 0, 0); // CRC, which nothing here verifies.
  };

  chunk('IHDR', [
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    6,
    0,
    0,
    0,
  ]);
  for (const extra of options.chunks ?? []) chunk(extra.type, extra.data ?? []);
  chunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01]);
  if (options.omitEnd !== true) {
    bytes.push(0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
  }
  bytes.push(...(options.trailing ?? []));
  return Uint8Array.from(bytes);
}

/** A JPEG, likewise. `before` lets a test put segments ahead of the frame header. */
function jpeg(
  width: number,
  height: number,
  options: { before?: number[]; trailing?: number[]; omitEnd?: boolean; exif?: boolean } = {},
): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  // APP0/JFIF, which almost every real JPEG carries and which a parser has to step over.
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  if (options.exif === true) {
    // APP1 whose payload begins with the ASCII `Exif`.
    bytes.push(0xff, 0xe1, 0x00, 0x0c, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00);
  }
  bytes.push(...(options.before ?? []));
  // SOF0: length 17, precision 8, height, width, 3 components.
  bytes.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  );
  // SOS, then a token amount of entropy-coded data.
  bytes.push(0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0x00, 0x12, 0x34, 0x56);
  if (options.omitEnd !== true) bytes.push(0xff, 0xd9);
  bytes.push(...(options.trailing ?? []));
  return Uint8Array.from(bytes);
}

function ascii(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i));
  return bytes;
}

/** The reason `inspectImage` refused, or `null` if it did not refuse at all. */
function rejectionFor(bytes: Uint8Array, declaredType?: 'jpeg' | 'png'): ImageRejection | null {
  try {
    inspectImage(bytes, declaredType === undefined ? {} : { declaredType });
    return null;
  } catch (error) {
    if (error instanceof ImageRejectedError) return error.reason;
    throw error;
  }
}

describe('what these bytes are', () => {
  it('recognises a PNG and a JPEG by their signatures', () => {
    expect(sniffImageType(png(400, 300))).toBe('png');
    expect(sniffImageType(jpeg(400, 300))).toBe('jpeg');
  });

  it('recognises nothing else, whatever it is called', () => {
    // A filename and a content-type are things a stranger types. These are the bytes.
    expect(sniffImageType(Uint8Array.from(ascii('GIF89a')))).toBeNull();
    expect(sniffImageType(Uint8Array.from(ascii('%PDF-1.7')))).toBeNull();
    expect(sniffImageType(Uint8Array.from(ascii('<!DOCTYPE html>')))).toBeNull();
    expect(sniffImageType(Uint8Array.from(ascii('RIFF____WEBPVP8 ')))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('refuses the EICAR test file as what it is: not an image', () => {
    // AC-5.3 names EICAR, and it never reaches the virus scanner — it is a text file, and a
    // text file is refused three steps earlier for not being a photograph.
    const eicar = ascii('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    expect(rejectionFor(Uint8Array.from(eicar))).toBe('not_an_image');
  });
});

describe('dimensions, read without decoding', () => {
  it('reads them from a PNG header', () => {
    expect(readImageHeader(png(1200, 900))).toEqual({ type: 'png', width: 1200, height: 900 });
  });

  it('reads them from a JPEG frame header, past the metadata in front of it', () => {
    expect(readImageHeader(jpeg(1200, 900))).toEqual({ type: 'jpeg', width: 1200, height: 900 });
  });

  it('does not mistake a Huffman table for a frame header', () => {
    /**
     * DHT is `FFC4`, which sits inside the `FFC0..FFCF` range that frame headers occupy. A
     * parser that takes the whole range reads its dimensions out of a compression table and
     * reports something confidently wrong — and "confidently wrong about how big this is" is
     * exactly the belief a decompression bomb needs us to hold.
     */
    const dht = [0xff, 0xc4, 0x00, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05];
    expect(readImageHeader(jpeg(640, 480, { before: dht }))).toEqual({
      type: 'jpeg',
      width: 640,
      height: 480,
    });
  });

  it('steps over fill bytes before a marker', () => {
    expect(readImageHeader(jpeg(640, 480, { before: [0xff, 0xff, 0xff] }))?.width).toBe(640);
  });

  it('gives up on a truncated file rather than guessing', () => {
    // Unknown size is not a size. A file whose decode cost cannot be bounded is refused.
    const short = jpeg(640, 480).slice(0, 6);
    expect(readImageHeader(short)).toBeNull();
    expect(rejectionFor(short)).toBe('malformed');
  });

  it('gives up on a JPEG with no frame header at all', () => {
    const noFrame = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f,
      0x00, 0xff, 0xd9,
    ]);
    expect(readImageHeader(noFrame)).toBeNull();
  });

  it('does not walk backwards on a segment length of zero', () => {
    // A length below two would leave the cursor where it was, and the loop would sit there.
    // The test is that this returns at all.
    const liar = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x41, 0x41, 0xff, 0xd9]);
    expect(readImageHeader(liar)).toBeNull();
  });

  it('does not walk backwards on a PNG chunk length that points nowhere', () => {
    const bytes = png(400, 300);
    // Overwrite the IDAT-ish chunk length with something enormous.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(33, 0xffff_ffff);
    expect(hasExif(bytes)).toBe(false);
  });
});

describe('size limits, applied before a decoder sees anything', () => {
  it('refuses a file over ten megabytes', () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(png(400, 300).subarray(0, 64));
    expect(rejectionFor(big)).toBe('too_large');
  });

  it('refuses a side longer than eight thousand pixels', () => {
    // Tall enough to get past the minimum, so the side limit is what this measures rather
    // than `too_small` firing first.
    expect(rejectionFor(png(9000, 1000))).toBe('dimensions_too_large');
  });

  it('refuses a decompression bomb while it is still a header', () => {
    /**
     * The whole reason nothing above decodes. 8000 × 5000 is within the side limit, is forty
     * megapixels, and is 160 MB of RGBA the moment a decoder is handed it. This file is about
     * seventy bytes.
     */
    const bomb = png(8000, 5000);
    expect(bomb.length).toBeLessThan(200);
    expect(rejectionFor(bomb)).toBe('too_many_pixels');
  });

  it('refuses something too small to show a card', () => {
    expect(rejectionFor(png(16, 16))).toBe('too_small');
  });

  it('accepts an ordinary photograph', () => {
    expect(rejectionFor(jpeg(3024, 4032))).toBeNull();
    expect(inspectImage(jpeg(3024, 4032))).toEqual({ type: 'jpeg', width: 3024, height: 4032 });
  });
});

describe('a file that is two files', () => {
  it('refuses a JPEG with a web page glued on after it', () => {
    // AC-5.3's polyglot, in its most common form: a real image, then a passenger. It is a
    // valid JPEG to a decoder and a valid HTML document to a browser that was talked into
    // sniffing it.
    const polyglot = jpeg(800, 600, { trailing: ascii('<script>alert(1)</script>') });
    expect(sniffImageType(polyglot)).toBe('jpeg');
    expect(readImageHeader(polyglot)?.width, 'it really is a valid JPEG').toBe(800);
    expect(rejectionFor(polyglot)).toBe('trailing_data');
  });

  it('refuses a PNG with the EICAR file glued on after it', () => {
    const carrier = png(800, 600, {
      trailing: ascii('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
    });
    expect(rejectionFor(carrier)).toBe('trailing_data');
  });

  it('refuses a file that stops before the image does', () => {
    expect(endsCleanly(jpeg(800, 600, { omitEnd: true }))).toBe(false);
    expect(rejectionFor(png(800, 600, { omitEnd: true }))).toBe('trailing_data');
  });

  it('accepts one that ends exactly where it should', () => {
    expect(endsCleanly(jpeg(800, 600))).toBe(true);
    expect(endsCleanly(png(800, 600))).toBe(true);
  });

  it('is honest that a payload hidden inside the image passes', () => {
    /**
     * Recorded rather than hidden. A comment chunk sits *before* the terminator, so it has
     * none of the shape this function looks for, and it passes — as it should, because this is
     * a filter and not the control.
     *
     * What removes it is the re-encode: the stored copy is rebuilt from decoded pixels, and a
     * comment chunk is not a pixel. This test exists so nobody reads `endsCleanly` as a
     * promise it does not make.
     */
    const hidden = png(800, 600, { chunks: [{ type: 'tEXt', data: ascii('x<script>alert(1)') }] });
    expect(rejectionFor(hidden)).toBeNull();
  });
});

describe('the type the request claimed', () => {
  it('refuses a PNG presigned as a JPEG', () => {
    // The presigned upload fixed a content type. Honouring that condition only matters if the
    // mismatch is refused, and there is no innocent reason for one.
    expect(rejectionFor(png(800, 600), 'jpeg')).toBe('type_mismatch');
  });

  it('accepts one that matches', () => {
    expect(rejectionFor(png(800, 600), 'png')).toBeNull();
  });
});

describe('EXIF, which is where somebody’s address lives', () => {
  it('finds it in a JPEG that carries it', () => {
    expect(hasExif(jpeg(800, 600, { exif: true }))).toBe(true);
  });

  it('does not imagine it in one that does not', () => {
    expect(hasExif(jpeg(800, 600))).toBe(false);
  });

  it('finds a PNG eXIf chunk', () => {
    expect(
      hasExif(png(800, 600, { chunks: [{ type: 'eXIf', data: [0x49, 0x49, 0x2a, 0x00] }] })),
    ).toBe(true);
  });

  it('says no for something that is not an image at all', () => {
    expect(hasExif(Uint8Array.from(ascii('not an image')))).toBe(false);
  });
});
