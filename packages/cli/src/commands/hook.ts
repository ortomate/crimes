import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  applySuppressionsToContext,
  context,
  findNearestPackageRoot,
  loadConfig,
  loadSuppressionsForRoot,
  type ContextReport,
} from "@crimes/core";
import { formatContextCompactReport, formatContextJsonReport } from "@crimes/reporter";
import type { Command } from "commander";

declare const __CRIMES_VERSION__: string;

/** Claude PreToolUse adapter; no permission decision is ever returned. */
export function registerHookCommand(program: Command): void {
  program
    .command("hook")
    .description(
      "Claude pre-edit hook: read tool input on stdin and return advisory context.",
    )
    .option(
      "--from-env <name>",
      "fall back to the named env var if stdin yields no file path",
    )
    .option("--format <format>", "output format: compact | json | claude", "compact")
    .action(
      async (options: { fromEnv?: string; format: "compact" | "json" | "claude" }) => {
        try {
          const format = options.format;
          if (format !== "compact" && format !== "json" && format !== "claude") {
            process.stderr.write(
              `crimes hook: unknown --format "${String(format)}". Expected "compact", "json" or "claude".\n`,
            );
            process.exit(0);
            return;
          }
          const input = await resolveHookInput(options.fromEnv);
          const filePath = input.filePath;
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
            : resolve(input.cwd ?? process.cwd(), filePath);
          if (!existsSync(absolute)) {
            // The agent might be creating a new file. Nothing to brief on.
            process.exit(0);
            return;
          }
          const report = await buildHookContext(
            absolute,
            process.env.CLAUDE_PROJECT_DIR || input.cwd,
          );
          if (format === "json") {
            process.stdout.write(formatContextJsonReport(report) + "\n");
          } else {
            const output = formatContextCompactReport(report);
            // Existing generated hooks used --format compact. Recognize the host
            // envelope so upgrading the CLI repairs delivery without rewriting settings.
            const body =
              format === "claude" || input.preToolUse
                ? JSON.stringify({
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      additionalContext: output,
                    },
                  })
                : output;
            process.stdout.write(body + "\n");
          }
        } catch (error) {
          process.stderr.write(`crimes hook: skipped (${errorMessage(error)})\n`);
          process.exit(0);
        }
      },
    );
}

interface HookInput {
  filePath?: string;
  cwd?: string;
  preToolUse?: boolean;
}

async function resolveHookInput(envName: string | undefined): Promise<HookInput> {
  const stdin = await readStdinIfAvailable();
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin) as {
        tool_input?: { file_path?: unknown };
        cwd?: unknown;
        hook_event_name?: unknown;
      };
      const fromBody = parsed.tool_input?.file_path;
      if (typeof fromBody === "string" && fromBody.trim() !== "") {
        return {
          filePath: fromBody,
          cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
          preToolUse: parsed.hook_event_name === "PreToolUse",
        };
      }
    } catch {
      // fall through to env fallback
    }
  }
  if (envName) {
    const value = process.env[envName];
    if (typeof value === "string" && value.trim() !== "") return { filePath: value };
  }
  return {};
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

async function buildHookContext(
  absolute: string,
  projectRoot?: string,
): Promise<ContextReport> {
  const scanRoot = projectRoot
    ? resolve(projectRoot)
    : ((await findNearestPackageRoot(dirname(absolute))) ?? process.cwd());
  const config = loadConfig(scanRoot);
  const suppressions = loadSuppressionsForRoot(scanRoot, config);
  const report = await context({
    file: absolute,
    root: scanRoot,
    suppressionsEntries: suppressions.entries,
  });
  return applySuppressionsToContext(report, suppressions.entries, {
    showSuppressed: false,
    crimesVersion: __CRIMES_VERSION__,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "unexpected error";
}
