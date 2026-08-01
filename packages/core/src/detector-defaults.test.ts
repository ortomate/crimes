import { describe, expect, it } from "vitest";
import {
  DETECTOR_DEFAULTS,
  GENERIC_DEFAULT,
  getDefaultsFor,
} from "./detector-defaults.js";
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
      expect(defaults.fix_shape.length, `${type} fix_shape too long`).toBeLessThanOrEqual(
        120,
      );
      expect(defaults.fix_shape, `${type} fix_shape has newline`).not.toContain("\n");
      expect(defaults.fix_shape.trim(), `${type} fix_shape empty`).not.toBe("");
      expect(["quick", "small", "medium", "large"]).toContain(defaults.effort);
    }
  });

  it("covers every registered detector id (source + asset)", () => {
    // `getDefaultsFor` is keyed on `Finding.type`, which is the abstract
    // charge — language packs qualify only the *detector* id. A Python
    // detector with `id: "large_function.py"` emits findings with
    // `type: "large_function"` and correctly picks up that type's
    // defaults, so the pack suffix is stripped before the lookup.
    const ids = new Set<string>([
      ...builtInDetectors.map((d) => stripPackSuffix(d.id)),
      ...builtInAssetDetectors.map((d) => stripPackSuffix(d.id)),
    ]);
    for (const id of ids) {
      expect(
        DETECTOR_DEFAULTS[id],
        `missing default for detector ${id} — add it to detector-defaults.ts`,
      ).toBeDefined();
    }
  });

  it("resolves defaults for a Python detector via its abstract type", () => {
    // Guards the split above: if a Python detector ever emitted its
    // qualified id as `Finding.type`, it would silently fall back to
    // GENERIC_DEFAULT instead of the charge's real effort / fix_shape.
    expect(getDefaultsFor("large_function")).not.toEqual(GENERIC_DEFAULT);
    expect(getDefaultsFor("large_function.py")).toEqual(GENERIC_DEFAULT);
  });

  it("returns GENERIC_DEFAULT for an unknown detector type", () => {
    expect(getDefaultsFor("not_a_real_detector_id")).toEqual(GENERIC_DEFAULT);
  });

  it("returns the bespoke default for a known type", () => {
    expect(getDefaultsFor("large_function").effort).toBe("small");
  });
});

/** Mirror of `assignPackAndDetectorId`'s suffixing, in reverse. */
function stripPackSuffix(id: string): string {
  return id.replace(/\.(js|py|x)$/, "");
}
