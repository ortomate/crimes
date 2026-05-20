import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Command } from "commander";

/**
 * Read Claude Code / Codex PreToolUse hook JSON from stdin, extract the
 * file path the agent is about to edit, and re-invoke `crimes context`
 * on it so the agent sees a pre-edit briefing.
 *
 * The hook is registered by `crimes init --agents` (see
 * `hook-templates.ts`). The actual command in `.claude/settings.local.json`
 * is literally `npx -y crimes hook 2>/dev/null || true` — every error
 * path here must therefore exit quietly so the user never sees a hook
 * stack trace while editing.
 *
 * Claude Code hook input format
 * (https://code.claude.com/docs/en/hooks):
 *
 *   {
 *     "session_id": "...",
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "Edit",
 *     "tool_input": {
 *       "file_path": "/abs/or/rel/path.ts",
 *       ...
 *     },
 *     ...
 *   }
 *
 * For Codex the shape is similar; we read `tool_input.file_path` for
 * both. The flag `--from-env <NAME>` is supported for forward-compat
 * with hosts that still set a single env var.
 */
export function registerHookCommand(program: Command): void {
  program
    .command("hook")
    .description(
      "Pre-edit hook: read Claude Code / Codex PreToolUse JSON from stdin and run `crimes context` on the file_path. Registered by `crimes init --agents`.",
    )
    .option(
      "--from-env <name>",
      "fall back to the named env var if stdin yields no file path",
    )
    .action(async (options: { fromEnv?: string }) => {
      try {
        const filePath = await resolveFilePath(options.fromEnv);
        if (!filePath) {
          // Nothing to brief on — exit quietly. This is the common case
          // for tools without a file_path (Bash, WebFetch, etc.) when
          // the matcher pattern is too broad, or when the hook payload
          // doesn't yet include tool_input.
          process.exit(0);
          return;
        }
        const absolute = isAbsolute(filePath)
          ? filePath
          : resolve(process.cwd(), filePath);
        if (!existsSync(absolute)) {
          // The agent might be creating a new file. Nothing to brief on.
          process.exit(0);
          return;
        }
        await runContextChild(absolute);
      } catch {
        // Hook failures must never block the user. Per the install
        // template `2>/dev/null || true` would swallow this anyway, but
        // exit 0 here so even shell variants that ignore the swallow
        // pattern don't surface anything.
        process.exit(0);
      }
    });
}

async function resolveFilePath(envName: string | undefined): Promise<string | undefined> {
  const stdin = await readStdinIfAvailable();
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin) as {
        tool_input?: { file_path?: unknown };
      };
      const fromBody = parsed.tool_input?.file_path;
      if (typeof fromBody === "string" && fromBody.trim() !== "") {
        return fromBody;
      }
    } catch {
      // fall through to env fallback
    }
  }
  if (envName) {
    const value = process.env[envName];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Read stdin to EOF if a payload is piped, otherwise return undefined
 * without blocking. We treat stdin as a TTY → "no payload"; a piped
 * stream → buffer to EOF. The 100ms idle timeout is the belt-and-braces
 * fallback for hosts that hand us a non-TTY stdin without ever writing
 * to it (we don't want the hook to hang the agent).
 */
async function readStdinIfAvailable(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  return await new Promise<string | undefined>((resolvePromise) => {
    let buffer = "";
    let settled = false;
    const settle = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const timer = setTimeout(() => settle(buffer.length > 0 ? buffer : undefined), 100);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      timer.refresh();
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      settle(buffer.length > 0 ? buffer : undefined);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      settle(undefined);
    });
  });
}

/**
 * Re-invoke this same CLI binary with `context <file> --format json`.
 * We exec via `process.argv[1]` so the hook always uses the same crimes
 * version it was registered against, rather than re-resolving via npx.
 */
async function runContextChild(absolute: string): Promise<void> {
  const cliEntry = process.argv[1];
  if (typeof cliEntry !== "string") {
    process.exit(0);
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [cliEntry, "context", absolute, "--format", "json"],
      { stdio: ["ignore", "inherit", "ignore"] },
    );
    child.on("close", () => resolvePromise());
    child.on("error", () => resolvePromise());
  });
}
