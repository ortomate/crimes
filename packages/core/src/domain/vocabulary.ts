/**
 * Shared domain vocabulary.
 *
 * Several detectors added in 0.16.0 need the same judgement call: "does
 * this identifier / literal / field name carry business meaning, or is it
 * plumbing?" `duplicated_policy` uses it to decide whether a clone is a
 * *policy* clone; `contract_drift` uses it to decide whether a disagreeing
 * field is worth a finding; `swallowed_error` and `unsafe_retry` use it to
 * decide whether the protected operation is consequential.
 *
 * Keeping one catalogue matters more than the individual words. Three
 * detectors with three drifting copies of "what counts as a permission
 * check" is exactly the crime this product reports, and shipping it inside
 * the product would be embarrassing.
 *
 * Everything here is a *lexical* signal. No detector may conclude
 * "this is authorization code" from a token match alone — the token raises
 * confidence on a structural finding that already stands on its own.
 */

/**
 * Concept families. The key is the stable id used in evidence strings; the
 * value is the set of lowercase tokens that count as members.
 *
 * Tokens are matched against **word-split identifiers** (see
 * {@link splitIdentifier}), never as substrings — otherwise `role` matches
 * `rolled`, `plan` matches `planet`, and the confidence boost becomes
 * noise.
 */
export const DOMAIN_CONCEPTS: Record<string, readonly string[]> = {
  authorization: [
    "role",
    "roles",
    "permission",
    "permissions",
    "scope",
    "scopes",
    "grant",
    "grants",
    "acl",
    "policy",
    "policies",
    "privilege",
    "privileges",
    "admin",
    "superuser",
    "authorize",
    "authorized",
    "authorization",
    "authorise",
    "authorised",
    "can",
    "allowed",
    "forbidden",
    "denied",
  ],
  identity: [
    "user",
    "account",
    "actor",
    "principal",
    "member",
    "membership",
    "owner",
    "ownership",
    "auth",
    "session",
    "token",
    "credential",
    "credentials",
    "identity",
  ],
  tenancy: [
    "tenant",
    "workspace",
    "organization",
    "organisation",
    "org",
    "team",
    "project",
    "namespace",
  ],
  billing: [
    "plan",
    "plans",
    "tier",
    "tiers",
    "price",
    "pricing",
    "billing",
    "invoice",
    "subscription",
    "subscribe",
    "quota",
    "seat",
    "seats",
    "usage",
    "credit",
    "credits",
    "charge",
    "refund",
    "coupon",
    "discount",
    "currency",
    "amount",
    "total",
    "subtotal",
    "tax",
  ],
  lifecycle: [
    "status",
    "state",
    "phase",
    "stage",
    "transition",
    "active",
    "inactive",
    "pending",
    "approved",
    "rejected",
    "cancelled",
    "canceled",
    "archived",
    "published",
    "draft",
    "deleted",
    "suspended",
    "expired",
  ],
  eligibility: [
    "eligible",
    "eligibility",
    "entitled",
    "entitlement",
    "entitlements",
    "feature",
    "features",
    "flag",
    "flags",
    "gate",
    "enabled",
    "available",
    "limit",
    "threshold",
  ],
  validation: [
    "valid",
    "invalid",
    "validate",
    "validation",
    "verify",
    "verified",
    "required",
    "constraint",
  ],
} as const;

/** Every domain token, flattened. Built once at module load. */
const ALL_DOMAIN_TOKENS: ReadonlySet<string> = new Set(
  Object.values(DOMAIN_CONCEPTS).flat(),
);

/**
 * The subset of {@link DOMAIN_CONCEPTS} that is *only* ever business
 * vocabulary.
 *
 * This tier exists because the full catalogue is deliberately generous —
 * it is used to raise confidence, where a false match costs a rounding
 * error. Some of those words are also ordinary programming vocabulary:
 * `state`, `type`, `valid`, `flag`, `limit`, `total`, `can`, `active`.
 * A detector that *gates* on the full catalogue reports
 * `if (buffer.length > 0)` as a duplicated business rule, which is how a
 * useful detector becomes a disabled one.
 *
 * So gating uses this narrower list. Every word here names something a
 * product person would recognise and nothing a compiler would.
 * `user` is deliberately absent (it appears in `userAgent`,
 * `userland`); `role`, `permission`, and `plan` carry the same
 * expressions when they matter.
 */
const STRONG_DOMAIN_TOKENS: ReadonlySet<string> = new Set([
  // authorization
  "role",
  "roles",
  "permission",
  "permissions",
  "grant",
  "grants",
  "acl",
  "privilege",
  "privileges",
  "admin",
  "superuser",
  "authorize",
  "authorized",
  "authorization",
  "authorise",
  "authorised",
  "forbidden",
  "denied",
  // identity
  "principal",
  "membership",
  "owner",
  "ownership",
  "credential",
  "credentials",
  // tenancy
  "tenant",
  "workspace",
  "organization",
  "organisation",
  "namespace",
  // billing
  "plan",
  "plans",
  "tier",
  "tiers",
  "price",
  "pricing",
  "billing",
  "invoice",
  "subscription",
  "subscribe",
  "quota",
  "seat",
  "seats",
  "coupon",
  "discount",
  "currency",
  "refund",
  "subtotal",
  "tax",
  // lifecycle — `status` only; `state` is too generic to gate on
  "status",
  "approved",
  "rejected",
  "cancelled",
  "canceled",
  "archived",
  "published",
  "suspended",
  "expired",
  // eligibility
  "eligible",
  "eligibility",
  "entitled",
  "entitlement",
  "entitlements",
]);

/**
 * Concept id for each token, for evidence strings that want to name the
 * family ("domain concept: billing") rather than repeat the token.
 */
const TOKEN_TO_CONCEPT: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [concept, tokens] of Object.entries(DOMAIN_CONCEPTS)) {
    for (const token of tokens) {
      // First writer wins so a token listed in two families reports the
      // family it was primarily catalogued under. Deterministic because
      // `Object.entries` preserves insertion order for string keys.
      if (!map.has(token)) map.set(token, concept);
    }
  }
  return map;
})();

/**
 * Split an identifier or property path into lowercase words.
 *
 * Handles camelCase, PascalCase, snake_case, kebab-case, dotted property
 * paths, and SCREAMING_SNAKE. `user.billingPlan` → `["user", "billing",
 * "plan"]`. Consecutive capitals are kept together so `ACL` survives as
 * one word rather than three.
 */
export function splitIdentifier(name: string): string[] {
  if (name.length === 0) return [];
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/**
 * Domain tokens present in an identifier, in first-appearance order and
 * deduplicated. Empty when the identifier is pure plumbing.
 */
export function domainTokensIn(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of splitIdentifier(name)) {
    if (!ALL_DOMAIN_TOKENS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** Does this identifier carry any domain-bearing token? */
export function isDomainBearing(name: string): boolean {
  for (const word of splitIdentifier(name)) {
    if (ALL_DOMAIN_TOKENS.has(word)) return true;
  }
  return false;
}

/**
 * Unambiguously-business tokens in an identifier — the gating tier.
 *
 * Use this to decide **whether** to report; use {@link domainTokensIn} to
 * decide how confident to be. Mixing the two is what turns a policy
 * detector into a clone detector.
 */
export function strongDomainTokensIn(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of splitIdentifier(name)) {
    if (!STRONG_DOMAIN_TOKENS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** Does this identifier carry an unambiguously-business token? */
export function isStronglyDomainBearing(name: string): boolean {
  for (const word of splitIdentifier(name)) {
    if (STRONG_DOMAIN_TOKENS.has(word)) return true;
  }
  return false;
}

/** Strong domain tokens across a collection of names, sorted. */
export function strongDomainTokensAcross(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const token of strongDomainTokensIn(name)) out.add(token);
  }
  return [...out].sort();
}

/**
 * Concept families touched by an identifier, sorted for deterministic
 * evidence. `["billing"]` for `planTier`, `[]` for `retryCount`.
 */
export function conceptsIn(name: string): string[] {
  const out = new Set<string>();
  for (const token of domainTokensIn(name)) {
    const concept = TOKEN_TO_CONCEPT.get(token);
    if (concept) out.add(concept);
  }
  return [...out].sort();
}

/**
 * Domain tokens across a collection of names, deduplicated and sorted.
 * Convenience for detectors that score a whole clone group or contract at
 * once.
 */
export function domainTokensAcross(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const token of domainTokensIn(name)) out.add(token);
  }
  return [...out].sort();
}

/**
 * Field names whose disagreement between two representations of one
 * contract is materially riskier than an ordinary field: identifiers,
 * tenancy keys, permission carriers, money, and timestamps.
 *
 * Used by `contract_drift` to escalate severity, per the rule that a
 * renamed `userId` is a different class of problem from a renamed
 * `displayName`.
 */
export function isCriticalField(name: string): boolean {
  const words = splitIdentifier(name);
  if (words.length === 0) return false;
  const last = words[words.length - 1]!;

  // Identifier-shaped: `id`, `userId`, `tenant_id`, `uuid`, `externalRef`.
  if (last === "id" || last === "uuid" || last === "guid" || last === "ref") {
    return true;
  }
  // Timestamps: `createdAt`, `updated_at`, `expiresAt`, `deletedOn`.
  if (last === "at" || last === "on" || last === "timestamp" || last === "date") {
    return true;
  }
  // Money: an `amount` / `price` / `total` / `currency` word anywhere.
  for (const word of words) {
    if (MONEY_WORDS.has(word)) return true;
    if (TENANCY_WORDS.has(word)) return true;
    if (PERMISSION_WORDS.has(word)) return true;
    if (STATUS_WORDS.has(word)) return true;
  }
  return false;
}

/**
 * Why a field counts as critical, for evidence. Returns `undefined` when
 * it doesn't. Deterministic: the first matching category in a fixed order
 * wins, so the same field always reports the same reason.
 */
export function criticalFieldReason(name: string): string | undefined {
  const words = splitIdentifier(name);
  if (words.length === 0) return undefined;
  const last = words[words.length - 1]!;
  if (last === "id" || last === "uuid" || last === "guid" || last === "ref") {
    return "identifier field";
  }
  for (const word of words) {
    if (TENANCY_WORDS.has(word)) return "tenancy field";
  }
  for (const word of words) {
    if (PERMISSION_WORDS.has(word)) return "permission field";
  }
  for (const word of words) {
    if (STATUS_WORDS.has(word)) return "status field";
  }
  for (const word of words) {
    if (MONEY_WORDS.has(word)) return "money field";
  }
  if (last === "at" || last === "on" || last === "timestamp" || last === "date") {
    return "timestamp field";
  }
  return undefined;
}

const MONEY_WORDS: ReadonlySet<string> = new Set([
  "amount",
  "price",
  "cost",
  "total",
  "subtotal",
  "balance",
  "currency",
  "cents",
  "tax",
  "fee",
  "discount",
  "refund",
  "charge",
]);

const TENANCY_WORDS: ReadonlySet<string> = new Set([
  "tenant",
  "workspace",
  "organization",
  "organisation",
  "org",
  "account",
  "namespace",
]);

const PERMISSION_WORDS: ReadonlySet<string> = new Set([
  "role",
  "roles",
  "permission",
  "permissions",
  "scope",
  "scopes",
  "acl",
  "grant",
  "grants",
  "privilege",
  "privileges",
]);

const STATUS_WORDS: ReadonlySet<string> = new Set(["status", "state", "phase"]);

/**
 * Operation words that make a failure consequential — a write that
 * silently no-ops is worse than a read that silently returns nothing.
 *
 * Consumed by `swallowed_error` (severity escalation) and `unsafe_retry`
 * (mutating-operation detection). One catalogue, two readings.
 */
export const MUTATING_OPERATION_WORDS: ReadonlySet<string> = new Set([
  "create",
  "insert",
  "update",
  "upsert",
  "delete",
  "destroy",
  "remove",
  "save",
  "write",
  "put",
  "post",
  "patch",
  "publish",
  "emit",
  "enqueue",
  "queue",
  "dispatch",
  "send",
  "submit",
  "charge",
  "capture",
  "refund",
  "transfer",
  "pay",
  "commit",
  "apply",
  "provision",
  "deploy",
  "register",
  "revoke",
  "grant",
  "increment",
  "decrement",
  "mutate",
  "execute",
  "exec",
  "run",
]);

/** Does this callee name look like it mutates state somewhere? */
export function looksMutating(calleeName: string): boolean {
  const words = splitIdentifier(calleeName);
  for (const word of words) {
    if (MUTATING_OPERATION_WORDS.has(word)) return true;
  }
  return false;
}

/**
 * Boundary families a caught-and-discarded failure might be hiding.
 * Ordered most-consequential first so evidence names the worst one.
 */
export const RISKY_BOUNDARIES: ReadonlyArray<{
  id: string;
  label: string;
  tokens: readonly string[];
}> = [
  {
    id: "payment",
    label: "payment",
    tokens: [
      "charge",
      "payment",
      "stripe",
      "invoice",
      "refund",
      "payout",
      "billing",
      "checkout",
    ],
  },
  {
    id: "authorization",
    label: "authentication / authorization",
    tokens: [
      "auth",
      "authenticate",
      "authorize",
      "authorise",
      "login",
      "session",
      "token",
      "permission",
      "role",
    ],
  },
  {
    id: "persistence",
    label: "database write",
    tokens: [
      "db",
      "database",
      "prisma",
      "knex",
      "sequelize",
      "mongo",
      "repository",
      "repo",
      "transaction",
      "insert",
      "update",
      "upsert",
      "delete",
      "save",
      "persist",
    ],
  },
  {
    id: "queue",
    label: "queue publish",
    tokens: [
      "queue",
      "publish",
      "enqueue",
      "kafka",
      "sqs",
      "sns",
      "pubsub",
      "rabbit",
      "topic",
      "producer",
    ],
  },
  {
    id: "filesystem",
    label: "file write",
    tokens: [
      "writefile",
      "mkdir",
      "rename",
      "unlink",
      "rmdir",
      "copyfile",
      "appendfile",
      "truncate",
    ],
  },
  {
    id: "network",
    label: "external request",
    tokens: ["fetch", "axios", "request", "http", "https", "client", "api", "webhook"],
  },
  {
    id: "state_transition",
    label: "state transition",
    tokens: [
      "transition",
      "activate",
      "deactivate",
      "cancel",
      "approve",
      "reject",
      "complete",
      "finalize",
      "finalise",
      "archive",
      "suspend",
    ],
  },
];

/**
 * The most consequential boundary an expression appears to touch, or
 * `undefined`. `expressionText` is the raw source of the protected
 * operation; matching runs over its split words so `stripe.charges.create`
 * matches `stripe` (payment) rather than accidentally matching a substring.
 */
export function classifyBoundary(
  expressionText: string,
): { id: string; label: string; token: string } | undefined {
  const words = splitIdentifier(expressionText);
  const candidates = new Set(words);
  // Adjacent pairs, joined. `fs.writeFile` splits to `["fs", "write",
  // "file"]`, so the catalogue's `writefile` would never match a
  // word-by-word lookup. Adding joined pairs lets multi-word API names
  // (`writeFile`, `sendMessage`, `captureException`) be catalogued as the
  // single concepts they are, without falling back to substring matching
  // and its false positives.
  for (let i = 0; i + 1 < words.length; i++) {
    candidates.add(`${words[i]}${words[i + 1]}`);
  }

  for (const boundary of RISKY_BOUNDARIES) {
    for (const token of boundary.tokens) {
      if (candidates.has(token)) {
        return { id: boundary.id, label: boundary.label, token };
      }
    }
  }
  return undefined;
}
