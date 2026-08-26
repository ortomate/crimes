import { describe, expect, it } from "vitest";
import { CLAIM_ATOM_PATTERN, claimAtoms, composeClaim } from "./claims.js";
import { builtInAssetDetectors, builtInDetectors } from "./detector-registry.js";
import { fingerprintFinding } from "./fingerprint.js";

/**
 * The gate that keeps "one type, one claim" true as detectors change.
 *
 * `Detector.claims` is only worth having if it cannot drift from what
 * the detectors actually emit. Everything here is a property of the
 * declared registry rather than of a particular scan, so it holds for
 * repos no fixture covers — which matters, because the corpus that
 * exposed this bug was a private 761-file monorepo and the fixtures
 * exercise `config_drift` exactly once.
 *
 * The runtime half — every emitted `finding.claim` is one the detector
 * declared — is asserted in `scan.test.ts` against a real scan.
 */

const allDetectors = [...builtInDetectors, ...builtInAssetDetectors];

describe("declared detector claims", () => {
  it("uses claim atoms that are stable, lowercase machine ids", () => {
    for (const d of allDetectors) {
      for (const claim of d.claims ?? []) {
        expect(
          CLAIM_ATOM_PATTERN.test(claim),
          `${d.id} declares claim "${claim}", which is not [a-z0-9_]+`,
        ).toBe(true);
      }
    }
  });

  it("never declares a single claim, which would be indistinguishable from none", () => {
    // A one-element list adds a fingerprint segment while removing no
    // ambiguity — except where a *sibling pack* emits the same abstract
    // `type` with other claims, which is why these are named rather than
    // banned outright. Consumers group by `type`, so once any pack makes
    // a second claim under it every pack must label.
    const crossPackSingletons = new Set([
      "large_function", // large_function.py also emits `deeply_nested`
      "direct_date", // direct_date.py also emits `naive_datetime`
      "weak_test_signal.py", // weak-test-signal.ts emits the other two
    ]);
    for (const d of allDetectors) {
      if (d.claims === undefined) continue;
      if (d.claims.length > 1 || crossPackSingletons.has(d.id)) continue;
      expect.fail(
        `${d.id} declares exactly one claim (${d.claims[0]}) and no sibling ` +
          `pack shares its type. Drop the declaration, or add the id to ` +
          `crossPackSingletons with the reason.`,
      );
    }
  });

  it("declares no duplicate atoms within one detector", () => {
    for (const d of allDetectors) {
      const claims = d.claims ?? [];
      expect(new Set(claims).size, `${d.id} declares a duplicate claim`).toBe(
        claims.length,
      );
    }
  });

  it("keeps every pack that emits a multi-claim type labelling its own claims", () => {
    // The invariant that actually protects a consumer: for any abstract
    // `type`, either no detector emitting it declares claims, or all of
    // them do. A labelled finding sitting beside an unlabelled one under
    // the same type is the ambiguity `claim` exists to remove.
    const abstractType = (id: string) => id.replace(/\.(js|py)$/, "");
    const byType = new Map<string, { id: string; declares: boolean }[]>();
    for (const d of allDetectors) {
      const key = abstractType(d.id);
      const list = byType.get(key) ?? [];
      list.push({ id: d.id, declares: d.claims !== undefined });
      byType.set(key, list);
    }
    for (const [type, members] of byType) {
      if (members.length < 2) continue;
      const declaring = members.filter((m) => m.declares);
      if (declaring.length === 0 || declaring.length === members.length) continue;
      expect.fail(
        `type "${type}" is emitted by ${members.map((m) => m.id).join(", ")} ` +
          `but only ${declaring.map((m) => m.id).join(", ")} declare claims. ` +
          `Either all packs emitting a type label their claims or none do.`,
      );
    }
  });
});

describe("composeClaim", () => {
  it("is a function of the atom set, not the order they were collected", () => {
    // The property the fingerprint depends on: if this were
    // order-sensitive, an unrelated reordering inside a detector would
    // move every fingerprint it emits and silently drop every pin.
    expect(composeClaim(["undocumented", "type_disagreement"])).toBe(
      composeClaim(["type_disagreement", "undocumented"]),
    );
  });

  it("de-duplicates repeated atoms", () => {
    expect(composeClaim(["undocumented", "undocumented"])).toBe("undocumented");
  });

  it("returns undefined for no atoms rather than an empty string", () => {
    // An empty string would reach `fingerprintFinding` as a trailing
    // separator and produce `type/::file::symbol`.
    expect(composeClaim([])).toBeUndefined();
  });

  it("round-trips through claimAtoms", () => {
    const atoms = ["boundary_bypass", "type_disagreement", "undocumented"];
    expect(claimAtoms(composeClaim(atoms))).toEqual(atoms);
  });

  it("reads an absent claim as no atoms, not as one empty atom", () => {
    expect(claimAtoms(undefined)).toEqual([]);
    expect(claimAtoms("")).toEqual([]);
  });
});

describe("fingerprints under claims", () => {
  it("separates two claims that share type, file, symbol and discriminator", () => {
    // The whole point. Before 0.8.0 these two were one fingerprint, so a
    // suppression written against the first silenced the second.
    const base = {
      type: "weak_test_signal",
      file: "test/a.test.ts",
      discriminator: "renders the plan",
    };
    expect(fingerprintFinding({ ...base, claim: "no_assertions" })).not.toBe(
      fingerprintFinding({ ...base, claim: "weak_assertion_matchers" }),
    );
  });

  it("leaves single-claim detectors on the fingerprint shape they have always had", () => {
    expect(fingerprintFinding({ type: "large_file", file: "src/a.ts" })).toBe(
      "large_file::src/a.ts::",
    );
  });

  it("puts the claim on the type segment so the discriminator stays an opaque tail", () => {
    // A discriminator may itself contain "::" — the duplicate-block
    // family hashes source text — so nothing appended after it can be
    // read back out. Hence `type/claim`, not a fifth segment.
    expect(
      fingerprintFinding({
        type: "swallowed_error",
        claim: "log_without_error",
        file: "src/a.ts",
        symbol: "load",
        discriminator: "db::query",
      }),
    ).toBe("swallowed_error/log_without_error::src/a.ts::load::db::query");
  });
});
