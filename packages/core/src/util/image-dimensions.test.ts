import { describe, expect, it } from "vitest";
import { readImageDimensions } from "./image-dimensions.js";

/**
 * Build a minimal valid PNG header buffer for tests. Real PNG decoders
 * are happy with just the signature + IHDR chunk; we don't need
 * pixel data because the dimension reader only looks at the header.
 */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  // 4-byte length (13 = IHDR data length) — value ignored by reader.
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeGif(width: number, height: number, variant: "87a" | "89a" = "89a"): Buffer {
  const buf = Buffer.alloc(10);
  buf.write(`GIF${variant}`, 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function makeJpeg(width: number, height: number): Buffer {
  // SOI marker, then an SOF0 segment with the requested dimensions.
  // Segment length = 8 (2 length bytes + 1 precision + 2 height + 2 width + 1 components).
  const buf = Buffer.alloc(11);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0 marker
  buf.writeUInt16BE(8, 4); // segment length
  buf[6] = 8; // precision (bits per sample) — ignored
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

describe("readImageDimensions", () => {
  it("reads PNG dimensions", () => {
    expect(readImageDimensions(makePng(800, 600))).toEqual({
      width: 800,
      height: 600,
      format: "png",
    });
  });

  it("reads GIF87a dimensions", () => {
    expect(readImageDimensions(makeGif(48, 48, "87a"))).toEqual({
      width: 48,
      height: 48,
      format: "gif",
    });
  });

  it("reads GIF89a dimensions", () => {
    expect(readImageDimensions(makeGif(640, 480, "89a"))).toEqual({
      width: 640,
      height: 480,
      format: "gif",
    });
  });

  it("reads JPEG dimensions from a SOF0 segment", () => {
    expect(readImageDimensions(makeJpeg(1024, 768))).toEqual({
      width: 1024,
      height: 768,
      format: "jpeg",
    });
  });

  it("returns undefined for an unknown / unsupported format (e.g. WebP)", () => {
    // RIFF header — not parseable by this reader.
    const buf = Buffer.from("RIFF\x00\x00\x00\x00WEBP", "ascii");
    expect(readImageDimensions(buf)).toBeUndefined();
  });

  it("returns undefined for a truncated PNG signature", () => {
    expect(readImageDimensions(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  it("returns undefined for a non-image buffer", () => {
    expect(readImageDimensions(Buffer.from("hello world", "ascii"))).toBeUndefined();
  });

  it("returns undefined for a JPEG with no SOF marker", () => {
    // SOI but no further segments (corrupt file).
    expect(readImageDimensions(Buffer.from([0xff, 0xd8]))).toBeUndefined();
  });

  it("returns undefined for an empty buffer", () => {
    expect(readImageDimensions(Buffer.alloc(0))).toBeUndefined();
  });
});
