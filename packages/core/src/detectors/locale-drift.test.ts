import { describe, expect, it } from "vitest";
import type { DateMethodCall } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { localeDriftDetector } from "./locale-drift.js";

function makeCtx(
  calls: DateMethodCall[] | undefined,
  overrides: { file?: string } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/billing.ts",
    absolutePath: "/tmp/billing.ts",
    source: "",
    parsed: {
      lineCount: 50,
      functions: [],
      dateNowOrNewDateUses: [],
      dateMethodCalls: calls,
    },
    config: DEFAULT_CONFIG,
  };
}

function loc(method: string, line: number, argCount = 0): DateMethodCall {
  return { receiver: "d", method, family: "local", line, argCount };
}

describe("localeDriftDetector", () => {
  it("returns nothing on a clean file", async () => {
    expect(await localeDriftDetector.run(makeCtx([]))).toEqual([]);
    expect(await localeDriftDetector.run(makeCtx(undefined))).toEqual([]);
  });

  it("fires on toLocaleDateString() with no args", async () => {
    const findings = await localeDriftDetector.run(
      makeCtx([loc("toLocaleDateString", 5)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.charge).toBe("Host-Locale Drift");
    expect(findings[0]!.severity).toBe("low");
  });

  it("skips toLocale* calls that pass a locale argument", async () => {
    const findings = await localeDriftDetector.run(
      makeCtx([loc("toLocaleDateString", 5, 1), loc("toLocaleString", 6, 1)]),
    );
    expect(findings).toEqual([]);
  });

  it("escalates to medium in user-facing paths", async () => {
    const findings = await localeDriftDetector.run(
      makeCtx([loc("toLocaleDateString", 5)], { file: "src/components/Header.tsx" }),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("escalates to high in user-facing paths with 5+ offenders", async () => {
    const calls = Array.from({ length: 5 }, (_, i) => loc("toLocaleDateString", i + 1));
    const findings = await localeDriftDetector.run(
      makeCtx(calls, { file: "src/pages/dashboard.tsx" }),
    );
    expect(findings[0]!.severity).toBe("high");
  });

  it("escalates to medium in non-user-facing paths with 3+ offenders", async () => {
    const calls = Array.from({ length: 3 }, (_, i) => loc("toLocaleString", i + 1));
    const findings = await localeDriftDetector.run(
      makeCtx(calls, { file: "src/jobs/digest.ts" }),
    );
    expect(findings[0]!.severity).toBe("medium");
  });

  it("ignores non-locale Date methods", async () => {
    const findings = await localeDriftDetector.run(
      makeCtx([loc("getHours", 1), loc("getUTCFullYear", 2)]),
    );
    expect(findings).toEqual([]);
  });

  it("skips test files", async () => {
    const findings = await localeDriftDetector.run(
      makeCtx([loc("toLocaleDateString", 1)], { file: "src/ui/header.test.tsx" }),
    );
    expect(findings).toEqual([]);
  });
});
