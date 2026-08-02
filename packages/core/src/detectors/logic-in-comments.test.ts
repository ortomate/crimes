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
