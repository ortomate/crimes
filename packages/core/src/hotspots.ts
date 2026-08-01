import { basename, resolve } from "node:path";
import type { CrimesConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { Detector } from "./detector.js";
import type { Finding, Severity } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { collectChurn } from "./git/churn.js";
import { scan } from "./scan.js";

export type HighestSeverity = "none" | Severity;

export interface Hotspot {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Commits in the window that touched this file. 0 for files with no churn. */
  change_count: number;
  /** ISO timestamp of the most recent commit. Omitted when there is no churn. */
  latest_change?: string;
  /** Number of `crimes scan` findings on this file. */
  finding_count: number;
  /** Worst severity present in `finding_count` — `"none"` when finding_count is 0. */
  highest_severity: HighestSeverity;
  /** Aggregate change-risk score, 0-1. See {@link computeRisk}. */
  risk: number;
}

export interface HotspotsReport {
  schema_version: typeof SCHEMA_VERSION;
  /** Discriminator. Always the literal `"hotspots"`. */
  report_type: "hotspots";
  repo: { name: string; root: string };
  /** Echoed `--since` (normalised form not exposed — we keep the user input). */
  since: string;
  /**
   * False when the directory is not a Git repository or `git` is not callable.
   * In that case `change_count` is `0` for every hotspot and `risk` collapses
   * to the severity component only.
   */
  git_available: boolean;
  /**
   * True when the working tree is a shallow clone — commit history is
   * truncated, so churn counts only reflect the slice of history present
   * locally. Agents should treat hotspot rankings as advisory in this
   * case. Absent / `undefined` when `git_available` is false (the
   * detection requires git in the first place).
   */
  history_limited?: boolean;
  /** Short reason string. Only set when `history_limited` is true. */
  history_limited_reason?: string;
  /**
   * Optional presentation metadata. Commands that cap the returned list
   * populate these fields so agents can tell whether more rows exist.
   */
  total_files?: number;
  shown_count?: number;
  hidden_count?: number;
  hotspots: Hotspot[];
}

export interface HotspotsOptions {
  /** Repo root. Defaults to cwd. */
  root?: string;
  /** Git window. Default: "90d". */
  since?: string;
  /** Override config. */
  config?: CrimesConfig;
  /** Override detectors. */
  detectors?: Detector[];
}

const SEVERITY_WEIGHT: Record<HighestSeverity, number> = {
  none: 0,
  low: 0.3,
  medium: 0.6,
  high: 1.0,
};

const SEVERITY_RANK: Record<HighestSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Cap at which churn saturates. Any file with this many commits in the
 * window scores 1.0 on the churn axis.
 */
const CHURN_CAP = 20;

/**
 * Aggregate change-risk score in [0, 1], rounded to 2 decimal places.
 *
 *   risk = 0.6 * churn + 0.4 * severity
 *
 *   churn    = min(change_count / 20, 1)
 *   severity = { none: 0, low: 0.3, medium: 0.6, high: 1.0 }[highest_severity]
 *
 * Deterministic, monotonic in both inputs. No git → churn = 0, so risk
 * degrades cleanly to the severity component only.
 */
export function computeRisk(args: {
  changeCount: number;
  highestSeverity: HighestSeverity;
}): number {
  const churn = Math.min(args.changeCount / CHURN_CAP, 1);
  const severity = SEVERITY_WEIGHT[args.highestSeverity];
  const raw = 0.6 * churn + 0.4 * severity;
  return Math.round(raw * 100) / 100;
}

function highestOf(findings: Finding[]): HighestSeverity {
  let worst: HighestSeverity = "none";
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}

export async function hotspots(options: HotspotsOptions = {}): Promise<HotspotsReport> {
  const root = resolve(options.root ?? process.cwd());
  const config = options.config ?? loadConfig(root);
  const since = options.since ?? "90d";

  const [scanReport, churn] = await Promise.all([
    scan({
      root,
      config,
      ...(options.detectors ? { detectors: options.detectors } : {}),
    }),
    collectChurn({ root, since }),
  ]);

  const filtered = buildHotspotRows(
    scanReport.findings,
    churn.files.map((file) => ({
      file: file.file,
      count: file.changeCount,
      latest: file.latestChange,
    })),
  );

  const report: HotspotsReport = {
    schema_version: SCHEMA_VERSION,
    report_type: "hotspots",
    repo: { name: basename(root), root },
    since,
    git_available: churn.gitAvailable,
    hotspots: filtered,
  };
  if (churn.historyLimited) {
    report.history_limited = true;
    if (churn.historyLimitedReason) {
      report.history_limited_reason = churn.historyLimitedReason;
    }
  }
  return report;
}

interface ChurnRow {
  file: string;
  count: number;
  latest: string;
}

function buildHotspotRows(findings: Finding[], churnRows: ChurnRow[]): Hotspot[] {
  const findingsByFile = groupFindingsByFile(findings);
  const churnByFile = groupChurnByFile(churnRows);
  const rows = Array.from(unionFiles(findingsByFile, churnByFile), (file) =>
    buildHotspotRow(file, findingsByFile.get(file) ?? [], churnByFile.get(file)),
  );
  return rows
    .filter((h) => h.change_count > 0 || h.finding_count > 0)
    .sort(compareHotspots);
}

function groupFindingsByFile(findings: Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    grouped.set(finding.file, [...(grouped.get(finding.file) ?? []), finding]);
  }
  return grouped;
}

function groupChurnByFile(churnRows: ChurnRow[]): Map<string, ChurnRow> {
  return new Map(churnRows.map((row) => [row.file, row]));
}

function unionFiles(
  findingsByFile: Map<string, Finding[]>,
  churnByFile: Map<string, ChurnRow>,
): Set<string> {
  return new Set([...churnByFile.keys(), ...findingsByFile.keys()]);
}

function buildHotspotRow(
  file: string,
  findings: Finding[],
  churnInfo: ChurnRow | undefined,
): Hotspot {
  const changeCount = churnInfo?.count ?? 0;
  const highest = highestOf(findings);
  return {
    file,
    change_count: changeCount,
    ...(churnInfo ? { latest_change: churnInfo.latest } : {}),
    finding_count: findings.length,
    highest_severity: highest,
    risk: computeRisk({ changeCount, highestSeverity: highest }),
  };
}

function compareHotspots(a: Hotspot, b: Hotspot): number {
  if (b.risk !== a.risk) return b.risk - a.risk;
  if (b.change_count !== a.change_count) return b.change_count - a.change_count;
  const severityDelta =
    SEVERITY_RANK[b.highest_severity] - SEVERITY_RANK[a.highest_severity];
  if (severityDelta !== 0) return severityDelta;
  return a.file.localeCompare(b.file);
}
