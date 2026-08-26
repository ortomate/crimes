/**
 * Claim identity — the unit that carries one truth value.
 *
 * A detector's `type` says which detector spoke. Its **claim** says what
 * was alleged. Those were the same thing for as long as every detector
 * said exactly one thing, and eleven of them do not: `weak_test_signal`
 * alleges both "this test contains no expect/assert calls" and "this
 * test only uses weak assertion matchers", which are different
 * questions with different answers and different fixes.
 *
 * Because triage, suppressions and the baseline all key on `type` plus
 * fingerprint, a reader who sampled one claim and judged the type
 * silenced the rest. See {@link Finding.claim} for the field, and
 * `docs/claims.md` for the full rule.
 *
 * ## Atoms and composites
 *
 * Most multi-claim detectors pick exactly one claim per finding — a test
 * either asserts nothing or asserts weakly, never both. Those emit a
 * single **atom**.
 *
 * A few detectors legitimately assert a **conjunction** about one
 * subject. `config_drift` reports one finding per environment variable
 * and lists everything wrong with it: `DATABASE_URL` can be parsed as
 * two different types *and* undocumented at the same time, and a
 * reviewer wants both in one place rather than in two findings that
 * happen to share a symbol. Those emit a composite — the atoms sorted
 * and joined with `+`.
 *
 * Sorting is what makes a composite an identity rather than a
 * coincidence of evaluation order. `type_disagreement+undocumented`
 * must be the same string whichever order the checks ran in, or the
 * fingerprint moves between scans of unchanged code and every pin
 * against it drops.
 *
 * A composite is still one truth value: the conjunction is true exactly
 * when every atom is. What it is *not* is a licence to bundle — a
 * detector whose claims are alternatives must emit atoms, so that
 * silencing one cannot silence the other.
 */

/** Separator between atoms in a composite claim. */
const COMPOSITE_SEPARATOR = "+";

/** Shape every claim atom must take: `[a-z0-9_]+`. */
export const CLAIM_ATOM_PATTERN = /^[a-z0-9_]+$/;

/**
 * Build a claim id from the atoms a finding asserts.
 *
 * Sorts and de-duplicates, so the result is a function of the *set* of
 * atoms and not of the order the detector happened to collect them.
 * Returns `undefined` for an empty list, which is what a detector that
 * found nothing to allege should carry — an empty-string claim would
 * otherwise reach the fingerprint as a trailing separator.
 */
export function composeClaim(atoms: readonly string[]): string | undefined {
  const unique = [...new Set(atoms)].sort();
  return unique.length === 0 ? undefined : unique.join(COMPOSITE_SEPARATOR);
}

/**
 * Split a claim id back into the atoms it asserts.
 *
 * A single-atom claim yields a one-element list, so callers never need
 * to know whether a given detector composes. An absent or empty claim
 * yields an empty list rather than `[""]`.
 */
export function claimAtoms(claim: string | undefined): string[] {
  if (claim === undefined || claim === "") return [];
  return claim.split(COMPOSITE_SEPARATOR);
}

/**
 * Does this finding's claim assert `atom`?
 *
 * True for an exact single-atom match and for any composite containing
 * it, which is the semantics `detectors.disable` needs: a user who
 * writes `config_drift/client_exposed_secret` means "stop telling me
 * about client-exposed secrets", not "stop telling me only when that is
 * the sole problem with the variable".
 */
export function claimAsserts(claim: string | undefined, atom: string): boolean {
  return claimAtoms(claim).includes(atom);
}
