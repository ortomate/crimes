import type { PreFinding as Finding } from "../finding.js";
import type { UniversalDetector } from "../detector.js";
import { JS_EXTENSIONS } from "../discovery/language-pack-router.js";

const JS_EXT_SET = new Set<string>(JS_EXTENSIONS);

const SINGLE_LINE_COMMENT_RE = /^\s*(?:\/\/|#|--)\s?(.*)$/;
const CODE_TOKEN_RE =
  /\b(?:def|fn|function|class|let|var|const|return|if|for|while|import|from|use|pub|public|private|protected|interface|impl|struct|enum|match|switch)\b/;
const MINIMUM_RUN = 4;
const MINIMUM_CODE_HITS = 3;

/**
 * Universal-pack variant of `commented_out_code`. Runs on every file
 * except those claimed by the language-js pack (which has an AST-aware
 * variant under the same abstract `type`). Uses line-level regex
 * detection: a run of >= 4 single-line comments where >= 3 contain
 * code-shaped tokens (function/def/class/let/var/const/return/if/for/while/etc.)
 * is the trigger.
 */
export const commentedOutCodeUniversalDetector: UniversalDetector = {
  id: "commented_out_code",
  name: "Commented-Out Code (Universal)",
  description:
    "Flags runs of consecutive line comments whose content looks like " +
    "disabled code (universal variant; runs on non-JS files).",
  whyItMatters:
    "Code left behind in comments stales: the language and APIs around " +
    "it move on, but the dead block still hints at intent that's no " +
    "longer true. Agents reading the file may pattern-match on the " +
    "commented version and revive it incorrectly. Delete or move to " +
    "version control history.",
  pack: "universal",

  async run(ctx) {
    if (JS_EXT_SET.has(ctx.extension)) return [];
    const source = await ctx.readSource();
    const lines = source.split("\n");

    const findings: Finding[] = [];
    let runStart = -1;
    let runCodeHits = 0;
    let runCount = 0;

    const flushRun = (endLine: number): void => {
      if (
        runCount >= MINIMUM_RUN &&
        runCodeHits >= MINIMUM_CODE_HITS &&
        runStart >= 0
      ) {
        findings.push(buildFinding(ctx.file, runStart + 1, endLine));
      }
      runStart = -1;
      runCodeHits = 0;
      runCount = 0;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const m = SINGLE_LINE_COMMENT_RE.exec(lines[i]!);
      if (m) {
        if (runStart < 0) runStart = i;
        runCount += 1;
        if (CODE_TOKEN_RE.test(m[1] ?? "")) runCodeHits += 1;
      } else {
        flushRun(i);
      }
    }
    flushRun(lines.length);

    return findings;
  },
};

function buildFinding(file: string, startLine: number, endLine: number): Finding {
  return {
    id: "",
    type: "commented_out_code",
    charge: "Commented-Out Code",
    severity: "low",
    confidence: 0.65,
    file,
    lines: [startLine, endLine] as [number, number],
    summary:
      `A run of ${endLine - startLine + 1} consecutive comments looks like disabled code. ` +
      "Code left in comments stales — agents may revive incorrect snippets.",
    evidence: [
      `${endLine - startLine + 1} consecutive comment lines (lines ${startLine}–${endLine})`,
      ">=3 lines contain code-shaped tokens (def/fn/function/class/let/var/const/etc.)",
    ],
    effort: "quick",
    fix_shape: "delete the commented block (history preserves it)",
    scores: {
      severity: 0.35,
      confidence: 0.65,
      agent_risk: 0.35,
    },
    suggested_actions: [
      {
        kind: "delete_commented_block",
        description:
          "Delete the commented-out block. Version control preserves the history " +
          "if the code ever needs to come back.",
        risk: "low",
      },
    ],
  };
}
