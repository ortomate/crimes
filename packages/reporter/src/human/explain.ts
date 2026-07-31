import type { ExplainReport, Finding, Severity } from "@crimes/core";
import type { ColourFns } from "./shared.js";
import { pc, plainColour } from "./shared.js";

export interface ExplainHumanReportOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
}

/**
 * Render a `crimes explain` report as a human-readable block. Always
 * includes the suggested `crimes ignore <fingerprint> --reason "…"`
 * command verbatim so an agent or human can copy it without re-deriving
 * the fingerprint.
 */
export function formatExplainReport(
  report: ExplainReport,
  options: ExplainHumanReportOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const f = report.finding;
  const lines: string[] = [];

  lines.push(...explainHeaderBlock(f, colour));

  lines.push("");
  lines.push(colour.bold("What this detector looks for"));
  lines.push(`  ${report.detector.description}`);
  lines.push("");
  lines.push(colour.bold("Why it matters"));
  lines.push(`  ${report.why_it_matters || "(no rationale text for this detector)"}`);

  pushSection(lines, evidenceBlock(f, colour));
  pushSection(lines, explainRiskProfileBlock(f, colour));
  pushSection(lines, suggestedActionsBlock(f, colour));
  pushSection(lines, likelyRemediesBlock(report, colour));
  pushSection(lines, relatedFilesBlock(f, colour));

  lines.push("");
  lines.push(
    colour.bold("To suppress (only if the team has decided this is acceptable)"),
  );
  lines.push(`  ${report.suggested_suppression_command}`);

  return lines.join("\n");
}

function explainHeaderBlock(finding: Finding, colour: ColourFns): string[] {
  const lines: string[] = [
    colour.bold("CRIMES EXPLAIN"),
    `${colour.bold("charge:")}    ${finding.charge}`,
    `${colour.bold("type:")}      ${finding.type}`,
    `${colour.bold("severity:")}  ${severityCell(finding.severity, colour)}` +
      `   ${colour.bold("confidence:")} ${finding.confidence.toFixed(2)}`,
    `${colour.bold("file:")}      ${finding.file}`,
  ];
  if (finding.symbol) lines.push(`${colour.bold("symbol:")}    ${finding.symbol}`);
  if (finding.lines) {
    const span = finding.lines[0] === finding.lines[1]
      ? `${finding.lines[0]}`
      : `${finding.lines[0]}–${finding.lines[1]}`;
    lines.push(`${colour.bold("lines:")}     ${span}`);
  }
  if (finding.suppressed === true) {
    lines.push(`${colour.bold("suppressed:")} ${finding.suppression_reason ?? "(no reason)"}`);
  }
  return lines;
}

function pushSection(lines: string[], section: string[]): void {
  if (section.length === 0) return;
  lines.push("");
  lines.push(...section);
}

function evidenceBlock(finding: Finding, colour: ColourFns): string[] {
  if (finding.evidence.length === 0) return [];
  return [
    colour.bold("Evidence"),
    ...finding.evidence.map((ev) => `  · ${colour.dim(ev)}`),
  ];
}

function suggestedActionsBlock(finding: Finding, colour: ColourFns): string[] {
  if (!finding.suggested_actions || finding.suggested_actions.length === 0) return [];
  const lines = [colour.bold("Suggested actions")];
  for (const action of finding.suggested_actions) {
    lines.push(`  · ${action.kind} (risk: ${action.risk})`);
    lines.push(`      ${action.description}`);
  }
  return lines;
}

function likelyRemediesBlock(
  report: ExplainReport,
  colour: ColourFns,
): string[] {
  if (report.likely_remedies.length === 0) return [];
  return [
    colour.bold("Likely remedies"),
    ...report.likely_remedies.map((remedy, index) => `  ${index + 1}. ${remedy}`),
  ];
}

function relatedFilesBlock(finding: Finding, colour: ColourFns): string[] {
  if (!finding.related_files || finding.related_files.length === 0) return [];
  return [
    colour.bold("Related files"),
    ...finding.related_files.map((rel) => `  · ${colour.cyan(rel)}`),
  ];
}

/**
 * "Risk profile" section for `crimes explain`. Each per-finding score
 * is shown alongside its raw evidence (commit count, importer count,
 * test-coverage hint) so the user sees *why* the score is what it is.
 * Returns an empty list when no scoring signal is present.
 */
function explainRiskProfileBlock(
  finding: Finding,
  colour: ColourFns,
): string[] {
  const { churn, test_gap, blast_radius } = finding.scores;
  if (churn === undefined && test_gap === undefined && blast_radius === undefined) {
    return [];
  }
  const lines: string[] = [];
  lines.push(colour.bold("Risk profile"));
  lines.push(
    `  · churn:        ${(churn ?? 0).toFixed(2)} — ` +
      churnExplain(churn ?? 0),
  );
  lines.push(
    `  · test gap:     ${(test_gap ?? 0).toFixed(2)} — ` +
      testGapExplain(test_gap ?? 0),
  );
  lines.push(
    `  · blast radius: ${(blast_radius ?? 0).toFixed(2)} — ` +
      blastRadiusExplain(blast_radius ?? 0),
  );
  return lines;
}

function churnExplain(score: number): string {
  if (score === 0) return "no commits touched this file in the last 90 days";
  if (score >= 1) return "20+ commits in the last 90 days (cap reached)";
  return `~${Math.round(score * 20)} commits in the last 90 days`;
}

function testGapExplain(score: number): string {
  if (score === 0) return "a test file imports this module";
  if (score === 0.5) {
    return "a test file matches this module's name but does not import it";
  }
  if (score >= 1) return "no sibling or __tests__ test file detected";
  return "partial coverage signal";
}

function blastRadiusExplain(score: number): string {
  if (score === 0) return "no other files import this one";
  if (score >= 1) return "50+ transitive importers (cap reached)";
  return `~${Math.round(score * 50)} transitive importers`;
}

function severityCell(s: Severity, colour: ColourFns): string {
  switch (s) {
    case "high":
      return colour.red(colour.bold(s));
    case "medium":
      return colour.yellow(colour.bold(s));
    case "low":
      return colour.dim(colour.bold(s));
  }
}
