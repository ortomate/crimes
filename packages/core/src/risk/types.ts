/**
 * Cross-file risk index types.
 *
 * The 0.16.0 detectors split cleanly in two. Per-file ones
 * (`swallowed_error`, `unsafe_retry`, `unbounded_async_fanout`,
 * `mock_saturation`) read `ctx.parsed` and need nothing from here.
 * Cross-file ones (`duplicated_policy`, `contract_drift`, `config_drift`,
 * `pass_through_abstraction`) need a repo-wide view, and this is it.
 *
 * One builder populates all four inventories from a single parse pass —
 * see `risk/build.ts`. Four independent builders would mean four parses
 * of every TypeScript file in the repo, which is the kind of thing this
 * product exists to complain about.
 */

import type {
  ContractField,
  ContractSource,
  EnvRead,
  PassThroughForwarding,
  PolicyKind,
} from "@crimes/language-js";
import type { ScopeClass } from "../util/scope-class.js";

/** One occurrence of a policy expression, located in the repo. */
export interface PolicyOccurrence {
  file: string;
  scope: ScopeClass;
  kind: PolicyKind;
  /**
   * The canonical form this occurrence normalised to. Duplicated onto
   * every occurrence rather than held only on the group, because the
   * near-clone pass buckets occurrences before any group exists.
   */
  normalized: string;
  line: number;
  endLine: number;
  /** Readable rendering of the original source. */
  readable: string;
  /** Enclosing function name, when there is one. */
  enclosing?: string;
  /** Full dotted property paths the rule reads. */
  paths: string[];
  /** Literal values participating in the rule. */
  literals: string[];
  /** Callee names the rule invokes. */
  calls: string[];
  /**
   * Operators in traversal order — the rule's shape. Carried so
   * detectors can tell a bare comparison from a compound predicate
   * without re-parsing the normalised string.
   */
  operators: string[];
  tokens: number;
}

/**
 * A set of occurrences that normalised to the same canonical form — an
 * exact policy clone.
 */
export interface PolicyCloneGroup {
  /** The shared normalised form. */
  normalized: string;
  /** Occurrences, sorted by file then line. */
  occurrences: PolicyOccurrence[];
  /** Distinct files involved, sorted. */
  files: string[];
  /** Lexicographically first file — the deterministic emission anchor. */
  anchorFile: string;
}

/**
 * A family of clone groups that share a rule *shape* and differ only in
 * literal values — the "copy, paste, then tweak one rule" crime.
 *
 * Modelled as a family rather than as pairs on purpose. A shape with four
 * variants has six pairs, and emitting six findings would report one
 * crime six times, at one anchor, with six identical fingerprints. The
 * family is the useful unit: *these are the N versions of this rule, and
 * here is where each lives.*
 */
export interface PolicyNearCloneFamily {
  /** The shared shape, with every literal blanked to `?`. */
  shape: string;
  /** The variants, sorted by normalised form. Always ≥2. */
  variants: PolicyCloneGroup[];
  /** Readable statements of how the variants differ, sorted. */
  differences: string[];
  /** Lexicographically first file across every variant. */
  anchorFile: string;
}

export interface PolicyIndex {
  /** Exact clone groups with ≥2 occurrences in ≥2 distinct files. */
  clones: PolicyCloneGroup[];
  /** Near-clone families: one entry per rule shape with ≥2 variants. */
  nearClones: PolicyNearCloneFamily[];
  /** Total occurrences retained, for diagnostics. */
  occurrenceCount: number;
}

/** One declared record shape, located in the repo. */
export interface ContractOccurrence {
  file: string;
  scope: ScopeClass;
  name: string;
  source: ContractSource;
  exported: boolean;
  line: number;
  endLine: number;
  fields: ContractField[];
  partial: boolean;
  /** Lowercased field names, for set comparison. */
  fieldNames: string[];
  /** Normalised concept name — `UserDTO`, `user_row`, `Users` → `user`. */
  concept: string;
}

/** Kinds of disagreement two representations of one contract can have. */
export type ContractDisagreementKind =
  | "requiredness"
  | "nullability"
  | "type"
  | "enum_members"
  | "nesting"
  | "missing_field";

export interface ContractDisagreement {
  kind: ContractDisagreementKind;
  field: string;
  /** How side A declares it. */
  left: string;
  /** How side B declares it. */
  right: string;
  /** Set when the field is identity / tenancy / permission / money / time. */
  criticalReason?: string;
}

/** Two contracts believed to describe the same record, and their conflicts. */
export interface ContractDriftPair {
  left: ContractOccurrence;
  right: ContractOccurrence;
  /** Why the two were matched, for evidence. */
  matchReasons: string[];
  /** Field names present in both. */
  sharedFields: string[];
  /** Overlap of the smaller field set, 0-1. */
  overlap: number;
  disagreements: ContractDisagreement[];
  /** Lexicographically first of the two files. */
  anchorFile: string;
}

export interface ContractIndex {
  occurrences: ContractOccurrence[];
  pairs: ContractDriftPair[];
}

/** One environment-variable read, located in the repo. */
export interface EnvOccurrence extends EnvRead {
  file: string;
  scope: ScopeClass;
  /** True when the file looks like the repo's central config module. */
  central: boolean;
  /** True when the file is reachable from client / browser code. */
  clientReachable: boolean;
}

export interface EnvVariableRecord {
  name: string;
  reads: EnvOccurrence[];
  files: string[];
  /** Distinct parsers observed, sorted. `"(none)"` for unparsed reads. */
  parsers: string[];
  /** Distinct rendered defaults observed, sorted. */
  defaults: string[];
  /** Distinct units implied by the name across reads. */
  units: string[];
  /** True when at least one read treats the variable as required. */
  anyRequired: boolean;
  /** True when at least one read does not treat it as required. */
  anyOptional: boolean;
  /** Documented in `.env.example` or an equivalent inventory. */
  documented: boolean;
  /** Lexicographically first reading file — the emission anchor. */
  anchorFile: string;
}

export interface EnvIndex {
  /** Every variable observed, keyed by name, sorted by name. */
  variables: EnvVariableRecord[];
  /** Names found in `.env.example`-style files. */
  documentedNames: Set<string>;
  /** The documented-variable inventory files that were read. */
  inventoryFiles: string[];
  /** Files that read env directly and concentrate ≥3 distinct variables. */
  configModules: string[];
  /** True when at least one file performs a computed `process.env[x]` read. */
  hasDynamicReads: boolean;
}

/** One wrapper → target edge. */
export interface PassThroughEdge {
  file: string;
  scope: ScopeClass;
  name: string;
  line: number;
  endLine: number;
  exported: boolean;
  target: string;
  targetTail: string;
  forwarding: PassThroughForwarding;
  /** Everything the wrapper adds. Empty means it adds nothing. */
  adds: string[];
  viaMember?: string;
  sameName?: true;
}

/** A run of wrappers that forward to each other across files. */
export interface PassThroughChain {
  /** Edges from outermost wrapper inward. */
  edges: PassThroughEdge[];
  /** Distinct files spanned, in chain order. */
  files: string[];
  /** Name of the final callee — what the chain actually does. */
  terminal: string;
  anchorFile: string;
}

/**
 * A group of wrappers in one file that all forward to the same
 * collaborator — the "class that is a list of one-line delegations"
 * shape, which a chain walk cannot see because each edge is length one.
 */
export interface PassThroughCluster {
  file: string;
  scope: ScopeClass;
  /** Receiver every member forwards to (`this.repo`), when shared. */
  receiver: string;
  edges: PassThroughEdge[];
  anchorFile: string;
}

export interface PassThroughIndex {
  /** Every edge, keyed by `file::name`. */
  edges: Map<string, PassThroughEdge>;
  chains: PassThroughChain[];
  clusters: PassThroughCluster[];
}

export interface RiskIndex {
  /**
   * Lexicographically first source file the builder processed.
   *
   * Repo-level findings need a deterministic emission point inside the
   * per-file detector loop, and some of them (a documented-but-unused
   * environment variable) have no natural file of their own to anchor
   * on. `undefined` when the builder processed nothing.
   */
  anchorFile?: string;
  policy: PolicyIndex;
  contracts: ContractIndex;
  env: EnvIndex;
  passThrough: PassThroughIndex;
  /**
   * True when the builder stopped early because the repo exceeded the
   * file budget. Detectors surface this as an advisory note rather than
   * silently reporting a partial view as complete.
   */
  limited?: boolean;
  limitedReason?: string;
}
