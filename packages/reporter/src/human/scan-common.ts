import type { ScanReport } from "@crimes/core";
import type { ColourFns } from "./shared.js";

/**
 * The report's one-line summary: repo, totals, severity split.
 *
 * Rendered twice on a long report — once as the header, once just above
 * the action-close — and both call sites use this function so the two
 * are byte-identical. Two phrasings of one fact read as two facts.
 *
 * **It counts what the report shows.** The default view lists only
 * domain findings; non-domain ones (`scopeTiers.nonDomain`, whose first
 * default entry is `scripts/**`) are collapsed into a one-line "Also
 * flagged elsewhere" footer. The header used to count both, so on
 * choreograph.cc it announced *491 findings across 208 files* above a
 * report body listing 339 across 137 — describing a superset of itself.
 *
 * That is the mechanism behind "the headline number is demoralising and
 * not actionable": a third of the number was findings the report had
 * already decided not to show. The remainder is still stated, so nothing
 * is hidden — and `summary.total` is untouched, because the renderer is
 * a view and the JSON is the contract.
 */
export function scanSummaryLine(
  report: ScanReport,
  colour: ColourFns,
  options: { showAll?: boolean } = {},
): string {
  const domain = report.findings.filter((f) => f.tier !== "nonDomain");
  // Fall back to counting everything when the body is going to list
  // everything: under `--all`, and when *every* finding is non-domain
  // (the renderer has its own "All findings are in non-domain folders"
  // branch for that). Otherwise the header would read "0 findings" above
  // a page of them.
  const listsEverything = options.showAll === true || domain.length === 0;
  const shown = listsEverything ? report.findings : domain;
  const hidden = listsEverything ? 0 : report.findings.length - domain.length;

  const fileCount = new Set(shown.map((f) => f.file)).size;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of shown) counts[f.severity] += 1;

  const remainder =
    hidden > 0 ? `  ·  ${colour.dim(`+${hidden} in non-domain paths`)}` : "";
  return colour.dim(
    `repo: ${report.repo.name}  ·  ${shown.length} finding${
      shown.length === 1 ? "" : "s"
    } across ${fileCount} file${fileCount === 1 ? "" : "s"}  ·  ` +
      `${colour.red(`${counts.high} high`)}  ${colour.yellow(`${counts.medium} medium`)}  ${colour.dim(
        `${counts.low} low`,
      )}${remainder}`,
  );
}

/**
 * Repeat the summary just above the report's closing line, but only on a
 * report long enough that the header has scrolled away.
 *
 * Field notes from choreograph.cc: `scan --top 15` on a 209-file repo
 * emits 296 lines, so the header — line 6 — was gone by the time the
 * reader reached the end, and a second run at `--top 3` was needed *just
 * to read the totals*.
 *
 * It goes above the close rather than after it: the 0.10.0 front-door
 * redesign deliberately ends the report on `→ Start with crimes context
 * <file>`, which is the single most actionable line an agent gets, and
 * that decision stands.
 */
export function pushSummaryRepeat(
  lines: string[],
  report: ScanReport,
  colour: ColourFns,
  options: { showAll?: boolean } = {},
): void {
  if (lines.length < SUMMARY_REPEAT_MIN_LINES) return;
  lines.push("");
  lines.push(scanSummaryLine(report, colour, options));
}

/**
 * Below this many rendered lines, the header and the close are on the
 * same screen and repeating one would just be saying it twice. Set
 * conservatively against a short terminal rather than a tall one — the
 * cost of an unnecessary repeat is one line, and the cost of a missing
 * one is a whole second scan.
 */
const SUMMARY_REPEAT_MIN_LINES = 40;

export function severityCountsLine(report: ScanReport, colour: ColourFns): string {
  const { high, medium, low } = report.summary;
  return `${colour.red(`${high} high`)}  ${colour.yellow(`${medium} medium`)}  ${colour.dim(`${low} low`)}`;
}

export function suppressedCountLine(report: ScanReport): string | undefined {
  if (!report.suppressed_count || report.suppressed_count <= 0) {
    return undefined;
  }
  return `${report.suppressed_count} finding${
    report.suppressed_count === 1 ? "" : "s"
  } suppressed; run with --show-suppressed to see.`;
}
