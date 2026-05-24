import { readFileSync as fsReadFileSync } from "node:fs";
import type { LanguageJsDetector, DetectorContext } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

/**
 * Fires when ≥3 files contain comparison-style checks against the same
 * role / status / plan literal, with at least two distinct comparison
 * shapes. Captures the copy-paste-then-tweak pattern where one place
 * checks `role === "admin"`, another checks `role === "admin" ||
 * role === "owner"`, and a third checks `role !== "guest"` — all
 * trying to express the same policy.
 *
 * Anchored on the lex-first file in the duplicate set. Uses raw regex
 * scanning rather than full AST traversal — the patterns are
 * unambiguous enough that the source-text approach matches the
 * production detector's accuracy without re-parsing.
 *
 * Cross-file: walks every file the IA index already discovered (which
 * itself scans every source file under the scan root) so the per-file
 * detector loop emits each finding exactly once.
 */
export const duplicatedRoleStatusPlanCheckDetector: LanguageJsDetector = {
  id: "duplicated_role_status_plan_check",
  name: "Duplicated Role / Status / Plan Check",
  description:
    "Flags comparison checks against the same role / status / plan " +
    "literal that appear with different conditions across multiple files.",
  whyItMatters:
    "When the same policy literal (`'admin'`, `'active'`, `'pro'`) is " +
    "checked in three places with three different expressions, the team " +
    "no longer has one source of truth. Agents extending one site rarely " +
    "notice the others have a subtly different rule.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    if (!isPrimaryAnchor(ctx)) return [];
    return analyse(ctx);
  },
};

interface CheckHit {
  file: string;
  line: number;
  literal: string;
  expression: string;
}

function analyse(ctx: DetectorContext): Finding[] {
  if (!ctx.ia) return [];
  const files = Object.keys(ctx.ia.files);
  const hitsByLiteral = new Map<string, CheckHit[]>();

  for (const file of files) {
    // The IA index keeps file paths but not their raw sources. We need
    // the source to scan for comparison patterns; read once per file.
    // Skip the read silently on any I/O error — detector is advisory.
    let source: string;
    try {
      // Use the on-disk path the IA index recorded. ctx.ia.root +
      // file gives an absolute path.
      const abs = `${ctx.ia.root}/${file}`;
      source = readFileSync(abs);
    } catch {
      continue;
    }
    if (source.length === 0) continue;
    if (isTestFile(file)) continue;
    scanFile(file, source, hitsByLiteral);
  }

  const findings: Finding[] = [];
  for (const [literal, hits] of hitsByLiteral) {
    const files = new Set(hits.map((h) => h.file));
    const expressions = new Set(hits.map((h) => h.expression));
    if (files.size < 3) continue;
    if (expressions.size < 2) continue;

    const anchor = [...files].sort()[0]!;
    findings.push(buildFinding(literal, hits, anchor));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file));
  return findings;
}

const COMPARISON_RE =
  /([A-Za-z_$][\w$.]*)\s*(===|!==|==|!=)\s*['"]([a-zA-Z0-9_-]{2,30})['"]/g;

const POLICY_NAMES = new Set([
  "role",
  "status",
  "plan",
  "tier",
  "permission",
  "permissions",
  "subscription",
  "tier",
  "state",
]);

function scanFile(
  file: string,
  source: string,
  out: Map<string, CheckHit[]>,
): void {
  let lineStart = 0;
  let line = 1;
  for (const match of source.matchAll(COMPARISON_RE)) {
    const [whole, lhsExpr, op, literal] = match;
    const lhsLower = lhsExpr!.toLowerCase();
    const tail = lhsLower.split(".").pop() ?? lhsLower;
    if (!POLICY_NAMES.has(tail)) continue;
    const idx = match.index ?? 0;
    while (lineStart <= idx) {
      const next = source.indexOf("\n", lineStart);
      if (next === -1 || next > idx) break;
      lineStart = next + 1;
      line += 1;
    }
    const hit: CheckHit = {
      file,
      line,
      literal: literal!,
      expression: `${lhsLower} ${op} "${literal}"`.trim(),
    };
    void whole;
    const key = `${tail}::${literal}`;
    const existing = out.get(key);
    if (existing) existing.push(hit);
    else out.set(key, [hit]);
  }
}

function buildFinding(
  literalKey: string,
  hits: CheckHit[],
  anchor: string,
): Finding {
  const [_field, literal] = literalKey.split("::");
  const distinctFiles = Array.from(new Set(hits.map((h) => h.file))).sort();
  const distinctExpressions = Array.from(new Set(hits.map((h) => h.expression))).sort();

  const evidence: string[] = [
    `literal: "${literal}"`,
    `${distinctFiles.length} file(s), ${distinctExpressions.length} distinct expression shapes`,
  ];
  for (const hit of hits.slice(0, 5)) {
    evidence.push(`${hit.file}:${hit.line}: ${hit.expression}`);
  }
  if (hits.length > 5) {
    evidence.push(`+${hits.length - 5} more occurrence(s)`);
  }

  return {
    id: "",
    type: "duplicated_role_status_plan_check",
    charge: "Duplicated Role / Status / Plan Check",
    severity: "medium",
    confidence: 0.7,
    file: anchor,
    summary:
      `The literal "${literal}" is compared against in ${distinctFiles.length} ` +
      `files using ${distinctExpressions.length} different expression shapes. ` +
      "Extracting a single policy function would prevent the rules from " +
      "drifting silently.",
    evidence,
    effort: "medium",
    fix_shape: "centralise the policy check; everyone calls the one helper",
    scores: {
      severity: 0.55,
      confidence: 0.7,
    },
    suggested_actions: [
      {
        kind: "extract_policy_function",
        description:
          `Replace the ad-hoc checks against "${literal}" with a single ` +
          "policy function that every call site delegates to.",
        risk: "medium",
      },
    ],
    related_files: distinctFiles.filter((f) => f !== anchor),
  };
}


function isPrimaryAnchor(ctx: DetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}

function readFileSync(abs: string): string {
  return fsReadFileSync(abs, "utf8");
}
