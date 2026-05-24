import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { directDateDetector as _directDateDetector } from "./direct-date.js";
const directDateDetector = _directDateDetector as LanguageJsDetector;

function makeCtx(
  uses: Array<{ kind: "now" | "new"; line: number }>,
  overrides: { file?: string } = {},
): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file: overrides.file ?? "src/date.ts",
    absolutePath: "/tmp/date.ts",
    source: "",
    parsed: {
      lineCount: 50,
      functions: [],
      dateNowOrNewDateUses: uses,
    },
    config: DEFAULT_CONFIG,
  };
}

describe("directDateDetector", () => {
  it("returns nothing when there are no Date uses", async () => {
    const findings = await directDateDetector.run(makeCtx([]));
    expect(findings).toEqual([]);
  });

  it("reports the count and line range", async () => {
    const findings = await directDateDetector.run(
      makeCtx([
        { kind: "now", line: 3 },
        { kind: "new", line: 17 },
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lines).toEqual([3, 17]);
    expect(findings[0]!.summary).toMatch(/2 direct uses/);
  });

  it("ranks a single use as low", async () => {
    const findings = await directDateDetector.run(makeCtx([{ kind: "now", line: 5 }]));
    expect(findings[0]!.severity).toBe("low");
  });

  it("ranks 2+ uses as medium — pattern, not accident", async () => {
    const uses = Array.from({ length: 4 }, (_, i) => ({ kind: "now" as const, line: i + 1 }));
    const findings = await directDateDetector.run(makeCtx(uses));
    expect(findings[0]!.severity).toBe("medium");
  });

  it("escalates to high at 8+ uses", async () => {
    const uses = Array.from({ length: 8 }, (_, i) => ({ kind: "now" as const, line: i + 1 }));
    const findings = await directDateDetector.run(makeCtx(uses));
    expect(findings[0]!.severity).toBe("high");
  });

  it("evidence separates Date.now() from new Date() counts", async () => {
    const findings = await directDateDetector.run(
      makeCtx([
        { kind: "now", line: 1 },
        { kind: "now", line: 2 },
        { kind: "new", line: 3 },
      ]),
    );
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toContain("2× Date.now()");
    expect(evidence).toContain("1× new Date()");
  });

  it("skips emission entirely on test files (false positive in §20)", async () => {
    const uses = Array.from({ length: 5 }, (_, i) => ({
      kind: "new" as const,
      line: i + 1,
    }));
    for (const file of [
      "src/foo.test.ts",
      "src/foo.spec.tsx",
      "packages/core/src/__tests__/build.ts",
      "src/suppressions.test.ts",
    ]) {
      const findings = await directDateDetector.run(makeCtx(uses, { file }));
      expect(findings).toEqual([]);
    }
  });

  it("still emits on non-test files with date-shaped names", async () => {
    const uses = Array.from({ length: 5 }, (_, i) => ({
      kind: "new" as const,
      line: i + 1,
    }));
    const findings = await directDateDetector.run(
      makeCtx(uses, { file: "src/billing.ts" }),
    );
    expect(findings).toHaveLength(1);
  });

  it("skips explicit clock boundary modules", async () => {
    const uses = [{ kind: "new" as const, line: 1 }];
    for (const file of ["src/clock.ts", "packages/core/src/time.ts"]) {
      const findings = await directDateDetector.run(makeCtx(uses, { file }));
      expect(findings).toEqual([]);
    }
  });
});
