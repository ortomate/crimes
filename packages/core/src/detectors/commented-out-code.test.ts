import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { commentedOutCodeDetector as _commentedOutCodeDetector } from "./commented-out-code.js";
const commentedOutCodeDetector = _commentedOutCodeDetector as LanguageJsDetector;

function makeCtx(source: string): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: "src/example.ts",
    absolutePath: "/tmp/example.ts",
    source,
    parsed: parseFile({ absolutePath: "/tmp/example.ts", source }),
    config: DEFAULT_CONFIG,
  };
}

describe("commentedOutCodeDetector", () => {
  it("detects consecutive line comments that contain disabled code", async () => {
    const source = `
// const user = await getUser(id);
// if (!user) {
//   return null;
// }
// await saveUser(user);
export const active = true;
`;
    const findings = await commentedOutCodeDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("commented_out_code");
    expect(findings[0]!.lines).toEqual([2, 6]);
    expect(findings[0]!.evidence.join(" ")).toContain("const");
  });

  it("detects block comments that contain disabled code", async () => {
    const source = `
/*
const invoice = buildInvoice(order);
if (invoice.total > 0) {
  await sendInvoice(invoice);
}
*/
export const active = true;
`;
    const findings = await commentedOutCodeDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.charge).toBe("Commented-Out Corpse");
  });

  it("ignores prose comments and JSDoc examples", async () => {
    const source = `
/**
 * Formats a user-facing label.
 * @example
 * formatLabel("Team")
 */
// This explains why the next line keeps the historical label.
export const label = "Team";
`;
    const findings = await commentedOutCodeDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });
});
