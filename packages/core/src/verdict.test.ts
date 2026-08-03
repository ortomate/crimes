import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { NotAGitRepoError } from "./git/changed-files.js";
import {
  judgeVerdict,
  NoDefaultBaseError,
  recommendActions,
  resolveDefaultBase,
  SEVERITY_WEIGHT,
  shouldFailVerdict,
  verdict,
} from "./verdict.js";
import type { VerdictReport } from "./verdict.js";

const execFileAsync = promisify(execFile);

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: "crime_00001",
    fingerprint: "",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
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

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "crimes-test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "crimes-test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function makeRepo(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), "crimes-verdict-test-"));
  const dir = await realpath(raw);
  await git(dir, "init", "--initial-branch=main", "--quiet");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function bigFunctionSource(name: string): string {
  // 80-line body — past the 60-line default but the resulting severity
  // depends on threshold ratios. Use only for "introduces a finding".
  const body = Array.from({ length: 80 }, (_, i) => `  let v${i} = ${i};`).join("\n");
  return `export function ${name}() {\n${body}\n  return null;\n}\n`;
}

describe("SEVERITY_WEIGHT", () => {
  it("is 3 / 2 / 1 in severity order", () => {
    expect(SEVERITY_WEIGHT.high).toBe(3);
    expect(SEVERITY_WEIGHT.medium).toBe(2);
    expect(SEVERITY_WEIGHT.low).toBe(1);
  });
});

describe("judgeVerdict", () => {
  it("returns `unchanged` when there are no new and no fixed findings", () => {
    const result = judgeVerdict({ newFindings: [], fixedFindings: [] });
    expect(result.verdict).toBe("unchanged");
    expect(result.summary.new_weighted).toBe(0);
    expect(result.summary.fixed_weighted).toBe(0);
  });

  it("returns `worse` when any new high finding exists, even if many lows were fixed", () => {
    const newHigh = makeFinding({ severity: "high", symbol: "fresh" });
    const fixedLows = [
      makeFinding({ severity: "low", symbol: "a" }),
      makeFinding({ severity: "low", symbol: "b" }),
      makeFinding({ severity: "low", symbol: "c" }),
      makeFinding({ severity: "low", symbol: "d" }),
    ];
    const result = judgeVerdict({
      newFindings: [newHigh],
      fixedFindings: fixedLows,
    });
    expect(result.verdict).toBe("worse");
    // new weighted = 3; fixed weighted = 4. Fixed is greater — but the
    // "any new high" rule still kicks in.
    expect(result.summary.new_weighted).toBe(3);
    expect(result.summary.fixed_weighted).toBe(4);
    expect(result.reasons.some((r) => r.includes("high-severity"))).toBe(true);
  });

  it("returns `worse` when new weighted > fixed weighted (no new high)", () => {
    const result = judgeVerdict({
      newFindings: [
        makeFinding({ severity: "medium", symbol: "a" }),
        makeFinding({ severity: "medium", symbol: "b" }),
      ],
      fixedFindings: [makeFinding({ severity: "medium", symbol: "c" })],
    });
    expect(result.verdict).toBe("worse");
    expect(result.summary.new_weighted).toBe(4);
    expect(result.summary.fixed_weighted).toBe(2);
  });

  it("returns `cleaner` when fixed weighted > new weighted and no new high", () => {
    const result = judgeVerdict({
      newFindings: [makeFinding({ severity: "low", symbol: "newLow" })],
      fixedFindings: [makeFinding({ severity: "medium", symbol: "fixedMed" })],
    });
    expect(result.verdict).toBe("cleaner");
    expect(result.summary.new_weighted).toBe(1);
    expect(result.summary.fixed_weighted).toBe(2);
  });

  it("returns `cleaner` when only fixed findings exist", () => {
    const result = judgeVerdict({
      newFindings: [],
      fixedFindings: [makeFinding({ severity: "high", symbol: "gone" })],
    });
    expect(result.verdict).toBe("cleaner");
  });

  it("returns `mixed` when new and fixed weighted scores are equal and non-zero", () => {
    const result = judgeVerdict({
      newFindings: [makeFinding({ severity: "medium", symbol: "newMed" })],
      fixedFindings: [makeFinding({ severity: "medium", symbol: "fixedMed" })],
    });
    expect(result.verdict).toBe("mixed");
    expect(result.summary.new_weighted).toBe(2);
    expect(result.summary.fixed_weighted).toBe(2);
  });

  it("summarises by-severity counts on both sides", () => {
    const result = judgeVerdict({
      newFindings: [
        makeFinding({ severity: "high", symbol: "n1" }),
        makeFinding({ severity: "medium", symbol: "n2" }),
      ],
      fixedFindings: [
        makeFinding({ severity: "low", symbol: "f1" }),
        makeFinding({ severity: "low", symbol: "f2" }),
      ],
    });
    expect(result.summary.new_by_severity).toEqual({
      high: 1,
      medium: 1,
      low: 0,
    });
    expect(result.summary.fixed_by_severity).toEqual({
      high: 0,
      medium: 0,
      low: 2,
    });
  });
});

describe("recommendActions", () => {
  it("recommends fixing new high findings first when the verdict is `worse` with high", () => {
    const lines = recommendActions({
      verdict: "worse",
      summary: {
        new: 1,
        fixed: 0,
        unchanged: 0,
        new_by_severity: { high: 1, medium: 0, low: 0 },
        fixed_by_severity: { high: 0, medium: 0, low: 0 },
        new_weighted: 3,
        fixed_weighted: 0,
      },
    });
    expect(lines.join(" ")).toContain("high-severity");
  });

  it("congratulates a `cleaner` branch", () => {
    const lines = recommendActions({
      verdict: "cleaner",
      summary: {
        new: 0,
        fixed: 1,
        unchanged: 0,
        new_by_severity: { high: 0, medium: 0, low: 0 },
        fixed_by_severity: { high: 0, medium: 1, low: 0 },
        new_weighted: 0,
        fixed_weighted: 2,
      },
    });
    expect(lines.join(" ").toLowerCase()).toContain("ship");
  });

  it("flags `mixed` as a trade-off", () => {
    const lines = recommendActions({
      verdict: "mixed",
      summary: {
        new: 1,
        fixed: 1,
        unchanged: 0,
        new_by_severity: { high: 0, medium: 1, low: 0 },
        fixed_by_severity: { high: 0, medium: 1, low: 0 },
        new_weighted: 2,
        fixed_weighted: 2,
      },
    });
    expect(lines.join(" ").toLowerCase()).toContain("trade-off");
  });
});

describe("shouldFailVerdict", () => {
  function makeReport(overrides: {
    verdict: VerdictReport["verdict"];
    high?: number;
    medium?: number;
    low?: number;
  }): VerdictReport {
    return {
      schema_version: SCHEMA_VERSION,
      report_type: "verdict",
      repo: { name: "x", root: "/x" },
      base: "main",
      head: "HEAD",
      verdict: overrides.verdict,
      summary: {
        new: (overrides.high ?? 0) + (overrides.medium ?? 0) + (overrides.low ?? 0),
        fixed: 0,
        unchanged: 0,
        new_by_severity: {
          high: overrides.high ?? 0,
          medium: overrides.medium ?? 0,
          low: overrides.low ?? 0,
        },
        fixed_by_severity: { high: 0, medium: 0, low: 0 },
        new_weighted: 0,
        fixed_weighted: 0,
      },
      reasons: [],
      recommended_actions: [],
      new_findings: [],
      fixed_findings: [],
    };
  }

  it("`worse` threshold fires only when verdict is `worse`", () => {
    expect(shouldFailVerdict(makeReport({ verdict: "worse" }), "worse")).toBe(true);
    expect(shouldFailVerdict(makeReport({ verdict: "cleaner" }), "worse")).toBe(false);
    expect(shouldFailVerdict(makeReport({ verdict: "unchanged" }), "worse")).toBe(false);
    expect(shouldFailVerdict(makeReport({ verdict: "mixed" }), "worse")).toBe(false);
  });

  it("`new-high` fires only when any new high finding exists", () => {
    expect(shouldFailVerdict(makeReport({ verdict: "worse", high: 1 }), "new-high")).toBe(
      true,
    );
    expect(
      shouldFailVerdict(makeReport({ verdict: "worse", medium: 5 }), "new-high"),
    ).toBe(false);
    expect(shouldFailVerdict(makeReport({ verdict: "mixed", low: 99 }), "new-high")).toBe(
      false,
    );
  });

  it("`new-medium` fires when any new medium OR high finding exists", () => {
    expect(
      shouldFailVerdict(makeReport({ verdict: "worse", medium: 1 }), "new-medium"),
    ).toBe(true);
    expect(
      shouldFailVerdict(makeReport({ verdict: "worse", high: 1 }), "new-medium"),
    ).toBe(true);
    expect(
      shouldFailVerdict(makeReport({ verdict: "mixed", low: 3 }), "new-medium"),
    ).toBe(false);
  });
});

describe("resolveDefaultBase (against a real git repo)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("prefers `main` when it exists and `origin/main` does not", async () => {
    await writeFile(join(repo, "f.ts"), "export const x = 1;\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");

    const base = await resolveDefaultBase(repo);
    expect(base).toBe("main");
  });

  it("throws NoDefaultBaseError when neither origin/main nor main resolves", async () => {
    // Brand new repo with no commits — `main` does not yet point anywhere.
    await expect(resolveDefaultBase(repo)).rejects.toBeInstanceOf(NoDefaultBaseError);
  });
});

describe("verdict (end-to-end against a real git repo)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports a `worse` verdict when a new God Function is introduced", {
    timeout: 30000,
  }, async () => {
    await writeFile(join(repo, "f.ts"), "export const x = 1;\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "base", "--quiet");

    await writeFile(join(repo, "fresh.ts"), bigFunctionSource("freshFn"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "head", "--quiet");

    const report = await verdict({ root: repo, base: "HEAD~1" });

    expect(report.report_type).toBe("verdict");
    expect(report.schema_version).toBe(SCHEMA_VERSION);
    expect(report.base).toBe("HEAD~1");
    expect(report.head).toBe("HEAD");
    expect(report.verdict).toBe("worse");
    expect(report.summary.new).toBeGreaterThan(0);
    expect(report.recommended_actions.length).toBeGreaterThan(0);
    expect(report.new_findings.some((f) => f.symbol === "freshFn")).toBe(true);
  });

  it("reports a `cleaner` verdict when a God Function is removed", {
    timeout: 30000,
  }, async () => {
    await writeFile(join(repo, "doomed.ts"), bigFunctionSource("doomedFn"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "base", "--quiet");

    await rm(join(repo, "doomed.ts"));
    await writeFile(join(repo, "still.ts"), "export const x = 1;\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "head", "--quiet");

    const report = await verdict({ root: repo, base: "HEAD~1" });
    expect(report.verdict).toBe("cleaner");
    expect(report.summary.fixed).toBeGreaterThan(0);
    expect(report.summary.new).toBe(0);
  });

  it("reports `unchanged` when nothing differs between refs", {
    timeout: 30000,
  }, async () => {
    await writeFile(join(repo, "f.ts"), "export const x = 1;\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "only", "--quiet");

    const report = await verdict({ root: repo, base: "HEAD", head: "HEAD" });
    expect(report.verdict).toBe("unchanged");
    expect(report.summary.new).toBe(0);
    expect(report.summary.fixed).toBe(0);
  });

  it("carries `unchanged` count through from the underlying diff", {
    timeout: 30000,
  }, async () => {
    await writeFile(join(repo, "stable.ts"), bigFunctionSource("stableFn"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");
    // Touch an unrelated file; the underlying detector should still match
    // the stableFn finding by fingerprint.
    await writeFile(join(repo, "other.ts"), "export const y = 2;\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "noise", "--quiet");

    const report = await verdict({ root: repo, base: "HEAD~1" });
    expect(report.summary.unchanged).toBeGreaterThan(0);
  });

  it("throws NotAGitRepoError when run outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crimes-verdict-not-repo-"));
    try {
      await expect(verdict({ root: dir })).rejects.toBeInstanceOf(NotAGitRepoError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws NoDefaultBaseError when no base is passed and origin/main / main do not resolve", async () => {
    // Fresh repo with no commits — no `main` ref exists yet.
    await expect(verdict({ root: repo })).rejects.toBeInstanceOf(NoDefaultBaseError);
  });
});
