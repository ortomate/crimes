import { z } from "zod";
import { invokeClaude } from "./agents/claude.js";
import type { JudgeQuestionScore, Scenario } from "./types.js";

const DEFAULT_JUDGE_MODEL = "claude-opus-4-7";

const JudgeAnswerSchema = z.object({
  score: z.number().int().min(0).max(10),
  reasoning: z.string().min(1),
});
type JudgeAnswer = z.infer<typeof JudgeAnswerSchema>;

export interface RunJudgeArgs {
  scenario: Scenario;
  response: string;
  /** Override the model used for the judge run. */
  model?: string;
}

export interface RunJudgeResult {
  overall: number;
  per_question: JudgeQuestionScore[];
  model: string;
}

/**
 * Opt-in judge-model pass (per §5.6 of the calibration plan). Sends
 * the scenario + expected artifacts + the agent's response back to the
 * `claude` CLI in a judging role. Each `judge_questions` entry
 * receives a structured `{score, reasoning}` answer.
 *
 * Malformed JSON or schema-failing answers are marked `failed`
 * (score 0, reasoning explains the failure) rather than crashing the
 * run — judge results are inherently stochastic and we never gate
 * anything on them.
 *
 * Returns `undefined` when the scenario has no `judge_questions`
 * (nothing to ask).
 */
export async function runJudge(args: RunJudgeArgs): Promise<RunJudgeResult | undefined> {
  const questions = args.scenario.judge_questions ?? [];
  if (questions.length === 0) return undefined;

  const model = args.model ?? DEFAULT_JUDGE_MODEL;
  const prompt = composeJudgePrompt(args.scenario, args.response, questions);
  const agentResult = await invokeClaude({ prompt, model });

  const per_question = parseJudgeResponse(agentResult.response, questions);
  const overall =
    per_question.length === 0
      ? 0
      : per_question.reduce((sum, q) => sum + q.score, 0) / per_question.length;

  return {
    overall: Math.round(overall * 100) / 100,
    per_question,
    model,
  };
}

function composeJudgePrompt(
  scenario: Scenario,
  agentResponse: string,
  questions: string[],
): string {
  return (
    "[SYSTEM]\n" +
    "You are evaluating an AI agent's response to a code-analysis task. " +
    "You will be given the scenario, the expected artifacts, the agent's full " +
    "response, and a list of judge questions. For each question, respond " +
    'with a JSON object: {"score": 0-10, "reasoning": "<one paragraph>"}.\n\n' +
    "Respond with one JSON object per question, in order, separated by newlines.\n\n" +
    "[USER]\n" +
    `SCENARIO: ${JSON.stringify(scenario, null, 2)}\n\n` +
    `EXPECTED: ${JSON.stringify(scenario.expected_artifacts, null, 2)}\n\n` +
    `AGENT_RESPONSE: ${agentResponse}\n\n` +
    "JUDGE_QUESTIONS:\n" +
    questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
  );
}

/**
 * Walk the judge's response and pull one `{score, reasoning}` object
 * per question. Tolerant: scans for JSON objects in source order. A
 * missing or malformed answer for a question becomes
 * `{score: 0, reasoning: "judge response failed validation: ..."}`.
 */
function parseJudgeResponse(
  judgeText: string,
  questions: string[],
): JudgeQuestionScore[] {
  const objects = extractJsonObjects(judgeText);
  const answers: (JudgeAnswer | undefined)[] = objects.map((raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const result = JudgeAnswerSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  });
  return questions.map((question, idx) => {
    const answer = answers[idx];
    if (!answer) {
      return {
        question,
        score: 0,
        reasoning: "judge response failed validation (missing or malformed JSON)",
      };
    }
    return { question, score: answer.score, reasoning: answer.reasoning };
  });
}

/**
 * Extract top-level JSON objects from arbitrary text. Walks character
 * by character tracking brace depth and basic string-escape state — no
 * regex, no JSON parser involvement until we have a complete candidate.
 */
function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}
