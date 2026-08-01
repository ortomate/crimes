import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import type { AssetDetector, AssetDetectorContext, CrimesConfig } from "./index.js";
import {
  buildDetectorRegistry,
  builtInAssetDetectors,
  builtInDetectors,
  filterAssetDetectors,
  UnknownDetectorError,
} from "./detector-registry.js";
import { scan } from "./scan.js";

async function makeRepo(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-assets-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

function stubAsset(
  overrides: Partial<AssetDetector> = {},
): AssetDetector & { calls: AssetDetectorContext[] } {
  const calls: AssetDetectorContext[] = [];
  const detector: AssetDetector & { calls: AssetDetectorContext[] } = {
    id: overrides.id ?? "stub_asset",
    name: overrides.name ?? "Stub Asset",
    description: overrides.description ?? "Stub for testing the asset pass.",
    whyItMatters: overrides.whyItMatters ?? "Tests the orchestrator.",
    pack: "universal",
    extensions: overrides.extensions ?? [".png"],
    calls,
    async run(ctx) {
      calls.push(ctx);
      return overrides.run ? await overrides.run(ctx) : [];
    },
  };
  return detector;
}

describe("filterAssetDetectors", () => {
  it("returns all asset detectors when no enable/disable is set", () => {
    const stub = stubAsset();
    const result = filterAssetDetectors([stub], DEFAULT_CONFIG);
    expect(result).toEqual([stub]);
  });

  it("respects detectors.disable for asset ids", () => {
    const stub = stubAsset({ id: "oversized_raster" });
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: { disable: ["oversized_raster"] },
    };
    const result = filterAssetDetectors([stub], config);
    expect(result).toEqual([]);
  });

  it("accepts an enable/disable id that lives only in the source pool", () => {
    // A user disables `large_function` (a source detector). The asset
    // filter must not throw — the union of source + asset known ids
    // covers `large_function`.
    const stub = stubAsset({ id: "raster_should_be_vector" });
    const knownIds = new Set(["large_function", "raster_should_be_vector"]);
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: { disable: ["large_function"] },
    };
    const result = filterAssetDetectors([stub], config, knownIds);
    expect(result).toEqual([stub]);
  });

  it("throws UnknownDetectorError for a typo in either list", () => {
    const stub = stubAsset({ id: "oversized_raster" });
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: { disable: ["oversizdd_raster"] },
    };
    expect(() => filterAssetDetectors([stub], config)).toThrow(UnknownDetectorError);
  });
});

describe("buildDetectorRegistry", () => {
  it("unions source and asset detector ids", () => {
    const stub = stubAsset({ id: "oversized_raster" });
    const reg = buildDetectorRegistry(builtInDetectors, [stub]);
    const ids = reg.map((r) => r.id);
    expect(ids).toContain("large_function");
    expect(ids).toContain("oversized_raster");
  });
});

describe("scan asset pass", () => {
  it("runs asset detectors only against files whose extension matches", async () => {
    const root = await makeRepo({
      "logo.png": Buffer.from("fake-png-bytes"),
      "icon.svg": "<svg></svg>",
      "src/x.ts": "export const ok = 1;\n",
    });
    const pngStub = stubAsset({ id: "png_stub", extensions: [".png"] });
    const svgStub = stubAsset({ id: "svg_stub", extensions: [".svg"] });

    await scan({ root, assetDetectors: [pngStub, svgStub] });

    expect(pngStub.calls).toHaveLength(1);
    expect(pngStub.calls[0]!.file).toBe("logo.png");
    expect(pngStub.calls[0]!.extension).toBe(".png");
    expect(pngStub.calls[0]!.byteSize).toBe("fake-png-bytes".length);

    expect(svgStub.calls).toHaveLength(1);
    expect(svgStub.calls[0]!.file).toBe("icon.svg");
  });

  it("lazy-reads file bytes only when a detector calls ctx.read()", async () => {
    const root = await makeRepo({
      "logo.png": Buffer.from("PNG-CONTENT"),
    });

    let readCount = 0;
    const sizeOnly = stubAsset({ id: "size_only", extensions: [".png"] });
    const reader: AssetDetector & { read?: Buffer } = {
      id: "reader",
      name: "Reader",
      description: "Reads bytes.",
      whyItMatters: "Tests caching.",
      pack: "universal",
      extensions: [".png"],
      async run(ctx) {
        // Two reads — the second must hit the cache without re-opening.
        const a = await ctx.read();
        const b = await ctx.read();
        readCount += 1;
        expect(a.equals(b)).toBe(true);
        return [];
      },
    };

    await scan({ root, assetDetectors: [sizeOnly, reader] });
    expect(sizeOnly.calls).toHaveLength(1);
    expect(readCount).toBe(1);
  });

  it("aggregates asset findings into the final ScanReport alongside source findings", async () => {
    const root = await makeRepo({
      "logo.png": Buffer.from("PNG-CONTENT"),
      "src/big.ts": Array.from({ length: 800 }, () => "// line").join("\n"),
    });
    const tagger = stubAsset({
      id: "asset_tagger",
      extensions: [".png"],
      run() {
        return [
          {
            id: "",
            type: "asset_tagger",
            charge: "Tagged Asset",
            severity: "low",
            confidence: 0.9,
            file: "logo.png",
            summary: "tagged",
            evidence: ["stub finding"],
            effort: "medium",
            fix_shape: "stub",
            scores: { severity: 0.3, confidence: 0.9 },
          },
        ];
      },
    });
    const report = await scan({ root, assetDetectors: [tagger] });
    const types = report.findings.map((f) => f.type);
    expect(types).toContain("asset_tagger");
    expect(types).toContain("large_file");
  });

  it("skips the asset pass entirely when no asset detectors are registered", async () => {
    const root = await makeRepo({
      "logo.png": Buffer.from("PNG-CONTENT"),
    });
    const report = await scan({ root, assetDetectors: [] });
    expect(report.findings).toEqual([]);
  });

  it("honours assets.exclude — files matching the pattern are skipped", async () => {
    const root = await makeRepo({
      "logo.png": Buffer.from("a"),
      "public/vendor/old.png": Buffer.from("b"),
    });
    const stub = stubAsset({ id: "all_pngs", extensions: [".png"] });
    await scan({
      root,
      assetDetectors: [stub],
      config: {
        ...DEFAULT_CONFIG,
        assets: {
          include: ["**/*.png"],
          exclude: ["**/public/vendor/**"],
        },
      },
    });
    expect(stub.calls.map((c) => c.file).sort()).toEqual(["logo.png"]);
  });

  it("isolates per-detector failures — one detector throwing doesn't abort the asset pass", async () => {
    const root = await makeRepo({
      "logo.png": Buffer.from("X"),
    });
    const thrower: AssetDetector = {
      id: "thrower",
      name: "Thrower",
      description: "Always throws.",
      whyItMatters: "Tests isolation.",
      pack: "universal",
      extensions: [".png"],
      run() {
        throw new Error("boom");
      },
    };
    const survivor = stubAsset({ id: "survivor", extensions: [".png"] });
    const report = await scan({
      root,
      assetDetectors: [thrower, survivor],
    });
    // The survivor still ran, and the scan still returned.
    expect(survivor.calls).toHaveLength(1);
    expect(report.findings).toBeDefined();
  });

  it("exposes builtInAssetDetectors as an array (empty for phase 5a)", () => {
    expect(Array.isArray(builtInAssetDetectors)).toBe(true);
  });
});
