import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Finding, TriageEntry } from "@crimes/core";
import { buildRetriageMatcher, todayYmd } from "./triage.js";

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
    schema_version: "0.2.0",
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
    expect(
      m(makeFinding("src/foo.ts"), makeEntry("other::x::y", "x")),
    ).toBe(false);
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
    const result = await runCli(
      ["triage", "--list", "--format", "json"],
      tmp,
    );
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
    const written = JSON.parse(
      readFileSync(join(tmp, ".crimes", "triage.json"), "utf8"),
    );
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0].disposition).toBe("wont-fix");
  });

  it("rejects invalid JSON with exit 2", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-applybad-"));
    const applyFile = join(tmp, "bad.json");
    writeFileSync(applyFile, "{ not json");
    const result = await runCli(["triage", "--apply", applyFile], tmp);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
  });

  it("rejects missing --apply file with exit 2", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "crimes-triage-applymiss-"));
    const result = await runCli(
      ["triage", "--apply", join(tmp, "nope.json")],
      tmp,
    );
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
    const result = await runCli(
      ["triage", "--clear", "x::src/a.ts::fn"],
      tmp,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cleared");
    const written = JSON.parse(
      readFileSync(join(tmp, ".crimes", "triage.json"), "utf8"),
    );
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
