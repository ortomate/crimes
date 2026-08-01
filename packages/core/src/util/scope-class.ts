/**
 * Shared "what kind of file is this?" classifier.
 *
 * The 0.16.0 detector families all need the same exclusion policy:
 * generated code, vendored code, migrations, fixtures, and snapshots are
 * either skipped outright or down-ranked. Before this module each detector
 * carried its own regex, which is how you end up with `duplicated_policy`
 * skipping `__generated__/` while `contract_drift` reports it.
 *
 * Two layers, deliberately separate:
 *
 *  - {@link classifyScope} — path-only. Cheap, works without reading the
 *    file, and is what most call sites want.
 *  - {@link looksGeneratedSource} — content sniffing for the
 *    `@generated` / "DO NOT EDIT" banner. Only worth calling when the
 *    detector already has the source in hand.
 *
 * `isTestFile` deliberately stays in `util/test-files.ts`: it predates
 * this module, has its own semantics (test *pairing*, not just
 * exclusion), and is consumed by scoring as well as detectors.
 */

import { isTestFile } from "./test-files.js";

/**
 * Coarse scope of a file, in the order detectors care about.
 *
 * - `generated` — machine-written; editing it is pointless and reporting
 *   a crime in it is noise.
 * - `vendored` — third-party code checked into the repo.
 * - `migration` — historical, append-only by convention. A migration that
 *   duplicates a policy is not a duplicate to fix; it is a record of what
 *   the policy was in March.
 * - `fixture` — deliberately-messy sample input, including this repo's
 *   own `examples/`. Detectors down-rank rather than skip, because a
 *   fixture scan is a legitimate use of the tool.
 * - `test` — test source.
 * - `config` — build / tooling configuration.
 * - `production` — everything else. The only scope most detectors report
 *   a high-confidence finding in.
 */
export type ScopeClass =
  | "generated"
  | "vendored"
  | "migration"
  | "fixture"
  | "test"
  | "config"
  | "production";

/** Paths that are machine-written. */
const GENERATED_RE =
  /(^|\/)(__generated__|generated|\.generated|node_modules)\/|\.(generated|gen)\.[cm]?[jt]sx?$|(^|\/)(schema|graphql|api)\.generated\./;

/** Paths that hold third-party code checked into the repo. */
const VENDORED_RE = /(^|\/)(vendor|vendored|third[-_]party|thirdparty|external|\.yarn)\//;

/** Database / schema migration directories and the timestamped file form. */
const MIGRATION_RE =
  /(^|\/)(migrations?|db\/migrate|alembic\/versions|prisma\/migrations)\/|(^|\/)\d{6,}[-_][\w-]+\.[cm]?[jt]s$/;

/** Fixture, sample, and snapshot material. */
const FIXTURE_RE =
  /(^|\/)(fixtures?|__fixtures__|__snapshots__|__mocks__|snapshots?|examples?|samples?|testdata|mocks?|stubs?)\//;

/** Build / tooling configuration that no product rule lives in. */
const CONFIG_RE =
  /(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)(\.eslintrc|\.prettierrc|tsup|vite|vitest|webpack|rollup|jest|babel|next|tailwind|postcss)\.config\./;

/**
 * Classify a repo-relative POSIX path.
 *
 * Order matters and is fixed: a file under `vendor/migrations/` is
 * vendored, and a `__generated__/foo.test.ts` is generated, not a test.
 * Callers get one answer, always the same one.
 */
export function classifyScope(path: string): ScopeClass {
  const p = normalise(path);
  if (GENERATED_RE.test(p)) return "generated";
  if (VENDORED_RE.test(p)) return "vendored";
  if (MIGRATION_RE.test(p)) return "migration";
  if (FIXTURE_RE.test(p)) return "fixture";
  if (isTestFile(p)) return "test";
  if (CONFIG_RE.test(p)) return "config";
  return "production";
}

/**
 * Is this a file a detector should treat as authoritative production
 * code? True only for `production`.
 *
 * This is the guard nearly every 0.16.0 detector opens with. Detectors
 * that legitimately inspect tests (`mock_saturation`) or manifests
 * (`dependency_provenance_gap`) call {@link classifyScope} directly and
 * apply their own policy.
 */
export function isProductionScope(path: string): boolean {
  return classifyScope(path) === "production";
}

/**
 * Scopes that must never contribute a finding, regardless of detector.
 * Generated and vendored code isn't the team's to fix, and reporting it
 * trains people to ignore the tool.
 */
export function isNeverReportable(path: string): boolean {
  const scope = classifyScope(path);
  return scope === "generated" || scope === "vendored";
}

/**
 * Confidence multiplier for a finding anchored in this scope. Applied on
 * top of a detector's own confidence so the down-ranking rule lives in
 * one place.
 *
 * `production` is 1.0 (no change). Fixtures and migrations are damped
 * because a crime there is usually intentional; they are not zeroed
 * because scanning a fixture repo is a supported workflow.
 */
export function scopeConfidenceMultiplier(path: string): number {
  switch (classifyScope(path)) {
    case "production":
      return 1;
    case "config":
      return 0.9;
    case "test":
      return 0.8;
    case "fixture":
      return 0.7;
    case "migration":
      return 0.6;
    case "generated":
    case "vendored":
      return 0;
  }
}

/**
 * Banner-based generated-file detection. Only the first ~40 lines are
 * inspected — every convention puts the marker at the top, and scanning a
 * whole minified bundle for a comment is wasted I/O.
 *
 * Recognises the `@generated` tag used by Relay / Prettier / Buf, the
 * `Code generated by ... DO NOT EDIT.` form Go and protoc emit, and the
 * plain "AUTO-GENERATED"/"DO NOT EDIT" banners.
 */
export function looksGeneratedSource(source: string): boolean {
  const head = source.split(/\r?\n/, 40).join("\n");
  return (
    /@generated\b/.test(head) ||
    /\bCode generated by\b[\s\S]{0,80}\bDO NOT EDIT\b/i.test(head) ||
    /\b(?:AUTO[- ]?GENERATED|AUTOGENERATED)\b/i.test(head) ||
    /\bDO NOT EDIT(?:\s+THIS FILE)?\b/i.test(head)
  );
}

function normalise(path: string): string {
  // Accept Windows-style separators from callers that hand through a
  // raw `path.relative()` result. Every internal path is POSIX, but a
  // classifier that silently mis-answers on backslashes is a trap.
  return path.replace(/\\/g, "/");
}
