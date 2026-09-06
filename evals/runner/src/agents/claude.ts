import { spawn } from "node:child_process";

export interface AgentRunResult {
  /** The agent's final response text. */
  response: string;
  /** Raw transcript / stdout (may be the same as response for simple CLIs). */
  transcript: string;
  /** Anything written to stderr — useful for debugging. */
  stderr: string;
  /** Non-zero exit codes turn into rejections; this is here for completeness. */
  exitCode: number;
}

export interface InvokeClaudeOptions {
  /** Full prompt — includes the scan JSON, instructions, scenario body. */
  prompt: string;
  /** Optional model override, passed through as `--model <value>`. */
  model?: string;
  /** Max time (ms) to wait for the agent to finish. Default 10 min. */
  timeoutMs?: number;
}

/**
 * Shell out to the locally-installed `claude` CLI in non-interactive
 * mode. Authenticates against the user's existing Claude subscription
 * via `~/.claude/...` credentials — no API keys involved.
 *
 * Wire format: `claude -p "<prompt>" --output-format json` is the
 * non-interactive single-shot equivalent. The CLI returns one JSON
 * object on stdout whose `result` field is the model's final response.
 */
export async function invokeClaude(
  options: InvokeClaudeOptions,
): Promise<AgentRunResult> {
  const args = ["-p", options.prompt, "--output-format", "json"];
  if (options.model) args.push("--model", options.model);
  const { stdout, stderr, exitCode } = await runProcess(
    "claude",
    args,
    options.timeoutMs ?? 600_000,
  );

  if (exitCode !== 0) {
    throw new AgentInvocationError(
      `claude exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
    );
  }

  // The CLI's --output-format json wraps the response in a JSON envelope.
  // Tolerate both the wrapped form and a bare string (older CLI versions).
  let response: string;
  try {
    const parsed = JSON.parse(stdout) as { result?: string; response?: string };
    response = parsed.result ?? parsed.response ?? stdout;
  } catch {
    response = stdout;
  }
  return { response, transcript: stdout, stderr, exitCode };
}

export class AgentInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInvocationError";
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(
        new AgentInvocationError(`agent invocation timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(new AgentInvocationError(`spawn ${command} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/** Re-export for callers that want to detect-then-skip the claude CLI. */
export { runProcess };
