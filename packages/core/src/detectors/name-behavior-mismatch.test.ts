import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { nameBehaviorMismatchDetector } from "./name-behavior-mismatch.js";

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

describe("nameBehaviorMismatchDetector", () => {
  it("detects safe-sounding functions that perform side effects", async () => {
    const source = `
export async function calculateInvoice(order: Order) {
  const invoice = buildInvoice(order);
  await saveInvoice(invoice);
  await sendInvoiceEmail(invoice);
  return invoice.total;
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("name_behavior_mismatch");
    expect(findings[0]!.symbol).toBe("calculateInvoice");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.join(" ")).toContain("saveInvoice");
  });

  it("ignores names that disclose mutation", async () => {
    const source = `
export async function getOrCreateUser(id: string) {
  const existing = await findUser(id);
  if (existing) return existing;
  return createUser(id);
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });

  it("ignores pure transformations", async () => {
    const source = `
export function formatLabel(value: string) {
  return value.trim().toUpperCase();
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source));
    expect(findings).toEqual([]);
  });

  it("ignores test files", async () => {
    const source = `
function calculateInvoice(order: Order) {
  saveInvoice(order);
  sendInvoiceEmail(order);
}
`;
    const findings = await nameBehaviorMismatchDetector.run(makeCtx(source, "src/billing.test.ts"));
    expect(findings).toEqual([]);
  });
});
