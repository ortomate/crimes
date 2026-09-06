import type { ContextReport } from "@crimes/core";

/** A bounded pre-edit briefing, also used as Claude's additionalContext. */
export function formatContextCompactReport(report: ContextReport): string {
  const lines = [
    `crimes context ${report.file}: ${report.risk.level} risk (${report.risk.high} high, ${report.risk.medium} medium, ${report.risk.low} low)`,
  ];
  lines.push(`Root: ${report.repo.root}`);
  lines.push(
    `Analysis: ${report.analysis_status ?? "unknown"}. Findings are review leads; an empty list does not establish safety.`,
  );
  const warnings = (report.coverage?.warnings ?? []).filter((warning) =>
    [
      "index_unavailable",
      "index_truncated",
      "files_unreadable",
      "files_unparsed",
      "files_partial_parse",
      "working_set_path_unmatched",
    ].includes(warning.kind),
  );
  for (const warning of warnings.slice(0, 3))
    lines.push(`${warning.kind}: ${warning.detail}`);
  if (warnings.length > 3)
    lines.push(
      `Plus ${warnings.length - 3} coverage warnings; inspect context --format json.`,
    );
  if (report.findings.length > 0) {
    lines.push("Top findings:");
    for (const finding of report.findings.slice(0, 3)) {
      const location = finding.lines ? `:${finding.lines[0]}-${finding.lines[1]}` : "";
      lines.push(
        `- ${finding.severity.toUpperCase()} ${finding.charge} ${finding.file}${location} (${finding.fingerprint})`,
      );
      if (finding.evidence[0]) lines.push(`  ${finding.evidence[0]}`);
    }
    if (report.findings.length > 3)
      lines.push(`- plus ${report.findings.length - 3} more`);
  } else {
    lines.push(
      report.analysis_status === "complete"
        ? "No findings for this file under the configured analysis."
        : "No findings available; review the analysis limits above.",
    );
  }
  const guidance = report.agent_guidance.slice(0, 2);
  if (guidance.length > 0) lines.push(`Agent notes: ${guidance.join(" ")}`);
  if (report.likely_tests.length > 0) {
    lines.push(
      `Likely tests (discovery, not executed coverage): ${report.likely_tests.slice(0, 3).join(", ")}`,
    );
  } else if (report.likely_tests_reason) {
    lines.push(`Likely tests: ${report.likely_tests_reason}`);
  }
  return lines.join("\n");
}
