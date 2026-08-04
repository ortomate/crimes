import type { CrimesConfig, DetectorRegistry } from "./config.js";
import type {
  AssetDetector,
  Detector,
  CrossLanguageDetector,
  LanguageJsDetector,
  LanguagePyDetector,
  UniversalDetector,
} from "./detector.js";
import { accessibleInteractionRiskDetector } from "./detectors/accessible-interaction-risk.js";
import { actionLabelDriftDetector } from "./detectors/action-label-drift.js";
import { booleanNamingDriftDetector } from "./detectors/boolean-naming-drift.js";
import { circularDependencyDetector } from "./detectors/circular-dependency.js";
import { commandDriftDocsCodeDriftDetector } from "./detectors/command-drift-docs-code-drift.js";
import { commentedOutCodeDetector } from "./detectors/commented-out-code.js";
import { commentedOutCodeUniversalDetector } from "./detectors/commented-out-code-universal.js";
import { agentPermissionSprawlDetector } from "./detectors/agent-permission-sprawl.js";
import { conceptAliasDriftDetector } from "./detectors/concept-alias-drift.js";
import { configDriftDetector } from "./detectors/config-drift.js";
import { contractDriftDetector } from "./detectors/contract-drift.js";
import { copyIaDriftDetector } from "./detectors/copy-ia-drift.js";
import { dateStringConcatDetector } from "./detectors/date-string-concat.js";
import { deepImportDetector } from "./detectors/deep-import.js";
import { dependencyProvenanceGapDetector } from "./detectors/dependency-provenance-gap.js";
import { designTokenEscapeDetector } from "./detectors/design-token-escape.js";
import { directDateDetector } from "./detectors/direct-date.js";
import { docsCodeDriftDetector } from "./detectors/docs-code-drift.js";
import { dstNaiveArithmeticDetector } from "./detectors/dst-naive-arithmetic.js";
import { duplicateComponentShapeDetector } from "./detectors/duplicate-component-shape.js";
import { duplicatedNavigationSourceDetector } from "./detectors/duplicated-navigation-source.js";
import { duplicatedPolicyDetector } from "./detectors/duplicated-policy.js";
import { duplicatedRoleStatusPlanCheckDetector } from "./detectors/duplicated-role-status-plan-check.js";
import { exactDuplicateBlockDetector } from "./detectors/exact-duplicate-block.js";
import { finderDuplicateFilenameDetector } from "./detectors/finder-duplicate-filename.js";
import { hardcodedLocalPathDetector } from "./detectors/hardcoded-local-path.js";
import { hardcodedLocalhostDetector } from "./detectors/hardcoded-localhost.js";
import { highFanInFanOutDetector } from "./detectors/high-fan-in-fan-out.js";
import { largeFileDetector } from "./detectors/large-file.js";
import { largeFunctionDetector } from "./detectors/large-function.js";
import { layerViolationDetector } from "./detectors/layer-violation.js";
import { localeDriftDetector } from "./detectors/locale-drift.js";
import { logicInCommentsDetector } from "./detectors/logic-in-comments.js";
import { magicDomainLiteralScatterDetector } from "./detectors/magic-domain-literal-scatter.js";
import { missingAgentContextDetector } from "./detectors/missing-agent-context.js";
import { mockSaturationDetector } from "./detectors/mock-saturation.js";
import { mixedUtcLocalMethodsDetector } from "./detectors/mixed-utc-local-methods.js";
import { nameBehaviorMismatchDetector } from "./detectors/name-behavior-mismatch.js";
import { nearDuplicateBlockDetector } from "./detectors/near-duplicate-block.js";
import { negativeFlagMazeDetector } from "./detectors/negative-flag-maze.js";
import { optionBagJunkDrawerDetector } from "./detectors/option-bag-junk-drawer.js";
import { orphanedDestinationDetector } from "./detectors/orphaned-destination.js";
import { oversizedRasterDetector } from "./detectors/oversized-raster.js";
import { parallelDestinationDetector } from "./detectors/parallel-destination.js";
import { passThroughAbstractionDetector } from "./detectors/pass-through-abstraction.js";
import { permissionIaDriftDetector } from "./detectors/permission-ia-drift.js";
import { rasterShouldBeVectorDetector } from "./detectors/raster-should-be-vector.js";
import { responsiveFragilityDetector } from "./detectors/responsive-fragility.js";
import { returnShapeRouletteDetector } from "./detectors/return-shape-roulette.js";
import { routeMetadataDriftDetector } from "./detectors/route-metadata-drift.js";
import { singularPluralTypeMismatchDetector } from "./detectors/singular-plural-type-mismatch.js";
import { svgWithEmbeddedRasterDetector } from "./detectors/svg-with-embedded-raster.js";
import { swallowedErrorDetector } from "./detectors/swallowed-error.js";
import { syncIoInHotpathDetector } from "./detectors/sync-io-in-hotpath.js";
import { timezoneUnsafeParseDetector } from "./detectors/timezone-unsafe-parse.js";
import { todoDensityDetector } from "./detectors/todo-density.js";
import { unboundedAsyncFanoutDetector } from "./detectors/unbounded-async-fanout.js";
import { unsafeRetryDetector } from "./detectors/unsafe-retry.js";
import { weakTestSignalDetector } from "./detectors/weak-test-signal.js";
import { pythonDetectors } from "./detectors/py/index.js";
import { crossLanguageDetectors } from "./detectors/cross/index.js";

/**
 * Built-in source-detector slate, in priority order. Order matters for
 * the default `crimes scan` output (which sorts by severity then
 * detector position) — keep structural / file-local detectors first
 * since they make up the bulk of findings on most repos and don't
 * depend on cross-file analysis.
 */
export const builtInDetectors: Detector[] = [
  // Structural / file-local detectors (run first; they make up the bulk of
  // findings on most repos and don't depend on cross-file analysis).
  largeFileDetector,
  largeFunctionDetector,
  todoDensityDetector,
  directDateDetector,
  timezoneUnsafeParseDetector,
  mixedUtcLocalMethodsDetector,
  localeDriftDetector,
  dstNaiveArithmeticDetector,
  dateStringConcatDetector,
  // Naming-tier (0.8.0): consume typedDeclarations from the parser.
  booleanNamingDriftDetector,
  singularPluralTypeMismatchDetector,
  // Hot-path & portability (0.8.0): sync I/O inside hot-path shapes,
  // developer-specific local paths, and dev-server URL literals.
  syncIoInHotpathDetector,
  hardcodedLocalPathDetector,
  hardcodedLocalhostDetector,
  finderDuplicateFilenameDetector,
  // Petty crimes (small local patterns that increase agent confusion).
  commentedOutCodeDetector, // language-js variant (AST)
  commentedOutCodeUniversalDetector, // universal variant (regex, non-JS only)
  logicInCommentsDetector,
  nameBehaviorMismatchDetector,
  magicDomainLiteralScatterDetector,
  weakTestSignalDetector,
  optionBagJunkDrawerDetector,
  returnShapeRouletteDetector,
  negativeFlagMazeDetector,
  // Information-architecture detectors (cross-file; require ctx.ia).
  missingAgentContextDetector,
  routeMetadataDriftDetector,
  duplicatedNavigationSourceDetector,
  conceptAliasDriftDetector,
  docsCodeDriftDetector,
  orphanedDestinationDetector,
  parallelDestinationDetector,
  permissionIaDriftDetector,
  actionLabelDriftDetector,
  copyIaDriftDetector,
  commandDriftDocsCodeDriftDetector,
  // Dependency-graph + architecture (require ctx.imports).
  layerViolationDetector,
  circularDependencyDetector,
  deepImportDetector,
  highFanInFanOutDetector,
  // Frontend / UI agent-risk (require ctx.parsed.jsxElements).
  designTokenEscapeDetector,
  accessibleInteractionRiskDetector,
  duplicateComponentShapeDetector,
  responsiveFragilityDetector,
  // Duplication (require ctx.functionHashIndex / ctx.ia).
  exactDuplicateBlockDetector,
  nearDuplicateBlockDetector,
  duplicatedRoleStatusPlanCheckDetector,
  // Correctness-risk tier (0.16.0). File-local detectors first — they
  // read `ctx.parsed` alone and are the cheapest to evaluate.
  swallowedErrorDetector,
  unsafeRetryDetector,
  unboundedAsyncFanoutDetector,
  mockSaturationDetector,
  // Cross-file authority + hygiene (0.16.0). These need `ctx.risk`,
  // `ctx.manifest`, or `ctx.agentConfig`, so they run after the
  // file-local slate for the same reason the IA detectors do.
  duplicatedPolicyDetector,
  contractDriftDetector,
  configDriftDetector,
  passThroughAbstractionDetector,
  dependencyProvenanceGapDetector,
  agentPermissionSprawlDetector,
  // Python pack (0.14.0). Ids are qualified (`large_function.py`) so
  // they are separately addressable in `detectors.enable` / `disable`;
  // the findings they emit carry the abstract `type` so cross-language
  // grouping still works. See `detectors/py/shared.ts`.
  ...pythonDetectors,
  // Cross-language pack (0.15.0). Run once per scan after every
  // per-language pass, over the whole parsed corpus.
  ...crossLanguageDetectors,
];

/**
 * Built-in asset detectors — image-shaped findings that the source
 * pipeline can't surface because they don't have an AST. Run in a
 * separate second pass after every source detector emits.
 */
export const builtInAssetDetectors: AssetDetector[] = [
  oversizedRasterDetector,
  rasterShouldBeVectorDetector,
  svgWithEmbeddedRasterDetector,
];

/**
 * Project a detector list down to the slice the config loader uses for
 * validating `detectors.options.<id>`. Exported so other scan entry
 * points (`context`, future commands) can share a single source of
 * truth without re-importing every detector.
 *
 * Asset detectors share the same `detectors.options.<id>` namespace as
 * source detectors — pass both lists so the loader recognises asset-
 * detector ids and validates any options blocks against the asset
 * detector's `optionsSchema`.
 */
export function buildDetectorRegistry(
  detectors: readonly Detector[],
  assetDetectors: readonly AssetDetector[] = [],
): DetectorRegistry {
  return [
    ...detectors.map((d) => ({ id: d.id, optionsSchema: d.optionsSchema })),
    ...assetDetectors.map((d) => ({ id: d.id, optionsSchema: d.optionsSchema })),
  ];
}

/**
 * Apply `config.detectors.enable` / `config.detectors.disable` to the
 * built-in detector list. Returns a new array; never mutates the input.
 *
 * `enable` is an allowlist (empty / omitted means "all built-ins").
 * `disable` runs **after** `enable` so a user can shrink the set in two
 * passes if they want to. An unknown id in either list raises
 * {@link UnknownDetectorError} — typos should not silently no-op.
 *
 * `allKnownIds` (optional) carries the combined source + asset
 * detector id set so an asset-detector id in `enable`/`disable` is
 * recognised as known even though it isn't in this `available`
 * source-detector pool. When omitted, validation falls back to
 * `available`'s ids only.
 */
export function filterDetectors(
  available: Detector[],
  config: CrimesConfig,
  allKnownIds?: Set<string>,
): Detector[] {
  const knownIds = allKnownIds ?? new Set(available.map((d) => d.id));
  return applyEnableDisable(available, config, knownIds);
}

/**
 * Asset-pipeline counterpart of {@link filterDetectors}. Same
 * `config.detectors.enable` / `config.detectors.disable` lists apply
 * — asset and source detectors share one id namespace.
 */
export function filterAssetDetectors(
  available: AssetDetector[],
  config: CrimesConfig,
  allKnownIds?: Set<string>,
): AssetDetector[] {
  const knownIds = allKnownIds ?? new Set(available.map((d) => d.id));
  return applyEnableDisable(available, config, knownIds);
}

/**
 * Build the union of every known detector id (source + asset) — the
 * set the enable/disable validator consults so a config that mixes
 * source and asset ids doesn't get one path's filter throwing
 * `UnknownDetectorError` against an id the other path knows about.
 */
export function collectKnownIds(
  detectors: readonly Detector[],
  assetDetectors: readonly AssetDetector[],
): Set<string> {
  const ids = new Set<string>();
  for (const d of detectors) ids.add(d.id);
  for (const d of assetDetectors) ids.add(d.id);
  return ids;
}

/**
 * Every id that names a gated detector, from either registry plus the
 * pool being filtered.
 *
 * Both registries are consulted because `enable` shares one id
 * namespace across source and asset detectors: filtering the *asset*
 * pool has to recognise that a source-detector id like
 * `parallel_destination` is gated, or it treats it as an allowlist
 * entry and empties the asset pass. `available` is folded in on top so
 * a caller passing its own detectors — which tests do — gets the same
 * treatment for its own gated ids.
 */
function gatedIdsFor(available: ReadonlyArray<{ id: string; defaultOff?: true }>) {
  const gated = new Set<string>();
  for (const d of builtInDetectors) if (d.defaultOff === true) gated.add(d.id);
  for (const d of builtInAssetDetectors) if (d.defaultOff === true) gated.add(d.id);
  for (const d of available) if (d.defaultOff === true) gated.add(d.id);
  return gated;
}

function applyEnableDisable<T extends { id: string; defaultOff?: true }>(
  available: T[],
  config: CrimesConfig,
  knownIds: Set<string>,
): T[] {
  const enable = config.detectors?.enable ?? [];
  const disable = config.detectors?.disable ?? [];

  for (const id of enable) {
    if (!knownIds.has(id)) throw new UnknownDetectorError(id);
  }
  for (const id of disable) {
    if (!knownIds.has(id)) throw new UnknownDetectorError(id);
  }

  const enableSet = new Set(enable);

  // Naming a gated detector in `enable` is *additive* — it switches
  // that detector on without narrowing the pool. Only ids that name a
  // default-*on* detector form the allowlist.
  //
  // Without this split, `enable` is a pure allowlist and the advice the
  // CLI prints when a gated detector sits out —
  //
  //   crimes: parallel_destination did not run (off by default).
  //           Enable with "detectors": { "enable": ["parallel_destination"] }.
  //
  // — silently turns off every other detector. Measured on
  // `evals/fixtures/05-stress-ia-drift`: following it took the scan
  // from 13 findings to 1, and killed the asset pass as well, with no
  // warning. A tool whose own remediation advice quietly guts the scan
  // is worse than one that never offered it, and this product's whole
  // value is being trustworthy about what it did and did not look at.
  //
  // The original ordering comment was right about the case it
  // considered — an `enable` list for unrelated detectors must not
  // resurrect a gated one — and that still holds: a gated detector runs
  // only when named. What it did not consider was a list naming
  // *nothing but* a gated detector, which is exactly what the hint
  // tells users to write.
  const gated = gatedIdsFor(available);
  const allowlist = new Set(enable.filter((id) => !gated.has(id)));

  let pool = available;
  if (allowlist.size > 0) {
    pool = pool.filter(
      (d) => allowlist.has(d.id) || (d.defaultOff === true && enableSet.has(d.id)),
    );
  }
  // A `defaultOff` detector runs only when named. Checked after the
  // allowlist so `disable` still wins — the filter below runs last.
  pool = pool.filter((d) => d.defaultOff !== true || enableSet.has(d.id));
  if (disable.length > 0) {
    const disableSet = new Set(disable);
    pool = pool.filter((d) => !disableSet.has(d.id));
  }
  return pool;
}

/**
 * Detector ids that ship gated and were therefore not in this run.
 *
 * Returns the ids the CLI should tell the user about: `defaultOff`
 * detectors the config did not opt into. A detector the user explicitly
 * disabled is their decision and is not reported here.
 */
export function defaultOffDetectorIds(
  available: readonly { id: string; defaultOff?: true }[],
  config: CrimesConfig,
): string[] {
  const enable = new Set(config.detectors?.enable ?? []);
  return available
    .filter((d) => d.defaultOff === true && !enable.has(d.id))
    .map((d) => d.id)
    .sort();
}

export class UnknownDetectorError extends Error {
  id: string;
  constructor(id: string) {
    super(
      `unknown detector id "${id}" in crimes.config.json. ` +
        `Check the spelling against the built-in detector list in ` +
        `docs/finding-types/.`,
    );
    this.name = "UnknownDetectorError";
    this.id = id;
  }
}

/**
 * Typed grouping result — each pack key maps to a narrowed detector array
 * so the scan orchestrator can call `detector.run(ctx)` without type casts.
 */
export interface GroupedDetectors {
  universal?: UniversalDetector[];
  "language-js"?: LanguageJsDetector[];
  "language-py"?: LanguagePyDetector[];
  "cross-language"?: CrossLanguageDetector[];
}

/**
 * Group a detector list by pack so the scan orchestrator can hand each
 * pack only the detectors it should run. Returned record has one entry
 * per pack that has at least one detector — empty packs are omitted so
 * callers can `for (const pack of Object.keys(grouped))` cleanly.
 *
 * Asset detectors are NOT included — they live in a separate
 * `AssetDetector` list and are grouped via the existing
 * `builtInAssetDetectors` export.
 *
 * The return type is a {@link GroupedDetectors} with narrowed arrays per
 * pack, so the orchestrator can call `detector.run(ctx)` without casts.
 */
export function groupDetectorsByPack(detectors: readonly Detector[]): GroupedDetectors {
  const grouped: GroupedDetectors = {};
  for (const d of detectors) {
    if (d.pack === "universal") {
      const bucket = grouped.universal ?? [];
      bucket.push(d as UniversalDetector);
      grouped.universal = bucket;
    } else if (d.pack === "language-js") {
      const bucket = grouped["language-js"] ?? [];
      bucket.push(d as LanguageJsDetector);
      grouped["language-js"] = bucket;
    } else if (d.pack === "language-py") {
      const bucket = grouped["language-py"] ?? [];
      bucket.push(d as LanguagePyDetector);
      grouped["language-py"] = bucket;
    } else if (d.pack === "cross-language") {
      const bucket = grouped["cross-language"] ?? [];
      bucket.push(d as CrossLanguageDetector);
      grouped["cross-language"] = bucket;
    }
  }
  return grouped;
}
