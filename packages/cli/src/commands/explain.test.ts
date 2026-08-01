import { execFile } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
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
      { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
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

function largeFunctionSource(): string {
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  return `export function generateInvoice() {\n${body}\n  return 0;\n}\n`;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-explain-cli-"));
  await writeFile(join(root, "billing.ts"), largeFunctionSource(), "utf8");
  return root;
}

describe("crimes explain", () => {
  it("default mode runs a fresh scan and resolves the fingerprint", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["explain", "large_function::billing.ts::generateInvoice", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CRIMES EXPLAIN");
    expect(result.stdout).toContain("God Function");
    expect(result.stdout).toContain("Likely remedies");
    expect(result.stdout).toContain(
      "crimes ignore large_function::billing.ts::generateInvoice",
    );
    expect(result.stdout).toContain("--reason");
  });

  it("JSON output matches the ExplainReport shape", async () => {
    const root = await makeRepo();
    const result = await runCli(
      [
        "explain",
        "large_function::billing.ts::generateInvoice",
        "--format",
        "json",
        "--no-color",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.report_type).toBe("explain");
    expect(parsed.schema_version).toBe("0.3.0");
    expect(parsed.finding.type).toBe("large_function");
    expect(parsed.detector.charge).toBe("God Function");
    expect(typeof parsed.why_it_matters).toBe("string");
    expect(Array.isArray(parsed.likely_remedies)).toBe(true);
    expect(parsed.likely_remedies.length).toBeGreaterThan(0);
    expect(parsed.suggested_suppression_command).toContain("crimes ignore");
  });

  it("--from <scan.json> resolves a finding without re-scanning", async () => {
    const root = await makeRepo();
    const scanResult = await runCli(["scan", "--format", "json", "--no-color"], root);
    expect(scanResult.exitCode).toBe(0);
    const scanPath = join(root, "scan.json");
    await writeFile(scanPath, scanResult.stdout, "utf8");

    const result = await runCli(
      [
        "explain",
        "large_function::billing.ts::generateInvoice",
        "--from",
        "scan.json",
        "--format",
        "json",
        "--no-color",
      ],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.finding.type).toBe("large_function");
  });

  it("--from with an id resolves correctly", async () => {
    const root = await makeRepo();
    const scanResult = await runCli(["scan", "--format", "json", "--no-color"], root);
    const scanPath = join(root, "scan.json");
    await writeFile(scanPath, scanResult.stdout, "utf8");
    const scan = JSON.parse(scanResult.stdout);
    const id = scan.findings[0].id;

    const result = await runCli(
      ["explain", id, "--from", "scan.json", "--format", "json", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.finding.id).toBe(id);
  });

  it("unknown id / fingerprint exits 2", async () => {
    const root = await makeRepo();
    const result = await runCli(["explain", "crime_99999", "--no-color"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no finding");
  });

  it("human output contains the suggested crimes ignore command line", async () => {
    const root = await makeRepo();
    const result = await runCli(
      ["explain", "large_function::billing.ts::generateInvoice", "--no-color"],
      root,
    );
    expect(result.stdout).toMatch(
      /crimes ignore large_function::billing\.ts::generateInvoice --reason "<one-sentence justification>"/,
    );
  });
});
