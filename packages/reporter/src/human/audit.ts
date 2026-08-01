import type {
  AuditConcern,
  AuditSuppressionEntry,
  AuditSuppressionsReport,
} from "@crimes/core";
import type { ColourFns } from "./shared.js";
import { pc, plainColour } from "./shared.js";

export interface AuditSuppressionsHumanReportOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
}

/**
 * Render an `crimes audit-suppressions` report as a human-readable block.
 * Entries with concerns are listed first under a "Flagged" heading; clean
 * entries follow under "Active". Concerns are surfaced inline per row.
 */
export function formatAuditSuppressionsReport(
  report: AuditSuppressionsReport,
  options: AuditSuppressionsHumanReportOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const lines: string[] = [];

  lines.push(colour.bold("CRIMES AUDIT-SUPPRESSIONS"));
  lines.push(colour.dim(`file: ${report.suppressions_path}`));

  if (!report.loaded) {
    lines.push("");
    lines.push(
      colour.green(
        "No suppressions file found. Nothing to audit — run `crimes ignore` to add one.",
      ),
    );
    return lines.join("\n");
  }

  if (report.total === 0) {
    lines.push("");
    lines.push(colour.green("Suppressions file is empty. Nothing to audit."));
    return lines.join("\n");
  }

  lines.push(
    colour.dim(
      `${report.total} suppression${report.total === 1 ? "" : "s"}  ·  ` +
        `${report.flagged_count} flagged`,
    ),
  );

  const flagged = report.entries.filter((e) => e.concerns.length > 0);
  const clean = report.entries.filter((e) => e.concerns.length === 0);

  if (flagged.length > 0) {
    lines.push("");
    lines.push(colour.bold(`Flagged (${flagged.length})`));
    for (const entry of flagged) {
      pushAuditEntry(lines, entry, colour);
    }
  }

  if (clean.length > 0) {
    lines.push("");
    lines.push(colour.bold(`Active (${clean.length})`));
    for (const entry of clean) {
      pushAuditEntry(lines, entry, colour);
    }
  }

  return lines.join("\n");
}

function pushAuditEntry(
  lines: string[],
  entry: AuditSuppressionEntry,
  colour: ColourFns,
): void {
  const ageLabel = `${entry.age_days}d`;
  const head = `  · ${colour.cyan(entry.fingerprint)} ${colour.dim(`(${ageLabel})`)}`;
  lines.push(head);
  lines.push(`      reason: ${entry.reason}`);
  if (entry.created_by) {
    lines.push(`      added by: ${colour.dim(entry.created_by)}`);
  }
  if (entry.concerns.length > 0) {
    lines.push(
      `      ${colour.yellow("concerns:")} ${entry.concerns
        .map((c) => describeConcern(c))
        .join(", ")}`,
    );
  }
}

function describeConcern(c: AuditConcern): string {
  switch (c) {
    case "stale":
      return "older than 180 days";
    case "short_reason":
      return "reason shorter than 16 characters";
    case "vague_reason":
      return "reason looks like a deferral keyword";
  }
}
