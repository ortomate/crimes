import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import { extractComments, type SourceComment } from "../petty/comments.js";

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

export const commentedOutCodeDetector: Detector = {
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
          agent_risk: round(Math.min(0.48 + score.statementCount * 0.04, 0.72)),
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

  const proseWords = lines.join(" ").split(/\s+/).filter((word) => /^[a-z]{4,}$/i.test(word)).length;
  const codeText = codeLikeLines.join("\n");
  const syntaxCount = countMatches(codeText, /[{};]|=>|===|!==|&&|\|\|/g);
  const callLines = codeLikeLines.filter((line) => /\b[A-Za-z_$][\w$]*\s*\([^)]*\)/.test(line)).length;
  const tokens = CODE_TOKENS.filter((token) => new RegExp(`\\b${token}\\b`).test(codeText));
  const statementCount = syntaxCount + callLines + tokens.length + codeLikeLines.length;

  if (statementCount < 5) return undefined;
  if (proseWords > statementCount * 4 && syntaxCount < 5) return undefined;

  const firstLine = codeLikeLines[0] ?? "";
  return {
    tokens: tokens.slice(0, 5),
    statementCount,
    firstLine: truncate(firstLine, 80),
    confidence: round(Math.min(0.7 + statementCount * 0.02, 0.9)),
  };
}

function isCodeLikeLine(line: string): boolean {
  if (/^(const|let|var|function|class|import|export|interface|type|if|else|for|while|switch|try|catch|await|return)\b/.test(line)) {
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
