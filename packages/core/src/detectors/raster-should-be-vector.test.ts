import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { CrimesConfig } from "../config.js";
import type { AssetDetectorContext } from "../detector.js";
import { rasterShouldBeVectorDetector } from "./raster-should-be-vector.js";

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
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeCtx(args: {
  buffer: Buffer;
  file?: string;
  extension?: string;
  config?: CrimesConfig;
}): AssetDetectorContext {
  return {
    file: args.file ?? "src/assets/icon.png",
    absolutePath: `/tmp/${args.file ?? "src/assets/icon.png"}`,
    extension: args.extension ?? ".png",
    byteSize: args.buffer.length,
    read: async () => args.buffer,
    config: args.config ?? DEFAULT_CONFIG,
  };
}

describe("rasterShouldBeVectorDetector", () => {
  it("fires on a 32×32 PNG (well below the default 64 threshold)", async () => {
    const findings = await rasterShouldBeVectorDetector.run(
      makeCtx({ buffer: makePng(32, 32) }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("raster_should_be_vector");
    expect(findings[0]!.charge).toBe("Icon-Sized Raster");
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.evidence.join(" ")).toContain("32 × 32");
  });

  it("fires when both dimensions are at the threshold exactly", async () => {
    const findings = await rasterShouldBeVectorDetector.run(
      makeCtx({ buffer: makePng(64, 64) }),
    );
    expect(findings).toHaveLength(1);
  });

  it("does not fire when one dimension exceeds the threshold", async () => {
    const findings = await rasterShouldBeVectorDetector.run(
      makeCtx({ buffer: makePng(64, 80) }),
    );
    expect(findings).toEqual([]);
  });

  it("does not fire on a hero-sized image", async () => {
    const findings = await rasterShouldBeVectorDetector.run(
      makeCtx({ buffer: makePng(1920, 1080) }),
    );
    expect(findings).toEqual([]);
  });

  it("skips files whose format the dimension reader cannot parse", async () => {
    const findings = await rasterShouldBeVectorDetector.run(
      makeCtx({
        buffer: Buffer.from("RIFF\x00\x00\x00\x00WEBP", "ascii"),
        extension: ".webp",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("honours a custom iconSizeMax via detectors.options", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: {
        ...DEFAULT_CONFIG.detectors,
        options: {
          raster_should_be_vector: { iconSizeMax: 128 },
        },
      },
    };
    const findings = await rasterShouldBeVectorDetector.run(
      makeCtx({ buffer: makePng(96, 96), config }),
    );
    expect(findings).toHaveLength(1);
  });

  it("honours allowedPaths exemptions", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: {
        ...DEFAULT_CONFIG.detectors,
        options: {
          raster_should_be_vector: { allowedPaths: ["favicons/"] },
        },
      },
    };
    const findings = await rasterShouldBeVectorDetector.run(
      makeCtx({
        buffer: makePng(32, 32),
        file: "public/favicons/favicon-32.png",
        config,
      }),
    );
    expect(findings).toEqual([]);
  });
});
