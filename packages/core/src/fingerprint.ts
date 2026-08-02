import type { Finding } from "./finding.js";

/**
 * Stable, cross-scan identity for a {@link Finding}.
 *
 * Two scans run at different commits should agree on the fingerprint of "the
 * same finding" even when unrelated edits have shifted line numbers. That
 * means the fingerprint deliberately does **not** include:
 *
 * - `id` (re-assigned per scan based on sort order)
 * - `lines` (small unrelated edits shift them)
 * - `summary`, `evidence`, `scores` (derived; may drift across detector tuning)
 *
 * The fingerprint is `<type>::<file>::<symbol-or-empty>`, with
 * `::<discriminator>` appended when the finding carries one:
 *
 * - `type` — detector identity (`large_function`, `large_file`, ...)
 * - `file` — repo-relative POSIX path. File renames register as a fix+new
 *   pair, mirroring how `git diff` treats renames without `--find-renames`.
 * - `symbol` — present for findings that name a specific declaration (e.g.
 *   `large_function.symbol = "generateInvoice"`); empty for file-level
 *   detectors (`large_file`, `todo_density`, `direct_date`) where the
 *   `(type, file)` pair is already unique.
 * - `discriminator` — optional tiebreaker (added in `schema_version` 0.4.0),
 *   set only by detectors that can emit more than one finding per
 *   `(type, file, symbol)` triple. See {@link Finding.discriminator} for the
 *   rules a detector must follow when choosing one.
 *
 * Before 0.4.0 those detectors collided on a single fingerprint, which cost
 * more than a conflated `crimes diff`: `crimes ignore <fingerprint>` on one
 * of them silently suppressed the others too, so a user got a finding
 * hidden that they never looked at.
 *
 * The discriminator segment is omitted entirely when unset, so findings from
 * the overwhelming majority of detectors keep the three-part form they have
 * always had. Only the detectors that were colliding change shape.
 *
 * Residual limitation: two findings that are genuinely indistinguishable —
 * same type, file, symbol, and discriminator — still share a fingerprint.
 * That is now a detector bug rather than a schema gap; the fix is for the
 * detector to supply a discriminator that separates them.
 */
export function fingerprintFinding(
  finding: Pick<Finding, "type" | "file"> &
    Partial<Pick<Finding, "symbol" | "discriminator">>,
): string {
  const base = `${finding.type}::${finding.file}::${finding.symbol ?? ""}`;
  return finding.discriminator === undefined || finding.discriminator === ""
    ? base
    : `${base}::${finding.discriminator}`;
}

/**
 * Shape check for a fingerprint a user typed or pasted — `crimes ignore`,
 * `crimes unignore`, and `crimes feedback` all accept one as an argument
 * and each needs to reject a typo before it lands on disk.
 *
 * The discriminator segment is matched as an opaque tail rather than a
 * fourth colon-free field. It is detector-chosen text — a collection
 * expression, a condensed statement, a hash — and constraining its
 * contents here would silently make some findings unignorable, which is
 * the failure this pattern previously had: written for the three-part
 * form, it rejected every discriminated fingerprint the scanner emits.
 *
 * Exported from `core` rather than duplicated per command, because three
 * copies is how it came to be wrong in three places at once.
 */
export const FINGERPRINT_PATTERN = /^[a-z0-9_]+::[^:]*::[^:]*(?:::.*)?$/i;
