import { describe, expect, it } from "vitest";
import type { AssetDetector, Detector } from "./detector.js";

describe("Detector interface", () => {
  it("requires a pack field", () => {
    const d: Detector = {
      id: "x",
      name: "X",
      description: "x",
      whyItMatters: "x",
      pack: "universal",
      run: () => [],
    };
    expect(d.pack).toBe("universal");
  });

  it("AssetDetector also requires a pack field (always 'universal')", () => {
    const d: AssetDetector = {
      id: "x_asset",
      name: "X Asset",
      description: "x",
      whyItMatters: "x",
      pack: "universal",
      extensions: [".png"],
      run: () => [],
    };
    expect(d.pack).toBe("universal");
  });
});
