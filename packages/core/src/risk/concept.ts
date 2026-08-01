/**
 * Contract name normalisation.
 *
 * `contract_drift` has to answer "are these two declarations describing
 * the same record?" before it can answer "do they disagree?" — and
 * getting the first question wrong produces the worst kind of false
 * positive, one that reads plausibly and wastes a real investigation.
 *
 * The rule has two halves, and the second is the important one.
 *
 * **Equivalence suffixes** are noise words a codebase attaches to the
 * same concept: `User`, `UserDTO`, `UserModel`, `UserSchema`, and
 * `UserEntity` all mean the user. Strip them.
 *
 * **Projection markers** are the opposite: they announce that the
 * declaration is deliberately *not* the whole record. `UserSummary`,
 * `UserPatch`, `CreateUserInput`, `PublicUser`, `UserRow`, and
 * `UpdateUserRequest` are all supposed to differ from `User`, and
 * reporting them as drift would be reporting the design as a bug.
 *
 * So a projection marker is retained as part of the concept key. Two
 * contracts pair only when their markers match — `UserSummary` pairs
 * with `UserSummaryDTO`, never with `User`.
 */

/** Suffixes and prefixes that carry no meaning of their own. */
const EQUIVALENCE_AFFIXES: readonly string[] = [
  "dto",
  "model",
  "schema",
  "type",
  "types",
  "interface",
  "shape",
  "entity",
  "object",
  "obj",
  "def",
  "definition",
  "struct",
];

/**
 * Words announcing "this is a projection of something else". Retained in
 * the concept key so projections never pair with the full record.
 */
const PROJECTION_MARKERS: readonly string[] = [
  "summary",
  "patch",
  "update",
  "create",
  "insert",
  "delete",
  "input",
  "output",
  "payload",
  "public",
  "private",
  "internal",
  "external",
  "row",
  "record",
  "request",
  "req",
  "response",
  "res",
  "args",
  "arguments",
  "props",
  "params",
  "parameters",
  "options",
  "opts",
  "config",
  "preview",
  "brief",
  "partial",
  "draft",
  "view",
  "list",
  "item",
  "detail",
  "details",
  "form",
  "filter",
  "query",
  "result",
  "state",
  "snapshot",
];

const PROJECTION_SET: ReadonlySet<string> = new Set(PROJECTION_MARKERS);
const EQUIVALENCE_SET: ReadonlySet<string> = new Set(EQUIVALENCE_AFFIXES);

/** Irregular plurals worth handling; everything else uses the `s` rule. */
const IRREGULAR_SINGULARS: ReadonlyMap<string, string> = new Map([
  ["people", "person"],
  ["children", "child"],
  ["entries", "entry"],
  ["companies", "company"],
  ["categories", "category"],
  ["policies", "policy"],
  ["identities", "identity"],
  ["addresses", "address"],
  ["statuses", "status"],
]);

export interface ConceptKey {
  /** Comparable key: base concept plus any projection markers, sorted. */
  key: string;
  /** The bare concept with every affix removed (`user`). */
  base: string;
  /** Projection markers found, sorted. Empty for a full-record contract. */
  projections: string[];
}

/**
 * Reduce a declaration name to a comparable concept key.
 *
 * `UserDTO` → `{ key: "user", base: "user", projections: [] }`
 * `CreateUserInput` → `{ key: "user::create+input", base: "user",
 *                        projections: ["create", "input"] }`
 */
export function conceptKeyOf(name: string): ConceptKey {
  const words = splitWords(name);
  const base: string[] = [];
  const projections = new Set<string>();

  for (const word of words) {
    if (EQUIVALENCE_SET.has(word)) continue;
    if (PROJECTION_SET.has(word)) {
      projections.add(word);
      continue;
    }
    base.push(singularise(word));
  }

  // A name made *entirely* of affixes (`Schema`, `CreateInput`) has no
  // concept of its own. Fall back to the whole lowercased name so two
  // such declarations still only match each other.
  const baseKey = base.length > 0 ? base.join("") : words.join("");
  const sorted = [...projections].sort();
  return {
    key: sorted.length > 0 ? `${baseKey}::${sorted.join("+")}` : baseKey,
    base: baseKey,
    projections: sorted,
  };
}

/**
 * Is this pair of names a projection relationship rather than two
 * spellings of one record? Used to reject a candidate pair even when
 * field overlap is high.
 */
export function isProjectionPair(left: ConceptKey, right: ConceptKey): boolean {
  if (left.projections.length === right.projections.length) {
    // Same markers, or both unmarked: not a projection relationship.
    return left.projections.some((p) => !right.projections.includes(p));
  }
  return true;
}

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

function singularise(word: string): string {
  const irregular = IRREGULAR_SINGULARS.get(word);
  if (irregular !== undefined) return irregular;
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("ses")) return word.slice(0, -2);
  // `status` / `address` must not lose their trailing `s`.
  if (
    word.length > 2 &&
    word.endsWith("s") &&
    !word.endsWith("ss") &&
    !word.endsWith("us")
  ) {
    return word.slice(0, -1);
  }
  return word;
}
