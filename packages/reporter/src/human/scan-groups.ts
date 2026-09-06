import { fileRiskScore } from "@crimes/core";
import type { Finding, Severity } from "@crimes/core";
import { fileRiskSummary } from "./scan-risk-summary.js";
import type { ColourFns } from "./shared.js";
import { severityGlyph } from "./shared.js";

export interface FileGroup {
  file: string;
  findings: Finding[];
  totalRankScore: number;
  maxSeverity: Severity;
  severityCounts: Record<Severity, number>;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function groupByFile(findings: Finding[], recencyEnabled = true): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of findings) {
    const existing = groups.get(f.file);
    if (existing) {
      existing.findings.push(f);

      existing.maxSeverity = maxSeverity(existing.maxSeverity, f.severity);
      existing.severityCounts[f.severity] += 1;
    } else {
      groups.set(f.file, {
        file: f.file,
        findings: [f],
        totalRankScore: 0,
        maxSeverity: f.severity,
        severityCounts: {
          high: f.severity === "high" ? 1 : 0,
          medium: f.severity === "medium" ? 1 : 0,
          low: f.severity === "low" ? 1 : 0,
        },
      });
    }
  }
  for (const group of groups.values())
    group.totalRankScore = fileRiskScore(group.findings, recencyEnabled);
  return Array.from(groups.values()).sort(
    (a, b) => b.totalRankScore - a.totalRankScore || a.file.localeCompare(b.file),
  );
}

/**
 * Findings shown per file before the rest are counted off.
 *
 * `scan.topFiles` caps how many *files* the default view shows and
 * nothing caps what is printed inside one, so a repo with few files and
 * many findings each got no compression at all — n8n's
 * `instance-ai.service.ts` printed 41 numbered lines under a single
 * heading. That is the opposite of "signal over exhaustiveness", and it
 * is worst exactly where the file cap cannot help.
 *
 * Findings arrive rank-ordered, so the ones kept are the ones that
 * matter most; the tally on the heading line already states the true
 * total, and the count-off line names `--all`.
 */
const FINDINGS_PER_FILE = 8;

export function renderFileGroups(
  lines: string[],
  groups: FileGroup[],
  colour: ColourFns,
  isColorDisabled: boolean,
): void {
  groups.forEach((group, groupIdx) => {
    if (groupIdx > 0) lines.push("");
    const glyph = severityGlyph(group.maxSeverity, isColorDisabled);
    lines.push(`${glyph}${colour.bold(group.file)}  ${colour.dim(fileTally(group))}`);
    group.findings.slice(0, FINDINGS_PER_FILE).forEach((f, idx) => {
      lines.push(formatFindingCompactLine(f, idx + 1, colour));
    });
    if (group.findings.length > FINDINGS_PER_FILE) {
      lines.push(
        `     ${colour.dim(
          `…+${group.findings.length - FINDINGS_PER_FILE} more in this file (--all)`,
        )}`,
      );
    }
    const risk = fileRiskSummary(group.findings);
    if (risk) lines.push(`     ${colour.bold("Risk:")} ${colour.dim(risk)}`);
    lines.push(`     ${colour.dim(idRange(group.findings))}`);
  });
}

export function renderResurfaceBlock(
  lines: string[],
  resurfaced: Finding[],
  colour: ColourFns,
  isColorDisabled: boolean,
): void {
  const byFile = groupFindingsByPath(resurfaced);
  let isFirstGroup = true;
  for (const [file, findings] of byFile) {
    lines.push("");
    if (isFirstGroup) isFirstGroup = false;
    const tally = fileTally(toFileGroup(file, findings));
    const glyph = severityGlyph(maxSeverityOf(findings), isColorDisabled);
    lines.push(`${glyph}${colour.bold(file)}  ${colour.dim(tally)}`);
    findings.forEach((f, idx) => {
      renderResurfacedFinding(lines, f, idx, colour, isColorDisabled);
    });
    lines.push(
      `     ${colour.dim(`Touch this disposition: crimes triage --retriage ${file}`)}`,
    );
  }
}

export function nonDomainCountsLine(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const bucket = nonDomainBucket(f.file);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, n]) => `${bucket}  ${n} finding${n === 1 ? "" : "s"}`)
    .join("    ");
}

/**
 * Render `Finding.symbol` for the human report.
 *
 * The historical convention appends `()` because `symbol` used to hold
 * a function name in every case. From 0.16.0 several detectors use it
 * to carry a **stable identity** instead — `persistOrder → insert`,
 * `admin plan "admin" "free" rule`, `REQUEST_TIMEOUT_MS`,
 * `permissions.allow` — and `persistOrder → insert()` reads as though
 * the arrow were part of a call.
 *
 * So the parentheses are appended only when the symbol looks callable:
 * a plain identifier that is not SCREAMING_SNAKE. Every symbol emitted
 * before 0.16.0 is a plain function or class name, so this leaves all
 * existing output byte-identical.
 */
function formatSymbol(symbol: string): string {
  const looksCallable =
    /^[A-Za-z_$][\w$]*$/.test(symbol) && !/^[A-Z0-9_$]+$/.test(symbol);
  return looksCallable ? `${symbol}()` : symbol;
}

function renderResurfacedFinding(
  lines: string[],
  finding: Finding,
  idx: number,
  colour: ColourFns,
  isColorDisabled: boolean,
): void {
  const marker = isColorDisabled ? "*" : "▼";
  const symbol = finding.symbol ? ` · ${colour.cyan(formatSymbol(finding.symbol))}` : "";
  lines.push(
    `   ${colour.bold(`${idx + 1}.`)} ${colour.bold(marker)} ${finding.charge}${symbol}`,
  );
  if (finding.previous_triage) {
    const prev = finding.previous_triage;
    const ownerSegment = prev.owner ? ` · ${prev.owner}` : "";
    lines.push(
      `      ${colour.dim(`${prev.disposition} · "${prev.reason}"${ownerSegment} (${prev.date})`)}`,
    );
  } else if (finding.previously_baselined) {
    const dateSegment = finding.previous_baseline?.date
      ? ` (${finding.previous_baseline.date})`
      : "";
    lines.push(colour.dim(`      previously baselined${dateSegment}`));
  }
}

function groupFindingsByPath(findings: Finding[]): Map<string, Finding[]> {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const existing = byFile.get(f.file);
    if (existing) existing.push(f);
    else byFile.set(f.file, [f]);
  }
  return byFile;
}

function toFileGroup(file: string, findings: Finding[]): FileGroup {
  const severityCounts = countSeverities(findings);
  return {
    file,
    findings,
    severityCounts,
    maxSeverity:
      severityCounts.high > 0 ? "high" : severityCounts.medium > 0 ? "medium" : "low",
    totalRankScore: fileRiskScore(findings),
  };
}

function countSeverities(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

function maxSeverityOf(findings: Finding[]): Severity {
  let best: Severity = "low";
  for (const f of findings) {
    if (f.severity === "high") return "high";
    if (f.severity === "medium") best = "medium";
  }
  return best;
}

function fileTally(group: FileGroup): string {
  const total = group.findings.length;
  const parts: string[] = [];
  if (group.severityCounts.high > 0) parts.push(`${group.severityCounts.high} high`);
  if (group.severityCounts.medium > 0)
    parts.push(`${group.severityCounts.medium} medium`);
  if (group.severityCounts.low > 0) parts.push(`${group.severityCounts.low} low`);
  return `${total} finding${total === 1 ? "" : "s"} · ${parts.join(", ")}`;
}

function idRange(findings: Finding[]): string {
  if (findings.length === 1) return `id=${findings[0]!.id}`;
  return `id=${findings[0]!.id} … ${findings[findings.length - 1]!.id}`;
}

function formatFindingCompactLine(f: Finding, n: number, colour: ColourFns): string {
  const symbol = f.symbol ? ` · ${colour.cyan(formatSymbol(f.symbol))}` : "";
  const evidence = compactEvidence(f);
  const evidenceSegment = evidence ? `   ${colour.dim(evidence)}` : "";
  const triagedPrefix = f.triaged
    ? `${colour.bold(`▶ ${f.triaged.disposition}`)} · `
    : "";
  return `   ${colour.bold(`${n}.`)} ${triagedPrefix}${f.charge}${symbol}${evidenceSegment}`;
}

function compactEvidence(f: Finding): string {
  if (f.evidence.length === 0) return "";
  return f.evidence.slice(0, 2).join(", ");
}

function nonDomainBucket(file: string): string {
  const lower = file.toLowerCase();
  if (lower.startsWith("scripts/")) return "scripts/";
  if (lower.startsWith("examples/")) return "examples/";
  if (lower.startsWith("fixtures/")) return "fixtures/";
  if (lower.startsWith("public/")) return "public/";
  if (isTestPath(lower)) return "tests/";
  if (!file.includes("/")) return file;
  const firstSegment = file.split("/")[0];
  return firstSegment ? `${firstSegment}/` : file;
}

function isTestPath(lower: string): boolean {
  return (
    /\.test\.[^/]+$/.test(lower) ||
    /\.spec\.[^/]+$/.test(lower) ||
    /(^|\/)__tests__\//.test(lower)
  );
}
