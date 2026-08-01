export {
  BASELINE_RELATIVE_PATH,
  BaselineNotFoundError,
  checkBaseline,
  classifyAgainstBaseline,
  loadBaseline,
  MalformedBaselineError,
  saveBaseline,
  severityAtLeast,
  toBaselineEntry,
} from "./baseline.js";
export type {
  Baseline,
  BaselineCheckReport,
  BaselineCheckSummary,
  BaselineEntry,
  CheckBaselineOptions,
  FailOn,
  SaveBaselineOptions,
  SaveBaselineResult,
} from "./baseline.js";
export {
  ConfigParseError,
  CrimesConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_NON_DOMAIN_PATTERNS,
  DEFAULT_RESURFACE_BASE,
  DEFAULT_SUPPRESSIONS_PATH,
  DEFAULT_TOP_FILES,
  loadConfig,
  loadConfigDetailed,
  resolveSuppressionsPath,
} from "./config.js";
export {
  appendToGlobalRollup,
  buildFeedbackSummary,
  countEntriesByDetector,
  FEEDBACK_GLOBAL_RELATIVE_PATH,
  FEEDBACK_RELATIVE_PATH,
  feedbackEntryFromTriage,
  FeedbackEntrySchema,
  latestPerFingerprint,
  MalformedFeedbackEntryError,
  readFeedback,
  RELEASE_NOTES,
  RELEASE_NOTES_FALLBACK,
  releaseNoteFor,
  resolveFeedbackPath,
  resolveGlobalRollupPath,
  resurfacedSuppressions,
  verdictForDisposition,
  WONT_FIX_FALLBACK_VERDICT,
  writeFeedbackEntry,
} from "./feedback/index.js";
export type {
  AppendToGlobalRollupArgs,
  AppendToGlobalRollupResult,
  FeedbackEntry,
  FeedbackReport,
  FeedbackSummary,
  FeedbackVerdict,
  ReadFeedbackOptions,
  ReadFeedbackResult,
  ResurfacedSuppression,
  ResurfacedSuppressionsOptions,
  WriteFeedbackOptions,
  WriteFeedbackResult,
} from "./feedback/index.js";
export type {
  ConfigIssue,
  CrimesConfig,
  DetectorRegistry,
  DetectorRegistryEntry,
  LoadConfigResult,
} from "./config.js";
export {
  applySuppressionsToContext,
  context,
  findNearestPackageRoot,
} from "./context.js";
export type {
  ContextClues,
  ContextOptions,
  ContextReport,
  ContextRisk,
} from "./context.js";
export {
  explain,
  UnknownDetectorTypeError,
  UnknownFindingError,
} from "./explain.js";
export type { ExplainOptions, ExplainReport } from "./explain.js";
export {
  findRelatedFiles,
  RELATED_FILES_CAP,
} from "./context-related-files.js";
export type {
  ContextRelatedFile,
  FindRelatedFilesOptions,
} from "./context-related-files.js";
export type { AssetDetector, AssetDetectorContext, Detector, DetectorContext } from "./detector.js";
export { accessibleInteractionRiskDetector } from "./detectors/accessible-interaction-risk.js";
export { actionLabelDriftDetector } from "./detectors/action-label-drift.js";
export { booleanNamingDriftDetector } from "./detectors/boolean-naming-drift.js";
export { circularDependencyDetector } from "./detectors/circular-dependency.js";
export { commandDriftDocsCodeDriftDetector } from "./detectors/command-drift-docs-code-drift.js";
export { commentedOutCodeDetector } from "./detectors/commented-out-code.js";
export { conceptAliasDriftDetector } from "./detectors/concept-alias-drift.js";
export { copyIaDriftDetector } from "./detectors/copy-ia-drift.js";
export { dateStringConcatDetector } from "./detectors/date-string-concat.js";
export { deepImportDetector } from "./detectors/deep-import.js";
export { designTokenEscapeDetector } from "./detectors/design-token-escape.js";
export { directDateDetector } from "./detectors/direct-date.js";
export { docsCodeDriftDetector } from "./detectors/docs-code-drift.js";
export { dstNaiveArithmeticDetector } from "./detectors/dst-naive-arithmetic.js";
export { duplicateComponentShapeDetector } from "./detectors/duplicate-component-shape.js";
export { duplicatedNavigationSourceDetector } from "./detectors/duplicated-navigation-source.js";
export { duplicatedRoleStatusPlanCheckDetector } from "./detectors/duplicated-role-status-plan-check.js";
export { exactDuplicateBlockDetector } from "./detectors/exact-duplicate-block.js";
export { hardcodedLocalPathDetector } from "./detectors/hardcoded-local-path.js";
export { hardcodedLocalhostDetector } from "./detectors/hardcoded-localhost.js";
export { highFanInFanOutDetector } from "./detectors/high-fan-in-fan-out.js";
export { largeFileDetector } from "./detectors/large-file.js";
export { largeFunctionDetector } from "./detectors/large-function.js";
export { layerViolationDetector } from "./detectors/layer-violation.js";
export { localeDriftDetector } from "./detectors/locale-drift.js";
export { logicInCommentsDetector } from "./detectors/logic-in-comments.js";
export { magicDomainLiteralScatterDetector } from "./detectors/magic-domain-literal-scatter.js";
export { missingAgentContextDetector } from "./detectors/missing-agent-context.js";
export { mixedUtcLocalMethodsDetector } from "./detectors/mixed-utc-local-methods.js";
export { nameBehaviorMismatchDetector } from "./detectors/name-behavior-mismatch.js";
export { nearDuplicateBlockDetector } from "./detectors/near-duplicate-block.js";
export { negativeFlagMazeDetector } from "./detectors/negative-flag-maze.js";
export { optionBagJunkDrawerDetector } from "./detectors/option-bag-junk-drawer.js";
export { orphanedDestinationDetector } from "./detectors/orphaned-destination.js";
export { oversizedRasterDetector } from "./detectors/oversized-raster.js";
export { parallelDestinationDetector } from "./detectors/parallel-destination.js";
export { permissionIaDriftDetector } from "./detectors/permission-ia-drift.js";
export { rasterShouldBeVectorDetector } from "./detectors/raster-should-be-vector.js";
export { responsiveFragilityDetector } from "./detectors/responsive-fragility.js";
export { returnShapeRouletteDetector } from "./detectors/return-shape-roulette.js";
export { routeMetadataDriftDetector } from "./detectors/route-metadata-drift.js";
export { singularPluralTypeMismatchDetector } from "./detectors/singular-plural-type-mismatch.js";
export { svgWithEmbeddedRasterDetector } from "./detectors/svg-with-embedded-raster.js";
export { syncIoInHotpathDetector } from "./detectors/sync-io-in-hotpath.js";
export { timezoneUnsafeParseDetector } from "./detectors/timezone-unsafe-parse.js";
export { todoDensityDetector } from "./detectors/todo-density.js";
export { weakTestSignalDetector } from "./detectors/weak-test-signal.js";
// 0.16.0 detector slate.
export { agentPermissionSprawlDetector } from "./detectors/agent-permission-sprawl.js";
export { configDriftDetector } from "./detectors/config-drift.js";
export { contractDriftDetector } from "./detectors/contract-drift.js";
export { dependencyProvenanceGapDetector } from "./detectors/dependency-provenance-gap.js";
export { duplicatedPolicyDetector } from "./detectors/duplicated-policy.js";
export { mockSaturationDetector } from "./detectors/mock-saturation.js";
export { passThroughAbstractionDetector } from "./detectors/pass-through-abstraction.js";
export { swallowedErrorDetector } from "./detectors/swallowed-error.js";
export { unboundedAsyncFanoutDetector } from "./detectors/unbounded-async-fanout.js";
export { unsafeRetryDetector } from "./detectors/unsafe-retry.js";
// 0.16.0 shared analysis infrastructure. Exported because the detectors
// above are exported: a consumer assembling a custom detector list needs
// to be able to build the indexes those detectors read.
export { buildRiskIndex } from "./risk/build.js";
export type { BuildRiskIndexOptions } from "./risk/build.js";
export { discoverEnvInventoryFiles } from "./risk/env-inventory.js";
export { conceptKeyOf, isProjectionPair } from "./risk/concept.js";
export type { ConceptKey } from "./risk/concept.js";
export type {
  ContractDisagreement,
  ContractDisagreementKind,
  ContractDriftPair,
  ContractIndex,
  ContractOccurrence,
  EnvIndex,
  EnvOccurrence,
  EnvVariableRecord,
  PassThroughChain,
  PassThroughCluster,
  PassThroughEdge,
  PassThroughIndex,
  PolicyCloneGroup,
  PolicyIndex,
  PolicyNearCloneFamily,
  PolicyOccurrence,
  RiskIndex,
} from "./risk/types.js";
export { buildManifestIndex, classifySpecifier, isPinnedGitSpecifier } from "./manifest/build.js";
export type {
  DeclaredDependency,
  DependencyKind,
  Lockfile,
  ManifestIndex,
  PackageManifest,
  SpecifierShape,
} from "./manifest/types.js";
export { buildAgentConfigIndex, quoteFragment, redactSecrets } from "./agents/build.js";
export type {
  AgentArtefactKind,
  AgentConfigIndex,
  AgentHook,
  AgentInstruction,
  AgentMcpServer,
  AgentPermissionRule,
  AgentPlatform,
} from "./agents/types.js";
export {
  classifyScope,
  isNeverReportable,
  isProductionScope,
  looksGeneratedSource,
  scopeConfidenceMultiplier,
} from "./util/scope-class.js";
export type { ScopeClass } from "./util/scope-class.js";
export {
  ConfidenceLadder,
  SeverityLadder,
  scoreFromSeverity,
  severityFromScore,
} from "./scoring/confidence.js";
export type { ConfidenceSignal } from "./scoring/confidence.js";
export {
  DOMAIN_CONCEPTS,
  MUTATING_OPERATION_WORDS,
  RISKY_BOUNDARIES,
  classifyBoundary,
  conceptsIn,
  domainTokensAcross,
  domainTokensIn,
  isCriticalField,
  criticalFieldReason,
  isDomainBearing,
  looksMutating,
  splitIdentifier,
} from "./domain/vocabulary.js";
export {
  applyDiffFailOn,
  classifyDiff,
  diff,
  InvalidDiffRangeError,
  parseDiffRange,
} from "./diff.js";
export type {
  DiffFailOn,
  DiffOptions,
  DiffReport,
  DiffSummary,
} from "./diff.js";
export { fingerprintFinding } from "./fingerprint.js";
export type {
  Effort,
  Finding,
  FindingScores,
  ScanReport,
  ScanSummary,
  Severity,
  SuggestedAction,
} from "./finding.js";
export { SCHEMA_VERSION } from "./finding.js";
export {
  DEFAULT_ALIAS_GROUPS,
  aliasToGroupId,
  buildIaIndex,
  extractPermissions,
  extractReferencedCommands,
  liftLabelSignals,
  liftNavSignals,
  normaliseTokens,
  parseMarkdown,
  readDeclaredBins,
  routeFromFilePath,
  SINGULAR_TABLE,
  splitTokens,
  stripRepoPrefix,
  STOP_WORDS,
  tokenise,
  tokenisePath,
  toPosix as iaToPosix,
} from "./ia/index.js";
export {
  buildImportGraph,
  extractImportSpecifiers,
} from "./imports/build.js";
export type { BuildImportGraphOptions } from "./imports/build.js";
export type { ImportEdge, ImportGraph } from "./imports/types.js";
export { buildJsxShapeIndex } from "./jsx/shape-index.js";
export type { JsxShapeHit, JsxShapeIndex } from "./jsx/shape-index.js";
export { findJsxElements, walkJsx } from "./jsx/walk.js";
export type {
  JsxAttributeValue,
  JsxElementInfo,
  JsxNode,
} from "./jsx/walk.js";
export {
  hashFunction,
  hashJsxSubtree,
  hashSlice,
} from "./ast-hash/hash.js";
export type { AstHash } from "./ast-hash/hash.js";
export { buildFunctionHashIndex } from "./ast-hash/function-index.js";
export type {
  FunctionHashIndex,
  FunctionHit,
} from "./ast-hash/function-index.js";
export {
  buildScoringContext,
  computeAgentRisk,
  finaliseFindingScores,
  hasNotableScores,
} from "./scoring/build.js";
export type {
  BlastRadiusIndex,
  BuildScoringContextOptions,
  ChurnIndex,
  ScoringContext,
  TestGapIndex,
} from "./scoring/build.js";
export { classifyTier, makeTierClassifier } from "./scoring/tier.js";
export type { Tier } from "./scoring/tier.js";
export { buildPettyIndex } from "./petty/build.js";
export { extractStringLiterals } from "./petty/literals.js";
export type {
  BuildPettyIndexOptions,
} from "./petty/build.js";
export type {
  PettyIndex,
  PettyLiteralHit,
  RepoPath as PettyRepoPath,
} from "./petty/types.js";
export type {
  BuildIaIndexOptions,
  IaAgentInventory,
  IaConceptAliasGroup,
  IaDocFencedCommand,
  IaDocHeading,
  IaDocLink,
  IaDocSignal,
  IaFileSignals,
  IaIndex,
  IaLabelSignal,
  IaNavEntry,
  IaNavSignal,
  IaPermissionSignal,
  IaRouteSignal,
  RepoPath,
} from "./ia/index.js";
export {
  exportRefToTempDir,
  withRefCheckout,
} from "./git/archive.js";
export {
  getChangedFiles,
  NotAGitRepoError,
  UnknownGitRefError,
} from "./git/changed-files.js";
export type { ChangedFilesOptions } from "./git/changed-files.js";
export type {
  CollectChurnOptions,
  CollectChurnResult,
  FileChurn,
} from "./git/churn.js";
export {
  collectChurn,
  isGitRepo,
  normaliseSince,
  parseGitLog,
} from "./git/churn.js";
export { computeRisk, hotspots } from "./hotspots.js";
export type {
  HighestSeverity,
  Hotspot,
  HotspotsOptions,
  HotspotsReport,
} from "./hotspots.js";
export {
  buildDetectorRegistry,
  builtInAssetDetectors,
  builtInDetectors,
  filterAssetDetectors,
  filterDetectors,
  UnknownDetectorError,
} from "./detector-registry.js";
export {
  applyScanFailOn,
  applySuppressionsToScan,
  applyTriageToScan,
  resolveAliasGroups,
  scan,
} from "./scan.js";
export type { ApplyScanFailOnOptions, ScanOptions } from "./scan.js";
export { applyTriageFilter } from "./triage-filter.js";
export type {
  ApplyTriageFilterOptions,
  TriageFilterResult,
} from "./triage-filter.js";
export {
  appendSuppression,
  compareMinor,
  countResurfacedByPinnedMinor,
  findFuturePinnedSuppressions,
  loadSuppressions,
  loadSuppressionsForRoot,
  MalformedSuppressionsError,
  minorKey,
  partitionFindings,
  removeSuppression,
  resolveOverridePath,
  shouldResurface,
  suppressionsForFile,
  SuppressionEntrySchema,
  SuppressionsSchema,
} from "./suppressions.js";
export type {
  AppendSuppressionOptions,
  AppendSuppressionResult,
  ApplySuppressionsOptions,
  LoadSuppressionsResult,
  PartitionedFindings,
  RemoveSuppressionOptions,
  RemoveSuppressionResult,
  SuppressionEntry,
  SuppressionForFile,
  Suppressions,
} from "./suppressions.js";
export {
  auditSuppressions,
  SUPPRESSION_MIN_REASON_LENGTH,
  SUPPRESSION_STALE_AGE_DAYS,
} from "./audit-suppressions.js";
export type {
  AuditConcern,
  AuditSuppressionEntry,
  AuditSuppressionsOptions,
  AuditSuppressionsReport,
} from "./audit-suppressions.js";
export {
  emptyTriage,
  loadTriage,
  MalformedTriageError,
  parseTriage,
  resolveTriagePath,
  saveTriage,
  upsertTriageEntry,
  TRIAGE_RELATIVE_PATH,
} from "./triage.js";
export type {
  Triage,
  TriageEntry,
  TriageDisposition,
  LoadTriageResult,
} from "./triage.js";
export { collectResurfaced } from "./resurface.js";
export type { ResurfaceInput } from "./resurface.js";
export {
  judgeVerdict,
  NoDefaultBaseError,
  recommendActions,
  resolveDefaultBase,
  SEVERITY_WEIGHT,
  shouldFailVerdict,
  verdict,
} from "./verdict.js";
export type {
  Verdict,
  VerdictFailOn,
  VerdictOptions,
  VerdictReport,
  VerdictSummary,
} from "./verdict.js";
