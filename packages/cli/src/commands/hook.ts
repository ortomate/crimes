import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  applySuppressionsToContext,
  context,
  findNearestPackageRoot,
  loadConfig,
  loadSuppressionsForRoot,
  type ContextReport,
  type Finding,
} from "@crimes/core";
import { formatContextJsonReport } from "@crimes/reporter";
import type { Command } from "commander";

declare const __CRIMES_VERSION__: string;

/**
 * Read Claude Code / Codex PreToolUse hook JSON from stdin, extract the
 * file path the agent is about to edit, and run `crimes context` on it
 * so the agent sees a pre-edit briefing.
 *
 * The hook is registered by `crimes init --agents` (see
 * `hook-templates.ts`). Generated hook commands append `|| true`, so
 * failures must never block editing. We still write a short warning to
 * stderr on unexpected failures so hook problems are discoverable.
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
    .option("--format <format>", "output format: compact | json", "compact")
    .action(async (options: { fromEnv?: string; format: "compact" | "json" }) => {
      try {
        const format = options.format;
        if (format !== "compact" && format !== "json") {
          process.stderr.write(
            `crimes hook: unknown --format "${String(format)}". Expected "compact" or "json".\n`,
          );
          process.exit(0);
          return;
        }
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
        const report = await buildHookContext(absolute);
        if (format === "json") {
          process.stdout.write(formatContextJsonReport(report) + "\n");
        } else {
          const output = formatCompactHookReport(report);
          if (output !== "") process.stdout.write(output + "\n");
        }
      } catch (error) {
        process.stderr.write(`crimes hook: skipped (${errorMessage(error)})\n`);
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

async function buildHookContext(absolute: string): Promise<ContextReport> {
  const scanRoot = (await findNearestPackageRoot(dirname(absolute))) ?? process.cwd();
  const config = loadConfig(scanRoot);
  const suppressions = loadSuppressionsForRoot(scanRoot, config);
  const report = await context({
    file: absolute,
    suppressionsEntries: suppressions.entries,
  });
  return applySuppressionsToContext(report, suppressions.entries, {
    showSuppressed: false,
    crimesVersion: __CRIMES_VERSION__,
  });
}

function formatCompactHookReport(report: ContextReport): string {
  const lines: string[] = [];
  const counts = `${report.risk.high} high, ${report.risk.medium} medium, ${report.risk.low} low`;
  lines.push(`crimes context ${report.file}: ${report.risk.level} risk (${counts})`);

  if (report.findings.length > 0) {
    lines.push("Top findings:");
    for (const finding of report.findings.slice(0, 3)) {
      lines.push(`- ${formatCompactFinding(finding)}`);
    }
    if (report.findings.length > 3) {
      lines.push(`- plus ${report.findings.length - 3} more`);
    }
  } else {
    lines.push("No findings for this file.");
  }

  const guidance = report.agent_guidance.slice(0, 2);
  if (guidance.length > 0) {
    lines.push(`Agent notes: ${guidance.join(" ")}`);
  }

  if (report.likely_tests.length > 0) {
    lines.push(`Likely tests: ${report.likely_tests.slice(0, 3).join(", ")}`);
  } else if (report.likely_tests_reason) {
    lines.push(`Likely tests: ${report.likely_tests_reason}`);
  }

  return lines.join("\n");
}

function formatCompactFinding(finding: Finding): string {
  const location = finding.lines ? `:${finding.lines[0]}-${finding.lines[1]}` : "";
  return `${finding.severity.toUpperCase()} ${finding.charge} ${finding.file}${location} (${finding.id})`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "unexpected error";
}
