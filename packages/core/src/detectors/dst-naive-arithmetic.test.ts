import { describe, expect, it } from "vitest";
import type { DateArithmetic } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { dstNaiveArithmeticDetector as _dstNaiveArithmeticDetector } from "./dst-naive-arithmetic.js";
const dstNaiveArithmeticDetector = _dstNaiveArithmeticDetector as LanguageJsDetector;

function makeCtx(
  hits: DateArithmetic[] | undefined,
  overrides: { file?: string } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/util.ts",
    absolutePath: "/tmp/util.ts",
    source: "",
    parsed: {
      lineCount: 50,
      functions: [],
      dateNowOrNewDateUses: [],
      dateArithmetic: hits,
    },
    config: DEFAULT_CONFIG,
  };
}

function day(line: number, kind: "add" | "subtract" = "add"): DateArithmetic {
  return { kind, line, operand: 86400000, unit: "day" };
}

describe("dstNaiveArithmeticDetector", () => {
  it("returns nothing on a clean file", async () => {
    expect(await dstNaiveArithmeticDetector.run(makeCtx([]))).toEqual([]);
    expect(await dstNaiveArithmeticDetector.run(makeCtx(undefined))).toEqual([]);
  });

  it("fires on a single day-level constant — default medium", async () => {
    const findings = await dstNaiveArithmeticDetector.run(makeCtx([day(7)]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.charge).toBe("DST-Naive Day Math");
    expect(findings[0]!.severity).toBe("medium");
  });

  it("escalates to high at 3+ hits", async () => {
    const hits = [day(1), day(2), day(3)];
    const findings = await dstNaiveArithmeticDetector.run(makeCtx(hits));
    expect(findings[0]!.severity).toBe("high");
  });

  it("escalates to high in billing / scheduling code regardless of count", async () => {
    for (const file of [
      "src/billing/invoice.ts",
      "src/scheduling/reminder.ts",
      "packages/cron/digest.ts",
      "src/payment/refund.ts",
    ]) {
      const findings = await dstNaiveArithmeticDetector.run(
        makeCtx([day(5)], { file }),
      );
      expect(findings[0]!.severity).toBe("high");
    }
  });

  it("evidence quotes the operand and unit", async () => {
    const findings = await dstNaiveArithmeticDetector.run(
      makeCtx([
        { kind: "add", line: 5, operand: 604800000, unit: "week" },
      ]),
    );
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain("604800000");
    expect(evidence).toContain("week");
  });

  it("evidence calls out sensitive paths explicitly", async () => {
    const findings = await dstNaiveArithmeticDetector.run(
      makeCtx([day(1)], { file: "src/billing/cycle.ts" }),
    );
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toMatch(/scheduling\/billing/i);
  });

  it("skips test files", async () => {
    const findings = await dstNaiveArithmeticDetector.run(
      makeCtx([day(1)], { file: "src/util.test.ts" }),
    );
    expect(findings).toEqual([]);
  });
});
