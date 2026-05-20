import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "..", "dist", "index.js");

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

interface SeedEntry {
  fingerprint: string;
  type: string;
  reason: string;
  created_at: string;
  created_by?: string;
}

async function seedSuppressions(
  root: string,
  entries: SeedEntry[],
): Promise<string> {
  await mkdir(join(root, ".crimes"), { recursive: true });
  const path = join(root, ".crimes", "suppressions.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        schema_version: "0.2.0",
        report_type: "suppressions",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-05-17T12:00:00.000Z",
        suppressions: entries,
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

describe("crimes audit-suppressions", () => {
  it("reports loaded:false when the file is missing (human)", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-audit-missing-"));
    const result = await runCli(
      ["audit-suppressions", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No suppressions file found");
  });

  it("reports an empty suppressions file (human)", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-audit-empty-"));
    await seedSuppressions(root, []);
    const result = await runCli(
      ["audit-suppressions", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Suppressions file is empty");
  });

  it("emits valid JSON with the expected shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-audit-json-"));
    await seedSuppressions(root, [
      {
        fingerprint: "large_function::a.ts::a",
        type: "large_function",
        reason: "tracked in #1234 (legacy module rewrite planned)",
        created_at: "2026-05-01T12:00:00.000Z",
      },
    ]);
    const result = await runCli(
      ["audit-suppressions", "--format", "json"],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.report_type).toBe("audit_suppressions");
    expect(parsed.schema_version).toBe("0.2.0");
    expect(parsed.loaded).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.entries[0].fingerprint).toBe("large_function::a.ts::a");
    expect(typeof parsed.entries[0].age_days).toBe("number");
    expect(Array.isArray(parsed.entries[0].concerns)).toBe(true);
  });

  it("flags entries with short reasons in the human output", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-audit-short-"));
    await seedSuppressions(root, [
      {
        fingerprint: "large_function::a.ts::a",
        type: "large_function",
        reason: "short",
        created_at: "2026-05-01T12:00:00.000Z",
      },
    ]);
    const result = await runCli(
      ["audit-suppressions", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Flagged");
    expect(result.stdout).toContain("reason shorter than 16 characters");
  });

  it("malformed suppressions file exits 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-audit-bad-"));
    await mkdir(join(root, ".crimes"), { recursive: true });
    await writeFile(
      join(root, ".crimes", "suppressions.json"),
      "not json",
      "utf8",
    );
    const result = await runCli(["audit-suppressions"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("malformed");
  });
});
