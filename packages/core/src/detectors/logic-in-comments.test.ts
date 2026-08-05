import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { logicInCommentsDetector } from "./logic-in-comments.js";

function makeCtx(source: string, file = "src/billing.ts"): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/tmp/${file}`,
    source,
    parsed: parseFile({ absolutePath: `/tmp/${file}`, source }),
    config: DEFAULT_CONFIG,
  };
}

describe("logicInCommentsDetector", () => {
  it("detects comments that carry domain rules not visible in nearby code", async () => {
    const source = `
// Only owners can refund plans unless support approves.
export function refundAccount(accountId: string) {
  return payments.refund(accountId);
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("logic_in_comments");
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.evidence.join(" ")).toContain("owners");
  });

  it("escalates comments near route files to medium", async () => {
    const source = `
// Only admins can change billing plans and this must never be cached.
export function action() {
  return save();
}
`;
    const findings = await logicInCommentsDetector.run(
      makeCtx(source, "src/routes/billing.ts"),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("ignores ordinary explanatory comments", async () => {
    const source = `
// Keep this branch separate because the old API sends arrays.
export function normalise(value: unknown) {
  return Array.isArray(value) ? value : [value];
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });

  it("gives every comment block its own discriminator", async () => {
    // This detector carries no `symbol`, so without one every block in a
    // file shares the fingerprint `logic_in_comments::<file>::` and
    // `crimes ignore` on one silently suppresses the rest.
    const source = `
// Only owners can refund plans unless support approves.
export function refundAccount(accountId: string) {
  return payments.refund(accountId);
}

// Admins must never change the billing tier after the cutoff.
export function setTier(accountId: string) {
  return save(accountId);
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(2);
  });

  it("keys the discriminator on the comment text, not on its position", async () => {
    const rule = "// Only owners can refund plans unless support approves.";
    const bare = `
${rule}
export function refundAccount(accountId: string) {
  return payments.refund(accountId);
}
`;
    const shifted = `
// An unrelated leading comment.
${bare}`;
    const [first] = await logicInCommentsDetector.run(makeCtx(bare));
    const [second] = await logicInCommentsDetector.run(makeCtx(shifted));
    expect(second!.lines?.[0]).not.toBe(first!.lines?.[0]);
    expect(first!.discriminator).toBeDefined();
    expect(second!.discriminator).toBe(first!.discriminator);
  });

  it("ignores rules that appear represented by nearby guard names", async () => {
    const source = `
// Only owners can refund annual plans.
export function refundAccount(user: User, plan: Plan) {
  if (!isOwner(user) || !isAnnualPlan(plan)) return;
  return refund(plan);
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });
});

/**
 * Domain and rule terms must match whole words.
 *
 * Field notes from choreograph.cc named `logic_in_comments` as having
 * the worst false-positive rate of any detector — it fired on five
 * files in a repo that documents its reasoning unusually well, and
 * **none were actionable**. Re-verified against `main`: all ten hits
 * still reproduce.
 *
 * Reading the ten hits' evidence found a cause nobody had proposed.
 * `DOMAIN_TERMS` were matched with `String.includes`, so:
 *
 *   "…never required for publish). Authored by the Curator persona."
 *      → domain term "auth", from **Auth**ored
 *
 *   "…publishResult captured that outcome. If a bonus step overran…"
 *      → domain term "utc",  from o**utc**ome
 *
 * Neither file has anything to do with authentication or timezones.
 * This is trap 1 in the release plan — *never resolve a symbol by name
 * alone* — in its dumbest form: never match a domain concept by
 * substring.
 *
 * The same applies to the nearby-code check, which is what decides
 * whether a finding is emitted at all: a comment mentioning `cache`
 * next to code containing `cached` is a term the code *does* encode.
 */
describe("logicInCommentsDetector — terms match whole words", () => {
  it("does not read `auth` out of `Authored`", async () => {
    const source = `
// Panorama — 360° equirectangular bonus piece (day % 3 == 2; never
// required for publish). Authored by the Curator persona.
export interface Post {
  panorama_url?: string | null;
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toHaveLength(0);
  });

  it("does not read `utc` out of `outcome`", async () => {
    const source = `
// Final job bookkeeping. The publish gate already ran above (before
// the bonus-art steps), so a hung or slow video can no longer strand
// the post — publishResult captured that outcome. If a bonus step
// overran this function's timeout we never reach here.
export function finish() {
  return 1;
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toHaveLength(0);
  });

  it("does not read `plan` out of `explanation`", async () => {
    const source = `
// The explanation above must always be read before editing, and never
// skipped.
export function go() {
  return 1;
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toHaveLength(0);
  });

  it("still fires on a genuine whole-word domain term", async () => {
    // The guard must not silence the detector — a rule about `refund`
    // that the code does not encode is exactly what this charge is for.
    const source = `
// Only owners can refund plans unless support approves.
export function settle(accountId: string) {
  return ledger.settle(accountId);
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
  });

  it("counts a term the nearby code encodes in a different inflection", async () => {
    // "the code doesn't say `cache`" is false when the code says
    // `cached`. The nearby check decides whether a finding exists at
    // all, so a miss here is a false positive.
    const source = `
// Responses must always be cached and never served stale, except for
// the admin path.
export function read(key: string) {
  const cached = store.get(key);
  return cached ?? fetchFresh(key);
}
`;
    const findings = await logicInCommentsDetector.run(makeCtx(source));
    // `cache` is encoded nearby (as `cached`); only `admin` is missing,
    // so the finding survives but must not claim the code is silent
    // about caching. Assert on the "not found nearby" line specifically
    // — the quoted comment text also contains the word.
    const missingLine = findings
      .flatMap((f) => f.evidence)
      .find((e) => e.startsWith("domain terms not found nearby:"));
    expect(missingLine).toBeDefined();
    expect(missingLine).not.toContain("cache");
    expect(missingLine).toContain("admin");
  });
});
