import { parseFile } from "@crimes/language-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { directDateDetector } from "./direct-date.js";

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
    const uses = Array.from({ length: 4 }, (_, i) => ({
      kind: "now" as const,
      line: i + 1,
    }));
    const findings = await directDateDetector.run(makeCtx(uses));
    expect(findings[0]!.severity).toBe("medium");
  });

  it("escalates to high at 8+ uses", async () => {
    const uses = Array.from({ length: 8 }, (_, i) => ({
      kind: "now" as const,
      line: i + 1,
    }));
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

/**
 * Reading time to *decide* something is not the same finding as reading
 * it to record or render something.
 *
 * Field notes from choreograph.cc: "`Temporal Recklessness` conflates
 * reading time with recording it… the genuinely risky case — time used
 * in a **branch or comparison** — is a much narrower and more valuable
 * signal", citing `JobDetail.tsx` reporting "9× Date.now(), 4× new
 * Date()" where "essentially all of it is display formatting".
 *
 * **The framing is right and that example is wrong.** Opening the file
 * found two poll timeouts:
 *
 *   if (Date.now() - startedAt >= VIDEO_POLL_TIMEOUT_MS) { … }
 *
 * which is precisely the risky shape. The count was correct; the
 * evidence just could not say which two of the thirteen mattered. So
 * the split lands in the evidence and in severity, not as a filter that
 * would have made a true finding vanish.
 */
/** Parses real source, so `usage` is classified by the parser. */
function makeSourceCtx(source: string, file = "src/poll.ts"): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/tmp/${file}`,
    source,
    parsed: parseFile({ absolutePath: `/tmp/${file}`, source }),
    config: DEFAULT_CONFIG,
  };
}

describe("directDateDetector — decide vs record", () => {
  it("classifies a timeout comparison as deciding a branch", async () => {
    const source = `
export function poll(startedAt: number) {
  if (Date.now() - startedAt >= 30_000) {
    return "timeout";
  }
  return "waiting";
}
`;
    const findings = await directDateDetector.run(makeSourceCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toMatch(/all 1 decide a branch/);
  });

  it("classifies a recorded timestamp as recording, not deciding", async () => {
    const source = `
export function complete(row: Record<string, unknown>) {
  row.completed_at = new Date().toISOString();
  row.updated_at = new Date().toISOString();
  return row;
}
`;
    const findings = await directDateDetector.run(makeSourceCtx(source));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join(" ")).toMatch(/none decide a branch/);
  });

  it("follows a local binding one hop into a comparison", async () => {
    // `const now = Date.now()` then `now > deadline` is the common
    // shape; classifying on the declaration alone would call it a
    // recorded value.
    const source = `
export function expired(deadline: number) {
  const now = Date.now();
  return now > deadline;
}
`;
    const findings = await directDateDetector.run(makeSourceCtx(source));
    expect(findings[0]!.evidence.join(" ")).toMatch(/decide a branch/);
    expect(findings[0]!.evidence.join(" ")).not.toMatch(/none decide/);
  });

  it("reports both counts when a file does each", async () => {
    const source = `
export function poll(startedAt: number, row: Record<string, unknown>) {
  row.rendered_at = new Date().toISOString();
  if (Date.now() - startedAt >= 30_000) {
    return "timeout";
  }
  return "waiting";
}
`;
    const findings = await directDateDetector.run(makeSourceCtx(source));
    const evidence = findings[0]!.evidence.join(" ");
    expect(evidence).toMatch(/1 decide a branch or comparison/);
    expect(evidence).toMatch(/1 only record or render/);
  });

  it("caps a record-only file at medium however many readings it has", async () => {
    // Ten `new Date().toISOString()` calls writing timestamp columns is
    // a real testability cost and a real finding. It is not a poll
    // timeout, and calling it `high` on volume alone is what made this
    // detector read as noise on a component that formats a lot of dates.
    const body = Array.from(
      { length: 10 },
      (_, i) => `  row.f${i} = new Date().toISOString();`,
    ).join("\n");
    const source = `
export function stamp(row: Record<string, unknown>) {
${body}
  return row;
}
`;
    const findings = await directDateDetector.run(makeSourceCtx(source));
    expect(findings[0]!.severity).toBe("medium");
  });

  it("still calls a comparison-heavy file high", async () => {
    const body = Array.from(
      { length: 10 },
      (_, i) => `  if (Date.now() > deadlines[${i}]!) return ${i};`,
    ).join("\n");
    const source = `
export function which(deadlines: number[]) {
${body}
  return -1;
}
`;
    const findings = await directDateDetector.run(makeSourceCtx(source));
    expect(findings[0]!.severity).toBe("high");
  });
});
