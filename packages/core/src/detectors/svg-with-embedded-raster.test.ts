import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { CrimesConfig } from "../config.js";
import type { AssetDetectorContext } from "../detector.js";
import { svgWithEmbeddedRasterDetector } from "./svg-with-embedded-raster.js";

function makeCtx(
  source: string,
  overrides: { file?: string; config?: CrimesConfig } = {},
): AssetDetectorContext {
  const buffer = Buffer.from(source, "utf8");
  return {
    file: overrides.file ?? "src/assets/logo.svg",
    absolutePath: `/tmp/${overrides.file ?? "src/assets/logo.svg"}`,
    extension: ".svg",
    byteSize: buffer.length,
    read: async () => buffer,
    config: overrides.config ?? DEFAULT_CONFIG,
  };
}

describe("svgWithEmbeddedRasterDetector", () => {
  it("returns nothing on a clean vector-only SVG", async () => {
    const findings = await svgWithEmbeddedRasterDetector.run(
      makeCtx('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10H0z"/></svg>'),
    );
    expect(findings).toEqual([]);
  });

  it("flags a single embedded base64 PNG", async () => {
    const findings = await svgWithEmbeddedRasterDetector.run(
      makeCtx(
        '<svg xmlns="http://www.w3.org/2000/svg">' +
          '<image href="data:image/png;base64,iVBORw0KGgo=" x="0" y="0"/>' +
          "</svg>",
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("svg_with_embedded_raster");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.join(" ")).toContain("image/png");
  });

  it("flags xlink:href variants", async () => {
    const findings = await svgWithEmbeddedRasterDetector.run(
      makeCtx(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
          '<image xlink:href="data:image/jpeg;base64,/9j/4AAQ"/>' +
          "</svg>",
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toContain("image/jpeg");
  });

  it("upgrades to high severity at 2+ embedded rasters", async () => {
    const findings = await svgWithEmbeddedRasterDetector.run(
      makeCtx(
        "<svg>" +
          '<image href="data:image/png;base64,AAAA"/>' +
          '<image href="data:image/jpeg;base64,BBBB"/>' +
          "</svg>",
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.evidence.join(" ")).toContain("image/jpeg, image/png");
  });

  it("ignores base64 data: URIs that are not inside an <image> element", async () => {
    // A pattern or feImage texture isn't the same anti-pattern.
    const findings = await svgWithEmbeddedRasterDetector.run(
      makeCtx(
        "<svg>" +
          '<defs><pattern id="p"><use href="data:image/png;base64,X"/></pattern></defs>' +
          "</svg>",
      ),
    );
    expect(findings).toEqual([]);
  });

  it("honours allowedPaths exemptions", async () => {
    const config: CrimesConfig = {
      ...DEFAULT_CONFIG,
      detectors: {
        ...DEFAULT_CONFIG.detectors,
        options: {
          svg_with_embedded_raster: { allowedPaths: ["brand-logos/"] },
        },
      },
    };
    const findings = await svgWithEmbeddedRasterDetector.run(
      makeCtx('<svg><image href="data:image/png;base64,X"/></svg>', {
        file: "src/assets/brand-logos/partner.svg",
        config,
      }),
    );
    expect(findings).toEqual([]);
  });
});
