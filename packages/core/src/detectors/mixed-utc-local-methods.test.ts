import { describe, expect, it } from "vitest";
import type { DateMethodCall } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { mixedUtcLocalMethodsDetector } from "./mixed-utc-local-methods.js";

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

function utc(receiver: string, method: string, line: number): DateMethodCall {
  return { receiver, method, family: "utc", line, argCount: 0 };
}
function local(receiver: string, method: string, line: number): DateMethodCall {
  return { receiver, method, family: "local", line, argCount: 0 };
}

describe("mixedUtcLocalMethodsDetector", () => {
  it("returns nothing on a clean file", async () => {
    expect(await mixedUtcLocalMethodsDetector.run(makeCtx([]))).toEqual([]);
    expect(await mixedUtcLocalMethodsDetector.run(makeCtx(undefined))).toEqual([]);
  });

  it("returns nothing when all methods are one family", async () => {
    const calls = [
      utc("d", "getUTCFullYear", 2),
      utc("d", "getUTCMonth", 3),
      utc("d", "getUTCDate", 4),
    ];
    expect(await mixedUtcLocalMethodsDetector.run(makeCtx(calls))).toEqual([]);
  });

  it("fires high when one receiver mixes families", async () => {
    const findings = await mixedUtcLocalMethodsDetector.run(
      makeCtx([
        utc("d", "getUTCFullYear", 3),
        local("d", "getMonth", 5),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.charge).toBe("Half-UTC, Half-Local");
    expect(findings[0]!.lines).toEqual([3, 5]);
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain('"d" uses getUTCFullYear() @L3');
    expect(evidence).toContain("getMonth() @L5");
  });

  it("treats different receivers independently", async () => {
    const findings = await mixedUtcLocalMethodsDetector.run(
      makeCtx([
        utc("a", "getUTCFullYear", 1),
        local("b", "getMonth", 2),
      ]),
    );
    // Neither a nor b mixes — different receivers.
    expect(findings).toEqual([]);
  });

  it("lists multiple offenders in evidence", async () => {
    const findings = await mixedUtcLocalMethodsDetector.run(
      makeCtx([
        utc("a", "getUTCFullYear", 1),
        local("a", "getMonth", 2),
        utc("b", "getUTCDate", 3),
        local("b", "getHours", 4),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toMatch(/2 receivers/);
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain('"a"');
    expect(evidence).toContain('"b"');
  });

  it("skips test files", async () => {
    const calls = [utc("d", "getUTCHours", 1), local("d", "getHours", 2)];
    expect(
      await mixedUtcLocalMethodsDetector.run(
        makeCtx(calls, { file: "src/foo.test.ts" }),
      ),
    ).toEqual([]);
  });
});
