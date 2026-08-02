import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { commentedOutCodeDetector } from "./commented-out-code.js";

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

describe("commented_out_code fingerprint uniqueness", () => {
  it("gives each comment block in a file a distinct fingerprint", async () => {
    // This detector emits one finding per block and carries no `symbol`,
    // so every finding in a file shared the fingerprint
    // `commented_out_code::<file>::`. `crimes ignore` on one therefore
    // silently suppressed all of them, and `crimes diff` conflated them.
    // On zulip that lost 135 findings; 12 blocks in a single file shared
    // one fingerprint. 0.17.0 broke the wire format to fix exactly this
    // class of bug, but only wired the discriminator into two detectors.
    const source = [
      "export const a = 1;",
      "// const legacyTotal = items.reduce((sum, i) => sum + i.price, 0);",
      "// if (legacyTotal > 100) { applyDiscount(legacyTotal); }",
      "// return legacyTotal;",
      "export const b = 2;",
      "// function oldHandler(req, res) {",
      "//   const parsed = JSON.parse(req.body);",
      "//   return res.send(parsed);",
      "// }",
      "export const c = 3;",
    ].join("\n");

    const found = await commentedOutCodeDetector.run(makeCtx(source));
    expect(found.length).toBeGreaterThanOrEqual(2);

    const discriminators = found.map((f) => f.discriminator);
    expect(discriminators.every((d) => typeof d === "string" && d.length > 0)).toBe(true);
    expect(new Set(discriminators).size).toBe(found.length);
  });

  it("keeps the discriminator stable across runs of the same source", async () => {
    const source = [
      "export const a = 1;",
      "// const legacyTotal = items.reduce((sum, i) => sum + i.price, 0);",
      "// if (legacyTotal > 100) { applyDiscount(legacyTotal); }",
      "// return legacyTotal;",
    ].join("\n");

    const first = await commentedOutCodeDetector.run(makeCtx(source));
    const second = await commentedOutCodeDetector.run(makeCtx(source));

    expect(first.map((f) => f.discriminator)).toEqual(second.map((f) => f.discriminator));
  });
});
