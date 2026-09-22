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
  // `--skip-git-repo-check` is required, not optional politeness: the
  // runner hands every invocation a throwaway fixture copy with no
  // `.git`, and codex refuses to start outside a "trusted directory"
  // without it. The check exists to stop an agent editing a repository
  // it was not pointed at — which is precisely what the sandbox already
  // guarantees, by giving it nothing but a disposable copy.
  const args = ["exec", "--json", "--skip-git-repo-check", options.prompt];
  if (options.model) args.push("--model", options.model);
  const { stdout, stderr, exitCode } = await runProcess(
    "codex",
    args,
    options.timeoutMs ?? 600_000,
    options.cwd,
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
