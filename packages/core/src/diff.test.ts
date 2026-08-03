import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDiffFailOn,
  classifyDiff,
  diff,
  InvalidDiffRangeError,
  parseDiffRange,
} from "./diff.js";
import type { DiffReport } from "./diff.js";
import { SCHEMA_VERSION } from "./finding.js";
import type { Finding } from "./finding.js";
import { NotAGitRepoError, UnknownGitRefError } from "./git/changed-files.js";

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
  const raw = await mkdtemp(join(tmpdir(), "crimes-diff-test-"));
  const dir = await realpath(raw);
  await git(dir, "init", "--initial-branch=main", "--quiet");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function bigFunctionSource(name: string): string {
  // 80-line function body, well past the 60-line default threshold.
  const body = Array.from({ length: 80 }, (_, i) => `  let v${i} = ${i};`).join("\n");
  return `export function ${name}() {\n${body}\n  return null;\n}\n`;
}

describe("parseDiffRange", () => {
  it("parses main...HEAD", () => {
    expect(parseDiffRange("main...HEAD")).toEqual({
      base: "main",
      head: "HEAD",
    });
  });

  it("parses origin/main...HEAD", () => {
    expect(parseDiffRange("origin/main...HEAD")).toEqual({
      base: "origin/main",
      head: "HEAD",
    });
  });

  it("parses tag ranges", () => {
    expect(parseDiffRange("v0.1.0...HEAD")).toEqual({
      base: "v0.1.0",
      head: "HEAD",
    });
  });

  it("parses arbitrary head refs (not just HEAD)", () => {
    expect(parseDiffRange("main...feature/foo")).toEqual({
      base: "main",
      head: "feature/foo",
    });
  });

  it("rejects an empty range", () => {
    expect(() => parseDiffRange("")).toThrow(InvalidDiffRangeError);
  });

  it("rejects a missing separator", () => {
    expect(() => parseDiffRange("main")).toThrow(InvalidDiffRangeError);
  });

  it("rejects double-dot ranges explicitly", () => {
    expect(() => parseDiffRange("main..HEAD")).toThrow(InvalidDiffRangeError);
  });

  it("rejects an empty base", () => {
    expect(() => parseDiffRange("...HEAD")).toThrow(InvalidDiffRangeError);
  });

  it("rejects an empty head", () => {
    expect(() => parseDiffRange("main...")).toThrow(InvalidDiffRangeError);
  });

  it("rejects more than three dots", () => {
    expect(() => parseDiffRange("main....HEAD")).toThrow(InvalidDiffRangeError);
  });

  it("rejects a second triple-dot separator", () => {
    expect(() => parseDiffRange("main...HEAD...other")).toThrow(InvalidDiffRangeError);
  });
});

describe("classifyDiff", () => {
  it("classifies a finding present at both refs as unchanged", () => {
    const f = makeFinding({ symbol: "doThing" });
    const result = classifyDiff({
      baseFindings: [f],
      headFindings: [f],
    });
    expect(result.unchanged_findings).toHaveLength(1);
    expect(result.new_findings).toHaveLength(0);
    expect(result.fixed_findings).toHaveLength(0);
  });

  it("classifies a finding only at head as new", () => {
    const f = makeFinding({ symbol: "doThing" });
    const result = classifyDiff({
      baseFindings: [],
      headFindings: [f],
    });
    expect(result.new_findings).toEqual([f]);
    expect(result.fixed_findings).toEqual([]);
    expect(result.unchanged_findings).toEqual([]);
  });

  it("classifies a finding only at base as fixed", () => {
    const f = makeFinding({ symbol: "doThing" });
    const result = classifyDiff({
      baseFindings: [f],
      headFindings: [],
    });
    expect(result.new_findings).toEqual([]);
    expect(result.fixed_findings).toEqual([f]);
    expect(result.unchanged_findings).toEqual([]);
  });

  it("treats line shifts as unchanged (lines are not part of identity)", () => {
    const before = makeFinding({
      symbol: "doThing",
      lines: [37, 240],
    });
    const after = makeFinding({
      symbol: "doThing",
      lines: [42, 246],
      id: "crime_00009",
    });
    const result = classifyDiff({
      baseFindings: [before],
      headFindings: [after],
    });
    expect(result.unchanged_findings).toHaveLength(1);
    expect(result.new_findings).toHaveLength(0);
    expect(result.fixed_findings).toHaveLength(0);
  });

  it("uses the head finding for unchanged entries", () => {
    const before = makeFinding({ symbol: "doThing", lines: [10, 70] });
    const after = makeFinding({
      symbol: "doThing",
      lines: [10, 80],
      evidence: ["lines 10-80 (71 lines)"],
    });
    const result = classifyDiff({
      baseFindings: [before],
      headFindings: [after],
    });
    expect(result.unchanged_findings[0]).toBe(after);
  });

  it("handles a mixed set", () => {
    const sameOnBoth = makeFinding({ symbol: "stable" });
    const fixed = makeFinding({ symbol: "deleted" });
    const fresh = makeFinding({ symbol: "added" });
    const result = classifyDiff({
      baseFindings: [sameOnBoth, fixed],
      headFindings: [sameOnBoth, fresh],
    });
    expect(result.unchanged_findings).toEqual([sameOnBoth]);
    expect(result.fixed_findings).toEqual([fixed]);
    expect(result.new_findings).toEqual([fresh]);
  });

  it("deduplicates colliding fingerprints in head", () => {
    // Edge case: two findings with the same fingerprint in head (rare —
    // e.g. nested helpers with the same name). The classifier should
    // count them once, not double-count.
    const dup = makeFinding({ symbol: "foo" });
    const result = classifyDiff({
      baseFindings: [],
      headFindings: [dup, dup],
    });
    expect(result.new_findings).toHaveLength(1);
  });
});

describe("diff (end-to-end against a real git repo)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports new, fixed, and unchanged findings across two commits", {
    timeout: 30000,
  }, async () => {
    // BASE: one large function that survives, one large function that gets
    // deleted in head.
    await writeFile(join(repo, "stable.ts"), bigFunctionSource("stableFn"), "utf8");
    await writeFile(join(repo, "deleted.ts"), bigFunctionSource("deletedFn"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "base", "--quiet");

    // HEAD: delete one file (its finding should be "fixed"), keep the
    // stable one (should be "unchanged"), and add a brand-new offender.
    await rm(join(repo, "deleted.ts"));
    await writeFile(join(repo, "new.ts"), bigFunctionSource("freshFn"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "head", "--quiet");

    const report = await diff({
      root: repo,
      base: "HEAD~1",
      head: "HEAD",
    });

    expect(report.report_type).toBe("diff");
    expect(report.schema_version).toBe(SCHEMA_VERSION);
    expect(report.base).toBe("HEAD~1");
    expect(report.head).toBe("HEAD");

    const newSymbols = report.new_findings.map((f) => f.symbol);
    const fixedSymbols = report.fixed_findings.map((f) => f.symbol);
    const unchangedSymbols = report.unchanged_findings.map((f) => f.symbol);

    expect(newSymbols).toContain("freshFn");
    expect(fixedSymbols).toContain("deletedFn");
    expect(unchangedSymbols).toContain("stableFn");

    expect(report.summary).toEqual({
      new: report.new_findings.length,
      fixed: report.fixed_findings.length,
      unchanged: report.unchanged_findings.length,
    });
  });

  it("does not mutate the working tree", { timeout: 30000 }, async () => {
    // Set up two commits.
    await writeFile(join(repo, "f.ts"), bigFunctionSource("base"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "base", "--quiet");

    await writeFile(join(repo, "f.ts"), bigFunctionSource("head"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "head", "--quiet");

    // Leave a working-tree change that diff() must not clobber.
    const dirtyContent = "// dirty\nexport const dirty = 1;\n";
    await writeFile(join(repo, "f.ts"), dirtyContent, "utf8");

    await diff({ root: repo, base: "HEAD~1", head: "HEAD" });

    const stillDirty = await readUtf8(join(repo, "f.ts"));
    expect(stillDirty).toBe(dirtyContent);

    // No uncommitted-checkout side effects, no detached HEAD.
    const { stdout: branch } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repo },
    );
    expect(branch.trim()).toBe("main");
  });

  it("returns an empty report when nothing differs", { timeout: 30000 }, async () => {
    await writeFile(join(repo, "f.ts"), bigFunctionSource("only"), "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");

    const report = await diff({ root: repo, base: "HEAD", head: "HEAD" });
    expect(report.new_findings).toEqual([]);
    expect(report.fixed_findings).toEqual([]);
    // There may or may not be findings — but they should all be unchanged.
    expect(report.summary.new).toBe(0);
    expect(report.summary.fixed).toBe(0);
  });

  it("throws NotAGitRepoError when run outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crimes-not-a-repo-"));
    try {
      await expect(
        diff({ root: dir, base: "main", head: "HEAD" }),
      ).rejects.toBeInstanceOf(NotAGitRepoError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws UnknownGitRefError for a missing base ref", async () => {
    await writeFile(join(repo, "f.ts"), "export const x = 1;\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");

    await expect(
      diff({ root: repo, base: "does-not-exist", head: "HEAD" }),
    ).rejects.toBeInstanceOf(UnknownGitRefError);
  });

  it("throws UnknownGitRefError for a missing head ref", async () => {
    await writeFile(join(repo, "f.ts"), "export const x = 1;\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init", "--quiet");

    await expect(
      diff({ root: repo, base: "HEAD", head: "does-not-exist" }),
    ).rejects.toBeInstanceOf(UnknownGitRefError);
  });
});

async function readUtf8(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf8");
}

describe("applyDiffFailOn", () => {
  function makeReport(newFindings: Finding[]): DiffReport {
    return {
      schema_version: SCHEMA_VERSION,
      report_type: "diff",
      repo: { name: "x", root: "/x" },
      base: "main",
      head: "HEAD",
      summary: { new: newFindings.length, fixed: 0, unchanged: 0 },
      new_findings: newFindings,
      fixed_findings: [],
      unchanged_findings: [],
    };
  }

  it("new-high fails on any new high finding", () => {
    const r = applyDiffFailOn(
      makeReport([makeFinding({ severity: "high" })]),
      "new-high",
    );
    expect(r.fail_on).toBe("new-high");
    expect(r.failed).toBe(true);
  });

  it("new-high passes when only mediums are new", () => {
    const r = applyDiffFailOn(
      makeReport([makeFinding({ severity: "medium" })]),
      "new-high",
    );
    expect(r.failed).toBe(false);
  });

  it("new-medium fails on a new medium finding", () => {
    const r = applyDiffFailOn(
      makeReport([makeFinding({ severity: "medium" })]),
      "new-medium",
    );
    expect(r.failed).toBe(true);
  });

  it("ignores suppressed findings on the gate", () => {
    const r = applyDiffFailOn(
      makeReport([makeFinding({ severity: "high", suppressed: true })]),
      "new-high",
    );
    expect(r.failed).toBe(false);
  });

  it("returns the input untouched apart from fail_on / failed", () => {
    const input = makeReport([makeFinding({ severity: "low" })]);
    const r = applyDiffFailOn(input, "new-high");
    expect(r.new_findings).toEqual(input.new_findings);
    expect(r.summary).toEqual(input.summary);
  });
});
