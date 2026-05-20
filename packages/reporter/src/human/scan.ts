import type { Finding, ScanReport, Severity } from "@crimes/core";
import { formatBlastRadius, formatChurn } from "./score-format.js";
import type { ColourFns, FeedbackHintOptions } from "./shared.js";
import { pc, plainColour, renderFinding, severityGlyph } from "./shared.js";

export interface HumanReportOptions {
  /** When true, every finding is shown. Otherwise the top N. */
  showAll?: boolean;
  /**
   * Default cap on findings shown by the legacy (`--flat`) layout when
   * `showAll` is false.
   */
  topN?: number;
  /**
   * Default cap on file groups shown by the new file-grouped layout.
   * Ignored when `showAll` or `flat` is set.
   */
  topFiles?: number;
  /** Disable ANSI colour output. */
  noColor?: boolean;
  /**
   * When true, revert to today's severity-grouped layout (preserved for
   * users that grep stdout or otherwise depended on the previous
   * presentation).
   */
  flat?: boolean;
  /** Inline feedback hints (0.7.0). Suppressed when `noColor` is true. */
  feedbackHints?: FeedbackHintOptions;
}

const DEFAULT_TOP_N = 10;
const DEFAULT_TOP_FILES = 5;

/**
 * Default `crimes scan` human formatter.
 *
 * Layout (release A):
 *   - Header: `CRIME SCENE REPORT` + repo / counts line.
 *   - Empty state: green sparkle line, unchanged.
 *   - `--flat`: bit-for-bit identical to today's severity-grouped layout
 *     (delegates to {@link formatHumanReportFlat}).
 *   - `--all`: flat rank-ordered list of every finding, both tiers, with
 *     the full per-finding block (charge / summary / evidence).
 *   - Default: domain findings grouped by file (top N by Σ rank_score);
 *     each file gets a one-line compact entry per finding, a per-file
 *     `Risk:` summary, and an `id=...` reference range. Non-domain
 *     findings are summarised in an "Also flagged elsewhere" footer that
 *     buckets by path prefix.
 *   - All paths end with a single imperative action-close line pointing
 *     at the highest-risk file.
 */
export function formatHumanReport(
  report: ScanReport,
  options: HumanReportOptions = {},
): string {
  if (options.flat) return formatHumanReportFlat(report, options);

  const colour = options.noColor ? plainColour() : pc;
  const showAll = options.showAll === true;
  const noColor = options.noColor === true;
  const topFiles = options.topFiles ?? DEFAULT_TOP_FILES;

  const lines: string[] = [];
  lines.push(colour.bold("CRIME SCENE REPORT"));
  const fileCount = new Set(report.findings.map((f) => f.file)).size;
  if (report.findings.length === 0) {
    lines.push(
      colour.dim(`repo: ${report.repo.name}  ·  0 findings`),
    );
    lines.push("");
    const cleanPrefix = noColor ? "" : "✨ ";
    lines.push(colour.green(`${cleanPrefix}No crimes detected. Suspiciously clean.`));
    return lines.join("\n");
  }
  lines.push(
    colour.dim(
      `repo: ${report.repo.name}  ·  ${report.findings.length} finding${
        report.findings.length === 1 ? "" : "s"
      } across ${fileCount} file${fileCount === 1 ? "" : "s"}`,
    ),
  );

  // Partition resurfaced findings out of both tiers so they appear only
  // in the resurface block above, not duplicated below in the top-files
  // list. Resurface flag is set by the scan pipeline (Task 9).
  const isResurfaced = (f: Finding): boolean =>
    f.previously_triaged === true || f.previously_baselined === true;
  const resurfaced = report.findings.filter(isResurfaced);
  const fresh = report.findings.filter((f) => !isResurfaced(f));
  const domain = fresh.filter((f) => f.tier !== "nonDomain");
  const nonDomain = fresh.filter((f) => f.tier === "nonDomain");

  if (resurfaced.length > 0) {
    lines.push("");
    lines.push(
      colour.bold(
        "You're editing files you previously triaged — was this still intentional?",
      ),
    );
    renderResurfaceBlock(lines, resurfaced, colour, noColor);
  }

  if (showAll) {
    // Flat rank-ordered list of every finding.
    lines.push("");
    report.findings.forEach((finding, idx) => {
      lines.push(
        ...renderFinding(finding, idx + 1, colour, {
          alwaysShowRiskProfile: true,
          feedbackHints: options.feedbackHints,
          noColor,
        }),
      );
      lines.push("");
    });
    // Trailing summary line.
    lines.push(summaryLine(report, colour));
  } else if (domain.length === 0) {
    // All-non-domain edge case.
    const groupedNon = groupByFile(nonDomain);
    const shown = groupedNon.slice(0, topFiles);
    lines.push("");
    lines.push(colour.bold("All findings are in non-domain folders"));
    renderFileGroups(lines, shown, colour, noColor);
    if (groupedNon.length > shown.length) {
      lines.push("");
      lines.push(
        colour.dim(
          `Showing ${shown.length} of ${groupedNon.length} files. Run with --all for every finding.`,
        ),
      );
    }
    lines.push("");
    const topFile = shown[0]!.file;
    lines.push(
      `→ Start with \`crimes context ${topFile}\` — every finding is in non-domain folders; review your scopeTiers config if that surprises you.`,
    );
  } else {
    const groupedDomain = groupByFile(domain);
    const shown = groupedDomain.slice(0, topFiles);
    lines.push("");
    lines.push(colour.bold("Top files by risk"));
    renderFileGroups(lines, shown, colour, noColor);

    if (groupedDomain.length > shown.length) {
      lines.push("");
      lines.push(
        colour.dim(
          `Showing ${shown.length} of ${groupedDomain.length} files. Run with --all for every finding.`,
        ),
      );
    }

    if (nonDomain.length > 0) {
      lines.push("");
      lines.push(colour.bold("Also flagged elsewhere"));
      lines.push(colour.dim(`  ${nonDomainCountsLine(nonDomain)}`));
      lines.push(colour.dim(`  Run with --all to see them.`));
    }

    lines.push("");
    lines.push(
      `→ Start with \`crimes context ${shown[0]!.file}\` — it concentrates the most risk in this scan.`,
    );
  }

  if (report.suppressed_count && report.suppressed_count > 0) {
    lines.push("");
    lines.push(
      colour.dim(
        `${report.suppressed_count} finding${
          report.suppressed_count === 1 ? "" : "s"
        } suppressed; run with --show-suppressed to see.`,
      ),
    );
  }

  return lines.join("\n");
}

/**
 * Legacy severity-grouped layout. Preserved bit-for-bit so `--flat`
 * users (greppers, downstream parsers that snapshot the old format) can
 * keep running without changes.
 */
function formatHumanReportFlat(
  report: ScanReport,
  options: HumanReportOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const topN = options.topN ?? DEFAULT_TOP_N;
  const showAll = options.showAll ?? false;

  const lines: string[] = [];
  lines.push(colour.bold("CRIME SCENE REPORT"));
  lines.push(
    colour.dim(
      `repo: ${report.repo.name}  ·  ${report.findings.length} finding${
        report.findings.length === 1 ? "" : "s"
      }`,
    ),
  );
  lines.push("");

  if (report.findings.length === 0) {
    const cleanPrefix = options.noColor ? "" : "✨ ";
    lines.push(colour.green(`${cleanPrefix}No crimes detected. Suspiciously clean.`));
    return lines.join("\n");
  }

  const shown = showAll ? report.findings : report.findings.slice(0, topN);
  const grouped = groupBySeverity(shown);

  for (const sev of ["high", "medium", "low"] as const) {
    const group = grouped[sev];
    if (group.length === 0) continue;
    lines.push(severityHeading(sev, group.length, colour, options.noColor === true));
    group.forEach((finding, idx) => {
      lines.push(
        ...renderFinding(finding, idx + 1, colour, {
          alwaysShowRiskProfile: showAll,
          feedbackHints: options.feedbackHints,
          noColor: options.noColor === true,
        }),
      );
      lines.push("");
    });
  }

  if (!showAll && report.findings.length > shown.length) {
    const hidden = report.findings.length - shown.length;
    lines.push(
      colour.dim(
        `Showing top ${shown.length} of ${report.findings.length}. Run with --all to see ${hidden} more.`,
      ),
    );
  }

  lines.push("");
  lines.push(summaryLine(report, colour));

  if (report.suppressed_count && report.suppressed_count > 0) {
    lines.push(
      colour.dim(
        `${report.suppressed_count} finding${
          report.suppressed_count === 1 ? "" : "s"
        } suppressed; run with --show-suppressed to see.`,
      ),
    );
  }

  return lines.join("\n");
}

function severityHeading(
  sev: Severity,
  count: number,
  colour: ColourFns,
  noColor: boolean,
): string {
  const label = `${severityGlyph(sev, noColor)}${sev.toUpperCase()} severity (${count})`;
  switch (sev) {
    case "high":
      return colour.red(colour.bold(label));
    case "medium":
      return colour.yellow(colour.bold(label));
    case "low":
      return colour.dim(colour.bold(label));
  }
}

function summaryLine(report: ScanReport, colour: ColourFns): string {
  const { high, medium, low, total } = report.summary;
  return colour.dim(
    `Total ${total}  ·  ${colour.red(`high ${high}`)}  ${colour.yellow(`medium ${medium}`)}  ${colour.dim(`low ${low}`)}`,
  );
}

export interface ScanFailOnLineOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
}

/**
 * Render the trailing OK / FAILED gate line that `crimes scan --changed
 * --fail-on <severity>` prints after the standard human report.
 *
 * Requires `report.fail_on` to be set — i.e. the report was produced via
 * {@link applyScanFailOn} from `@crimes/core`. The line is intentionally
 * short and self-contained so it reads cleanly inside CI logs.
 */
export function formatScanFailOnLine(
  report: ScanReport,
  options: ScanFailOnLineOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const failOn = report.fail_on ?? "medium";
  const glyph = options.noColor ? "" : (report.failed ? "❌ " : "✅ ");
  if (report.failed) {
    return colour.red(
      colour.bold(
        `${glyph}FAILED: at least one finding at or above "${failOn}" severity in the changed set.`,
      ),
    );
  }
  return colour.green(
    colour.bold(
      `${glyph}OK: no findings at or above "${failOn}" severity in the changed set.`,
    ),
  );
}

function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const groups: Record<Severity, Finding[]> = { high: [], medium: [], low: [] };
  for (const f of findings) groups[f.severity].push(f);
  return groups;
}

interface FileGroup {
  file: string;
  findings: Finding[];
  totalRankScore: number;
  maxSeverity: Severity;
  severityCounts: Record<Severity, number>;
}

function rankScore(f: Finding): number {
  const agentRisk = f.scores.agent_risk ?? 0;
  const recency = f.scores.recency ?? 0;
  return agentRisk * (1 + recency * 0.5);
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Bucket findings by `file`, sort by Σ rank_score desc. Preserves the
 * input order of findings within each group (the scanner already
 * orders them by rank_score desc, so the highest-risk finding in a
 * file lands first).
 */
function groupByFile(findings: Finding[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of findings) {
    const existing = groups.get(f.file);
    if (existing) {
      existing.findings.push(f);
      existing.totalRankScore += rankScore(f);
      existing.maxSeverity = maxSeverity(existing.maxSeverity, f.severity);
      existing.severityCounts[f.severity] += 1;
    } else {
      groups.set(f.file, {
        file: f.file,
        findings: [f],
        totalRankScore: rankScore(f),
        maxSeverity: f.severity,
        severityCounts: {
          high: f.severity === "high" ? 1 : 0,
          medium: f.severity === "medium" ? 1 : 0,
          low: f.severity === "low" ? 1 : 0,
        },
      });
    }
  }
  return Array.from(groups.values()).sort(
    (a, b) => b.totalRankScore - a.totalRankScore,
  );
}

/**
 * Render the per-file blocks for the new layout. Each block has:
 *   - A header line: severity glyph + file + tally
 *     (e.g. `4 findings · 2 high, 1 medium, 1 low`).
 *   - One compact line per finding: `   N. {charge} · {symbol}   {evidence}`.
 *   - A `Risk:` summary line aggregating max churn / dominant test_gap
 *     label / max blast radius across the file's findings (when any of
 *     those scores are populated).
 *   - An `id=<first>..<last>` reference line when the file has more
 *     than one finding, so users can map a row back to a JSON entry.
 */
function renderFileGroups(
  lines: string[],
  groups: FileGroup[],
  colour: ColourFns,
  noColor: boolean,
): void {
  groups.forEach((group, groupIdx) => {
    if (groupIdx > 0) lines.push("");
    const glyph = severityGlyph(group.maxSeverity, noColor);
    const tally = fileTally(group);
    lines.push(`${glyph}${colour.bold(group.file)}  ${colour.dim(tally)}`);
    group.findings.forEach((f, idx) => {
      lines.push(formatFindingCompactLine(f, idx + 1, colour));
    });
    const risk = fileRiskSummary(group);
    if (risk) {
      lines.push(`     ${colour.bold("Risk:")} ${colour.dim(risk)}`);
    }
    if (group.findings.length > 1) {
      const first = group.findings[0]!.id;
      const last = group.findings[group.findings.length - 1]!.id;
      lines.push(`     ${colour.dim(`id=${first} … ${last}`)}`);
    } else {
      lines.push(`     ${colour.dim(`id=${group.findings[0]!.id}`)}`);
    }
  });
}

/**
 * Renders the "you previously triaged" pre-block. Each resurfaced
 * finding gets the `▼` glyph (or prose marker in --no-color) plus a
 * one-liner with its prior disposition / reason / owner / date. Files
 * are listed in finding order; per-file "Touch this disposition" hint
 * points the user back to `crimes triage --retriage <file>`.
 */
function renderResurfaceBlock(
  lines: string[],
  resurfaced: Finding[],
  colour: ColourFns,
  noColor: boolean,
): void {
  const byFile = new Map<string, Finding[]>();
  for (const f of resurfaced) {
    const existing = byFile.get(f.file);
    if (existing) existing.push(f);
    else byFile.set(f.file, [f]);
  }
  let first = true;
  for (const [file, findings] of byFile) {
    lines.push("");
    if (first) first = false;
    const tally = fileTally(toFileGroup(file, findings));
    const glyph = severityGlyph(maxSeverityOf(findings), noColor);
    lines.push(`${glyph}${colour.bold(file)}  ${colour.dim(tally)}`);
    findings.forEach((f, idx) => {
      const marker = noColor ? "*" : "▼";
      const symbol = f.symbol ? ` · ${colour.cyan(`${f.symbol}()`)}` : "";
      lines.push(
        `   ${colour.bold(`${idx + 1}.`)} ${colour.bold(marker)} ${f.charge}${symbol}`,
      );
      const prev = f.previous_triage;
      if (prev) {
        const ownerSegment = prev.owner ? ` · ${prev.owner}` : "";
        lines.push(
          `      ${colour.dim(`${prev.disposition} · "${prev.reason}"${ownerSegment} (${prev.date})`)}`,
        );
      } else if (f.previously_baselined) {
        const dateSegment = f.previous_baseline?.date
          ? ` (${f.previous_baseline.date})`
          : "";
        lines.push(
          `      ${colour.dim(`previously baselined${dateSegment}`)}`,
        );
      }
    });
    lines.push(
      `     ${colour.dim(`Touch this disposition: crimes triage --retriage ${file}`)}`,
    );
  }
}

function toFileGroup(file: string, findings: Finding[]): FileGroup {
  let high = 0;
  let medium = 0;
  let low = 0;
  let totalRankScore = 0;
  for (const f of findings) {
    if (f.severity === "high") high += 1;
    else if (f.severity === "medium") medium += 1;
    else low += 1;
    totalRankScore += rankScore(f);
  }
  return {
    file,
    findings,
    severityCounts: { high, medium, low },
    maxSeverity: high > 0 ? "high" : medium > 0 ? "medium" : "low",
    totalRankScore,
  };
}

function maxSeverityOf(findings: Finding[]): "low" | "medium" | "high" {
  let best: "low" | "medium" | "high" = "low";
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
  if (group.severityCounts.medium > 0) parts.push(`${group.severityCounts.medium} medium`);
  if (group.severityCounts.low > 0) parts.push(`${group.severityCounts.low} low`);
  return `${total} finding${total === 1 ? "" : "s"} · ${parts.join(", ")}`;
}

/**
 * One compact, single-line per-finding row inside a file block:
 *   `   N. {charge} · {symbol}   {first 1–2 evidence strings, ", "-joined}`
 *
 * Evidence is capped at 2 strings to keep the row readable in a typical
 * terminal; the full evidence array is still available via `--all` and
 * the JSON output.
 */
function formatFindingCompactLine(
  f: Finding,
  n: number,
  colour: ColourFns,
): string {
  const symbol = f.symbol ? ` · ${colour.cyan(`${f.symbol}()`)}` : "";
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

/**
 * Per-file Risk summary line: max churn, dominant test_gap label, max
 * blast radius. Returns undefined when none of these scores are set on
 * any finding in the file (so stub-style findings stay clean).
 *
 * `dominant test_gap label` is chosen by majority of quartile buckets
 * across the file's findings, falling back to the highest bucket on a
 * tie (top-quartile beats ~median beats bottom-quartile) since
 * higher-gap is the safer signal to surface.
 */
function fileRiskSummary(group: FileGroup): string | undefined {
  let maxChurn: number | undefined;
  let maxBlast: number | undefined;
  const testGapBuckets: Record<TestGapBucket, number> = {
    "top-quartile": 0,
    "~median": 0,
    "bottom-quartile": 0,
    unknown: 0,
  };
  let anyTestGap = false;
  for (const f of group.findings) {
    if (f.scores.churn !== undefined) {
      maxChurn = maxChurn === undefined ? f.scores.churn : Math.max(maxChurn, f.scores.churn);
    }
    if (f.scores.blast_radius !== undefined) {
      maxBlast = maxBlast === undefined ? f.scores.blast_radius : Math.max(maxBlast, f.scores.blast_radius);
    }
    if (f.scores.test_gap !== undefined) {
      anyTestGap = true;
      testGapBuckets[testGapBucket(f.scores.test_gap)] += 1;
    }
  }
  if (maxChurn === undefined && maxBlast === undefined && !anyTestGap) {
    return undefined;
  }
  const parts: string[] = [];
  if (maxChurn !== undefined) parts.push(`churn ${formatChurn(maxChurn)}`);
  if (anyTestGap) parts.push(`test gap ${dominantTestGap(testGapBuckets)}`);
  if (maxBlast !== undefined) {
    parts.push(`blast ${formatBlastRadius(maxBlast)}`);
  }
  return parts.join(" · ");
}

type TestGapBucket = "top-quartile" | "~median" | "bottom-quartile" | "unknown";

function testGapBucket(score: number): TestGapBucket {
  if (score >= 0.75) return "top-quartile";
  if (score <= 0.25) return "bottom-quartile";
  return "~median";
}

/**
 * Pick the dominant quartile bucket across a file's findings.
 * Tie-breaks by preferring the higher-risk bucket (more conservative
 * surfaces the more alarming label).
 */
function dominantTestGap(buckets: Record<TestGapBucket, number>): TestGapBucket {
  const order: TestGapBucket[] = [
    "top-quartile",
    "~median",
    "bottom-quartile",
    "unknown",
  ];
  let bestBucket: TestGapBucket = "unknown";
  let bestCount = -1;
  for (const bucket of order) {
    if (buckets[bucket] > bestCount) {
      bestCount = buckets[bucket];
      bestBucket = bucket;
    }
  }
  return bestBucket;
}

/**
 * Summarise non-domain findings as a one-line breakdown by path
 * prefix. Buckets (in priority order):
 *   - `scripts/` — anything under `scripts/`
 *   - `examples/`
 *   - `fixtures/`
 *   - `public/`
 *   - `tests/` — `*.test.*`, `*.spec.*`, or anything inside a
 *     `__tests__` directory at any depth
 *   - everything else falls back to its first path segment
 */
function nonDomainCountsLine(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const bucket = nonDomainBucket(f.file);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted
    .map(([bucket, n]) => `${bucket}  ${n} finding${n === 1 ? "" : "s"}`)
    .join("    ");
}

function nonDomainBucket(file: string): string {
  const lower = file.toLowerCase();
  if (lower.startsWith("scripts/")) return "scripts/";
  if (lower.startsWith("examples/")) return "examples/";
  if (lower.startsWith("fixtures/")) return "fixtures/";
  if (lower.startsWith("public/")) return "public/";
  if (
    /\.test\.[^/]+$/.test(lower) ||
    /\.spec\.[^/]+$/.test(lower) ||
    /(^|\/)__tests__\//.test(lower)
  ) {
    return "tests/";
  }
  // Bare filename with no directory — return it as the bucket label
  // without a trailing slash, since "foo.ts/" reads as wrong.
  if (!file.includes("/")) return file;
  const first = file.split("/")[0];
  return first ? `${first}/` : file;
}
