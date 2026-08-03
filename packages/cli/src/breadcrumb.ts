import type { CrimesConfig, SuppressionEntry } from "@crimes/core";
import { findFuturePinnedSuppressions } from "@crimes/core";

// Below this count, disabling a handful of detectors is treated as
// ordinary tuning and stays silent. Three or more reads as a deliberate
// project posture worth surfacing.
const DISABLED_DETECTORS_THRESHOLD = 3;

export interface BreadcrumbOptions {
  /**
   * When true, decorative diagnostics are suppressed. Callers should
   * pass the same effective no-color flag they pass to the human
   * reporter — i.e. `--no-color` OR `!process.stdout.isTTY`. The
   * breadcrumb is a diagnostic for interactive humans; piping
   * `crimes scan --format json` shouldn't smear stderr into the
   * agent's pipeline.
   */
  noColor?: boolean;
  /** Override the stderr sink. Tests pass a buffer; CLI uses `process.stderr`. */
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

/**
 * Read the effective "no-color" flag from a Commander options bag.
 * Commander assigns `--no-color` to `options.color = false`, so a raw
 * `options.noColor` (the historical name in this codebase) is always
 * undefined. Falls back to `!process.stdout.isTTY` so piped output
 * stays quiet by default — same convention the human reporter uses.
 */
export function resolveNoColor(options: { color?: boolean; noColor?: boolean }): boolean {
  if (options.color === false) return true;
  if (options.noColor === true) return true;
  return !process.stdout.isTTY;
}

/**
 * Emit the one-line `detectors.disable` breadcrumb to stderr when a
 * `crimes.config.json` has wholesale-disabled a meaningful chunk of
 * the built-in detector set. Idempotent at the call site (each command
 * invokes it once), no-ops otherwise.
 *
 *   crimes: detectors.disable removed 5 detectors from this run.
 *           Consider per-finding `crimes ignore` for narrow exceptions.
 *
 * Suppression rules (per §12):
 *   • `detectors.disable.length < 3` — nothing to flag.
 *   • `options.noColor` — caller asked for clean diagnostics.
 */
export function emitDetectorsDisabledBreadcrumb(
  config: CrimesConfig,
  options: BreadcrumbOptions = {},
): void {
  if (options.noColor) return;
  const disabled = config.detectors?.disable ?? [];
  if (disabled.length < DISABLED_DETECTORS_THRESHOLD) return;
  const stderr = options.stderr ?? process.stderr;
  stderr.write(
    `crimes: detectors.disable removed ${disabled.length} detectors from this run.\n` +
      `        Consider per-finding \`crimes ignore\` for narrow exceptions.\n`,
  );
}

/**
 * Tell the user about a detector that did not run because it ships
 * gated.
 *
 * A detector that is off by default is invisible otherwise, and a
 * scanner whose whole value is being trustworthy should not quietly
 * decline to look at something. Unlike the `detectors.disable`
 * breadcrumb this fires for a single detector, because the user did not
 * choose this one — we did.
 *
 *   crimes: parallel_destination did not run (off by default).
 *           Enable it with "detectors": { "enable": ["parallel_destination"] }.
 *
 * Fires even under `--no-color` / a piped stdout, unlike the
 * `detectors.disable` breadcrumb next to it. That one reports a choice
 * the *user* made and can be told to stay quiet about; this one reports
 * a choice *we* made on their behalf, and a scan that silently declines
 * to run a detector is the same failure mode as a scan that silently
 * skips files. It goes to stderr, so piped JSON is unaffected.
 */
export function emitDefaultOffDetectorsBreadcrumb(
  gated: readonly string[],
  options: BreadcrumbOptions = {},
): void {
  if (gated.length === 0) return;
  const stderr = options.stderr ?? process.stderr;
  const names = [...gated].sort().join(", ");
  const list = gated.map((id) => `"${id}"`).join(", ");
  stderr.write(
    `crimes: ${names} did not run (off by default).\n` +
      `        Enable with "detectors": { "enable": [${list}] }.\n`,
  );
}

/**
 * One-line stderr breadcrumb fired by every scan-like command when one or
 * more feedback-sourced suppressions resurfaced (their pinned minor is
 * older than the current crimes minor). The calibration loop relies on
 * the user noticing and running `crimes feedback recheck`.
 *
 *   crimes: 5 feedback-sourced suppressions resurface because they were pinned to 0.6.
 *           Run `crimes feedback recheck` to review.
 *
 * Suppression rules (same shape as the detectors.disable breadcrumb):
 *   • Empty `byPinnedMinor` — nothing to flag, no-op.
 *   • `options.noColor` — caller asked for clean diagnostics.
 */
export function emitResurfacedSuppressionsBreadcrumb(
  byPinnedMinor: Record<string, number>,
  options: BreadcrumbOptions = {},
): void {
  if (options.noColor) return;
  const entries = Object.entries(byPinnedMinor).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return;

  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total < 1) return;

  const detail =
    entries.length === 1
      ? `because they were pinned to ${entries[0]![0]}`
      : `(${entries.map(([v, n]) => `${n} pinned to ${v}`).join(", ")})`;
  const plural = total === 1 ? "" : "s";

  const stderr = options.stderr ?? process.stderr;
  stderr.write(
    `crimes: ${total} feedback-sourced suppression${plural} resurface ${detail}.\n` +
      `        Run \`crimes feedback recheck\` to review.\n`,
  );
}

/**
 * One stderr line per feedback-sourced suppression whose pinned version is
 * later than the current crimes version (the "you downgraded crimes" edge
 * case). The suppression stays silenced regardless; this is purely a
 * heads-up so the user understands why a finding they marked `fp` in 0.8
 * doesn't reappear on a 0.7 box.
 */
export function emitFuturePinnedSuppressionsWarnings(
  entries: SuppressionEntry[],
  currentVersion: string,
  options: BreadcrumbOptions = {},
): void {
  if (options.noColor) return;
  const future = findFuturePinnedSuppressions(entries, currentVersion);
  if (future.length === 0) return;

  const stderr = options.stderr ?? process.stderr;
  for (const e of future) {
    stderr.write(
      `crimes: suppression ${e.fingerprint} is pinned to ${e.crimes_version_pinned}, ` +
        `which is later than the current crimes version ${currentVersion} — ` +
        "leaving silenced (downgrade scenario).\n",
    );
  }
}
