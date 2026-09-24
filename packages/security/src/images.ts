/**
 * What an uploaded photo actually is, decided from its bytes (SR-5.5, T10, AC-5.3).
 *
 * Nothing here decodes an image. That is the point: every function below reads a header and
 * answers a question, so a file can be refused *before* a decoder allocates memory on its
 * behalf. A 30000 × 30000 PNG is four hundred bytes of header and 3.6 GB of decoded pixels,
 * and the only safe moment to say no is while it is still four hundred bytes.
 *
 * ## What this is, and what it is not
 *
 * This is the **cheap first filter**. It refuses the obvious: a file that is not an image, a
 * file whose declared type disagrees with its bytes, a file too large to be a photograph of a
 * card, and a file with something riding along after the image ends.
 *
 * It is **not** what makes an upload safe. Three other things do that, and they matter more:
 *
 *  1. **Re-encoding.** The stored copy is rebuilt from decoded pixels, so every comment
 *     segment, every colour profile, every appended passenger and all the EXIF is simply not
 *     carried across. Whatever a clever file smuggled past the checks below does not survive
 *     being turned back into pixels and out again.
 *  2. **Never serving the original.** The bytes a stranger uploaded are never the bytes a
 *     browser receives, so a file that is simultaneously a valid JPEG and a valid HTML page is
 *     only ever the first of those to anybody who asks for it.
 *  3. **A fixed `Content-Type` and `nosniff`.** A served photo is `image/jpeg` because we say
 *     so, not because of anything in the file.
 *
 * Byte inspection is a filter that can be evaded by a sufficiently clever file. The three
 * controls above cannot, because they do not depend on having correctly understood the input.
 *
 * ## Why only JPEG and PNG
 *
 * The plan's SR-5.5 allows WebP as well. It is left out, and that is a decision rather than an
 * omission: every accepted format is another decoder exposed to bytes a stranger chose, and
 * WebP buys nothing here — phone cameras produce JPEG, screenshots produce PNG, and a seller
 * photographing a card produces neither a WebP nor a complaint about it. One fewer decoder on
 * the hostile path is worth more than the format.
 */

/** The only two things an uploaded photo may be. */
export type ImageType = 'jpeg' | 'png';

/** Ten mebibytes (SR-5.5). A photograph of a trading card is not larger than this. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Longest permitted side. Comfortably above any phone camera, far below a bomb. */
export const MAX_PHOTO_DIMENSION = 8000;

/**
 * Total pixels, which is the number that decides how much memory a decode costs.
 *
 * Checked separately from the side limit because the two catch different files: 8000 × 8000 is
 * within the side limit and is 64 megapixels, which is 256 MB of RGBA and enough to end a
 * worker. Twenty-four megapixels is larger than any camera a seller owns.
 */
export const MAX_PHOTO_PIXELS = 24_000_000;

/** Smallest image worth calling a photograph of a card. Below this it cannot show condition. */
export const MIN_PHOTO_DIMENSION = 200;

export type ImageRejection =
  /** The bytes are not a JPEG or a PNG at all. */
  | 'not_an_image'
  /** They are an image, but not the kind the request claimed. */
  | 'type_mismatch'
  | 'too_large'
  | 'too_small'
  | 'dimensions_too_large'
  | 'too_many_pixels'
  /** The header is an image and the rest of it is not — truncated, or never valid. */
  | 'malformed'
  /** Something is appended after the image ends. See `endsCleanly`. */
  | 'trailing_data';

export class ImageRejectedError extends Error {
  constructor(
    readonly reason: ImageRejection,
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

const JPEG_SOI = [0xff, 0xd8] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** `IEND` with its (always zero) length and its (always constant) CRC. */
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] as const;

/**
 * `.at()` rather than an index expression throughout this file, the same way the pricing maths
 * does it: every offset below is derived from a length that came out of the file itself, and
 * `.at()` is typed `number | undefined`, so walking off the end is a value to handle rather
 * than a surprise to discover.
 */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes.at(i) === byte);
}

function endsWith(bytes: Uint8Array, suffix: readonly number[]): boolean {
  if (bytes.length < suffix.length) return false;
  const offset = bytes.length - suffix.length;
  return suffix.every((byte, i) => bytes.at(offset + i) === byte);
}

/**
 * What these bytes are, according to the bytes.
 *
 * Never according to the filename, and never according to the `Content-Type` the uploader
 * chose — both of those are things a stranger types, and neither has ever stopped anybody.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, JPEG_SOI)) return 'jpeg';
  return null;
}

export interface ImageHeader {
  type: ImageType;
  width: number;
  height: number;
}

/**
 * Width and height, read from the header without decoding anything.
 *
 * Returns null when the bytes do not parse — truncated, or never an image to begin with. The
 * caller treats that as a refusal rather than as "unknown size", because a file whose
 * dimensions cannot be established is a file whose decode cost cannot be bounded.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const type = sniffImageType(bytes);
  if (type === 'png') return readPngHeader(bytes);
  if (type === 'jpeg') return readJpegHeader(bytes);
  return null;
}

/** PNG puts them in IHDR, which the specification requires to be the first chunk. */
function readPngHeader(bytes: Uint8Array): ImageHeader | null {
  // 8 signature + 4 length + 4 type + 8 of dimensions.
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Bytes 12..16 are the chunk type, which must read `IHDR`.
  if (view.getUint32(12) !== 0x49484452) return null;
  return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * JPEG hides them in a start-of-frame segment, somewhere after a run of metadata.
 *
 * So this walks the segment chain: each is `FF <marker> <two-byte length> <payload>`, except
 * the handful of standalone markers that carry no length at all. Reading a length where there
 * is none is how a parser walks off into the entropy-coded data and reports a thumbnail's
 * dimensions, or nonsense.
 */
function readJpegHeader(bytes: Uint8Array): ImageHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes.at(offset) !== 0xff) return null;

    const marker = bytes.at(offset + 1);
    if (marker === undefined) return null;

    // Fill bytes: a run of FF before the real marker is legal padding.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers, which carry no length: SOI, EOI and the eight restart markers.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan. Everything past here is compressed pixels; a frame header should already
    // have been seen, and if it has not then this file does not have one where it belongs.
    if (marker === 0xda) return null;

    const length = view.getUint16(offset + 2);
    // A segment's length includes its own two bytes, so anything under two is a lie that would
    // make this loop stand still.
    if (length < 2) return null;

    /**
     * SOF0 through SOF15 are the frame headers, which is where the dimensions live — *except*
     * for the three markers that share the range and mean something else entirely: DHT (C4),
     * JPG (C8) and DAC (CC). Reading dimensions out of a Huffman table is the classic way to
     * get a confidently wrong answer.
     */
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      // Payload: precision (1), height (2), width (2).
      if (offset + 9 >= bytes.length) return null;
      return {
        type: 'jpeg',
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }

    offset += 2 + length;
  }
  return null;
}

/**
 * Does the file stop where the image stops?
 *
 * The oldest trick in the upload-handling business is a valid image with a second file glued
 * on after it. Both formats have an unambiguous terminator — JPEG's EOI, PNG's IEND chunk —
 * and a passenger has to sit after it, because sitting before it would stop the image being an
 * image.
 *
 * This refuses a small number of legitimate files: some cameras and some editors leave padding
 * after EOI. That is a trade made on purpose. The cost is a seller occasionally being told to
 * re-save a photo; the alternative is accepting the one shape every appended payload has.
 *
 * It is not sufficient on its own, and is not meant to be — a payload hidden in a comment
 * segment sits *inside* the image and passes this happily. The re-encode is what removes that
 * one, which is why the re-encode is the control and this is the filter.
 */
export function endsCleanly(bytes: Uint8Array): boolean {
  const type = sniffImageType(bytes);
  if (type === 'png') return endsWith(bytes, PNG_IEND);
  if (type === 'jpeg') return endsWith(bytes, [0xff, 0xd9]);
  return false;
}

/**
 * Is there EXIF in here?
 *
 * Only ever used to assert that there is **not**, in the copy we serve. EXIF on a photograph
 * taken at home carries the GPS coordinates of the seller's house (SR-5.5), and a marketplace
 * that publishes those has done something considerably worse than leak an email address.
 *
 * The re-encode is what removes it. This is how a test proves the re-encode did.
 */
export function hasExif(bytes: Uint8Array): boolean {
  const type = sniffImageType(bytes);
  if (type === 'jpeg') return findJpegApp1Exif(bytes);
  if (type === 'png') return findPngTextChunk(bytes, 'eXIf');
  return false;
}

function findJpegApp1Exif(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes.at(offset) !== 0xff) return false;
    const marker = bytes.at(offset + 1);
    if (marker === undefined) return false;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return false;
    const length = view.getUint16(offset + 2);
    if (length < 2) return false;
    // APP1 holding the ASCII `Exif`. APP1 is also where XMP lives, hence checking the payload
    // rather than trusting the marker.
    if (marker === 0xe1 && offset + 8 < bytes.length && view.getUint32(offset + 4) === 0x45786966) {
      return true;
    }
    offset += 2 + length;
  }
  return false;
}

/** A four-character PNG chunk name, as the big-endian word the file actually stores. */
function chunkType(name: string): number {
  let word = 0;
  for (let i = 0; i < name.length; i += 1) word = ((word << 8) | name.charCodeAt(i)) >>> 0;
  return word;
}

function findPngTextChunk(bytes: Uint8Array, name: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wanted = chunkType(name);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    if (view.getUint32(offset + 4) === wanted) return true;
    // Guard the walk: a bogus length must not send this backwards or past the end.
    const next = offset + 12 + length;
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}

export interface InspectOptions {
  /** What the request said it was uploading, from the content type it asked to presign. */
  declaredType?: ImageType | undefined;
  maxBytes?: number | undefined;
}

/**
 * Everything above, in the order that refuses the cheapest thing first.
 *
 * Throws rather than returning a union, because every caller either accepts the file or stops,
 * and a reason code is the thing both the route and the audit entry want.
 */
export function inspectImage(bytes: Uint8Array, options: InspectOptions = {}): ImageHeader {
  const maxBytes = options.maxBytes ?? MAX_PHOTO_BYTES;

  if (bytes.length > maxBytes) {
    throw new ImageRejectedError('too_large', 'that file is larger than 10 MB');
  }

  const type = sniffImageType(bytes);
  if (type === null) {
    throw new ImageRejectedError('not_an_image', 'that file is not a JPEG or a PNG');
  }
  if (options.declaredType !== undefined && options.declaredType !== type) {
    // The upload was presigned for one type and is another. Not necessarily an attack — but
    // there is no innocent reason for it either, and the presigned condition is only worth
    // having if the mismatch is refused.
    throw new ImageRejectedError('type_mismatch', 'that file is not the type it was declared as');
  }

  const header = readImageHeader(bytes);
  if (header === null) {
    throw new ImageRejectedError('malformed', 'that image could not be read');
  }
  if (header.width < MIN_PHOTO_DIMENSION || header.height < MIN_PHOTO_DIMENSION) {
    throw new ImageRejectedError('too_small', 'that image is too small to show a card');
  }
  if (header.width > MAX_PHOTO_DIMENSION || header.height > MAX_PHOTO_DIMENSION) {
    throw new ImageRejectedError('dimensions_too_large', 'that image is too large in one side');
  }
  // Before any decoder is handed the file. This is the decompression bomb, refused while it is
  // still a header.
  if (header.width * header.height > MAX_PHOTO_PIXELS) {
    throw new ImageRejectedError('too_many_pixels', 'that image has too many pixels');
  }

  if (!endsCleanly(bytes)) {
    throw new ImageRejectedError('trailing_data', 'that file has data after the image ends');
  }

  return header;
}
