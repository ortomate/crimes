import { describe, expect, it } from "vitest";
import type { DateUse } from "@crimes/language-js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { timezoneUnsafeParseDetector } from "./timezone-unsafe-parse.js";

function makeCtx(
  uses: DateUse[],
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
      dateNowOrNewDateUses: uses,
    },
    config: DEFAULT_CONFIG,
  };
}

function unsafe(value: string, line = 1): DateUse {
  return { kind: "new", line, argKind: "string-literal", argValue: value };
}

describe("timezoneUnsafeParseDetector", () => {
  it("returns nothing on a clean file", async () => {
    const findings = await timezoneUnsafeParseDetector.run(makeCtx([]));
    expect(findings).toEqual([]);
  });

  it("flags YYYY-MM-DDTHH:MM:SS without a zone (local-time gotcha)", async () => {
    const findings = await timezoneUnsafeParseDetector.run(
      makeCtx([unsafe("2026-12-25T07:00:00", 12)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("timezone_unsafe_parse");
    expect(findings[0]!.charge).toBe("Timezone Roulette");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.lines).toEqual([12, 12]);
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain('"2026-12-25T07:00:00"');
  });

  it("flags YYYY-MM-DD date-only literals (UTC-midnight gotcha)", async () => {
    const findings = await timezoneUnsafeParseDetector.run(
      makeCtx([unsafe("2026-12-25", 5)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
  });

  it("skips literals ending in Z (explicit UTC)", async () => {
    const findings = await timezoneUnsafeParseDetector.run(
      makeCtx([unsafe("2026-12-25T07:00:00Z", 5)]),
    );
    expect(findings).toEqual([]);
  });

  it("skips literals with a numeric offset", async () => {
    for (const value of [
      "2026-12-25T07:00:00+05:30",
      "2026-12-25T07:00:00-08:00",
      "2026-12-25T07:00:00+0530",
    ]) {
      const findings = await timezoneUnsafeParseDetector.run(
        makeCtx([unsafe(value, 1)]),
      );
      expect(findings).toEqual([]);
    }
  });

  it("skips literals with GMT/UTC + offset strings", async () => {
    const findings = await timezoneUnsafeParseDetector.run(
      makeCtx([unsafe("2026-12-25T07:00:00 GMT+0500", 1)]),
    );
    expect(findings).toEqual([]);
  });

  it("skips literals that don't look date-like at all", async () => {
    // `new Date("hello")` produces Invalid Date — different bug class.
    const findings = await timezoneUnsafeParseDetector.run(
      makeCtx([unsafe("hello world", 1)]),
    );
    expect(findings).toEqual([]);
  });

  it("skips Date.now() and other non-string args", async () => {
    const findings = await timezoneUnsafeParseDetector.run(
      makeCtx([
        { kind: "now", line: 1 },
        { kind: "new", line: 2, argKind: "none" },
        { kind: "new", line: 3, argKind: "number", argValue: "1704067200000" },
        { kind: "new", line: 4, argKind: "expression" },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("escalates to high at 5+ unsafe parses in one file", async () => {
    const uses = Array.from({ length: 5 }, (_, i) =>
      unsafe(`2026-01-0${i + 1}T12:00:00`, i + 1),
    );
    const findings = await timezoneUnsafeParseDetector.run(makeCtx(uses));
    expect(findings[0]!.severity).toBe("high");
  });

  it("evidence lists up to three sample literals + line numbers", async () => {
    const uses = [
      unsafe("2026-12-25T07:00:00", 3),
      unsafe("2027-01-01", 8),
      unsafe("2027-06-15T14:30:00", 12),
      unsafe("2027-12-25", 20),
    ];
    const findings = await timezoneUnsafeParseDetector.run(makeCtx(uses));
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain('"2026-12-25T07:00:00"');
    expect(evidence).toContain('"2027-01-01"');
    expect(evidence).toContain('"2027-06-15T14:30:00"');
    expect(evidence).toContain("…");
    expect(evidence).toMatch(/lines: 3, 8, 12, 20/);
  });

  it("skips test files (literals in fixtures aren't bugs)", async () => {
    for (const file of [
      "src/foo.test.ts",
      "src/foo.spec.tsx",
      "packages/core/src/__tests__/build.ts",
      "src/billing.spec.cjs",
    ]) {
      const findings = await timezoneUnsafeParseDetector.run(
        makeCtx([unsafe("2026-12-25T07:00:00", 1)], { file }),
      );
      expect(findings).toEqual([]);
    }
  });

  it("honours detectors.options.timezone_unsafe_parse.allowedLiterals", async () => {
    const ctx = makeCtx([
      unsafe("2026-12-25T07:00:00", 5),
      unsafe("LAUNCH_DAY_2026", 9), // hypothetical sentinel string — not flagged here, just demoing
      unsafe("2027-01-01", 12),
    ]);
    ctx.config = {
      ...ctx.config,
      detectors: {
        options: {
          timezone_unsafe_parse: {
            allowedLiterals: ["2026-12-25T07:00:00"],
          },
        },
      },
    };
    const findings = await timezoneUnsafeParseDetector.run(ctx);
    expect(findings).toHaveLength(1);
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).not.toContain("2026-12-25T07:00:00");
    expect(evidence).toContain("2027-01-01");
  });

  it("returns nothing when every literal is allowlisted", async () => {
    const ctx = makeCtx([unsafe("2026-12-25", 1)]);
    ctx.config = {
      ...ctx.config,
      detectors: {
        options: {
          timezone_unsafe_parse: { allowedLiterals: ["2026-12-25"] },
        },
      },
    };
    const findings = await timezoneUnsafeParseDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("declares an optionsSchema the config loader can validate against", () => {
    expect(timezoneUnsafeParseDetector.optionsSchema).toBeDefined();
    const schema = timezoneUnsafeParseDetector.optionsSchema!;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ allowedLiterals: ["a", "b"] }).success).toBe(true);
    expect(schema.safeParse({ allowedLiterals: "not-an-array" }).success).toBe(false);
    expect(schema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });

  it("agent_risk grows with count but caps at 0.9", async () => {
    const single = await timezoneUnsafeParseDetector.run(
      makeCtx([unsafe("2026-12-25T07:00:00", 1)]),
    );
    const many = await timezoneUnsafeParseDetector.run(
      makeCtx(
        Array.from({ length: 10 }, (_, i) =>
          unsafe(`2026-01-0${i + 1}T12:00:00`, i + 1),
        ),
      ),
    );
    expect(single[0]!.scores!.agent_risk).toBeLessThan(many[0]!.scores!.agent_risk!);
    expect(many[0]!.scores!.agent_risk).toBeLessThanOrEqual(0.9);
  });
});
