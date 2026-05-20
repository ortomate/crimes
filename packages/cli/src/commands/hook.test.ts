import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// packages/cli/src/commands/hook.test.ts → packages/cli/dist/index.js
const CLI = resolve(here, "..", "..", "dist", "index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runHookCli(stdinPayload: string, cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, "hook"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on("error", (err) => {
      resolvePromise({ stdout, stderr: `${stderr}\nspawn error: ${err.message}`, exitCode: -1 });
    });
    child.stdin.end(stdinPayload);
  });
}

function largeFunctionSource(): string {
  const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join(
    "\n",
  );
  return `export function generateInvoice() {\n${body}\n  return 0;\n}\n`;
}

describe("crimes hook", () => {
  it(
    "reads PreToolUse JSON from stdin and runs context on tool_input.file_path",
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "crimes-cli-hook-"));
      await writeFile(join(root, "src.ts"), largeFunctionSource(), "utf8");

      const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: "src.ts",
          old_string: "x",
          new_string: "y",
        },
      });

      const result = await runHookCli(payload, root);
      expect(result.exitCode).toBe(0);
      // crimes context emits a JSON ContextReport with a top-level
      // `report_type: "context"` discriminator. If the hook ran context
      // for real, that's the signal we're looking for.
      expect(result.stdout).toContain('"report_type": "context"');
      expect(result.stdout).toContain('"file": "src.ts"');
    },
  );

  it(
    "exits 0 quietly when the stdin payload has no tool_input.file_path",
    { timeout: 15_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "crimes-cli-hook-nopath-"));
      const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const result = await runHookCli(payload, root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    },
  );

  it(
    "exits 0 quietly when stdin is empty",
    { timeout: 15_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "crimes-cli-hook-empty-"));
      const result = await runHookCli("", root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    },
  );

  it(
    "exits 0 quietly when stdin is malformed JSON",
    { timeout: 15_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "crimes-cli-hook-bad-"));
      const result = await runHookCli("not json{{{", root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    },
  );

  it(
    "exits 0 quietly when tool_input.file_path points at a non-existent file",
    { timeout: 15_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "crimes-cli-hook-missing-"));
      const payload = JSON.stringify({
        tool_input: { file_path: "does-not-exist.ts" },
      });
      const result = await runHookCli(payload, root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    },
  );
});
