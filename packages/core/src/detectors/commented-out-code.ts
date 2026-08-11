import { hashSlice } from "../ast-hash/hash.js";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { extractComments, type SourceComment } from "../petty/comments.js";
import { type IntrinsicLadder, intrinsicFrom } from "../scoring/intrinsic.js";

const CODE_TOKENS = [
  "const",
  "let",
  "var",
  "function",
  "class",
  "import",
  "export",
  "interface",
  "type",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "try",
  "catch",
  "await",
  "return",
];

/**
 * The one ladder both `commented_out_code` detectors express, and the
 * unit they express it on.
 *
 * ## Why this needed deciding rather than copying
 *
 * These are same-directory twins: one `type`, two detectors, both
 * emitting into a single report depending on the file's language. Unlike
 * the cross-pack pairs there is no language argument available for two
 * answers to one charge. But until `0.25.9` they disagreed by 2×, and
 * neither number was what the calibration table said.
 *
 * The language-js twin's ladder read `0.48 + statementCount * 0.04`
 * capped at 0.72. `statementCount` is not a count of statements — it is
 * `syntaxCount + callLines + tokens.length + codeLikeLines.length`, a
 * composite the detector also gates on at `>= 5`. So the base was
 * **unreachable**: the smallest block it can emit already scores
 * `0.48 + 5 × 0.04 = 0.68`, and anything with a composite of 6 or more
 * saturates at 0.72. Measured across the corpus, all 463 of its findings
 * carry an intrinsic of exactly 0.68 or 0.72 — a two-value ladder
 * pretending to be a ramp. The universal twin, meanwhile, was a flat
 * 0.35 across 152 findings.
 *
 * That matters beyond the twins. `detector-defaults.ts` publishes
 * `0.48 commented_out_code (js)` in the list of expressed bases that
 * every entry in `INTRINSIC_DEFAULTS` was anchored against — and 0.48 is
 * a value the detector could not produce. The peers were calibrated
 * against a number that never appeared in a report.
 *
 * ## The unit: code-like lines
 *
 * Both twins already count them — `codeLikeLines.length` here,
 * `runCodeHits` in the universal one — and it is the measure that
 * matches the charge. The hazard is how much dormant implementation a
 * reader has to disambiguate, and a block of twenty disabled lines is a
 * bigger second reality than a block of three. `statementCount` was a
 * detection heuristic doing double duty as a severity signal.
 *
 * ## The constants
 *
 * `0.45` base is the value `INTRINSIC_DEFAULTS` already implies: its
 * entry for `exact_duplicate_block` is 0.45 with the note "Literal
 * duplication. Common and often benign; **near commented_out_code**".
 * The table's own intent was ~0.45 and the js twin was emitting 0.68.
 *
 * A small block clears the js gate at two code-like lines and so scores
 * exactly **0.48** — which makes the published anchor true for the first
 * time rather than aspirational.
 *
 * `0.60` cap is `docs_code_drift`, and a twenty-line commented-out
 * module is a documentation-shaped lie about what the code does. Below
 * `duplicated_policy` 0.65, because a dormant block cannot be enforced
 * against anybody.
 */
export const COMMENTED_OUT_CODE_LADDER: IntrinsicLadder = {
  base: 0.45,
  step: 0.03,
  cap: 0.6,
};

export const commentedOutCodeDetector: LanguageJsDetector = {
  id: "commented_out_code",
  name: "Commented-Out Code",
  description: "Flags disabled code left behind in comments.",
  whyItMatters:
    "Disabled code in comments creates two diverging realities — the live " +
    "implementation and the dormant alternative. Agents may copy from the " +
    "comment without checking whether it was abandoned for a reason, and " +
    "reviewers cannot tell which is canonical.",

  pack: "language-js",
  run(ctx) {
    const findings: Finding[] = [];
    for (const comment of extractComments(ctx.source)) {
      const score = scoreComment(comment);
      if (!score) continue;

      const severity = pickSeverity(comment, score.statementCount);
      findings.push({
        id: "",
        type: "commented_out_code",
        charge: "Commented-Out Corpse",
        severity,
        confidence: score.confidence,
        file: ctx.file,
        lines: [comment.startLine, comment.endLine],
        // This detector emits one finding per comment block and carries
        // no `symbol`, so without a discriminator every block in a file
        // shares the fingerprint `commented_out_code::<file>::` —
        // `crimes ignore` on one silently suppresses all of them. The
        // block's own text is stable across scans of the same code, so
        // it is the discriminator, matching the 0.17.0 precedent set by
        // `exact_duplicate_block` and `magic_domain_literal_scatter`.
        discriminator: hashSlice(comment.text).exact.slice(0, 12),
        summary:
          `Comment block appears to contain disabled code. Dead implementation snippets can ` +
          `mislead humans and agents into copying or reviving stale behaviour.`,
        evidence: [
          `${comment.endLine - comment.startLine + 1} comment line${comment.endLine === comment.startLine ? "" : "s"}`,
          `code-like tokens: ${score.tokens.join(", ")}`,
          `first code-like line: ${score.firstLine}`,
        ],
        effort: "quick",
        fix_shape: "delete; git history preserves it",
        scores: {
          severity: severityScore(severity),
          confidence: score.confidence,
          // Reconciled with the universal twin in 0.25.9 — see
          // COMMENTED_OUT_CODE_LADDER for the unit and the constants.
          agent_risk: intrinsicFrom(score.codeLikeLineCount, COMMENTED_OUT_CODE_LADDER),
        },
        suggested_actions: [
          {
            kind: "delete_dead_comment_code",
            description:
              "Delete the disabled code, or replace it with a short rationale that explains the active implementation.",
            risk: "low",
          },
        ],
      });
    }
    return findings.slice(0, 5);
  },
};

interface CommentScore {
  tokens: string[];
  statementCount: number;
  /** Lines in the block the parser judged to be code — the ladder's unit. */
  codeLikeLineCount: number;
  firstLine: string;
  confidence: number;
}

function scoreComment(comment: SourceComment): CommentScore | undefined {
  if (looksLikeJsDoc(comment.raw)) return undefined;
  if (comment.text.includes("```") || comment.text.includes("@example")) return undefined;

  const lines = comment.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const charCount = lines.join("\n").length;
  if (lines.length < 3 && charCount < 80) return undefined;

  const codeLikeLines = lines.filter(isCodeLikeLine);
  if (codeLikeLines.length < 2) return undefined;

  const proseWords = lines
    .join(" ")
    .split(/\s+/)
    .filter((word) => /^[a-z]{4,}$/i.test(word)).length;
  const codeText = codeLikeLines.join("\n");
  const syntaxCount = countMatches(codeText, /[{};]|=>|===|!==|&&|\|\|/g);
  const callLines = codeLikeLines.filter((line) =>
    /\b[A-Za-z_$][\w$]*\s*\([^)]*\)/.test(line),
  ).length;
  const tokens = CODE_TOKENS.filter((token) =>
    new RegExp(`\\b${token}\\b`).test(codeText),
  );
  const statementCount = syntaxCount + callLines + tokens.length + codeLikeLines.length;

  if (statementCount < 5) return undefined;
  if (proseWords > statementCount * 4 && syntaxCount < 5) return undefined;

  const firstLine = codeLikeLines[0] ?? "";
  return {
    tokens: tokens.slice(0, 5),
    statementCount,
    codeLikeLineCount: codeLikeLines.length,
    firstLine: truncate(firstLine, 80),
    confidence: round(Math.min(0.7 + statementCount * 0.02, 0.9)),
  };
}

function isCodeLikeLine(line: string): boolean {
  if (
    /^(const|let|var|function|class|import|export|interface|type|if|else|for|while|switch|try|catch|await|return)\b/.test(
      line,
    )
  ) {
    return true;
  }
  if (/[{};]$/.test(line) || /=>/.test(line)) return true;
  return /\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*;?$/.test(line);
}

function looksLikeJsDoc(raw: string): boolean {
  return raw.trimStart().startsWith("/**");
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function pickSeverity(comment: SourceComment, statementCount: number): Severity {
  const length = comment.endLine - comment.startLine + 1;
  return length >= 40 || statementCount >= 18 ? "medium" : "low";
}

function severityScore(severity: Severity): number {
  return severity === "medium" ? 0.45 : 0.25;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
