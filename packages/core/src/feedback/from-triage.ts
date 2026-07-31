import type { TriageDisposition, TriageEntry } from "../triage.js";
import type { FeedbackEntry, FeedbackVerdict } from "./types.js";

/**
 * The verdict a triage disposition implies, or `null` when the
 * disposition is genuinely ambiguous and the user must be asked.
 *
 * Triage already makes the user look at a finding and commit to a
 * judgement, so the verdict is mostly free — it just wasn't being
 * recorded. `crimes feedback` shipped in 0.11 and had collected nothing
 * in months of use, because it required copying a fingerprint and
 * hand-writing a note.
 *
 * `wont-fix` is deliberately NOT mapped. It conflates "crimes was
 * wrong" with "crimes was right and we accept the risk", and those are
 * opposite calibration signals — the first should retune a detector,
 * the second should not. Guessing `fp` would also write an
 * auto-suppression off an assumption. Callers resolve it: interactively
 * by asking, non-interactively by falling back to `known`.
 */
export function verdictForDisposition(
  disposition: TriageDisposition,
): FeedbackVerdict | null {
  switch (disposition) {
    // The user is committing to act on it — they agree it is real.
    case "fix-now":
    case "fix-this-PR":
    case "needs-design":
      return "tp";
    // Real pattern, intentionally present in this context.
    case "scaffolding":
      return "known";
    case "wont-fix":
      return null;
  }
}

/**
 * Non-interactive fallback for `wont-fix` — used by `triage --merge`
 * and any other path that cannot ask. `known` is the conservative
 * choice: it records that a human looked and declined to act, without
 * asserting the detector was wrong or writing a suppression.
 */
export const WONT_FIX_FALLBACK_VERDICT: FeedbackVerdict = "known";

/**
 * Build the feedback entry implied by a triage entry. Returns `null`
 * when the disposition is ambiguous and no explicit verdict was
 * supplied, so callers can skip rather than record a guess.
 *
 * The triage reason carries over as the note — it is already required
 * to be non-empty, which is exactly what the `fp` path needs.
 */
export function feedbackEntryFromTriage(args: {
  triage: TriageEntry;
  crimesVersion: string;
  /** Resolves `wont-fix`; ignored for unambiguous dispositions. */
  explicitVerdict?: FeedbackVerdict;
}): Omit<FeedbackEntry, "timestamp"> | null {
  const implied = verdictForDisposition(args.triage.disposition);
  const verdict = implied ?? args.explicitVerdict;
  if (verdict === undefined || verdict === null) return null;

  return {
    crimes_version: args.crimesVersion,
    fingerprint: args.triage.fingerprint,
    finding_type: args.triage.type,
    verdict,
    note: args.triage.reason.trim() === "" ? null : args.triage.reason,
    scan_hash: null,
    resurfaced_from: null,
  };
}
