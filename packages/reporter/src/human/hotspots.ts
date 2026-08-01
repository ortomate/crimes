import type { HighestSeverity, Hotspot, HotspotsReport } from "@crimes/core";
import type { ColourFns } from "./shared.js";
import { pc, plainColour } from "./shared.js";

export interface HotspotsHumanReportOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
  /** When true, every hotspot is shown. Otherwise the top N. */
  showAll?: boolean;
  /** Default cap on hotspots shown when `showAll` is false. */
  topN?: number;
}

const DEFAULT_HOTSPOTS_TOP_N = 20;

export function formatHotspotsReport(
  report: HotspotsReport,
  options: HotspotsHumanReportOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const topN = options.topN ?? DEFAULT_HOTSPOTS_TOP_N;
  const showAll = options.showAll ?? false;

  const lines: string[] = [];
  lines.push(colour.bold("CRIMES HOTSPOTS"));
  lines.push(
    colour.dim(
      `repo: ${report.repo.name}  ·  since ${report.since}  ·  ${
        report.hotspots.length
      } file${report.hotspots.length === 1 ? "" : "s"}`,
    ),
  );

  if (!report.git_available) {
    lines.push(
      colour.yellow("  (not a git repo — ranking by findings only; no churn signal)"),
    );
  } else if (report.history_limited) {
    // Same warning line position as the not-a-git-repo notice — agents
    // and humans look here first when the ranking feels off.
    const reason =
      report.history_limited_reason ?? "shallow clone — older commits are unavailable";
    lines.push(colour.yellow(`  (history limited: ${reason})`));
  }

  lines.push("");

  if (report.hotspots.length === 0) {
    lines.push(
      colour.green(
        "No hotspots found. Either the repo is calm or the window is too narrow.",
      ),
    );
    return lines.join("\n");
  }

  const shown = showAll ? report.hotspots : report.hotspots.slice(0, topN);
  for (const [idx, h] of shown.entries()) {
    lines.push(...renderHotspot(h, idx + 1, colour));
    lines.push("");
  }

  if (!showAll && report.hotspots.length > shown.length) {
    const hidden = report.hotspots.length - shown.length;
    lines.push(
      colour.dim(
        `Showing top ${shown.length} of ${report.hotspots.length}. Run with --all to see ${hidden} more.`,
      ),
    );
  }

  return lines.join("\n");
}

function renderHotspot(h: Hotspot, n: number, colour: ColourFns): string[] {
  const out: string[] = [];
  out.push(
    `  ${colour.bold(`${n}.`)} ${colour.cyan(h.file)}  ${riskBadge(h.risk, colour)}`,
  );
  const churnLine = h.latest_change
    ? `${h.change_count} change${h.change_count === 1 ? "" : "s"} · latest ${h.latest_change.slice(0, 10)}`
    : `${h.change_count} change${h.change_count === 1 ? "" : "s"}`;
  out.push(`     ${colour.dim(churnLine)}`);
  out.push(
    `     ${colour.dim(
      `${h.finding_count} finding${h.finding_count === 1 ? "" : "s"} · highest ${severityLabel(h.highest_severity, colour)}`,
    )}`,
  );
  return out;
}

function riskBadge(risk: number, colour: ColourFns): string {
  const pct = (risk * 100).toFixed(0).padStart(2, " ");
  const label = `risk ${risk.toFixed(2)} (${pct}%)`;
  if (risk >= 0.7) return colour.red(colour.bold(label));
  if (risk >= 0.4) return colour.yellow(colour.bold(label));
  return colour.dim(label);
}

function severityLabel(sev: HighestSeverity, colour: ColourFns): string {
  switch (sev) {
    case "high":
      return colour.red(sev);
    case "medium":
      return colour.yellow(sev);
    case "low":
      return colour.dim(sev);
    case "none":
      return colour.green(sev);
  }
}
