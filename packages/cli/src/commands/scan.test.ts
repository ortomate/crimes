import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerScanCommand } from "./scan.js";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
// `packages/cli/src/commands/scan.test.ts` → `packages/cli/dist/index.js`.
// The CLI must have been built (e.g. `pnpm build` or `pnpm ci`) for these
// tests to run — same precondition as `pnpm scan:example`.
const CLI = resolve(here, "..", "..", "dist", "index.js");

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

function bigSource(): string {
  return Array.from({ length: 400 }, () => "// line").join("\n");
}

function largeFunctionSource(): string {
  // Past the default 60-line function-body threshold → severity "high".
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join(
    "\n",
  );
  return `export function generateInvoice() {\n${body}\n  return 0;\n}\n`;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "number") {
          resolvePromise({ stdout, stderr, exitCode: error.code });
          return;
        }
        if (error && (error as NodeJS.ErrnoException).code !== undefined) {
          // Spawn error (binary not found, etc.) — surface as an exception.
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

async function makeChangedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-cli-fail-on-"));
  await writeFile(join(root, "untouched.ts"), "export const x = 1;\n", "utf8");
  await git(root, "init", "--initial-branch=main", "--quiet");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "init", "--quiet");
  // A new file with a "high" finding (large function past the 60-line threshold).
  await writeFile(join(root, "new.ts"), largeFunctionSource(), "utf8");
  return root;
}

async function makeChangedRepoNoFindings(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-cli-fail-on-ok-"));
  await writeFile(join(root, "seed.ts"), "export const x = 1;\n", "utf8");
  await git(root, "init", "--initial-branch=main", "--quiet");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "init", "--quiet");
  // A trivial new file — no findings.
  await writeFile(join(root, "new.ts"), "export const y = 2;\n", "utf8");
  return root;
}

describe("crimes scan --changed --fail-on", () => {
  it("exits 1 when the changed set contains a finding ≥ threshold", async () => {
    const root = await makeChangedRepo();
    const result = await runCli(
      ["scan", "--changed", "--fail-on", "high", "--format", "json", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.fail_on).toBe("high");
    expect(parsed.failed).toBe(true);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings.length).toBeGreaterThan(0);
  });

  it("exits 0 when no changed-set finding meets the threshold", async () => {
    const root = await makeChangedRepoNoFindings();
    const result = await runCli(
      ["scan", "--changed", "--fail-on", "high", "--format", "json", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.fail_on).toBe("high");
    expect(parsed.failed).toBe(false);
  });

  it("emits an OK / FAILED line in human output when --fail-on is set", async () => {
    const root = await makeChangedRepo();
    const result = await runCli(
      ["scan", "--changed", "--fail-on", "high", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/FAILED:/);
  });

  it("emits an OK line when no findings meet the threshold (human)", async () => {
    const root = await makeChangedRepoNoFindings();
    const result = await runCli(
      ["scan", "--changed", "--fail-on", "high", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^OK:/m);
  });

  it("omits fail_on / failed when --fail-on is not provided", async () => {
    const root = await makeChangedRepo();
    const result = await runCli(
      ["scan", "--changed", "--format", "json", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.fail_on).toBeUndefined();
    expect(parsed.failed).toBeUndefined();
  });

  it("rejects --fail-on without --changed (exit 2)", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-cli-fail-on-misuse-"));
    await writeFile(join(root, "a.ts"), bigSource(), "utf8");
    const result = await runCli(["scan", ".", "--fail-on", "high"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--fail-on only applies when --changed/);
  });

  it("rejects unknown --fail-on values (exit 2)", async () => {
    const root = await makeChangedRepo();
    const result = await runCli(
      ["scan", "--changed", "--fail-on", "critical"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown --fail-on/);
  });

  it("respects --fail-on medium gating high findings", async () => {
    const root = await makeChangedRepo();
    const result = await runCli(
      ["scan", "--changed", "--fail-on", "medium", "--format", "json", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.fail_on).toBe("medium");
    expect(parsed.failed).toBe(true);
  });
});

describe("crimes scan — new flags", () => {
  it("declares --top, --flat, --no-recency, --show-triaged, --gate-needs-design, --gate-resurfaced, --explain-coverage", () => {
    const program = new Command();
    registerScanCommand(program);
    const scan = program.commands.find((c) => c.name() === "scan");
    expect(scan).toBeDefined();
    const opts = scan!.options.map((o) => o.long);
    expect(opts).toContain("--top");
    expect(opts).toContain("--flat");
    expect(opts).toContain("--no-recency");
    expect(opts).toContain("--show-triaged");
    expect(opts).toContain("--gate-needs-design");
    expect(opts).toContain("--gate-resurfaced");
    expect(opts).toContain("--explain-coverage");
  });
});

describe("crimes scan --explain-coverage", () => {
  it("prints a per-language coverage breakdown after the scan output", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-cli-coverage-"));
    await writeFile(join(root, "x.ts"), "const x = 1;\n", "utf8");
    await writeFile(join(root, "y.py"), "x = 1\n", "utf8");
    // Rust has no pack, so it is the one file here that stays
    // universal-only. `.py` was serving that role until 0.14.0.
    await writeFile(join(root, "z.rs"), "fn main() {}\n", "utf8");
    const result = await runCli(["scan", ".", "--explain-coverage", "--no-color"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("coverage breakdown");
    expect(result.stdout).toContain("files discovered: 3");
    expect(result.stdout).toContain("language-js");
    expect(result.stdout).toContain("language-py");
    expect(result.stdout).toContain("files with only universal coverage: 1");
  });

  it("omits the breakdown when the flag is not set", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-cli-no-coverage-"));
    await writeFile(join(root, "x.ts"), "const x = 1;\n", "utf8");
    const result = await runCli(["scan", ".", "--no-color"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("coverage breakdown");
  });
});

describe("crimes scan --show-triaged", () => {
  async function makeRepoWithTriagedFinding(): Promise<{ root: string }> {
    const root = await mkdtemp(join(tmpdir(), "crimes-cli-show-triaged-"));
    await writeFile(join(root, "src.ts"), largeFunctionSource(), "utf8");
    // Locate the finding fingerprint via a quick scan-as-tool.
    const probe = await runCli(["scan", ".", "--format", "json", "--no-color"], root);
    const probeReport = JSON.parse(probe.stdout) as {
      findings: Array<{ type: string; file: string; symbol?: string }>;
    };
    const target = probeReport.findings.find(
      (f) => f.type === "large_function" && f.file === "src.ts",
    );
    if (!target) throw new Error("expected large_function on src.ts in fixture");
    const print = `${target.type}::${target.file}::${target.symbol ?? ""}`;

    await mkdir(join(root, ".crimes"), { recursive: true });
    await writeFile(
      join(root, ".crimes/triage.json"),
      JSON.stringify({
        schema_version: "0.3.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: print,
            type: target.type,
            file: target.file,
            ...(target.symbol ? { symbol: target.symbol } : {}),
            disposition: "wont-fix",
            reason: "legacy",
            owner: "@me",
            date: "2026-05-20",
          },
        ],
      }),
      { encoding: "utf8" },
    );
    return { root };
  }

  it("hides silenced findings by default and sets triage_hidden_count", async () => {
    const { root } = await makeRepoWithTriagedFinding();
    await mkdtemp(join(tmpdir(), "noop-")); // keep the lint happy
    const result = await runCli(["scan", ".", "--format", "json", "--no-color"], root);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(
      parsed.findings.find(
        (f: { type: string; file: string }) =>
          f.type === "large_function" && f.file === "src.ts",
      ),
    ).toBeUndefined();
    expect(parsed.triage_hidden_count).toBe(1);
  });

  it("--show-triaged keeps the finding visible with a hidden_triage annotation", async () => {
    const { root } = await makeRepoWithTriagedFinding();
    const result = await runCli(
      ["scan", ".", "--show-triaged", "--format", "json", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const hit = parsed.findings.find(
      (f: { type: string; file: string }) =>
        f.type === "large_function" && f.file === "src.ts",
    );
    expect(hit).toBeDefined();
    expect(hit.hidden_triage?.disposition).toBe("wont-fix");
    expect(parsed.triage_hidden_count).toBeUndefined();
  });
});

describe("crimes scan — resurfacing end-to-end", () => {
  // Regression for the "resurfaced findings get silenced by the triage
  // filter" bug. Sets up a git repo with a wont-fix triage entry on a
  // file, branches off main, touches that file, runs `crimes scan`, and
  // asserts the resurfaced finding reaches both the JSON and the human
  // renderer's "You're editing files you previously triaged" block.
  async function makeRepoWithResurfacingCase(): Promise<{
    root: string;
    fingerprint: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "crimes-cli-resurface-"));
    await writeFile(join(root, "src.ts"), largeFunctionSource(), "utf8");
    await git(root, "init", "--initial-branch=main", "--quiet");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "init", "--quiet");

    const probe = await runCli(["scan", ".", "--format", "json", "--no-color"], root);
    const probeReport = JSON.parse(probe.stdout) as {
      findings: Array<{ type: string; file: string; symbol?: string }>;
    };
    const target = probeReport.findings.find(
      (f) => f.type === "large_function" && f.file === "src.ts",
    );
    if (!target) throw new Error("expected large_function on src.ts in fixture");
    const fingerprint = `${target.type}::${target.file}::${target.symbol ?? ""}`;

    await mkdir(join(root, ".crimes"), { recursive: true });
    await writeFile(
      join(root, ".crimes/triage.json"),
      JSON.stringify({
        schema_version: "0.3.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint,
            type: target.type,
            file: target.file,
            ...(target.symbol ? { symbol: target.symbol } : {}),
            disposition: "wont-fix",
            reason: "legacy billing, rewrite Q3",
            owner: "@amayfield",
            date: "2026-04-12",
          },
        ],
      }),
      { encoding: "utf8" },
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "triage", "--quiet");

    // Switch to a feature branch and touch the file so it shows up in the
    // diff against resurfaceBase (default "main").
    await git(root, "checkout", "-b", "feature", "--quiet");
    await writeFile(
      join(root, "src.ts"),
      largeFunctionSource() + "\n// touched\n",
      "utf8",
    );

    return { root, fingerprint };
  }

  it(
    "resurfaces a wont-fix finding on a touched file in JSON output",
    { timeout: 30_000 },
    async () => {
      const { root, fingerprint } = await makeRepoWithResurfacingCase();
      const result = await runCli(["scan", ".", "--format", "json", "--no-color"], root);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const resurfaced = parsed.findings.find(
        (f: {
          previously_triaged?: boolean;
          previous_triage?: { disposition: string };
        }) => f.previously_triaged === true,
      );
      expect(resurfaced, JSON.stringify(parsed, null, 2)).toBeDefined();
      expect(resurfaced.previous_triage.disposition).toBe("wont-fix");
      expect(resurfaced.previous_triage.reason).toBe(
        "legacy billing, rewrite Q3",
      );
      expect(resurfaced.previous_triage.owner).toBe("@amayfield");
      // The outer scan also discovered the same fingerprint as a fresh
      // finding; the triage filter silences that fresh copy, leaving the
      // resurfaced annotation as the sole representative in findings[].
      expect(parsed.triage_hidden_count).toBe(1);
      // Sanity: fingerprint matches the triage entry we wrote.
      expect(fingerprint).toContain("large_function::src.ts");
    },
  );

  it(
    "renders the 'previously triaged' resurface block in human output",
    { timeout: 30_000 },
    async () => {
      const { root } = await makeRepoWithResurfacingCase();
      const result = await runCli(["scan", ".", "--no-color"], root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "You're editing files you previously triaged",
      );
      expect(result.stdout).toContain("wont-fix");
      expect(result.stdout).toContain("legacy billing, rewrite Q3");
      expect(result.stdout).toContain("@amayfield");
      expect(result.stdout).toContain("crimes triage --retriage src.ts");
    },
  );
});
