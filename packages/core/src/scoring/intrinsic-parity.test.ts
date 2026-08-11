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
  // These two read as unported improvements and are not. Investigated in
  // 0.25.2: in both cases the condition the python base keys on has no
  // universal analogue, so there is nothing to port. What is left in each
  // is an ordinary constant gap, named here so it is not lost.
  "direct-date":
    "python's base is 0.55 when a read is naive and 0.45 otherwise; the " +
    "universal base is 0.45. NOT portable: `datetime.now()` without `tz=` " +
    "returns a naive datetime, and JavaScript has no such thing — `Date` is " +
    "always an absolute instant. The nearest JS hazard is parsing a string " +
    "with no zone marker, which is a different operation and has its own " +
    "charge (`timezone_unsafe_parse`). Residual gap for S4: cap 0.85 vs " +
    "0.88, base and step already agree.",
  "sync-io-in-hotpath":
    "python's base is 0.7 inside an `async def` and 0.5 otherwise; the " +
    "universal base is 0.55. NOT portable, and this one is a semantic trap " +
    "rather than a missing field: python's surcharge distinguishes blocking " +
    "the event loop from blocking one worker in a pool. Node has no pool — " +
    "a `readFileSync` blocks the single event loop whether or not the " +
    "enclosing function is `async`, so the same syntax would be scoring a " +
    "difference that does not exist. Residual gap for S4: base 0.55 vs " +
    "0.50 and step 0.08 vs 0.06.",
  // Both of these were shape gaps until 0.25.2 — the universal side
  // expressed no ladder at all. It now does, so what is left is a
  // constant difference, and in both cases the difference is argued
  // rather than accidental. That is the distinction this table exists to
  // hold: "nobody reconciled these" and "these two populations are not
  // the same population" look identical in a diff.
  "circular-dependency":
    "universal 0.45/0.06/0.70 vs python 0.68/0.07/0.92. The python base is " +
    "argued on ImportError at import time — a python cycle can crash at " +
    "startup depending on which module the process imports first, which a " +
    "TypeScript cycle cannot. Reconciling would mean deciding that failure " +
    "mode does not matter, which nobody has argued.",
  "deep-import":
    "universal 0.30/0.05/0.55 vs python 0.40/0.06/0.75. Different " +
    "populations rather than different opinions: the universal detector " +
    "fires only on third-party reach-in past a published surface, while " +
    "the python one also counts relative-level reach-ins and __init__.py " +
    "re-export layout.",
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
 *
 * **Empty as of `0.25.2`.** Both entries — `circular-dependency` and
 * `deep-import` — were closed by giving the universal side a ladder, and
 * moved to `KNOWN_DISAGREEMENTS` where the remaining constant gaps are
 * argued. The table stays because the gate below still runs against it,
 * and because a new one-sided detector is a thing that can happen again.
 */
const KNOWN_SHAPE_GAPS: Record<string, string> = {};

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
