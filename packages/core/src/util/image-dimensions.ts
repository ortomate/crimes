/**
 * Minimal raster-image dimension reader. Parses just enough of each
 * format header to recover `width` × `height` in pixels, without
 * decoding any pixel data and without taking a dependency.
 *
 * Supported formats: **PNG**, **GIF**, **JPEG**. Other raster formats
 * (`webp`, `avif`) return `undefined` — they have either a variable
 * subformat layout (WebP: VP8 / VP8L / VP8X) or a nested-box
 * structure (AVIF / HEIF) that's larger than its agent-risk value
 * for v1. The asset detectors that consume this treat `undefined` as
 * "format not supported — skip the file", which is the conservative
 * choice. Adding more formats later is additive.
 *
 * The function operates on a `Buffer` so callers can pre-slice (only
 * the first 64 bytes are typically needed). Returns `undefined` for
 * truncated buffers and malformed headers — callers should not
 * crash on a corrupt image.
 */
export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "gif" | "jpeg";
}

export function readImageDimensions(buf: Buffer): ImageDimensions | undefined {
  return readPng(buf) ?? readGif(buf) ?? readJpeg(buf);
}

// PNG signature is 8 bytes, then a 4-byte length, then the literal
// "IHDR" (4 bytes), then the 13-byte IHDR data. Width and height are
// the first 8 bytes of the IHDR data as big-endian uint32s.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buf: Buffer): ImageDimensions | undefined {
  if (buf.length < 24) return undefined;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    format: "png",
  };
}

// GIF87a / GIF89a — fixed-offset width/height in the Logical Screen
// Descriptor immediately after the 6-byte signature.
function readGif(buf: Buffer): ImageDimensions | undefined {
  if (buf.length < 10) return undefined;
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return undefined;
  return {
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
    format: "gif",
  };
}

// JPEG is a stream of segments after the SOI marker (FF D8). Each
// segment starts with FF <marker>, then for non-standalone markers a
// 2-byte big-endian length (inclusive of the length bytes themselves).
// SOF markers (FF C0..FF CF except C4 / C8 / CC) carry width/height.
function readJpeg(buf: Buffer): ImageDimensions | undefined {
  if (buf.length < 4) return undefined;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined; // not SOI
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return undefined; // marker alignment lost
    // Some encoders pad with extra FFs before the actual marker byte.
    while (i < buf.length && buf[i] === 0xff) i += 1;
    if (i >= buf.length) return undefined;
    const marker = buf[i]!;
    i += 1;
    // Standalone markers (no length / no payload): RST0..7 (D0..D7),
    // SOI (D8), EOI (D9), TEM (01). Move past them and keep scanning.
    if (
      marker === 0xd9 ||
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (i + 2 > buf.length) return undefined;
    const segmentLength = buf.readUInt16BE(i);
    if (segmentLength < 2) return undefined;
    // SOF markers — excluding DHT (C4), reserved (C8), DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // SOF payload: 1-byte precision, then height (BE u16),
      // then width (BE u16). Note JPEG stores height first.
      if (i + 7 > buf.length) return undefined;
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      if (width === 0 || height === 0) return undefined;
      return { width, height, format: "jpeg" };
    }
    i += segmentLength;
  }
  return undefined;
}
