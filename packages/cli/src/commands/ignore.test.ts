import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
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

function largeFunctionSource(name = "generateInvoice"): string {
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  return `export function ${name}() {\n${body}\n  return 0;\n}\n`;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-ignore-"));
  await writeFile(join(root, "billing.ts"), largeFunctionSource(), "utf8");
  return root;
}

describe("crimes ignore", () => {
  it("missing --reason exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["ignore", "large_function::billing.ts::generateInvoice"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--reason is required");
  });

  it("empty --reason exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["ignore", "large_function::billing.ts::generateInvoice", "--reason", ""],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--reason is required");
  });

  it("invalid id / fingerprint shape exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["ignore", "garbage", "--reason", "ok"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("neither a per-scan id");
  });

  it("valid fingerprint writes the file", async () => {
    const root = await makeRepo();
    const result = await runCli(
      [
        "ignore",
        "large_function::billing.ts::generateInvoice",
        "--reason",
        "tracked in #1234",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Suppressed");

    const path = join(root, ".crimes", "suppressions.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.suppressions).toHaveLength(1);
    expect(raw.suppressions[0].reason).toBe("tracked in #1234");
  });

  it("crime_NNNNN id resolves to a fingerprint via a fresh scan", async () => {
    const root = await makeRepo();
    // crime_00001 will be the largest-severity finding — large_function on billing.ts.
    const result = await runCli(["ignore", "crime_00001", "--reason", "legacy"], root);
    expect(result.exitCode).toBe(0);

    const raw = JSON.parse(
      readFileSync(join(root, ".crimes", "suppressions.json"), "utf8"),
    );
    expect(raw.suppressions[0].fingerprint).toBe(
      "large_function::billing.ts::generateInvoice",
    );
  });

  it("re-ignoring the same fingerprint updates the entry, doesn't append", async () => {
    const root = await makeRepo();
    await runCli(
      ["ignore", "large_function::billing.ts::generateInvoice", "--reason", "original"],
      root,
    );
    const second = await runCli(
      ["ignore", "large_function::billing.ts::generateInvoice", "--reason", "revised"],
      root,
    );
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Updated");

    const raw = JSON.parse(
      readFileSync(join(root, ".crimes", "suppressions.json"), "utf8"),
    );
    expect(raw.suppressions).toHaveLength(1);
    expect(raw.suppressions[0].reason).toBe("revised");
  });

  it("--file override is honoured", async () => {
    const root = await makeRepo();
    const overridePath = join(root, "custom-suppressions.json");
    const result = await runCli(
      [
        "ignore",
        "large_function::billing.ts::generateInvoice",
        "--reason",
        "ok",
        "--file",
        "custom-suppressions.json",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(overridePath)).toBe(true);
  });

  it("--dry-run prints the entry without writing", async () => {
    const root = await makeRepo();
    const result = await runCli(
      [
        "ignore",
        "large_function::billing.ts::generateInvoice",
        "--reason",
        "ok",
        "--dry-run",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Would write");
    expect(existsSync(join(root, ".crimes", "suppressions.json"))).toBe(false);
  });

  it("unknown fingerprint rejects with exit 2 (without --no-verify)", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["ignore", "large_function::doesnotexist.ts::nope", "--reason", "ok"],
      root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("did not match any finding");
  });
});
