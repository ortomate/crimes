import type { Writable } from "node:stream";
import { isSkippedWorkKind, type ScanReport } from "@crimes/core";

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
  renderWarnings(coverage.warnings, out);
  if (coverage.detectors_default_off?.length) {
    out.write(`  optional detectors off: ${coverage.detectors_default_off.join(", ")}\n`);
    out.write(`  Enable selected ids with detectors.enable in crimes.config.json.\n`);
  }
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

/**
 * Short notice for work the scan skipped. Printed on every human scan
 * that has warnings, not just under `--explain-coverage`: the whole
 * failure mode this field exists for is a confident report over a
 * fraction of a repo, and a warning nobody sees does not fix it.
 *
 * Names the two largest gaps and defers the rest, which keeps the
 * notice to four lines on the worst repo we have measured.
 *
 * Returns null when there is nothing to say. Unlike the coverage
 * banner this is content rather than decoration, so the caller should
 * print it regardless of TTY / colour settings.
 */
export function buildCoverageWarningNotice(
  coverage: ScanReport["coverage"] | undefined,
): string | null {
  const all = coverage?.warnings;
  if (!all || all.length === 0) return null;

  // A lapsed triage or suppression pin is in this array too, and its
  // files were scanned normally. Adding it to "N files were not
  // analysed" would make the field that exists to expose silent skips
  // state a confident false number. It gets its own notice instead --
  // see `buildUnmatchedPinsNotice`.
  const warnings = all.filter((w) => isSkippedWorkKind(w.kind));
  if (warnings.length === 0) return null;

  const totalFiles = warnings.reduce((sum, w) => sum + w.files, 0);
  const lines = [
    `skipped: ${totalFiles} file${totalFiles === 1 ? "" : "s"} were not analysed ` +
      `(${warnings.length} reason${warnings.length === 1 ? "" : "s"}). ` +
      `Findings below cover the rest.`,
  ];
  for (const warning of warnings.slice(0, NOTICE_LIMIT)) {
    lines.push(`         ${warning.files} × ${warning.subject} (${warning.kind})`);
  }
  const rest = warnings.length - NOTICE_LIMIT;
  if (rest > 0) {
    lines.push(`         + ${rest} more reason${rest === 1 ? "" : "s"}`);
  }
  lines.push("         Run with --explain-coverage for the full list.");
  return lines.join("\n");
}

/** Warning buckets named in the short notice before it defers. */
const NOTICE_LIMIT = 2;

/**
 * Notice for recorded decisions that stopped applying.
 *
 * Separate from the skipped-work notice above, and not folded into it,
 * for the reason `emitUnmatchedWorkingSetPaths` exists: that notice
 * names its two largest buckets and defers the rest to `+N more
 * reasons`, so on any real repo this would be the deferred line nobody
 * reads. The whole failure being fixed here is that the news arrived
 * nowhere -- burying it two lines further down would not fix it.
 *
 * `superseded` leads when present. It is the only half that is bad
 * news: the finding is back and unsilenced. The other half most likely
 * means somebody fixed something, and is phrased so it cannot be
 * misread as a problem.
 *
 * Returns null when there is nothing to say. Content, not decoration --
 * print it regardless of TTY / colour, exactly like the skipped notice.
 */
export function buildUnmatchedPinsNotice(
  coverage: ScanReport["coverage"] | undefined,
): string | null {
  const pins = (coverage?.warnings ?? []).filter((w) => !isSkippedWorkKind(w.kind));
  if (pins.length === 0) return null;

  const total = pins.reduce((sum, w) => sum + (w.entries ?? 0), 0);
  const lines = [
    `stale pins: ${total} recorded ${total === 1 ? "entry" : "entries"} ` +
      `match no finding in this scan.`,
  ];
  // Sorted so the alarm leads regardless of the array's file-count
  // order, and so the same tree always prints the same lines.
  const ordered = [...pins].sort(
    (a, b) =>
      Number(b.subject === "superseded") - Number(a.subject === "superseded") ||
      a.kind.localeCompare(b.kind),
  );
  for (const pin of ordered) {
    const n = pin.entries ?? 0;
    const file = pin.kind === "triage_entries_unmatched" ? "triage" : "suppressions";
    lines.push(
      pin.subject === "superseded"
        ? `            ${n} × ${file}: still reported under a new fingerprint — ` +
            `NOT silenced any more`
        : `            ${n} × ${file}: nothing of that kind is reported there now ` +
            `(likely fixed)`,
    );
  }
  lines.push("            Run with --explain-coverage for the detail.");
  return lines.join("\n");
}

/**
 * Full warning list for `--explain-coverage`. Machine-readable JSON
 * carries the same array; this is the same data with the prose the
 * schema already supplies, so the two never drift.
 */
function renderWarnings(
  warnings: NonNullable<ScanReport["coverage"]>["warnings"],
  out: Writable,
): void {
  if (!warnings || warnings.length === 0) return;
  const skipped = warnings.filter((w) => isSkippedWorkKind(w.kind));
  const pins = warnings.filter((w) => !isSkippedWorkKind(w.kind));
  if (skipped.length > 0) out.write(`\n  skipped work (${skipped.length}):\n`);
  renderWarningRows(skipped, out);
  if (pins.length > 0) {
    // Its own heading because these are not skipped work. Same rows,
    // same prose from the schema -- only the claim above them changes.
    out.write(`\n  recorded decisions that no longer apply (${pins.length}):\n`);
    renderWarningRows(pins, out);
  }
}

function renderWarningRows(
  warnings: readonly NonNullable<
    NonNullable<ScanReport["coverage"]>["warnings"]
  >[number][],
  out: Writable,
): void {
  for (const warning of warnings) {
    const size =
      warning.entries !== undefined
        ? `${warning.entries} entr${warning.entries === 1 ? "y" : "ies"}`
        : `${warning.files} file${warning.files === 1 ? "" : "s"}`;
    out.write(`    [${warning.kind}] ${warning.subject} — ${size}\n`);
    out.write(`      ${warning.detail}\n`);
    if (warning.remedy !== undefined) out.write(`      → ${warning.remedy}\n`);
    if (warning.examples && warning.examples.length > 0) {
      out.write(`      e.g. ${warning.examples.join(", ")}\n`);
    }
  }
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
