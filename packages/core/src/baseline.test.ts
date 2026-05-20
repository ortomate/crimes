import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASELINE_RELATIVE_PATH,
  BaselineNotFoundError,
  checkBaseline,
  classifyAgainstBaseline,
  loadBaseline,
  MalformedBaselineError,
  saveBaseline,
  severityAtLeast,
  toBaselineEntry,
} from "./baseline.js";
import type { Baseline, BaselineEntry } from "./baseline.js";
import type { Finding } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: "crime_00001",
    type: "large_function",
    charge: "God Function",
    severity: "high",
    confidence: 0.9,
    file: "src/billing.ts",
    summary: "...",
    evidence: [],
    effort: "small",
    fix_shape: "extract pure helpers; keep the orchestrator thin",
    scores: { severity: 0.9, confidence: 0.9 },
    ...overrides,
  };
}

function bigFunctionSource(name: string): string {
  // 80-line function body, well past the 60-line default threshold.
  const body = Array.from({ length: 80 }, (_, i) => `  let v${i} = ${i};`).join(
    "\n",
  );
  return `export function ${name}() {\n${body}\n  return null;\n}\n`;
}

async function makeRepo(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), "crimes-baseline-test-"));
  return await realpath(raw);
}

describe("toBaselineEntry", () => {
  it("produces a fingerprint::type::charge::severity::file entry", () => {
    const f = makeFinding({ symbol: "doThing" });
    expect(toBaselineEntry(f)).toEqual({
      fingerprint: "large_function::src/billing.ts::doThing",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      file: "src/billing.ts",
      symbol: "doThing",
    });
  });

  it("omits symbol when absent", () => {
    const f = makeFinding({ symbol: undefined, type: "large_file", charge: "God File" });
    const entry = toBaselineEntry(f);
    expect(entry).not.toHaveProperty("symbol");
    expect(entry.fingerprint).toBe("large_file::src/billing.ts::");
  });
});

describe("classifyAgainstBaseline", () => {
  function entry(overrides: Partial<BaselineEntry>): BaselineEntry {
    return {
      fingerprint: "large_function::src/a.ts::foo",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      file: "src/a.ts",
      symbol: "foo",
      ...overrides,
    };
  }

  it("classifies a finding present in both as unchanged", () => {
    const f = makeFinding({ symbol: "foo", file: "src/a.ts" });
    const result = classifyAgainstBaseline({
      baseline: [entry({})],
      current: [f],
    });
    expect(result.unchanged_findings).toEqual([f]);
    expect(result.new_findings).toEqual([]);
    expect(result.fixed_findings).toEqual([]);
  });

  it("classifies an only-current finding as new", () => {
    const f = makeFinding({ symbol: "fresh", file: "src/a.ts" });
    const result = classifyAgainstBaseline({
      baseline: [],
      current: [f],
    });
    expect(result.new_findings).toEqual([f]);
  });

  it("classifies an only-baseline entry as fixed", () => {
    const e = entry({ symbol: "deleted", fingerprint: "large_function::src/a.ts::deleted" });
    const result = classifyAgainstBaseline({
      baseline: [e],
      current: [],
    });
    expect(result.fixed_findings).toEqual([e]);
  });

  it("treats line shifts as unchanged (lines are not part of the fingerprint)", () => {
    const e = entry({});
    const shifted = makeFinding({
      symbol: "foo",
      file: "src/a.ts",
      lines: [42, 130],
    });
    const result = classifyAgainstBaseline({
      baseline: [e],
      current: [shifted],
    });
    expect(result.unchanged_findings).toHaveLength(1);
    expect(result.new_findings).toHaveLength(0);
  });

  it("deduplicates colliding fingerprints in current", () => {
    const f = makeFinding({ symbol: "dup", file: "src/a.ts" });
    const result = classifyAgainstBaseline({
      baseline: [],
      current: [f, f],
    });
    expect(result.new_findings).toHaveLength(1);
  });
});

describe("severityAtLeast", () => {
  it("low threshold catches every severity", () => {
    expect(severityAtLeast("low", "low")).toBe(true);
    expect(severityAtLeast("medium", "low")).toBe(true);
    expect(severityAtLeast("high", "low")).toBe(true);
  });

  it("medium threshold ignores low", () => {
    expect(severityAtLeast("low", "medium")).toBe(false);
    expect(severityAtLeast("medium", "medium")).toBe(true);
    expect(severityAtLeast("high", "medium")).toBe(true);
  });

  it("high threshold only catches high", () => {
    expect(severityAtLeast("low", "high")).toBe(false);
    expect(severityAtLeast("medium", "high")).toBe(false);
    expect(severityAtLeast("high", "high")).toBe(true);
  });
});

describe("saveBaseline + loadBaseline (end-to-end against a tmp repo)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it(
    "writes a baseline to .crimes/baseline.json and reads it back",
    { timeout: 30000 },
    async () => {
      await writeFile(
        join(repo, "biggie.ts"),
        bigFunctionSource("biggie"),
        "utf8",
      );

      const FROZEN_NOW = new Date("2026-05-16T12:00:00.000Z");
      const result = await saveBaseline({
        root: repo,
        crimesVersion: "0.2.0-test",
        now: () => FROZEN_NOW,
      });

      expect(result.path).toBe(join(repo, BASELINE_RELATIVE_PATH));
      expect(result.baseline.schema_version).toBe(SCHEMA_VERSION);
      expect(result.baseline.report_type).toBe("baseline");
      expect(result.baseline.created_at).toBe("2026-05-16T12:00:00.000Z");
      expect(result.baseline.crimes_version).toBe("0.2.0-test");
      expect(result.baseline.findings.length).toBeGreaterThan(0);
      expect(
        result.baseline.findings.some((f) => f.symbol === "biggie"),
      ).toBe(true);

      const onDisk = await readFile(result.path, "utf8");
      const parsed = JSON.parse(onDisk) as Baseline;
      expect(parsed.findings).toEqual(result.baseline.findings);
      // File ends with a trailing newline — POSIX-friendly.
      expect(onDisk.endsWith("\n")).toBe(true);

      const loaded = await loadBaseline(result.path);
      expect(loaded.findings).toEqual(result.baseline.findings);
      expect(loaded.created_at).toBe("2026-05-16T12:00:00.000Z");
    },
  );

  it("loadBaseline throws BaselineNotFoundError when missing", async () => {
    const path = join(repo, BASELINE_RELATIVE_PATH);
    await expect(loadBaseline(path)).rejects.toBeInstanceOf(
      BaselineNotFoundError,
    );
  });

  it("loadBaseline throws MalformedBaselineError on invalid JSON", async () => {
    const path = join(repo, BASELINE_RELATIVE_PATH);
    await mkdir(join(repo, ".crimes"), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    await expect(loadBaseline(path)).rejects.toBeInstanceOf(
      MalformedBaselineError,
    );
  });

  it("loadBaseline throws MalformedBaselineError on the wrong report_type", async () => {
    const path = join(repo, BASELINE_RELATIVE_PATH);
    await mkdir(join(repo, ".crimes"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schema_version: SCHEMA_VERSION,
        report_type: "diff",
        findings: [],
      }),
      "utf8",
    );
    await expect(loadBaseline(path)).rejects.toBeInstanceOf(
      MalformedBaselineError,
    );
  });

  it("loadBaseline throws MalformedBaselineError on a future schema_version", async () => {
    const path = join(repo, BASELINE_RELATIVE_PATH);
    await mkdir(join(repo, ".crimes"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schema_version: "999.0.0",
        report_type: "baseline",
        findings: [],
      }),
      "utf8",
    );
    await expect(loadBaseline(path)).rejects.toBeInstanceOf(
      MalformedBaselineError,
    );
  });

  it("loadBaseline throws MalformedBaselineError when findings entries are malformed", async () => {
    const path = join(repo, BASELINE_RELATIVE_PATH);
    await mkdir(join(repo, ".crimes"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schema_version: SCHEMA_VERSION,
        report_type: "baseline",
        created_at: "2026-05-16T12:00:00.000Z",
        summary: { total: 0, high: 0, medium: 0, low: 0 },
        findings: [{ fingerprint: "x", type: "large_function" /* missing severity */ }],
      }),
      "utf8",
    );
    await expect(loadBaseline(path)).rejects.toBeInstanceOf(
      MalformedBaselineError,
    );
  });
});

describe("checkBaseline (end-to-end against a tmp repo)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it(
    "reports new/fixed/unchanged correctly and does not fail when nothing new is added",
    { timeout: 30000 },
    async () => {
      await writeFile(
        join(repo, "stable.ts"),
        bigFunctionSource("stableFn"),
        "utf8",
      );

      // Capture the baseline.
      await saveBaseline({ root: repo });

      // No source changes between save and check.
      const report = await checkBaseline({ root: repo });

      expect(report.schema_version).toBe(SCHEMA_VERSION);
      expect(report.report_type).toBe("baseline_check");
      expect(report.summary.new).toBe(0);
      expect(report.summary.fixed).toBe(0);
      expect(report.summary.unchanged).toBeGreaterThan(0);
      expect(report.failed).toBe(false);
      expect(report.fail_on).toBe("medium");
    },
  );

  it(
    "flags new findings and sets failed=true at the default medium threshold",
    { timeout: 30000 },
    async () => {
      await writeFile(
        join(repo, "stable.ts"),
        bigFunctionSource("stableFn"),
        "utf8",
      );

      await saveBaseline({ root: repo });

      // Introduce a new God Function — should register as a new HIGH finding.
      await writeFile(
        join(repo, "fresh.ts"),
        bigFunctionSource("freshFn"),
        "utf8",
      );

      const report = await checkBaseline({ root: repo });

      expect(report.summary.new).toBeGreaterThan(0);
      expect(
        report.new_findings.some((f) => f.symbol === "freshFn"),
      ).toBe(true);
      // 80-line body → ratio 1.38× → medium severity. Medium new findings
      // should still trip the default `failOn: "medium"` threshold.
      expect(
        report.summary.new_by_severity.medium +
          report.summary.new_by_severity.high,
      ).toBeGreaterThan(0);
      expect(report.failed).toBe(true);
    },
  );

  it(
    "reports fixed findings when a file is deleted",
    { timeout: 30000 },
    async () => {
      await writeFile(
        join(repo, "doomed.ts"),
        bigFunctionSource("doomedFn"),
        "utf8",
      );
      await saveBaseline({ root: repo });

      await rm(join(repo, "doomed.ts"));

      const report = await checkBaseline({ root: repo });
      expect(report.summary.fixed).toBeGreaterThan(0);
      expect(
        report.fixed_findings.some((f) => f.symbol === "doomedFn"),
      ).toBe(true);
      expect(report.failed).toBe(false);
    },
  );

  it(
    "--fail-on high ignores new medium findings",
    { timeout: 30000 },
    async () => {
      // Save an empty baseline.
      await saveBaseline({ root: repo });

      // Introduce a TODO-density finding only. todo_density returns medium
      // when `count >= 8` OR `ratio >= 10`, and high only when both
      // `count >= 20` AND `ratio >= 10`. Ten markers stays comfortably
      // medium.
      const todoBlock = Array.from(
        { length: 10 },
        (_, i) => `// TODO item ${i}\n`,
      ).join("");
      await writeFile(
        join(repo, "todos.ts"),
        `${todoBlock}export const x = 1;\n`,
        "utf8",
      );

      const reportMedium = await checkBaseline({
        root: repo,
        failOn: "medium",
      });
      const reportHigh = await checkBaseline({ root: repo, failOn: "high" });

      // Same set of new findings under both runs — only the verdict differs.
      expect(reportMedium.summary.new).toBe(reportHigh.summary.new);
      expect(reportMedium.summary.new_by_severity.medium).toBeGreaterThan(0);
      expect(reportMedium.summary.new_by_severity.high).toBe(0);

      expect(reportMedium.failed).toBe(true);
      expect(reportHigh.failed).toBe(false);
    },
  );

  it("throws BaselineNotFoundError when no baseline is present", async () => {
    await expect(checkBaseline({ root: repo })).rejects.toBeInstanceOf(
      BaselineNotFoundError,
    );
  });
});
