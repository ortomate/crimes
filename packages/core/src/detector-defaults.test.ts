import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DETECTOR_DEFAULTS,
  GENERIC_DEFAULT,
  INTRINSIC_DEFAULTS,
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

describe("agent-risk intrinsics", () => {
  it("declares an intrinsic for every detector that does not express one", () => {
    // The defect this gate exists to stop: 28 of 70 detectors set no
    // `scores.agent_risk`, so they fell back to NEUTRAL_INTRINSIC (0.30)
    // — a value *below every one of the 29 expressed agent-signal bases*,
    // which run 0.35–0.80. A detector that declined to score itself was
    // therefore ranked below the most lenient deliberate judgement ever
    // made, including `contract_drift`, which the STRUCTURAL_CEILING
    // comment names as the thing a `large_file` must not outrank.
    const missing = detectorsWithoutExpressedIntrinsic().filter(
      (id) => INTRINSIC_DEFAULTS[stripPackSuffix(id)] === undefined,
    );
    expect(
      missing,
      `these detectors express no scores.agent_risk and have no declared intrinsic — ` +
        `add one to INTRINSIC_DEFAULTS: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps every declared intrinsic inside the measured expressed band", () => {
    // Calibration is only meaningful against the values already in use.
    // Measured across the corpus at 0.22.0, expressed agent-signal bases
    // run 0.35 (boolean_naming_drift, commented_out_code) to 0.80
    // (missing_agent_context). A declared value outside that range is
    // claiming to be more or less agent-hostile than anything a detector
    // author has ever asserted, which needs its own argument.
    for (const [type, intrinsic] of Object.entries(INTRINSIC_DEFAULTS)) {
      expect(
        intrinsic,
        `${type} intrinsic below the expressed floor`,
      ).toBeGreaterThanOrEqual(0.2);
      expect(
        intrinsic,
        `${type} intrinsic above the expressed ceiling`,
      ).toBeLessThanOrEqual(0.8);
    }
  });

  it("no longer leaves a differentiated finding on the neutral fallback", () => {
    // `contract_drift` is the specific inversion recorded in
    // scoring/agent-risk-class.ts. It sets no intrinsic of its own, so
    // before this table its agent_risk was 0.4 * 0.30 + context.
    expect(getDefaultsFor("contract_drift").intrinsic).toBeGreaterThan(0.3);
  });
});

/** Mirror of `assignPackAndDetectorId`'s suffixing, in reverse. */
function stripPackSuffix(id: string): string {
  return id.replace(/\.(js|py|x)$/, "");
}

/**
 * Registered detector ids whose source never assigns `scores.agent_risk`.
 *
 * This reads the detector sources rather than carrying a hand-written
 * list, because "does this detector express an intrinsic?" is a property
 * of the source and a hand-written list cannot see a detector added
 * tomorrow — which is exactly the hole that let 28 of them accumulate.
 * The same reasoning as the fingerprint-uniqueness gate in `scan.test.ts`:
 * a policy nobody enforces is a policy that regresses.
 */
function detectorsWithoutExpressedIntrinsic(): string[] {
  const dir = resolve(import.meta.dirname, "detectors");
  const sources = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = resolve(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        sources.set(full, readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);

  const out: string[] = [];
  for (const d of [...builtInDetectors, ...builtInAssetDetectors]) {
    // Match the detector to its source by the `id:` literal it declares,
    // so a rename cannot silently drop a detector out of this gate.
    const owning = [...sources.values()].filter((src) =>
      new RegExp(`id:\\s*["'\`]${d.id.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}["'\`]`).test(
        src,
      ),
    );
    if (owning.length === 0) {
      throw new Error(
        `detector ${d.id} has no source file declaring its id — the intrinsic gate cannot see it`,
      );
    }
    if (!owning.some((src) => /agent_risk\s*:/.test(src))) out.push(d.id);
  }
  return out.sort();
}
