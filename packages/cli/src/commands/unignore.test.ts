import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

async function makeRepoWithSuppression(): Promise<{
  root: string;
  path: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "crimes-unignore-"));
  await mkdir(join(root, ".crimes"), { recursive: true });
  const path = join(root, ".crimes", "suppressions.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        schema_version: "0.3.0",
        report_type: "suppressions",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        suppressions: [
          {
            fingerprint: "large_function::billing.ts::generateInvoice",
            type: "large_function",
            file: "billing.ts",
            symbol: "generateInvoice",
            reason: "tracked in #1234",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, path };
}

describe("crimes unignore", () => {
  it("invalid fingerprint exits 2", async () => {
    const { root } = await makeRepoWithSuppression();
    const result = await runCli(["unignore", "garbage"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not a stable fingerprint");
  });

  it("removes an existing entry and prints confirmation", async () => {
    const { root, path } = await makeRepoWithSuppression();
    const result = await runCli(
      ["unignore", "large_function::billing.ts::generateInvoice"],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Removed");
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.suppressions).toEqual([]);
  });

  it("missing fingerprint exits 2 with audit hint", async () => {
    const { root } = await makeRepoWithSuppression();
    const result = await runCli(
      ["unignore", "large_function::nope.ts::nope"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no suppression entry");
    expect(result.stderr).toContain("audit-suppressions");
  });

  it("missing file exits 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-unignore-no-file-"));
    const result = await runCli(
      ["unignore", "large_function::billing.ts::generateInvoice"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no suppressions file");
  });

  it("--dry-run previews without writing", async () => {
    const { root, path } = await makeRepoWithSuppression();
    const before = readFileSync(path, "utf8");
    const result = await runCli(
      [
        "unignore",
        "large_function::billing.ts::generateInvoice",
        "--dry-run",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Would remove");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("--file override is honoured", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-unignore-file-"));
    const overridePath = join(root, "custom.json");
    await writeFile(
      overridePath,
      JSON.stringify(
        {
          schema_version: "0.3.0",
          report_type: "suppressions",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          suppressions: [
            {
              fingerprint: "large_function::a.ts::a",
              type: "large_function",
              reason: "tracked in #1234",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const result = await runCli(
      [
        "unignore",
        "large_function::a.ts::a",
        "--file",
        "custom.json",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(overridePath)).toBe(true);
    const after = JSON.parse(readFileSync(overridePath, "utf8"));
    expect(after.suppressions).toEqual([]);
  });
});
