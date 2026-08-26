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
 * - `type` — detector identity (`large_function`, `large_file`, ...),
 *   suffixed `/<claim>` when the detector can make more than one claim
 *   (`weak_test_signal/no_assertions`). See {@link Finding.claim}.
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
 *
 * `schema_version` 0.8.0 added the claim segment, for the same reason
 * 0.4.0 added the discriminator and with the same consequence: entries
 * pinned to a pre-0.8.0 fingerprint of a multi-claim type stop matching
 * and need re-recording. That is the intent. Before 0.8.0 a suppression
 * on a `weak_test_signal` finding kept applying after the test grew a
 * `toBeTruthy()` and the claim changed underneath it — the reader had
 * judged "this test asserts nothing", and the entry went on silencing a
 * different statement they never saw.
 *
 * The claim rides in the **first** segment rather than as a fifth one
 * because the fourth is the discriminator, which is opaque detector-
 * chosen text that may itself contain `::` — nothing appended after it
 * can be read back out. Hanging the claim off `type` also gives
 * `detectors.disable` its `<type>/<claim>` form for free, and keeps a
 * type's claims sorted together wherever fingerprints are listed.
 */
export function fingerprintFinding(
  finding: Pick<Finding, "type" | "file"> &
    Partial<Pick<Finding, "symbol" | "discriminator" | "claim">>,
): string {
  const type =
    finding.claim === undefined || finding.claim === ""
      ? finding.type
      : `${finding.type}/${finding.claim}`;
  const base = `${type}::${finding.file}::${finding.symbol ?? ""}`;
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
 * The leading segment accepts an optional `/<claim>` suffix
 * (`weak_test_signal/no_assertions`), added in `schema_version` 0.8.0.
 * The same failure applies: without it every fingerprint from a
 * multi-claim detector is rejected as a typo.
 *
 * The claim half admits `+` because a composite claim joins its atoms
 * with it (`type_disagreement+undocumented`). Spelling the suffix as
 * atoms-only would reject every `config_drift` fingerprint there is —
 * that detector composes on almost every finding — which is this
 * pattern's recurring failure repeated a third time.
 *
 * Exported from `core` rather than duplicated per command, because three
 * copies is how it came to be wrong in three places at once.
 */
export const FINGERPRINT_PATTERN =
  /^[a-z0-9_]+(?:\/[a-z0-9_]+(?:\+[a-z0-9_]+)*)?::[^:]*::[^:]*(?:::.*)?$/i;

/**
 * Split a fingerprint's leading segment back into its `type` and
 * optional `claim`.
 *
 * The commands that accept a hand-typed fingerprint denormalise `type`
 * onto the entry they write, so a reviewer reading
 * `git diff .crimes/suppressions.json` can see what was silenced
 * without parsing anything. They all previously took
 * `fingerprint.split("::")[0]` as the type; with a claim suffix present
 * that recorded `weak_test_signal/no_assertions` in a field documented
 * as holding a detector id.
 */
export function splitFingerprintType(fingerprint: string): {
  type: string;
  claim?: string;
} {
  const head = fingerprint.split("::")[0] ?? "";
  const slash = head.indexOf("/");
  if (slash === -1) return { type: head };
  return { type: head.slice(0, slash), claim: head.slice(slash + 1) };
}
