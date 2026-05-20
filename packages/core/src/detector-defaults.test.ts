import { describe, expect, it } from "vitest";
import { DETECTOR_DEFAULTS, GENERIC_DEFAULT, getDefaultsFor } from "./detector-defaults.js";
import { builtInDetectors, builtInAssetDetectors } from "./detector-registry.js";

describe("detector-defaults", () => {
  it("exposes a GENERIC_DEFAULT fallback for unknown detector types", () => {
    expect(GENERIC_DEFAULT.effort).toBe("medium");
    expect(GENERIC_DEFAULT.fix_shape).toMatch(/refactor/);
    expect(GENERIC_DEFAULT.fix_shape.length).toBeLessThanOrEqual(120);
    expect(GENERIC_DEFAULT.fix_shape).not.toContain("\n");
  });

  it("has a one-line fix_shape (no newlines, <=120 chars) for every detector type", () => {
    for (const [type, defaults] of Object.entries(DETECTOR_DEFAULTS)) {
      expect(defaults.fix_shape.length, `${type} fix_shape too long`).toBeLessThanOrEqual(120);
      expect(defaults.fix_shape, `${type} fix_shape has newline`).not.toContain("\n");
      expect(defaults.fix_shape.trim(), `${type} fix_shape empty`).not.toBe("");
      expect(["quick", "small", "medium", "large"]).toContain(defaults.effort);
    }
  });

  it("covers every registered detector id (source + asset)", () => {
    const ids = new Set<string>([
      ...builtInDetectors.map((d) => d.id),
      ...builtInAssetDetectors.map((d) => d.id),
    ]);
    for (const id of ids) {
      expect(
        DETECTOR_DEFAULTS[id],
        `missing default for detector ${id} — add it to detector-defaults.ts`,
      ).toBeDefined();
    }
  });

  it("returns GENERIC_DEFAULT for an unknown detector type", () => {
    expect(getDefaultsFor("not_a_real_detector_id")).toEqual(GENERIC_DEFAULT);
  });

  it("returns the bespoke default for a known type", () => {
    expect(getDefaultsFor("large_function").effort).toBe("small");
  });
});
