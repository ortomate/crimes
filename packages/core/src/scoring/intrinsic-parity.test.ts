import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A standing gate on the *other* half of the cross-pack problem.
 *
 * `detector-defaults.test.ts` asserts that every detector expresses or
 * declares an intrinsic. It cannot see two detectors expressing
 * *different* intrinsics for the same charge, which is how 7 of the 8
 * twice-implemented charges came to disagree without anything failing —
 * `docs/dogfooding/2026-08-11-cross-pack-intrinsics.md`.
 *
 * This reads the detector sources rather than a hand-written list, for
 * the reason the intrinsic gate gives: a hand-written list cannot see a
 * detector added tomorrow, which is exactly the hole that let the
 * divergence accumulate.
 *
 * **The exceptions table below is the point of this test.** Every known
 * disagreement is listed with a reason, so it is asserted rather than
 * silent, and reconciling one means deleting a line here. A new
 * disagreement that nobody has argued for fails the build.
 */

const DETECTORS = resolve(import.meta.dirname, "..", "detectors");

interface Ladder {
  base: number | "conditional";
  step: number;
  cap: number;
}

/**
 * Charges whose two implementations knowingly disagree, each with the
 * reason it has not been reconciled. Ordered as the audit recommends
 * fixing them. Deleting an entry is how a reconciliation lands.
 */
const KNOWN_DISAGREEMENTS: Record<string, string> = {
  "weak-test-signal":
    "universal is a binary 0.68/0.58, not a ladder at all, against python's " +
    "0.32/0.045/0.72. Widest gap of the eight; needs its own argument.",
  "boolean-naming-drift":
    "python uniformly lower in floor and ceiling (0.30/0.05/0.60 vs " +
    "0.35/0.06/0.70). Ordinary drift between two hand-maintained copies.",
  "mixed-utc-local-methods":
    "same cap, python ramps at 60% the rate (0.06 vs 0.10 step).",
  "direct-date":
    "python conditions the base on a naive-parse surcharge the universal " +
    "side has no concept of. Looks like an unported improvement.",
  "sync-io-in-hotpath":
    "python conditions the base on `inAsyncHandler`; universal does not. " +
    "Looks like an unported improvement.",
};

/**
 * Same-directory twins that knowingly disagree — two detectors sharing
 * one `type`, neither of them a `py/` sibling.
 */
const KNOWN_SAME_DIR_DISAGREEMENTS: Record<string, string> = {
  commented_out_code:
    "language-js ramps 0.48 + 0.04/statement to 0.72; the universal twin " +
    "is a flat 0.35. The discriminator half of this pair was unified in " +
    "0.25.0 (both always identify a block); the intrinsic half is a " +
    "scoring change and needs its own baseline to be attributable.",
};

/**
 * Charges where one side expresses no ladder at all and takes a flat
 * value from `INTRINSIC_DEFAULTS` while the other ramps. A different
 * defect from a constant mismatch: one side cannot escalate with its own
 * evidence however much of it there is.
 */
const KNOWN_SHAPE_GAPS: Record<string, string> = {
  "circular-dependency":
    "universal expresses nothing (flat 0.45 from INTRINSIC_DEFAULTS); " +
    "python ramps 0.68→0.92. An 8-module python cycle reaches 0.92, the " +
    "identical TypeScript cycle is pinned at 0.45.",
  "deep-import":
    "universal expresses nothing (flat 0.30 — NEUTRAL_INTRINSIC itself, the " +
    "value 0.23.0 was written to stop findings falling back to); python " +
    "ramps 0.40→0.75.",
};

function readLadder(path: string): Ladder | null {
  let src: string;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // Both packs now route through one formula, so one pattern finds both:
  // intrinsicFrom(count, { base, step, cap }) and the py wrapper's
  // intrinsicFor({ count, base, step, cap }).
  const block =
    /intrinsicF(?:rom|or)\(\s*\{?[^}]*?base:\s*([^,]+),\s*step:\s*([\d.]+),\s*cap:\s*([\d.]+)/s.exec(
      src,
    );
  if (!block) return null;
  const rawBase = block[1]?.trim() ?? "";
  const base = /^[\d.]+$/.test(rawBase) ? Number(rawBase) : "conditional";
  return { base, step: Number(block[2]), cap: Number(block[3]) };
}

function charges(): string[] {
  return readdirSync(resolve(DETECTORS, "py"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .filter((f) => f !== "shared.ts")
    .map((f) => f.replace(/\.ts$/, ""));
}

/**
 * Twice-implemented charges that are **not** a `py/` pair — two
 * detectors in the same directory declaring one `type`. The first draft
 * of this gate walked `py/` only and so could not see
 * `commented_out_code`, which is one of the two pairs the audit was
 * originally written about. A gate that cannot see its own motivating
 * example is worth naming.
 */
function sameDirTwins(): Array<[string, string, string]> {
  const files = readdirSync(DETECTORS).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  const byId = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(resolve(DETECTORS, f), "utf8");
    const id = /^\s*id:\s*"([a-z_0-9]+)"/m.exec(src)?.[1];
    if (!id) continue;
    const bucket = byId.get(id);
    if (bucket) bucket.push(f);
    else byId.set(id, [f]);
  }
  const out: Array<[string, string, string]> = [];
  for (const [id, fs] of byId) {
    if (fs.length === 2) out.push([id, fs[0]!, fs[1]!]);
  }
  return out;
}

describe("cross-pack intrinsic parity", () => {
  it("finds the twice-implemented charges by reading the tree", () => {
    // If this drops to zero the gate has stopped seeing anything and
    // every assertion below passes vacuously.
    expect(charges().length).toBeGreaterThanOrEqual(8);
  });

  it("has no unexplained disagreement between two packs' ladders", () => {
    const unexplained: string[] = [];
    for (const charge of charges()) {
      if (KNOWN_DISAGREEMENTS[charge] || KNOWN_SHAPE_GAPS[charge]) continue;
      const uni = readLadder(resolve(DETECTORS, `${charge}.ts`));
      const py = readLadder(resolve(DETECTORS, "py", `${charge}.ts`));
      if (!uni || !py) continue;
      if (uni.base !== py.base || uni.step !== py.step || uni.cap !== py.cap) {
        unexplained.push(
          `${charge}: universal ${uni.base}/${uni.step}/${uni.cap} vs ` +
            `python ${py.base}/${py.step}/${py.cap}`,
        );
      }
    }
    expect(
      unexplained,
      "a charge implemented in both packs declares different ladders and is " +
        "not in KNOWN_DISAGREEMENTS. Either reconcile the two, or add an " +
        "entry saying why they differ:\n" +
        unexplained.join("\n"),
    ).toEqual([]);
  });

  it("keeps every claimed disagreement real", () => {
    // An exception that no longer describes anything is worse than no
    // exception: it documents a divergence that has silently been fixed
    // or renamed, and it suppresses the gate for a live charge.
    const stale: string[] = [];
    const known = charges();
    for (const charge of [
      ...Object.keys(KNOWN_DISAGREEMENTS),
      ...Object.keys(KNOWN_SHAPE_GAPS),
    ]) {
      if (!known.includes(charge)) stale.push(`${charge} (no such py detector)`);
    }
    expect(
      stale,
      `these entries name a charge that is no longer implemented in both ` +
        `packs — delete them: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("sees twice-implemented charges that are not a py/ pair", () => {
    const twins = sameDirTwins().map(([id]) => id);
    // commented_out_code is one of the two pairs the audit was written
    // about. The first draft of this gate walked py/ only and missed it.
    expect(twins).toContain("commented_out_code");
  });

  it("has no unexplained disagreement between same-directory twins", () => {
    const unexplained: string[] = [];
    for (const [id, a, b] of sameDirTwins()) {
      if (KNOWN_SAME_DIR_DISAGREEMENTS[id]) continue;
      const la = readLadder(resolve(DETECTORS, a));
      const lb = readLadder(resolve(DETECTORS, b));
      if (!la || !lb) continue;
      if (la.base !== lb.base || la.step !== lb.step || la.cap !== lb.cap) {
        unexplained.push(`${id}: ${a} vs ${b}`);
      }
    }
    expect(unexplained, unexplained.join("\n")).toEqual([]);
  });

  it("keeps the same-directory exceptions real too", () => {
    const ids = sameDirTwins().map(([id]) => id);
    const stale = Object.keys(KNOWN_SAME_DIR_DISAGREEMENTS).filter(
      (id) => !ids.includes(id),
    );
    expect(stale, `no longer twice-implemented: ${stale.join(", ")}`).toEqual([]);
  });

  it("still records the shape gaps as one-sided", () => {
    // The defining property of a shape gap: one side expresses no ladder
    // at all. When the universal side gains one, the entry should move to
    // KNOWN_DISAGREEMENTS or be deleted.
    for (const charge of Object.keys(KNOWN_SHAPE_GAPS)) {
      expect(
        readLadder(resolve(DETECTORS, `${charge}.ts`)),
        `${charge} now expresses a universal ladder — it is no longer a ` +
          `shape gap. Move it out of KNOWN_SHAPE_GAPS.`,
      ).toBeNull();
      expect(readLadder(resolve(DETECTORS, "py", `${charge}.ts`))).not.toBeNull();
    }
  });
});
