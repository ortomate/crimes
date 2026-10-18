import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  describe("rasters SVG cannot replace, or whose DPI is already handled", () => {
    const fires = async (file: string, buffer: Buffer = makePng(32, 32)) =>
      (await rasterShouldBeVectorDetector.run(makeCtx({ buffer, file }))).length > 0;

    it("skips JPEGs, which are photographic", async () => {
      const jpeg = Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x20, 0x03, 0x01,
        0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      ]);
      expect(
        (
          await rasterShouldBeVectorDetector.run(
            makeCtx({ buffer: jpeg, file: "img/avatars/a.jpg", extension: ".jpg" }),
          )
        ).length,
      ).toBe(0);
    });

    it("skips animated GIFs but not still ones", async () => {
      const gif = (animated: boolean) => {
        const head = Buffer.alloc(13);
        head.write("GIF89a", 0, "ascii");
        head.writeUInt16LE(16, 6);
        head.writeUInt16LE(16, 8);
        return animated ? Buffer.concat([head, Buffer.from("!\xffNETSCAPE2.0")]) : head;
      };
      expect(await fires("img/spinner.gif", gif(true))).toBe(false);
      expect(await fires("img/still.gif", gif(false))).toBe(true);
    });

    it("skips 1px spacers and tiles", async () => {
      expect(await fires("img/divider.png", makePng(1, 20))).toBe(false);
    });

    it("skips Android density buckets, with or without other qualifiers", async () => {
      expect(await fires("app/src/main/res/drawable-xxhdpi/ic_star.png")).toBe(false);
      expect(await fires("app/src/main/res/drawable-ldrtl-hdpi/ic_back.png")).toBe(false);
      expect(await fires("app/src/main/res/mipmap-mdpi/ic_launcher.png")).toBe(false);
      expect(await fires("app/src/main/res/drawable/ic_star.png")).toBe(true);
    });

    it("skips @2x / @3x resolution variants", async () => {
      expect(await fires("img/logo@2x.png")).toBe(false);
    });

    it("skips email template assets", async () => {
      expect(await fires("web/img/email/brand/logo.png")).toBe(false);
    });
  });

  it("reports a large same-format set once, on its first member", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crimes-raster-set-"));
    const names = Array.from(
      { length: 25 },
      (_, i) => `F${String(i).padStart(2, "0")}.png`,
    );
    for (const name of names) await writeFile(join(dir, name), makePng(24, 16));
    const config = { ...DEFAULT_CONFIG };
    const results = await Promise.all(
      names.map((name) =>
        rasterShouldBeVectorDetector.run({
          ...makeCtx({ buffer: makePng(24, 16), file: `img/flags/${name}`, config }),
          absolutePath: join(dir, name),
        }),
      ),
    );
    const findings = results.flat();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe("img/flags/F00.png");
    expect(findings[0]!.evidence.join(" ")).toContain("one of 25 .png files");
  });
});
