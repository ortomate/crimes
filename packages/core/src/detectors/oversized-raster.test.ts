import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { CrimesConfig } from "../config.js";
import type { AssetDetectorContext } from "../detector.js";
import { oversizedRasterDetector } from "./oversized-raster.js";

function makeCtx(args: {
  byteSize: number;
  file?: string;
  extension?: string;
  config?: CrimesConfig;
}): AssetDetectorContext {
  return {
    file: args.file ?? "src/assets/hero.png",
    absolutePath: `/tmp/${args.file ?? "src/assets/hero.png"}`,
    extension: args.extension ?? ".png",
    byteSize: args.byteSize,
    read: async () => Buffer.alloc(0),
    config: args.config ?? DEFAULT_CONFIG,
  };
}

describe("oversizedRasterDetector", () => {
  it("does not fire below the low threshold (200 KB default)", async () => {
    const findings = await oversizedRasterDetector.run(makeCtx({ byteSize: 100 * 1024 }));
    expect(findings).toEqual([]);
  });

  it("fires at low severity between low and medium thresholds", async () => {
    const findings = await oversizedRasterDetector.run(makeCtx({ byteSize: 300 * 1024 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.charge).toBe("Oversized Raster");
  });

  it("fires at medium severity between medium and high thresholds", async () => {
    const findings = await oversizedRasterDetector.run(makeCtx({ byteSize: 700 * 1024 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
  });

  it("fires at high severity at or above the high threshold (1000 KB)", async () => {
    const findings = await oversizedRasterDetector.run(makeCtx({ byteSize: 1_500_000 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.evidence.join(" ")).toContain("1.43 MB");
  });

  it("honours custom thresholds.assetWeight overrides", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        assetWeight: { lowKb: 50, mediumKb: 100, highKb: 200 },
      },
    };
    const findings = await oversizedRasterDetector.run(
      makeCtx({ byteSize: 60 * 1024, config }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
  });

  it("honours allowedPaths exemptions via detectors.options.oversized_raster", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: {
        ...DEFAULT_CONFIG.detectors,
        options: {
          oversized_raster: { allowedPaths: ["public/hero/"] },
        },
      },
    };
    const findings = await oversizedRasterDetector.run(
      makeCtx({
        byteSize: 2_000_000,
        file: "public/hero/banner.png",
        config,
      }),
    );
    expect(findings).toEqual([]);
  });

  it("reports the file extension in evidence", async () => {
    const findings = await oversizedRasterDetector.run(
      makeCtx({ byteSize: 800 * 1024, extension: ".jpg" }),
    );
    expect(findings[0]!.evidence.join(" ")).toContain("format: jpg");
  });
});
