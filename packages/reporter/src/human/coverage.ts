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
  renderUniversalOnlyHistogram(coverage.universal_only_by_extension, out);
  renderByPackage(coverage.by_package, out);
  if (coverage.files_universal_only > 0) {
    const tail =
      languagePacks(coverage.packs_loaded).length === 0
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

  const langPacks = languagePacks(coverage.packs_loaded);
  const packsLabel =
    langPacks.length === 0
      ? "(no language packs loaded)"
      : `(${langPacks.map(shortPackId).join(", ")})`;
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

/** Extensions listed individually before the rest collapse into "other". */
const HISTOGRAM_LIMIT = 6;

/**
 * Break the universal-only bucket down by extension, largest first.
 *
 * Without this the report says "48 files had universal coverage only"
 * and leaves the reader unable to tell whether those are Python files
 * worth a language pack or just .md and .json. Sorted by count so the
 * first line is the answer to "which pack would buy the most here?".
 */
function renderUniversalOnlyHistogram(
  histogram: Record<string, number> | undefined,
  out: Writable,
): void {
  if (!histogram) return;
  const entries = Object.entries(histogram).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return;

  const shown = entries.slice(0, HISTOGRAM_LIMIT);
  const rest = entries.slice(HISTOGRAM_LIMIT);
  for (const [ext, count] of shown) {
    out.write(`    ${ext}: ${count}\n`);
  }
  if (rest.length > 0) {
    const restTotal = rest.reduce((sum, [, n]) => sum + n, 0);
    out.write(
      `    other (${rest.length} extension${rest.length === 1 ? "" : "s"}): ${restTotal}\n`,
    );
  }
}

/**
 * `packs_loaded` reports every pack that ran, including `universal`.
 * Coverage prose is about which *language* packs claimed files, so the
 * universal pack — which claims everything and explains nothing about
 * language support — is filtered out before rendering.
 */
function languagePacks(packsLoaded: readonly string[]): string[] {
  return packsLoaded.filter((p) => p.startsWith("language-"));
}

/**
 * Per-package breakdown, printed only for monorepos (`by_package` is
 * absent otherwise).
 *
 * The repo-wide `files_by_language` can say a repo is 90% TypeScript
 * while one package is entirely Python. This is the line that tells a
 * reader *where* the other language lives, which is what decides
 * whether a change is risky.
 */
function renderByPackage(
  byPackage: NonNullable<ScanReport["coverage"]>["by_package"],
  out: Writable,
): void {
  if (!byPackage || byPackage.length === 0) return;
  out.write(`\n  packages (${byPackage.length}):\n`);
  const width = Math.max(...byPackage.map((p) => p.path.length));
  for (const pkg of byPackage) {
    const langs = Object.entries(pkg.files_by_language)
      .sort((a, b) => b[1] - a[1])
      .map(([short, n]) => `${short} ${n}`)
      .join(", ");
    const dominant =
      pkg.dominant_language === null
        ? langs.length > 0
          ? " — mixed"
          : " — no language pack claimed these"
        : "";
    out.write(
      `    ${pkg.path.padEnd(width)}  ${String(pkg.files_total).padStart(4)} files` +
        (langs.length > 0 ? `  (${langs})` : "") +
        `${dominant}\n`,
    );
  }
}
