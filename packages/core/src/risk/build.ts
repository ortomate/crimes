import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { looksLikeConfigModule, parseFile } from "@crimes/language-js";
import type { ContractField, ParsedFile } from "@crimes/language-js";
import { conceptKeyOf, isProjectionPair, type ConceptKey } from "./concept.js";
import {
  classifyScope,
  looksGeneratedSource,
  type ScopeClass,
} from "../util/scope-class.js";
import { criticalFieldReason, isDomainBearing } from "../domain/vocabulary.js";
import type {
  ContractDisagreement,
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
} from "./types.js";

/**
 * Build the cross-file risk index in one parse pass.
 *
 * Everything here obeys three rules:
 *
 *  1. **One parse per file.** Four inventories, one `parseFile` call.
 *  2. **No global pairwise comparison.** Every "does A relate to B?"
 *     question is answered inside a bucket keyed by something cheap to
 *     compute, and every bucket is capped. A repo with 20 000 interfaces
 *     must not cost 200 million comparisons.
 *  3. **Deterministic ordering everywhere.** Files are processed in
 *     sorted order and every emitted list is sorted, so two runs on the
 *     same tree produce byte-identical output regardless of filesystem
 *     iteration order or platform.
 */

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/**
 * File budget. Past this the index reports itself `limited` rather than
 * spending unbounded time — the same contract `ImportGraph` uses.
 */
const MAX_FILES = 5000;

/** Max candidates compared inside one bucket. */
const MAX_BUCKET_COMPARISONS = 400;

/** A policy clone must appear in at least this many distinct files. */
const MIN_CLONE_FILES = 2;

/**
 * A policy expression below this normalised-token count is too small to
 * be worth reporting as a clone even when it matches exactly.
 *
 * Three is the size of one comparison — `.role === "admin"` — which is
 * both the smallest real policy and the most common one. The parser has
 * already discarded trivial null and truthiness checks, so nothing below
 * this line is boilerplate; the floor exists to keep single-token
 * fragments out of the index, not to filter rules.
 */
const MIN_CLONE_TOKENS = 3;

/** Field-set overlap required before two contracts are candidate pairs. */
const MIN_CONTRACT_OVERLAP = 0.6;

/** Longest wrapper chain the walker will follow. */
const MAX_CHAIN_DEPTH = 8;

export interface BuildRiskIndexOptions {
  root: string;
  files: string[];
  /** Absolute paths of `.env.example`-style inventories, when known. */
  envInventoryFiles?: string[];
}

export async function buildRiskIndex(options: BuildRiskIndexOptions): Promise<RiskIndex> {
  // Sorted so every downstream "first wins" tie-break is stable across
  // platforms and filesystem orderings.
  const candidates = options.files
    .filter((f) => SOURCE_EXT_RE.test(f))
    .sort((a, b) => a.localeCompare(b));

  const limited = candidates.length > MAX_FILES;
  const budgeted = limited ? candidates.slice(0, MAX_FILES) : candidates;

  const policyOccurrences: PolicyOccurrence[] = [];
  const contractOccurrences: ContractOccurrence[] = [];
  const envOccurrences: EnvOccurrence[] = [];
  const passThroughEdges: PassThroughEdge[] = [];
  const configModules: string[] = [];
  let anchorFile: string | undefined;
  let hasDynamicReads = false;

  for (const absolutePath of budgeted) {
    const file = toRepoPath(options.root, absolutePath);
    const scope = classifyScope(file);
    // Generated and vendored code never contributes: it is not the
    // team's to fix, and a generated client full of identical wrappers
    // would dominate every inventory here.
    if (scope === "generated" || scope === "vendored") continue;

    let source: string;
    try {
      source = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (looksGeneratedSource(source)) continue;

    let parsed: ParsedFile;
    try {
      parsed = parseFile({ absolutePath, source });
    } catch {
      // A file the parser chokes on is skipped, never fatal. Matches
      // every other index builder in this package.
      continue;
    }

    // First file processed, in sorted order — the deterministic anchor
    // for repo-level findings that have no file of their own.
    anchorFile ??= file;

    collectPolicy(parsed, file, scope, policyOccurrences);
    collectContracts(parsed, file, scope, contractOccurrences);
    collectPassThrough(parsed, file, scope, passThroughEdges);

    const central = looksLikeConfigModule(parsed, file);
    if (central) configModules.push(file);
    for (const read of parsed.envReads ?? []) {
      if (read.name === "*") {
        hasDynamicReads = true;
        continue;
      }
      envOccurrences.push({
        ...read,
        file,
        scope,
        central,
        clientReachable: looksClientReachable(file),
      });
    }
  }

  const documented = await readEnvInventories(
    options.root,
    options.envInventoryFiles ?? [],
  );

  const index: RiskIndex = {
    ...(anchorFile !== undefined ? { anchorFile } : {}),
    policy: buildPolicyIndex(policyOccurrences),
    contracts: buildContractIndex(contractOccurrences),
    env: buildEnvIndex(envOccurrences, documented, configModules, hasDynamicReads),
    passThrough: buildPassThroughIndex(passThroughEdges),
  };
  if (limited) {
    index.limited = true;
    index.limitedReason = `risk index truncated at ${MAX_FILES} files (repo has ${candidates.length})`;
  }
  return index;
}

/* ------------------------------------------------------------------ *
 * Policy clones
 * ------------------------------------------------------------------ */

function collectPolicy(
  parsed: ParsedFile,
  file: string,
  scope: ScopeClass,
  out: PolicyOccurrence[],
): void {
  // Tests, fixtures, and migrations restate policy on purpose: a test
  // asserting `role === "admin"` is not a second source of truth, and a
  // migration recording March's rule is history, not duplication.
  if (scope !== "production") return;
  for (const policy of parsed.policyExpressions ?? []) {
    if (policy.tokens < MIN_CLONE_TOKENS) continue;
    out.push({
      file,
      scope,
      kind: policy.kind,
      normalized: policy.normalized,
      line: policy.line,
      endLine: policy.endLine,
      readable: policy.readable,
      paths: policy.paths,
      literals: policy.literals,
      calls: policy.calls,
      operators: policy.operators,
      tokens: policy.tokens,
      ...(policy.enclosing !== undefined ? { enclosing: policy.enclosing } : {}),
    });
  }
}

function buildPolicyIndex(occurrences: PolicyOccurrence[]): PolicyIndex {
  const byNormalized = new Map<string, PolicyOccurrence[]>();
  for (const occ of occurrences) {
    const list = byNormalized.get(occ.normalized);
    if (list) list.push(occ);
    else byNormalized.set(occ.normalized, [occ]);
  }

  const clones: PolicyCloneGroup[] = [];
  for (const [normalized, group] of byNormalized) {
    const files = [...new Set(group.map((o) => o.file))].sort();
    if (files.length < MIN_CLONE_FILES) continue;
    const sorted = [...group].sort(compareOccurrence);
    clones.push({
      normalized,
      occurrences: sorted,
      files,
      anchorFile: files[0]!,
    });
  }
  clones.sort((a, b) => a.normalized.localeCompare(b.normalized));

  return {
    clones,
    nearClones: buildNearClones(byNormalized),
    occurrenceCount: occurrences.length,
  };
}

/**
 * Group clone groups into families that share a rule shape.
 *
 * The bucketing trick: blank *every* literal in the normalised form to
 * produce a shape key. Two forms that differ only in literals
 * necessarily share a shape key, so only same-shape groups are ever
 * compared — no global pairwise scan. Buckets are capped, because a repo
 * with a hundred `x === "<some status>"` rules would otherwise blow up
 * quadratically inside one bucket.
 *
 * The result is one family per shape rather than one entry per pair.
 * That matters downstream: a shape with four variants has six pairs, and
 * six findings at one anchor would be one crime reported six times under
 * six identical fingerprints.
 */
function buildNearClones(
  byNormalized: Map<string, PolicyOccurrence[]>,
): PolicyNearCloneFamily[] {
  const buckets = new Map<string, string[]>();
  for (const normalized of byNormalized.keys()) {
    const shape = blankLiterals(normalized);
    const list = buckets.get(shape);
    if (list) list.push(normalized);
    else buckets.set(shape, [normalized]);
  }

  const out: PolicyNearCloneFamily[] = [];
  for (const [shape, forms] of buckets) {
    if (forms.length < 2) continue;
    const sorted = [...forms].sort();

    // Only variants that genuinely differ in *one* literal from at least
    // one sibling belong to the family. Two forms differing in three
    // literals share a skeleton and nothing else.
    const related = new Set<string>();
    const differences = new Set<string>();
    let comparisons = 0;
    outer: for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (++comparisons > MAX_BUCKET_COMPARISONS) break outer;
        const difference = singleLiteralDifference(sorted[i]!, sorted[j]!);
        if (difference === undefined) continue;
        related.add(sorted[i]!);
        related.add(sorted[j]!);
        differences.add(difference);
      }
    }
    if (related.size < 2) continue;

    const variants = [...related]
      .sort()
      .map((form) => groupFor(form, byNormalized))
      .filter((g): g is PolicyCloneGroup => g !== undefined);
    if (variants.length < 2) continue;

    // Every variant living in one file is a local switch, not a split
    // source of truth.
    const files = new Set(variants.flatMap((v) => v.files));
    if (files.size < 2) continue;

    out.push({
      shape,
      variants,
      differences: [...differences].sort(),
      anchorFile: [...files].sort()[0]!,
    });
  }

  out.sort((x, y) =>
    x.anchorFile === y.anchorFile
      ? x.shape.localeCompare(y.shape)
      : x.anchorFile.localeCompare(y.anchorFile),
  );
  return out;
}

/**
 * A one-occurrence "group" is still a group for near-clone purposes: the
 * interesting shape is two files with *different* rules, and requiring
 * each side to already be duplicated would miss it entirely.
 */
function groupFor(
  normalized: string,
  byNormalized: Map<string, PolicyOccurrence[]>,
): PolicyCloneGroup | undefined {
  const occurrences = byNormalized.get(normalized);
  if (!occurrences || occurrences.length === 0) return undefined;
  const files = [...new Set(occurrences.map((o) => o.file))].sort();
  return {
    normalized,
    occurrences: [...occurrences].sort(compareOccurrence),
    files,
    anchorFile: files[0]!,
  };
}

const LITERAL_RE = /"(?:[^"\\]|\\.)*"|(?<![\w.$])\d+(?:\.\d+)?/g;

function blankLiterals(normalized: string): string {
  return normalized.replace(LITERAL_RE, "?");
}

/**
 * When two same-shape forms differ in exactly one literal, describe the
 * difference. Returns `undefined` when they differ in zero or more than
 * one — zero means they are the same form, more than one means they are
 * two unrelated rules that happen to share a skeleton.
 */
function singleLiteralDifference(left: string, right: string): string | undefined {
  const leftLiterals = left.match(LITERAL_RE) ?? [];
  const rightLiterals = right.match(LITERAL_RE) ?? [];
  if (leftLiterals.length !== rightLiterals.length) return undefined;

  let differing: [string, string] | undefined;
  for (let i = 0; i < leftLiterals.length; i++) {
    if (leftLiterals[i] === rightLiterals[i]) continue;
    if (differing !== undefined) return undefined;
    differing = [leftLiterals[i]!, rightLiterals[i]!];
  }
  if (differing === undefined) return undefined;
  return `one side tests ${differing[0]}, the other tests ${differing[1]}`;
}

function compareOccurrence(a: PolicyOccurrence, b: PolicyOccurrence): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.line - b.line;
}

/* ------------------------------------------------------------------ *
 * Contracts
 * ------------------------------------------------------------------ */

function collectContracts(
  parsed: ParsedFile,
  file: string,
  scope: ScopeClass,
  out: ContractOccurrence[],
): void {
  // Fixtures and tests declare throwaway shapes constantly.
  if (scope !== "production" && scope !== "config") return;
  for (const contract of parsed.objectContracts ?? []) {
    const concept = conceptKeyOf(contract.name);
    out.push({
      file,
      scope,
      name: contract.name,
      source: contract.source,
      exported: contract.exported,
      line: contract.line,
      endLine: contract.endLine,
      fields: contract.fields,
      partial: contract.partial,
      fieldNames: contract.fields.map((f) => f.name.toLowerCase()).sort(),
      concept: concept.key,
    });
  }
}

function buildContractIndex(occurrences: ContractOccurrence[]): ContractIndex {
  // Bucket by concept key. Two contracts only pair when they claim to
  // describe the same thing, which keeps the comparison local.
  const byConcept = new Map<string, ContractOccurrence[]>();
  for (const occ of occurrences) {
    const list = byConcept.get(occ.concept);
    if (list) list.push(occ);
    else byConcept.set(occ.concept, [occ]);
  }

  const pairs: ContractDriftPair[] = [];
  for (const bucket of byConcept.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    );
    let comparisons = 0;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (++comparisons > MAX_BUCKET_COMPARISONS) break;
        const pair = comparePair(sorted[i]!, sorted[j]!);
        if (pair) pairs.push(pair);
      }
      if (comparisons > MAX_BUCKET_COMPARISONS) break;
    }
  }

  pairs.sort((a, b) => {
    if (a.anchorFile !== b.anchorFile) {
      return a.anchorFile.localeCompare(b.anchorFile);
    }
    return `${a.left.name}${a.right.name}`.localeCompare(`${b.left.name}${b.right.name}`);
  });

  return { occurrences, pairs };
}

function comparePair(
  first: ContractOccurrence,
  second: ContractOccurrence,
): ContractDriftPair | undefined {
  // Two declarations in the same file at the same place are the same
  // declaration seen twice.
  if (first.file === second.file && first.line === second.line) return undefined;

  const leftKey = conceptKeyOf(first.name);
  const rightKey = conceptKeyOf(second.name);
  if (isProjectionPair(leftKey, rightKey)) return undefined;

  const leftFields = new Set(first.fieldNames);
  const rightFields = new Set(second.fieldNames);
  const shared = [...leftFields].filter((f) => rightFields.has(f)).sort();
  const smaller = Math.min(leftFields.size, rightFields.size);
  if (smaller === 0) return undefined;
  const overlap = shared.length / smaller;
  if (overlap < MIN_CONTRACT_OVERLAP) return undefined;

  // Order the pair deterministically by file then line.
  const [left, right] =
    first.file === second.file
      ? first.line <= second.line
        ? [first, second]
        : [second, first]
      : first.file <= second.file
        ? [first, second]
        : [second, first];

  const disagreements = diffFields(left, right, shared);
  if (disagreements.length === 0) return undefined;

  const matchReasons = buildMatchReasons(left, right, leftKey, overlap, shared);

  return {
    left,
    right,
    matchReasons,
    sharedFields: shared,
    overlap: Math.round(overlap * 100) / 100,
    disagreements,
    anchorFile: left.file <= right.file ? left.file : right.file,
  };
}

function buildMatchReasons(
  left: ContractOccurrence,
  right: ContractOccurrence,
  key: ConceptKey,
  overlap: number,
  shared: string[],
): string[] {
  const reasons: string[] = [];
  reasons.push(
    `both names reduce to the concept "${key.base}" (\`${left.name}\` / \`${right.name}\`)`,
  );
  reasons.push(
    `${shared.length} shared field(s), ${Math.round(overlap * 100)}% of the smaller declaration`,
  );
  const domainShared = shared.filter((f) => isDomainBearing(f));
  if (domainShared.length > 0) {
    reasons.push(`shared domain fields: ${domainShared.slice(0, 6).join(", ")}`);
  }
  if (left.source !== right.source) {
    reasons.push(
      `declared in different forms (${left.source} vs ${right.source}), so no type checker compares them`,
    );
  }
  return reasons;
}

function diffFields(
  left: ContractOccurrence,
  right: ContractOccurrence,
  shared: string[],
): ContractDisagreement[] {
  const leftByName = fieldMap(left.fields);
  const rightByName = fieldMap(right.fields);
  const out: ContractDisagreement[] = [];

  for (const name of shared) {
    const a = leftByName.get(name);
    const b = rightByName.get(name);
    if (!a || !b) continue;

    const reason = criticalFieldReason(a.name);
    const add = (
      kind: ContractDisagreement["kind"],
      leftText: string,
      rightText: string,
    ): void => {
      out.push({
        kind,
        field: a.name,
        left: leftText,
        right: rightText,
        ...(reason !== undefined ? { criticalReason: reason } : {}),
      });
    };

    if (a.optional !== b.optional) {
      add(
        "requiredness",
        a.optional ? "optional" : "required",
        b.optional ? "optional" : "required",
      );
    }
    if (a.nullable !== b.nullable) {
      add(
        "nullability",
        a.nullable ? "nullable" : "non-null",
        b.nullable ? "nullable" : "non-null",
      );
    }
    if (a.enumMembers && b.enumMembers) {
      const aSet = new Set(a.enumMembers);
      const bSet = new Set(b.enumMembers);
      const onlyLeft = a.enumMembers.filter((m) => !bSet.has(m));
      const onlyRight = b.enumMembers.filter((m) => !aSet.has(m));
      if (onlyLeft.length > 0 || onlyRight.length > 0) {
        add("enum_members", a.enumMembers.join(" | "), b.enumMembers.join(" | "));
      }
    } else if (a.type !== b.type) {
      add("type", a.type, b.type);
    }
    if (a.nested !== b.nested && a.type !== b.type) {
      add(
        "nesting",
        a.nested ? "nested object" : a.type,
        b.nested ? "nested object" : b.type,
      );
    }
  }

  // A field one side declares and the other omits is only reportable when
  // the omitting side is complete — a `partial` contract may hold it in
  // the part we did not expand.
  const leftOnly = left.fieldNames.filter((f) => !right.fieldNames.includes(f));
  const rightOnly = right.fieldNames.filter((f) => !left.fieldNames.includes(f));
  if (!right.partial) {
    for (const name of leftOnly) {
      const field = leftByName.get(name);
      if (!field) continue;
      const reason = criticalFieldReason(field.name);
      if (reason === undefined) continue;
      out.push({
        kind: "missing_field",
        field: field.name,
        left: `declared (${field.type})`,
        right: "absent",
        criticalReason: reason,
      });
    }
  }
  if (!left.partial) {
    for (const name of rightOnly) {
      const field = rightByName.get(name);
      if (!field) continue;
      const reason = criticalFieldReason(field.name);
      if (reason === undefined) continue;
      out.push({
        kind: "missing_field",
        field: field.name,
        left: "absent",
        right: `declared (${field.type})`,
        criticalReason: reason,
      });
    }
  }

  return out.sort((a, b) =>
    a.field === b.field ? a.kind.localeCompare(b.kind) : a.field.localeCompare(b.field),
  );
}

function fieldMap(fields: ContractField[]): Map<string, ContractField> {
  const map = new Map<string, ContractField>();
  for (const field of fields) map.set(field.name.toLowerCase(), field);
  return map;
}

/* ------------------------------------------------------------------ *
 * Environment configuration
 * ------------------------------------------------------------------ */

function buildEnvIndex(
  occurrences: EnvOccurrence[],
  documented: { names: Set<string>; files: string[] },
  configModules: string[],
  hasDynamicReads: boolean,
): EnvIndex {
  const byName = new Map<string, EnvOccurrence[]>();
  for (const occ of occurrences) {
    const list = byName.get(occ.name);
    if (list) list.push(occ);
    else byName.set(occ.name, [occ]);
  }

  const variables: EnvVariableRecord[] = [];
  for (const [name, reads] of byName) {
    const sorted = [...reads].sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    );
    const files = [...new Set(sorted.map((r) => r.file))].sort();
    variables.push({
      name,
      reads: sorted,
      files,
      parsers: [...new Set(sorted.map((r) => r.parser ?? "(none)"))].sort(),
      defaults: [
        ...new Set(
          sorted.map((r) => r.defaultValue).filter((d): d is string => d !== undefined),
        ),
      ].sort(),
      units: [
        ...new Set(sorted.map((r) => r.unit).filter((u): u is string => u !== undefined)),
      ].sort(),
      anyRequired: sorted.some((r) => r.required),
      anyOptional: sorted.some((r) => !r.required),
      documented: documented.names.has(name),
      anchorFile: files[0]!,
    });
  }
  variables.sort((a, b) => a.name.localeCompare(b.name));

  return {
    variables,
    documentedNames: documented.names,
    inventoryFiles: documented.files.sort(),
    configModules: [...configModules].sort(),
    hasDynamicReads,
  };
}

/**
 * Read `.env.example`-style inventories.
 *
 * Only variable **names** are extracted. The parser stops at the `=` and
 * never looks right of it, so there is no code path by which a value from
 * one of these files can reach a finding — which matters, because a
 * developer's real `.env` occasionally gets committed and this tool must
 * not be the thing that prints its contents.
 */
async function readEnvInventories(
  root: string,
  absolutePaths: string[],
): Promise<{ names: Set<string>; files: string[] }> {
  const names = new Set<string>();
  const files: string[] = [];

  for (const absolutePath of [...absolutePaths].sort()) {
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    files.push(toRepoPath(root, absolutePath));
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const withoutExport = line.replace(/^export\s+/, "");
      const eq = withoutExport.indexOf("=");
      const name = (eq === -1 ? withoutExport : withoutExport.slice(0, eq)).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return { names, files };
}

/**
 * Does this file plausibly end up in a browser bundle?
 *
 * Path-based and deliberately coarse. It exists to raise severity on a
 * server-only variable read from client code, and the detector phrases
 * that finding as "appears to be reachable from client code" precisely
 * because a path heuristic cannot prove a bundling outcome.
 */
function looksClientReachable(file: string): boolean {
  return (
    /(^|\/)(app|src|pages|components|islands|routes)\/.*\.(tsx|jsx)$/.test(file) ||
    /(^|\/)(client|frontend|web|browser|ui)\//.test(file) ||
    /\.client\.[cm]?[jt]sx?$/.test(file)
  );
}

/* ------------------------------------------------------------------ *
 * Pass-through abstraction
 * ------------------------------------------------------------------ */

function collectPassThrough(
  parsed: ParsedFile,
  file: string,
  scope: ScopeClass,
  out: PassThroughEdge[],
): void {
  if (scope !== "production") return;
  for (const fn of parsed.passThroughFunctions ?? []) {
    out.push({
      file,
      scope,
      name: fn.name,
      line: fn.line,
      endLine: fn.endLine,
      exported: fn.exported,
      target: fn.target,
      targetTail: fn.targetTail,
      forwarding: fn.forwarding,
      adds: fn.adds,
      ...(fn.viaMember !== undefined ? { viaMember: fn.viaMember } : {}),
      ...(fn.sameName === true ? { sameName: true as const } : {}),
    });
  }
}

function buildPassThroughIndex(edges: PassThroughEdge[]): PassThroughIndex {
  const byKey = new Map<string, PassThroughEdge>();
  // Wrapper name → the edges declaring it. A chain step is "the target of
  // edge A is the name of edge B", which this index answers in O(1).
  const byName = new Map<string, PassThroughEdge[]>();

  const sorted = [...edges].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
  for (const edge of sorted) {
    byKey.set(`${edge.file}::${edge.name}`, edge);
    const list = byName.get(edge.name);
    if (list) list.push(edge);
    else byName.set(edge.name, [edge]);
  }

  return {
    edges: byKey,
    chains: buildChains(sorted, byName),
    clusters: buildClusters(sorted),
  };
}

/**
 * Can a walk step from `from` to `to`?
 *
 * Chain links used to be pure name equality: edge A's `targetTail`
 * equals edge B's `name`, in any file. On a large repo that is not a
 * link, it is a collision — `delete`, `has`, `get` and `run` are each
 * declared dozens of times by unrelated types, and the walk *preferred*
 * a different file, so it maximised the fabrication. Confidence then
 * rose with the number of unrelated files joined, because "spans 3
 * files" and "4 layers deep" are both scored as corroboration.
 *
 * Measured on n8n `packages/cli`: 13 chain findings, several at
 * confidence 0.98, one of them starting at `Set.prototype.has`.
 *
 * A cross-file step now additionally requires the target to be
 * **exported**. A function another module never exported cannot be the
 * one this module called, so the step would have been provably wrong,
 * not merely unproven.
 */
function canFollow(from: PassThroughEdge, to: PassThroughEdge): boolean {
  if (to.file === from.file) return true;
  return to.exported;
}

/**
 * Walk wrapper → wrapper links to find chains of length ≥2 spanning ≥2
 * files.
 *
 * A chain of length 1 is a thin wrapper, which is usually a façade and
 * never reported on its own — the whole premise of this detector is that
 * indirection becomes a problem when it *stacks*.
 */
function buildChains(
  edges: PassThroughEdge[],
  byName: Map<string, PassThroughEdge[]>,
): PassThroughChain[] {
  const chains: PassThroughChain[] = [];
  // Any edge that is itself some other edge's target is an interior link;
  // starting a walk there would report the same chain twice under two
  // different heads.
  const isInterior = new Set<string>();
  for (const edge of edges) {
    for (const next of byName.get(edge.targetTail) ?? []) {
      if (next.file === edge.file && next.name === edge.name) continue;
      isInterior.add(`${next.file}::${next.name}`);
    }
  }

  for (const start of edges) {
    if (isInterior.has(`${start.file}::${start.name}`)) continue;

    const walk: PassThroughEdge[] = [start];
    const visited = new Set<string>([`${start.file}::${start.name}`]);
    let cursor = start;

    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      // A member call (`this.repo.delete(…)`) names a method on an
      // object whose type we have not read. Its tail is not a link — it
      // is a word. Following it is how four unrelated registries, each
      // with its own `has()` delegating to its own private Map, became
      // one "4 layers across 4 files" chain on n8n at confidence 0.98.
      // See {@link canFollow}.
      if (cursor.viaMember !== undefined) break;
      const candidates = (byName.get(cursor.targetTail) ?? []).filter(
        (e) => !visited.has(`${e.file}::${e.name}`) && canFollow(cursor, e),
      );
      if (candidates.length === 0) break;
      // Prefer a link in a *different* file — the chain that costs a
      // reader something is the one that crosses module boundaries — and
      // break ties lexicographically so the walk is deterministic.
      const next = candidates.find((e) => e.file !== cursor.file) ?? candidates[0]!;
      walk.push(next);
      visited.add(`${next.file}::${next.name}`);
      cursor = next;
    }

    if (walk.length < 2) continue;
    const files: string[] = [];
    for (const edge of walk) {
      if (files[files.length - 1] !== edge.file) files.push(edge.file);
    }
    if (files.length < 2) continue;

    chains.push({
      edges: walk,
      files,
      terminal: cursor.target,
      anchorFile: walk[0]!.file,
    });
  }

  chains.sort((a, b) => {
    if (a.anchorFile !== b.anchorFile) {
      return a.anchorFile.localeCompare(b.anchorFile);
    }
    return a.edges[0]!.name.localeCompare(b.edges[0]!.name);
  });
  return chains;
}

/**
 * Find files where three or more wrappers all forward to the same
 * collaborator. This is the shape a chain walk cannot see: each edge is
 * length one, but together they are a class that exists only to repeat
 * another class's interface.
 */
function buildClusters(edges: PassThroughEdge[]): PassThroughCluster[] {
  const byFileReceiver = new Map<string, PassThroughEdge[]>();
  for (const edge of edges) {
    const receiver = edge.viaMember ?? receiverOf(edge.target);
    if (receiver === undefined) continue;
    const key = `${edge.file} ${receiver}`;
    const list = byFileReceiver.get(key);
    if (list) list.push(edge);
    else byFileReceiver.set(key, [edge]);
  }

  const clusters: PassThroughCluster[] = [];
  for (const [key, members] of byFileReceiver) {
    if (members.length < 3) continue;
    const [file, receiver] = key.split(" ") as [string, string];
    clusters.push({
      file,
      scope: members[0]!.scope,
      receiver,
      edges: [...members].sort((a, b) => a.line - b.line),
      anchorFile: file,
    });
  }
  clusters.sort((a, b) =>
    a.file === b.file
      ? a.receiver.localeCompare(b.receiver)
      : a.file.localeCompare(b.file),
  );
  return clusters;
}

function receiverOf(target: string): string | undefined {
  const idx = target.lastIndexOf(".");
  return idx === -1 ? undefined : target.slice(0, idx);
}

function toRepoPath(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
