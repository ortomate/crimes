import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Finding, TriageEntry } from "@crimes/core";
import {
  buildRetriageMatcher,
  groupByClaim,
  isCiEnv,
  todayYmd,
  triageEntryFor,
} from "./triage.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "..", "dist", "index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "number") {
          resolvePromise({ stdout, stderr, exitCode: error.code });
          return;
        }
        if (error && (error as NodeJS.ErrnoException).code !== undefined) {
          resolvePromise({
            stdout,
            stderr: `${stderr}\nspawn error: ${error.message}`,
            exitCode: -1,
          });
          return;
        }
        resolvePromise({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

function makeFinding(file: string): Finding {
  // Minimal Finding stub — only the fields the matcher reads are real.
  return {
    id: "crime_00001",
    type: "large_function",
    charge: "God Function",
    severity: "high",
    confidence: "high",
    blast_radius: 1,
    churn: 0,
    test_gap: 0,
    agent_risk: 0,
    file,
    evidence: [],
    effort: "medium",
    fix_shape: "split",
  } as unknown as Finding;
}

function makeEntry(fingerprint: string, file: string): TriageEntry {
  return {
    fingerprint,
    type: "large_function",
    file,
    disposition: "wont-fix",
    reason: "legacy",
    owner: "@me",
    date: "2026-05-20",
  };
}

const SAMPLE_DOC = (entries: TriageEntry[]): string =>
  JSON.stringify({
    schema_version: "0.3.0",
    report_type: "triage",
    created_at: "2026-05-20T14:00:00Z",
    updated_at: "2026-05-20T14:00:00Z",
    entries,
  });

describe("buildRetriageMatcher", () => {
  it("returns a no-op when target is undefined", () => {
    const m = buildRetriageMatcher(undefined, []);
    expect(m(makeFinding("src/a.ts"), undefined)).toBe(false);
  });

  it("matches an exact fingerprint when one exists in the triage entries", () => {
    const fp = "large_function::src/foo.ts::doStuff";
    const entry = makeEntry(fp, "src/foo.ts");
    const m = buildRetriageMatcher(fp, [entry]);
    expect(m(makeFinding("src/foo.ts"), entry)).toBe(true);
    expect(m(makeFinding("src/foo.ts"), undefined)).toBe(false);
    expect(m(makeFinding("src/foo.ts"), makeEntry("other::x::y", "x"))).toBe(false);
  });

  it("matches by exact file path when target is not a known fingerprint", () => {
    const m = buildRetriageMatcher("src/foo.ts", []);
    expect(m(makeFinding("src/foo.ts"), undefined)).toBe(true);
    expect(m(makeFinding("src/bar.ts"), undefined)).toBe(false);
  });

  it("matches by glob when target is a glob and not a known fingerprint", () => {
    const m = buildRetriageMatcher("src/**/*.ts", []);
    expect(m(makeFinding("src/a.ts"), undefined)).toBe(true);
    expect(m(makeFinding("src/sub/b.ts"), undefined)).toBe(true);
    expect(m(makeFinding("lib/c.ts"), undefined)).toBe(false);
  });
});

describe("todayYmd", () => {
  it("zero-pads the month and day", () => {
    expect(todayYmd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("uses the provided clock", () => {
    expect(todayYmd(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("isCiEnv", () => {
  it("returns false when CI is unset", () => {
    expect(isCiEnv({})).toBe(false);
  });
  it("returns false for the explicit-not-CI overrides", () => {
    expect(isCiEnv({ CI: "" })).toBe(false);
    expect(isCiEnv({ CI: "false" })).toBe(false);
    expect(isCiEnv({ CI: "False" })).toBe(false);
    expect(isCiEnv({ CI: "0" })).toBe(false);
    expect(isCiEnv({ CI: "  false  " })).toBe(false);
  });
  it("returns true for typical CI markers", () => {
    expect(isCiEnv({ CI: "true" })).toBe(true);
    expect(isCiEnv({ CI: "1" })).toBe(true);
    // GitHub Actions / GitLab / Jenkins / Buildkite all set CI=true,
    // but some hosts set non-empty arbitrary strings — treat any
    // non-override value as CI.
    expect(isCiEnv({ CI: "github-actions" })).toBe(true);
  });
});

describe("crimes triage --list", () => {
  it("prints 'No triage entries.' when the file is absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-list-"));
    const result = await runCli(["triage", "--list"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No triage entries.");
  });

  it("lists existing entries in human format", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-list2-"));
    mkdirSync(join(tmp, ".crimes"), { recursive: true });
    writeFileSync(
      join(tmp, ".crimes", "triage.json"),
      SAMPLE_DOC([
        {
          fingerprint: "large_function::src/foo.ts::doStuff",
          type: "large_function",
          file: "src/foo.ts",
          symbol: "doStuff",
          disposition: "wont-fix",
          reason: "legacy",
          owner: "@me",
          date: "2026-05-20",
        },
      ]),
    );
    const result = await runCli(["triage", "--list"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("large_function::src/foo.ts::doStuff");
    expect(result.stdout).toContain("wont-fix");
  });

  it("--format json emits entries as JSON", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-listjson-"));
    mkdirSync(join(tmp, ".crimes"), { recursive: true });
    writeFileSync(
      join(tmp, ".crimes", "triage.json"),
      SAMPLE_DOC([
        {
          fingerprint: "large_function::src/foo.ts::doStuff",
          type: "large_function",
          file: "src/foo.ts",
          symbol: "doStuff",
          disposition: "wont-fix",
          reason: "legacy",
          owner: "@me",
          date: "2026-05-20",
        },
      ]),
    );
    const result = await runCli(["triage", "--list", "--format", "json"], tmp);
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].disposition).toBe("wont-fix");
  });
});

describe("crimes triage --apply", () => {
  it("merges entries into .crimes/triage.json", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-apply-"));
    const applyFile = join(tmp, "input.json");
    writeFileSync(
      applyFile,
      SAMPLE_DOC([
        {
          fingerprint: "large_function::src/foo.ts::doStuff",
          type: "large_function",
          file: "src/foo.ts",
          symbol: "doStuff",
          disposition: "wont-fix",
          reason: "legacy",
          owner: "@me",
          date: "2026-05-20",
        },
      ]),
    );
    const result = await runCli(["triage", "--apply", applyFile], tmp);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, ".crimes", "triage.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(tmp, ".crimes", "triage.json"), "utf8"));
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0].disposition).toBe("wont-fix");
  });

  it("rejects invalid JSON with exit 2", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-applybad-"));
    const applyFile = join(tmp, "bad.json");
    writeFileSync(applyFile, "{ not json");
    const result = await runCli(["triage", "--apply", applyFile], tmp);
    expect(result.exitCode).toBe(2);
    // parseTriage surfaces both the source label and the parse error.
    expect(result.stderr).toContain("malformed");
    expect(result.stderr).toContain("invalid JSON");
  });

  it("rejects missing --apply file with exit 2", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-applymiss-"));
    const result = await runCli(["triage", "--apply", join(tmp, "nope.json")], tmp);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not found");
  });

  it("--format json emits a structured summary", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-applyjson-"));
    const applyFile = join(tmp, "input.json");
    writeFileSync(
      applyFile,
      SAMPLE_DOC([
        {
          fingerprint: "large_function::src/foo.ts::doStuff",
          type: "large_function",
          file: "src/foo.ts",
          symbol: "doStuff",
          disposition: "wont-fix",
          reason: "legacy",
          owner: "@me",
          date: "2026-05-20",
        },
      ]),
    );
    const result = await runCli(
      ["triage", "--apply", applyFile, "--format", "json"],
      tmp,
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.applied).toBe(1);
  });
});

describe("crimes triage --clear", () => {
  it("removes a matching entry", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-clear-"));
    mkdirSync(join(tmp, ".crimes"), { recursive: true });
    writeFileSync(
      join(tmp, ".crimes", "triage.json"),
      SAMPLE_DOC([
        {
          fingerprint: "x::src/a.ts::fn",
          type: "x",
          file: "src/a.ts",
          symbol: "fn",
          disposition: "wont-fix",
          reason: "ok",
          owner: "@me",
          date: "2026-05-20",
        },
      ]),
    );
    const result = await runCli(["triage", "--clear", "x::src/a.ts::fn"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cleared");
    const written = JSON.parse(readFileSync(join(tmp, ".crimes", "triage.json"), "utf8"));
    expect(written.entries).toHaveLength(0);
  });

  it("exits 1 when no entry matches", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-clear-miss-"));
    mkdirSync(join(tmp, ".crimes"), { recursive: true });
    writeFileSync(join(tmp, ".crimes", "triage.json"), SAMPLE_DOC([]));
    const result = await runCli(["triage", "--clear", "ghost::x::y"], tmp);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no triage entry matched");
  });
});

describe("crimes triage (interactive guard)", () => {
  it("refuses to start in CI", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-tty-"));
    const result = await runCli(["triage"], tmp, { CI: "1" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("non-TTY");
  });
});

describe("groupByClaim", () => {
  const f = (type: string, claim: string | undefined, file: string): Finding =>
    ({ type, ...(claim ? { claim } : {}), file }) as Finding;

  it("separates two claims that share a type", () => {
    // The walk's whole reason for grouping: a reviewer forms a verdict
    // from the first few findings and applies it to the run. Interleaved,
    // that run spans two different questions.
    const groups = groupByClaim([
      f("weak_test_signal", "no_assertions", "a.test.ts"),
      f("weak_test_signal", "weak_assertion_matchers", "b.test.ts"),
      f("weak_test_signal", "no_assertions", "c.test.ts"),
    ]);
    expect(groups.map((g) => [g.claim, g.findings.length])).toEqual([
      ["no_assertions", 2],
      ["weak_assertion_matchers", 1],
    ]);
  });

  it("keeps two types with the same claim id apart", () => {
    // Claim ids are unique within a detector, not globally — `too_long`
    // could plausibly be reused. Grouping on the claim alone would merge
    // unrelated detectors into one verdict.
    const groups = groupByClaim([
      f("large_function", "too_long", "a.ts"),
      f("large_file", "too_long", "b.ts"),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("gives unlabelled findings a group of their own per type", () => {
    const groups = groupByClaim([
      f("todo_density", undefined, "a.ts"),
      f("todo_density", undefined, "b.ts"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.claim).toBeUndefined();
    expect(groups[0]!.findings).toHaveLength(2);
  });

  it("preserves rank order both between groups and inside them", () => {
    // Grouping must not become a re-sort: the scan already ranked these,
    // and a reviewer working top-down should still meet the highest-risk
    // group first.
    const groups = groupByClaim([
      f("large_file", undefined, "first.ts"),
      f("weak_test_signal", "no_assertions", "second.test.ts"),
      f("large_file", undefined, "third.ts"),
    ]);
    expect(groups.map((g) => g.type)).toEqual(["large_file", "weak_test_signal"]);
    expect(groups[0]!.findings.map((x) => x.file)).toEqual(["first.ts", "third.ts"]);
  });

  it("loses no findings", () => {
    const input = [
      f("weak_test_signal", "no_assertions", "a.test.ts"),
      f("weak_test_signal", "weak_assertion_matchers", "b.test.ts"),
      f("large_file", undefined, "c.ts"),
    ];
    expect(groupByClaim(input).flatMap((g) => g.findings)).toHaveLength(input.length);
  });
});

describe("triageEntryFor", () => {
  const finding = (over: Partial<Finding>): Finding =>
    ({
      type: "weak_test_signal",
      file: "test/a.test.ts",
      fingerprint: "",
      ...over,
    }) as Finding;

  it("records which claim was judged", () => {
    // Without this the triage file says only `type: "weak_test_signal"`
    // — the reading that treats one verified sample as a verdict on the
    // whole detector.
    const entry = triageEntryFor({
      finding: finding({ claim: "no_assertions" }),
      disposition: "wont-fix",
      reason: "asserts through a helper",
      owner: "@me",
      date: "2026-08-26",
    });
    expect(entry.claim).toBe("no_assertions");
  });

  it("omits claim entirely for a single-claim detector", () => {
    const entry = triageEntryFor({
      finding: finding({ type: "large_file", claim: undefined }),
      disposition: "wont-fix",
      reason: "generated",
      owner: "@me",
      date: "2026-08-26",
    });
    expect("claim" in entry).toBe(false);
  });

  it("writes the fingerprint the scanner emits, claim segment included", () => {
    const entry = triageEntryFor({
      finding: finding({ claim: "no_assertions", discriminator: "renders" }),
      disposition: "fix-now",
      reason: "real",
      owner: "@me",
      date: "2026-08-26",
    });
    expect(entry.fingerprint).toBe(
      "weak_test_signal/no_assertions::test/a.test.ts::::renders",
    );
  });
});
