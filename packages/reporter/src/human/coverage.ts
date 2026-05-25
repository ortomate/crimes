import type { Writable } from "node:stream";
import type { ScanReport } from "@crimes/core";

const PACK_LABELS: Record<string, string> = {
  js: "language-js (.ts/.tsx/.js/.jsx/.mjs/.cjs/.cts/.mts)",
  py: "language-py (.py/.pyi)",
};

/**
 * Per-language coverage breakdown printed by `crimes scan --explain-coverage`.
 * Always invoked when the user passes the flag; renders an explicit
 * "no files discovered" line if coverage is absent.
 */
export function renderCoverageExplain(
  coverage: ScanReport["coverage"],
  out: Writable,
): void {
  if (!coverage) {
    out.write("coverage: no files discovered\n");
    return;
  }
  out.write("\ncoverage breakdown:\n");
  out.write(`  files discovered: ${coverage.files_total}\n`);
  out.write(`  packs loaded: ${coverage.packs_loaded.join(", ") || "(none)"}\n`);
  out.write(`  files by language pack:\n`);
  for (const [packShort, count] of Object.entries(coverage.files_by_language)) {
    const label = PACK_LABELS[packShort] ?? packShort;
    out.write(`    ${label}: ${count}\n`);
  }
  out.write(`  files with only universal coverage: ${coverage.files_universal_only}\n`);
  if (coverage.files_universal_only > 0) {
    const tail =
      coverage.packs_loaded.length === 0
        ? "Install a language pack to expand coverage."
        : "Install or wait for a language pack that covers these extensions.";
    out.write(
      `\n  These files were not claimed by any loaded language pack.\n` +
        `  They received universal-pack checks only (file size, raster\n` +
        `  assets, duplicate filenames, hardcoded localhost/local paths,\n` +
        `  docs link checking). ${tail}\n`,
    );
  }
}

/**
 * One-line coverage banner. Triggers only when >50% of discovered files
 * are universal-only — the case where users might otherwise read the
 * sparse findings list as "nothing wrong" rather than "we couldn't
 * parse most of this repo".
 *
 * Returns the banner string or null when no banner should appear.
 * Caller is responsible for suppressing when stdout isn't a TTY,
 * NO_COLOR is set, or --no-color is passed.
 */
export function buildCoverageBanner(
  coverage: ScanReport["coverage"] | undefined,
): string | null {
  if (!coverage || coverage.files_total === 0) return null;
  const universalRatio = coverage.files_universal_only / coverage.files_total;
  if (universalRatio <= 0.5) return null;

  const packsLabel =
    coverage.packs_loaded.length === 0
      ? "(no language packs loaded)"
      : `(${coverage.packs_loaded.map(shortPackId).join(", ")})`;
  const claimedPct = Math.round((1 - universalRatio) * 100);
  return (
    `coverage: ${coverage.files_total} files, ` +
    `${claimedPct}% covered by language packs ${packsLabel}.\n` +
    `          Run with --explain-coverage for the breakdown.`
  );
}

function shortPackId(full: string): string {
  return full.replace(/^language-/, "");
}
