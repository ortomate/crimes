import { AgentInvocationError, runProcess } from "./claude.js";
import type { AgentRunResult, InvokeClaudeOptions } from "./claude.js";
import { extractCodexResponse } from "./codex-transcript.js";

export type InvokeCodexOptions = InvokeClaudeOptions;

/**
 * Shell out to the locally-installed `codex` CLI in non-interactive
 * mode. Authenticates against the user's existing Codex subscription.
 *
 * Wire format: `codex exec --json <prompt>` streams JSONL, one event
 * per line — not a single envelope. `response` is reduced to the
 * agent's own messages via {@link extractCodexResponse}; the full
 * stream is preserved in `transcript` for debugging.
 *
 * A single-envelope form (`result` / `output` / `response`) is still
 * accepted for older CLI versions.
 */
export async function invokeCodex(options: InvokeCodexOptions): Promise<AgentRunResult> {
  const args = ["exec", "--json", options.prompt];
  if (options.model) args.push("--model", options.model);
  const { stdout, stderr, exitCode } = await runProcess(
    "codex",
    args,
    options.timeoutMs ?? 600_000,
  );

  if (exitCode !== 0) {
    throw new AgentInvocationError(
      `codex exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
    );
  }

  let response: string;
  try {
    const parsed = JSON.parse(stdout) as {
      result?: string;
      output?: string;
      response?: string;
    };
    response = parsed.result ?? parsed.output ?? parsed.response ?? stdout;
  } catch {
    // Expected on current CLI versions: JSONL is not parseable as one
    // object. Reduce the stream to the agent's messages rather than
    // scoring tool output and file dumps as if the agent wrote them.
    response = extractCodexResponse(stdout);
  }
  return { response, transcript: stdout, stderr, exitCode };
}
