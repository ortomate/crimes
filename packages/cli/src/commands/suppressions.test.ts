import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@crimes/core";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
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

function largeFunctionSource(name = "generateInvoice"): string {
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  return `export function ${name}() {\n${body}\n  return 0;\n}\n`;
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

async function writeSuppression(
  root: string,
  fingerprint: string,
  reason: string,
): Promise<void> {
  const dir = join(root, ".crimes");
  await mkdir(dir, { recursive: true });
  const doc = {
    schema_version: SCHEMA_VERSION,
    report_type: "suppressions",
    created_at: "2026-05-17T11:30:00.000Z",
    updated_at: "2026-05-17T11:30:00.000Z",
    suppressions: [
      {
        fingerprint,
        type: fingerprint.split("::")[0],
        reason,
        created_at: "2026-05-17T11:30:00.000Z",
      },
    ],
  };
  await writeFile(join(dir, "suppressions.json"), JSON.stringify(doc, null, 2), "utf8");
}

describe("crimes scan respects suppressions", () => {
  it("filters suppressed findings by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-scan-supp-"));
    await writeFile(join(root, "billing.ts"), largeFunctionSource(), "utf8");
    await writeSuppression(
      root,
      "large_function::billing.ts::generateInvoice",
      "tracked in #1234",
    );

    const result = await runCli(["scan", "--format", "json", "--no-color"], root);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.suppressed_count).toBe(1);
    expect(
      parsed.findings.find((f: { type: string }) => f.type === "large_function"),
    ).toBeUndefined();
  });

  it("--show-suppressed re-surfaces the finding annotated", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-scan-show-supp-"));
    await writeFile(join(root, "billing.ts"), largeFunctionSource(), "utf8");
    await writeSuppression(root, "large_function::billing.ts::generateInvoice", "legacy");

    const result = await runCli(
      ["scan", "--show-suppressed", "--format", "json", "--no-color"],
      root,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const supp = parsed.findings.find(
      (f: { type: string }) => f.type === "large_function",
    );
    expect(supp).toBeDefined();
    expect(supp.suppressed).toBe(true);
    expect(supp.suppression_reason).toBe("legacy");
  });

  it("--fail-on high with the only high finding suppressed exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-scan-supp-fail-on-"));
    await writeFile(join(root, "billing.ts"), largeFunctionSource(), "utf8");
    await writeSuppression(root, "large_function::billing.ts::generateInvoice", "ok");
    await git(root, "init", "--initial-branch=main", "--quiet");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "init", "--quiet");
    await writeFile(join(root, "trigger.ts"), "// trigger\n", "utf8");
    // The new untracked trigger.ts plus the suppressed billing.ts: gate
    // should not fire because the only finding is suppressed.
    const result = await runCli(
      ["scan", "--changed", "--fail-on", "high", "--format", "json", "--no-color"],
      root,
    );
    // The suppressed billing.ts isn't in the changed set anyway, but
    // confirm the suppression machinery doesn't break the gate.
    const parsed = JSON.parse(result.stdout);
    expect(parsed.failed).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
