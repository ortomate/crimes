/**
 * The minimum a finding must expose for {@link resolveDiscriminators} to
 * work on it. Deliberately structural rather than `PreFinding`, so a
 * detector can call this before it has finished building the rest.
 */
interface Disambiguable {
  symbol?: string;
  lines?: [number, number];
  discriminator?: string;
}

/**
 * Settle the fingerprint discriminators for one file's findings.
 *
 * A detector that can emit more than one finding per `(type, file,
 * symbol)` triple sets a **candidate** discriminator on every finding it
 * builds — something content-derived and stable across scans of the same
 * code, per the rules on {@link Finding.discriminator}. This pass then
 * decides which candidates are actually needed:
 *
 * 1. A finding whose `symbol` is unique within the file loses its
 *    candidate. `(type, file, symbol)` already identifies it, and adding
 *    a discriminator would change the fingerprint of every unambiguous
 *    finding the detector has ever emitted — invalidating pinned
 *    suppressions and baselines for no benefit. This is the rule 0.17.0
 *    established for `large_function`, generalised.
 * 2. A finding whose `symbol` repeats keeps its candidate.
 * 3. If two findings in one such group share a candidate as well, both
 *    get the start line appended, because a fingerprint that is merely
 *    *usually* unique is the bug this pass exists to remove. The start
 *    line is positional and moves when code above it moves, which is
 *    weaker than the stability rule the field documents — but it is only
 *    reached for findings that would otherwise be indistinguishable, and
 *    an unstable fingerprint on a previously *colliding* finding still
 *    beats one that silently suppresses its neighbours.
 * 4. An ambiguous finding with no candidate at all falls back to the
 *    start line alone, which is how `large_function` disambiguates its
 *    anonymous callbacks.
 *
 * Grouping is by `symbol` only, so a candidate is never compared against
 * a finding that a different symbol already separates.
 *
 * Call this once per file, on the array the detector is about to return.
 * Mutates in place.
 */
export function resolveDiscriminators<T extends Disambiguable>(findings: T[]): void {
  const groups = new Map<string, T[]>();
  for (const finding of findings) {
    const key = finding.symbol ?? "";
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [finding]);
    else group.push(finding);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      group[0]!.discriminator = undefined;
      continue;
    }

    const candidateCounts = new Map<string, number>();
    for (const finding of group) {
      const candidate = finding.discriminator ?? "";
      candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
    }

    for (const finding of group) {
      const candidate = finding.discriminator ?? "";
      const line = `L${finding.lines?.[0] ?? 0}`;
      if (candidate === "") finding.discriminator = line;
      else if ((candidateCounts.get(candidate) ?? 0) > 1) {
        finding.discriminator = `${candidate}@${line}`;
      }
    }
  }
}
