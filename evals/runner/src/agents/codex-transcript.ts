/**
 * `codex exec --json` streams JSONL — one JSON object per line covering
 * thread lifecycle, every tool invocation, that tool's captured output,
 * and the agent's own messages. It is NOT a single JSON envelope, so
 * `JSON.parse(stdout)` throws and naive callers fall back to the raw
 * transcript.
 *
 * Scoring that raw transcript is wrong in both directions. It contains
 * files the agent merely `cat`ed (including SKILL.md, which names
 * detector slugs), scan JSON it dumped, and paths from `rg` output —
 * all of which the structural rubric would credit as if the agent had
 * written them. It also buries the actual answer thousands of
 * characters deep, so any leading-window check reads the preamble
 * instead of the response.
 *
 * Measured on the committed 0.10.5 and 0.12.0 baselines, 82–84% of the
 * scored text was transcript rather than answer, while the `claude`
 * runner (whose `--output-format json` yields one envelope) was 0%
 * contaminated. Agent-vs-agent pass rates were not comparable.
 */

interface CodexEvent {
  item?: { type?: string; text?: string };
}

/**
 * Reduce a `codex exec --json` transcript to just the agent's own
 * messages, newline-joined in emission order.
 *
 * Idempotent and format-tolerant: input that isn't codex JSONL (plain
 * prose from the claude runner, or an already-extracted response) is
 * returned unchanged, so this is safe to apply defensively when
 * re-scoring stored result files of unknown vintage.
 */
export function extractCodexResponse(stdout: string): string {
  if (!looksLikeCodexTranscript(stdout)) return stdout;

  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue; // partial or interleaved line — skip, don't fail the run
    }
    if (event.item?.type === "agent_message" && event.item.text) {
      messages.push(event.item.text);
    }
  }

  // No agent_message events at all means the shape changed upstream.
  // Returning the raw transcript keeps the run scoreable (badly) rather
  // than silently scoring an empty string as a total failure.
  if (messages.length === 0) return stdout;
  return messages.join("\n\n");
}

function looksLikeCodexTranscript(stdout: string): boolean {
  return /^\s*\{"type":"(?:thread\.started|turn\.started|item\.)/.test(stdout);
}
