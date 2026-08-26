/**
 * The reverse pass over `.crimes/triage.json` and
 * `.crimes/suppressions.json`: which recorded entries matched **nothing**
 * in this scan.
 *
 * Both filters — `applyTriageFilter` and `partitionFindings` — iterate
 * findings and look each one up in a fingerprint-keyed map. An entry
 * nobody looks up is never visited, so an entry that stopped matching is
 * a silent no-op: `triage --apply` says "Applied N entries", the next
 * scan shows the findings again, and nothing connects the two facts.
 * (`.crimes/baseline.json` does not have this problem — it already runs
 * a reverse pass and reports unmatched entries as `fixed_findings`.)
 *
 * That went from theoretical to certain in `schema_version` 0.8.0, which
 * folded the claim into the fingerprint (`<type>/<claim>::<file>::…`).
 * Every pin recorded against one of the multi-claim types stopped
 * matching on the same release — and `.crimes/triage.json` is documented
 * as intended-to-be-committed, so it is shared team state that goes
 * quiet, not one laptop.
 *
 * ## Stale is not the same as fixed, and the difference is checkable
 *
 * An entry matching nothing because somebody fixed the code is good
 * news. An entry matching nothing because the fingerprint scheme moved
 * underneath it is a silenced finding that is now shouting again. They
 * read identically from the entry alone — but not from the scan:
 *
 * - {@link UnmatchedPinKind} `"superseded"` — a live finding still makes
 *   the **same claim about the same subject** (type, claim, file and
 *   symbol all agree) under a different fingerprint. The statement was
 *   never fixed; the pin lost track of it. This is what a fingerprint
 *   scheme change looks like, and it is the case worth alarming on.
 * - `"no_longer_reported"` — nothing of that type/claim fires in that
 *   file any more. Consistent with the code being fixed *and* with the
 *   file having been deleted. Genuinely ambiguous, and the prose says
 *   so rather than guessing.
 *
 * Comparison is on the **fingerprint's own segments**, not on the
 * entry's denormalised `type` / `file` / `symbol` fields, which both
 * schemas document as "strictly redundant for matching" and which a
 * hand-edited file may contradict. The fingerprint is what the filters
 * key on, so it is what staleness is measured against.
 *
 * Pure — no I/O, no mutation. In particular it never stats the
 * filesystem: "the file is gone" and "the file was not scanned this
 * run" are indistinguishable from a report alone, so they collapse into
 * `"no_longer_reported"` instead of being asserted apart.
 */

import type { Finding } from "./finding.js";

/**
 * Why an entry matched nothing, as far as the scan can actually tell.
 *
 * Deliberately two values, not three: "the code was fixed" and "the file
 * was deleted" are the same observation from here, and splitting them
 * would need a filesystem stat this module does not do.
 */
export type UnmatchedPinKind = "superseded" | "no_longer_reported";

/** One recorded entry that matched no finding in this scan. */
export interface UnmatchedPin {
  /** The fingerprint as recorded on disk — what to re-record or drop. */
  fingerprint: string;
  /**
   * Repo-relative path the entry points at, read from the fingerprint
   * and falling back to the entry's denormalised `file`. Empty only for
   * a malformed fingerprint carrying no file segment.
   */
  file: string;
  kind: UnmatchedPinKind;
  /**
   * For `"superseded"`, the fingerprint of a live finding making the
   * same claim about the same subject — the receipt for the verdict,
   * and the value the entry should be re-recorded against. Absent for
   * `"no_longer_reported"`, which has no counterpart by definition.
   */
  supersededBy?: string;
}

/**
 * The shape both {@link import("./triage.js").TriageEntry} and
 * {@link import("./suppressions-schema.js").SuppressionEntry} satisfy.
 * Only `fingerprint` is load-bearing; `file` is a fallback for the
 * reported path when the fingerprint has no file segment.
 */
export interface PinLike {
  fingerprint: string;
  file?: string;
}

export interface UnmatchedPinsResult {
  superseded: UnmatchedPin[];
  noLongerReported: UnmatchedPin[];
}

/**
 * Files this scan actually looked at, when it looked at only some of
 * them — `--changed`, `--files`, `--related-to`.
 *
 * Without this every entry outside a narrowed scan reads as unmatched,
 * so `crimes scan --changed` would report the whole triage file as
 * stale on every run. An entry whose file was not scanned produces no
 * evidence either way and is therefore not judged at all.
 */
export type ScannedFiles = ReadonlySet<string> | undefined;

/**
 * Partition `entries` into the ones that matched no finding, split by
 * whether the same claim is still being reported elsewhere.
 *
 * `findings` must be the **pre-filter** list — every finding the
 * detectors produced. Passing a list something has already silenced
 * makes the entries it silenced look unmatched, which is the exact
 * false alarm this module exists to avoid.
 *
 * Results are sorted by fingerprint so two scans of the same tree
 * produce byte-identical output.
 */
export function classifyUnmatchedPins(
  findings: readonly Finding[],
  entries: readonly PinLike[],
  scannedFiles: ScannedFiles = undefined,
): UnmatchedPinsResult {
  const result: UnmatchedPinsResult = { superseded: [], noLongerReported: [] };
  if (entries.length === 0) return result;

  const live = indexLiveFindings(findings);
  for (const entry of entries) {
    const pin = classifyOne(entry, live, scannedFiles);
    if (pin === undefined) continue;
    (pin.kind === "superseded" ? result.superseded : result.noLongerReported).push(pin);
  }

  result.superseded.sort(byFingerprint);
  result.noLongerReported.sort(byFingerprint);
  return result;
}

interface LiveIndex {
  /** Every fingerprint currently reported. */
  prints: ReadonlySet<string>;
  /** Subject key → the fingerprint of one finding making that claim. */
  subjects: ReadonlyMap<string, string>;
}

function indexLiveFindings(findings: readonly Finding[]): LiveIndex {
  const prints = new Set<string>();
  const subjects = new Map<string, string>();
  for (const finding of findings) {
    const print = fingerprintOf(finding);
    prints.add(print);
    const key = subjectKey(
      finding.type,
      finding.claim ?? "",
      finding.file,
      finding.symbol,
    );
    // First wins, so the receipt is stable under the sorted findings
    // list rather than depending on which duplicate came last.
    if (!subjects.has(key)) subjects.set(key, print);
  }
  return { prints, subjects };
}

/**
 * One entry's verdict, or `undefined` when there is nothing to say —
 * it still matches, or the scan never looked at its file.
 */
function classifyOne(
  entry: PinLike,
  live: LiveIndex,
  scannedFiles: ScannedFiles,
): UnmatchedPin | undefined {
  if (live.prints.has(entry.fingerprint)) return undefined;

  const parsed = parseFingerprint(entry.fingerprint);
  const file = parsed.file !== "" ? parsed.file : (entry.file ?? "");
  // Not scanned this run — no evidence either way, so no verdict.
  if (scannedFiles !== undefined && !scannedFiles.has(file)) return undefined;

  // An entry recorded without a claim predates the claim segment (or
  // names a single-claim type). It cannot say which claim it meant, so
  // any claim of that type on the same subject counts as the same
  // statement — that is precisely the 0.8.0 migration case.
  const match =
    parsed.claim === undefined
      ? findAnyClaim(live.subjects, parsed.type, file, parsed.symbol)
      : live.subjects.get(subjectKey(parsed.type, parsed.claim, file, parsed.symbol));

  return match === undefined
    ? { fingerprint: entry.fingerprint, file, kind: "no_longer_reported" }
    : { fingerprint: entry.fingerprint, file, kind: "superseded", supersededBy: match };
}

function byFingerprint(a: UnmatchedPin, b: UnmatchedPin): number {
  return a.fingerprint.localeCompare(b.fingerprint);
}

/**
 * `fingerprintFinding` inlined over the fields this module compares.
 * Kept local rather than imported so the subject key and the fingerprint
 * cannot drift into disagreeing about what "the same finding" means:
 * both are derived from the same four values here.
 */
function fingerprintOf(finding: Finding): string {
  const head =
    finding.claim === undefined || finding.claim === ""
      ? finding.type
      : `${finding.type}/${finding.claim}`;
  const base = `${head}::${finding.file}::${finding.symbol ?? ""}`;
  return finding.discriminator === undefined || finding.discriminator === ""
    ? base
    : `${base}::${finding.discriminator}`;
}

/**
 * NUL-separated, matching `CoverageWarningLog`'s bucket keys and for the
 * same reason: a symbol is detector-chosen prose that routinely contains
 * spaces and arrows (`"readJsonConfig \u2192 parse"` is one from this
 * repo's own triage file), so any printable separator lets two different
 * subjects collide on one key.
 */
function subjectKey(
  type: string,
  claim: string,
  file: string,
  symbol: string | undefined,
): string {
  return `${type} ${claim} ${file} ${symbol ?? ""}`;
}

/**
 * Any claim of `type` on this subject. Linear over the live subjects
 * only when the entry names no claim, which is the migration path
 * rather than the steady state.
 */
function findAnyClaim(
  liveSubjects: ReadonlyMap<string, string>,
  type: string,
  file: string,
  symbol: string,
): string | undefined {
  const prefix = `${type} `;
  const suffix = ` ${file} ${symbol}`;
  for (const [key, print] of liveSubjects) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) return print;
  }
  return undefined;
}

interface ParsedFingerprint {
  type: string;
  /** Absent when the fingerprint carries no `/<claim>` suffix. */
  claim?: string;
  file: string;
  symbol: string;
}

/**
 * Split a recorded fingerprint back into the parts it was built from.
 *
 * The discriminator is deliberately dropped: it is opaque
 * detector-chosen text that may itself contain `::`, and a detector that
 * changes how it phrases one is exactly the case `"superseded"` should
 * catch rather than miss.
 */
function parseFingerprint(fingerprint: string): ParsedFingerprint {
  const segments = fingerprint.split("::");
  const head = segments[0] ?? "";
  const slash = head.indexOf("/");
  const parsed: ParsedFingerprint = {
    type: slash === -1 ? head : head.slice(0, slash),
    file: segments[1] ?? "",
    symbol: segments[2] ?? "",
  };
  if (slash !== -1) parsed.claim = head.slice(slash + 1);
  return parsed;
}
