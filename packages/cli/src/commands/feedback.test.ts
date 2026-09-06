import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@crimes/core";

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

function largeFunctionSource(name = "generateInvoice"): string {
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  return `export function ${name}() {\n${body}\n  return 0;\n}\n`;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-feedback-"));
  await writeFile(join(root, "billing.ts"), largeFunctionSource(), "utf8");
  return root;
}

const FP = "large_function::billing.ts::generateInvoice";

describe("feedback JSON contract", () => {
  it.each(["list", "summary", "export", "recheck"])(
    "%s uses the current shared schema",
    async (command) => {
      const root = await makeRepo();
      const result = await runCli(["feedback", command, "--format", "json"], root);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.schema_version).toBe(SCHEMA_VERSION);
      expect(report.report_type).toBe(
        command === "recheck" ? "feedback_recheck" : "feedback",
      );
    },
  );
  it("append-global with JSON returns the global report and remains deduplicated", async () => {
    const root = await makeRepo();
    const global = await makeRepo();
    const env = { CRIMES_HOME: global };
    await runCli(["feedback", FP, "--verdict", "known"], root, env);
    const args = ["feedback", "export", "--append-global", "--format", "json"];
    const first = JSON.parse((await runCli(args, root, env)).stdout);
    const repeated = JSON.parse((await runCli(args, root, env)).stdout);
    expect(first.schema_version).toBe(SCHEMA_VERSION);
    expect(first.scope).toBe("global");
    expect(first.entries).toHaveLength(1);
    expect(repeated.entries).toEqual(first.entries);
  });
});

describe("crimes feedback (write)", () => {
  it("missing <fingerprint> exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requires <fingerprint-or-id>");
  });

  it("missing --verdict exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", FP], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--verdict is required");
  });

  it("--verdict fp without --note exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", FP, "--verdict", "fp"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--note is required when --verdict is fp");
  });

  it("invalid verdict exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", FP, "--verdict", "maybe"], root);
    expect(result.exitCode).toBe(2);
  });

  it("invalid fingerprint shape exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["feedback", "not-a-fingerprint", "--verdict", "tp"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("neither a per-scan id");
  });

  it("accepts a fingerprint carrying a discriminator", async () => {
    const root = await makeRepo();
    const result = await runCli(
      [
        "feedback",
        "large_function::billing.ts::describe callback::L1",
        "--verdict",
        "known",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
  });

  it("crime_NNNNN id without --file exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", "crime_00001", "--verdict", "tp"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--file <scan.json> is required");
  });

  it("--verdict fp writes a JSONL entry AND a feedback-sourced suppression", async () => {
    const root = await makeRepo();
    const result = await runCli(
      [
        "feedback",
        FP,
        "--verdict",
        "fp",
        "--note",
        "Builder pattern — DSL chain, not mixed responsibilities",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);

    const feedbackPath = join(root, ".crimes", "feedback.jsonl");
    expect(existsSync(feedbackPath)).toBe(true);
    const lines = readFileSync(feedbackPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.verdict).toBe("fp");
    expect(entry.fingerprint).toBe(FP);
    expect(entry.finding_type).toBe("large_function");
    expect(entry.note).toContain("Builder pattern");

    const suppPath = join(root, ".crimes", "suppressions.json");
    expect(existsSync(suppPath)).toBe(true);
    const doc = JSON.parse(readFileSync(suppPath, "utf8"));
    expect(doc.suppressions).toHaveLength(1);
    expect(doc.suppressions[0].source).toBe("feedback");
    expect(doc.suppressions[0].crimes_version_pinned).toMatch(/^\d+\.\d+$/);
    expect(doc.suppressions[0].reason).toContain("Builder pattern");
  });

  it("--verdict tp on a previously-fp finding removes the feedback suppression and appends a tp line", async () => {
    const root = await makeRepo();
    // First: mark fp.
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "DSL chain"], root);
    // Now: mark tp.
    const result = await runCli(
      ["feedback", FP, "--verdict", "tp", "--note", "I was wrong"],
      root,
    );
    expect(result.exitCode).toBe(0);

    const lines = readFileSync(join(root, ".crimes", "feedback.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).verdict).toBe("tp");

    const doc = JSON.parse(
      readFileSync(join(root, ".crimes", "suppressions.json"), "utf8"),
    );
    expect(doc.suppressions).toEqual([]);
  });

  it("--verdict known appends an entry but writes no suppression", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", FP, "--verdict", "known"], root);
    expect(result.exitCode).toBe(0);

    const lines = readFileSync(join(root, ".crimes", "feedback.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).verdict).toBe("known");

    expect(existsSync(join(root, ".crimes", "suppressions.json"))).toBe(false);
  });

  it("re-feedback fp on a resurfaced finding records resurfaced_from + bumps the pin", async () => {
    const root = await makeRepo();
    // Hand-craft a suppression as if it were written by an earlier minor.
    const suppDir = join(root, ".crimes");
    await writeFile(
      join(root, ".crimes", "suppressions.json").replace(
        join(root, ".crimes", "suppressions.json"),
        join(suppDir, "suppressions.json"),
      ),
      "",
      "utf8",
    ).catch(() => undefined);

    // Write it directly to bypass the CLI for setup.
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(root, ".crimes"), { recursive: true });
    await wf(
      join(root, ".crimes", "suppressions.json"),
      JSON.stringify(
        {
          schema_version: "0.3.0",
          report_type: "suppressions",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
          suppressions: [
            {
              fingerprint: FP,
              type: "large_function",
              file: "billing.ts",
              symbol: "generateInvoice",
              reason: "old reason",
              created_at: "2026-04-01T00:00:00.000Z",
              source: "feedback",
              crimes_version_pinned: "0.5",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runCli(
      ["feedback", FP, "--verdict", "fp", "--note", "still a DSL chain"],
      root,
    );
    expect(result.exitCode).toBe(0);

    const lines = readFileSync(join(root, ".crimes", "feedback.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.resurfaced_from).toBe("0.5");
    expect(entry.verdict).toBe("fp");

    // The suppression pin is bumped to the current minor.
    const doc = JSON.parse(
      readFileSync(join(root, ".crimes", "suppressions.json"), "utf8"),
    );
    expect(doc.suppressions).toHaveLength(1);
    expect(doc.suppressions[0].crimes_version_pinned).not.toBe("0.5");
  });
});

describe("crimes feedback list", () => {
  it("reports 'no feedback recorded yet' when the file is absent", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", "list"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No feedback recorded yet");
  });

  it("lists captured entries (latest verdict per fingerprint)", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "first"], root);
    await runCli(["feedback", FP, "--verdict", "tp", "--note", "I was wrong"], root);
    const result = await runCli(["feedback", "list"], root);
    expect(result.exitCode).toBe(0);
    // Only the latest verdict per fingerprint shows up — fp is shadowed by tp.
    expect(result.stdout).toContain("[tp   ]");
    expect(result.stdout).not.toMatch(/\[fp\s+\][\s\S]*large_function/);
  });

  it("--verdict filters to only the matching current verdict", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "stays fp"], root);
    const otherFp = "todo_density::billing.ts::";
    await runCli(["feedback", otherFp, "--verdict", "known"], root);
    const result = await runCli(["feedback", "list", "--verdict", "fp"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(FP);
    expect(result.stdout).not.toContain(otherFp);
  });

  it("--format json emits a FeedbackReport-shaped object", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);
    const result = await runCli(["feedback", "list", "--format", "json"], root);
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.report_type).toBe("feedback");
    expect(doc.scope).toBe("repo");
    expect(doc.entries).toHaveLength(1);
  });

  it("--since with a malformed duration exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", "list", "--since", "next-week"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--since");
  });
});

describe("crimes feedback recheck", () => {
  async function seedResurfaceableSuppression(root: string): Promise<void> {
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(root, ".crimes"), { recursive: true });
    await wf(
      join(root, ".crimes", "suppressions.json"),
      JSON.stringify(
        {
          schema_version: "0.3.0",
          report_type: "suppressions",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
          suppressions: [
            {
              fingerprint: "direct_date::src/suppressions.test.ts::",
              type: "direct_date",
              file: "src/suppressions.test.ts",
              reason: "Test-file injection — intentional",
              created_at: "2026-04-01T00:00:00.000Z",
              source: "feedback",
              crimes_version_pinned: "0.5",
            },
            {
              fingerprint: "large_function::src/x.ts::register",
              type: "large_function",
              file: "src/x.ts",
              symbol: "register",
              reason: "Commander DSL chain",
              created_at: "2026-04-01T00:00:00.000Z",
              source: "feedback",
              crimes_version_pinned: "0.5",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  it("reports nothing when there are no resurfaced suppressions", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", "recheck"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No resurfaced");
  });

  it("lists every resurfaced suppression with the release-notes hint", async () => {
    const root = await makeRepo();
    await seedResurfaceableSuppression(root);
    const result = await runCli(["feedback", "recheck"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/findings? previously marked fp/);
    expect(result.stdout).toContain("direct_date");
    expect(result.stdout).toContain("large_function");
    expect(result.stdout).toContain("Re-confirm fp:");
    expect(result.stdout).toContain("Mark resolved:");
  });

  it("--detector filters to one detector type", async () => {
    const root = await makeRepo();
    await seedResurfaceableSuppression(root);
    const result = await runCli(
      ["feedback", "recheck", "--detector", "direct_date"],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("direct_date");
    expect(result.stdout).not.toContain("large_function");
  });

  it("--format json emits structured output with reconfirm/resolve commands", async () => {
    const root = await makeRepo();
    await seedResurfaceableSuppression(root);
    const result = await runCli(["feedback", "recheck", "--format", "json"], root);
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.report_type).toBe("feedback_recheck");
    expect(doc.resurfaced).toHaveLength(2);
    expect(doc.resurfaced[0].commands.reconfirm_fp).toMatch(/--verdict fp/);
    expect(doc.resurfaced[0].commands.mark_resolved).toMatch(/--verdict tp/);
  });
});

describe("crimes feedback summary", () => {
  it("reports 'no feedback recorded yet' when the file is absent", async () => {
    const root = await makeRepo();
    const result = await runCli(["feedback", "summary"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No feedback recorded yet");
  });

  it("renders a table grouped by verdict / detector / version", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);
    await runCli(["feedback", "todo_density::billing.ts::", "--verdict", "known"], root);
    const result = await runCli(["feedback", "summary"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("By verdict:");
    expect(result.stdout).toContain("fp");
    expect(result.stdout).toContain("known");
    expect(result.stdout).toContain("By detector (top 5 by fp count):");
    expect(result.stdout).toContain("large_function");
    expect(result.stdout).toContain("By crimes_version:");
  });

  it("--format json emits FeedbackReport with summary populated", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);
    const result = await runCli(["feedback", "summary", "--format", "json"], root);
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.report_type).toBe("feedback");
    expect(doc.summary).toBeDefined();
    expect(doc.summary.total).toBe(1);
    expect(doc.summary.by_verdict.fp).toBe(1);
  });
});

describe("crimes feedback export", () => {
  it("prints local entries as JSONL by default", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);
    const result = await runCli(["feedback", "export"], root);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.fingerprint).toBe(FP);
  });

  it("--format md renders a Markdown report grouped by detector", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);
    const result = await runCli(["feedback", "export", "--format", "md"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# crimes feedback");
    expect(result.stdout).toContain("## large_function");
    expect(result.stdout).toContain("**[fp]**");
  });

  it("--format json emits FeedbackReport with entries + summary", async () => {
    const root = await makeRepo();
    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);
    const result = await runCli(["feedback", "export", "--format", "json"], root);
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.report_type).toBe("feedback");
    expect(doc.entries).toHaveLength(1);
    expect(doc.summary.by_verdict.fp).toBe(1);
  });

  it("--append-global stamps repo + dedupes across runs", async () => {
    const { mkdtemp: mkdtempFn } = await import("node:fs/promises");
    const root = await makeRepo();
    const fakeHome = await mkdtempFn(join(tmpdir(), "crimes-rollup-home-"));
    const env = { CRIMES_HOME: fakeHome };

    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);

    const first = await runCli(["feedback", "export", "--append-global"], root, env);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Appended 1 new entry");

    // process.cwd() inside the spawned CLI resolves the temp dir to its
    // realpath on macOS (/var/... → /private/var/...), so compare against
    // the resolved path rather than the raw mkdtemp output.
    const rootResolved = realpathSync(root);
    const rollupPath = join(realpathSync(fakeHome), ".crimes", "feedback-rollup.jsonl");
    const lines = readFileSync(rollupPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.repo).toBe(rootResolved);

    // Run again — should dedupe to zero appends.
    const second = await runCli(["feedback", "export", "--append-global"], root, env);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Appended 0 new entries");
    expect(second.stdout).toContain("1 entry was already present");
  });

  it("--global on summary reads from the rollup and includes by_repo", async () => {
    const { mkdtemp: mkdtempFn } = await import("node:fs/promises");
    const root = await makeRepo();
    const fakeHome = await mkdtempFn(join(tmpdir(), "crimes-rollup-home2-"));
    const env = { CRIMES_HOME: fakeHome };

    await runCli(["feedback", FP, "--verdict", "fp", "--note", "x"], root);
    await runCli(["feedback", "export", "--append-global"], root, env);
    const result = await runCli(
      ["feedback", "summary", "--global", "--format", "json"],
      root,
      env,
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.scope).toBe("global");
    expect(doc.summary.by_repo).toBeDefined();
    expect(doc.summary.by_repo[realpathSync(root)]).toBe(1);
  });
});
