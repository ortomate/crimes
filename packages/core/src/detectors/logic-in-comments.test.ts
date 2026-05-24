import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { logicInCommentsDetector as _logicInCommentsDetector } from "./logic-in-comments.js";
const logicInCommentsDetector = _logicInCommentsDetector as LanguageJsDetector;

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
    const findings = await logicInCommentsDetector.run(makeCtx(source, "src/routes/billing.ts"));
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
