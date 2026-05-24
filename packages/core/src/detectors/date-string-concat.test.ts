import { describe, expect, it } from "vitest";
import type { DateStringConcat } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { dateStringConcatDetector } from "./date-string-concat.js";

function makeCtx(
  hits: DateStringConcat[] | undefined,
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
      dateStringConcats: hits,
    },
    config: DEFAULT_CONFIG,
  };
}

describe("dateStringConcatDetector", () => {
  it("returns nothing on a clean file", async () => {
    expect(await dateStringConcatDetector.run(makeCtx([]))).toEqual([]);
    expect(await dateStringConcatDetector.run(makeCtx(undefined))).toEqual([]);
  });

  it("fires low on a single hand-rolled concatenation", async () => {
    const findings = await dateStringConcatDetector.run(
      makeCtx([{ line: 5, method: "getUTCFullYear" }]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.charge).toBe("Date String Sewing");
    expect(findings[0]!.severity).toBe("low");
  });

  it("escalates to medium at 3+ hits", async () => {
    const hits = [
      { line: 5, method: "getUTCFullYear" },
      { line: 6, method: "getUTCMonth" },
      { line: 7, method: "getUTCDate" },
    ];
    const findings = await dateStringConcatDetector.run(makeCtx(hits));
    expect(findings[0]!.severity).toBe("medium");
  });

  it("evidence quotes the method names involved", async () => {
    const findings = await dateStringConcatDetector.run(
      makeCtx([{ line: 5, method: "getUTCFullYear" }]),
    );
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain("getUTCFullYear");
  });

  it("skips test files", async () => {
    const findings = await dateStringConcatDetector.run(
      makeCtx([{ line: 1, method: "getUTCFullYear" }], { file: "src/util.test.ts" }),
    );
    expect(findings).toEqual([]);
  });
});
