import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import {
  conceptsIn,
  domainTokensAcross,
  strongDomainTokensAcross,
} from "../domain/vocabulary.js";
import {
  ConfidenceLadder,
  SeverityLadder,
  scoreRationale,
} from "../scoring/confidence.js";
import { hashSlice } from "../ast-hash/hash.js";
import type {
  PolicyCloneGroup,
  PolicyNearCloneFamily,
  PolicyOccurrence,
} from "../risk/types.js";

/**
 * Policy Doppelgänger — the same business rule implemented independently
 * in two or more production locations.
 *
 * ## What makes this different from clone detection
 *
 * A generic clone detector reports that you wrote the same six lines
 * twice. That is usually fine and always boring. This one only looks at
 * expressions the parser classified as *policy* — a decision about who
 * may do something, whether something is valid, what it costs, or which
 * state it may move to next — and only reports them when the same
 * decision is made in more than one place.
 *
 * The distinction is not cosmetic. A duplicated formatting helper costs
 * nothing when it drifts. A duplicated authorization rule that drifts
 * means one route enforces a policy the other does not, and nothing in
 * the type system or the test suite will tell you which.
 *
 * ## Why it matters more with agents
 *
 * An agent asked to "let team owners export billing data too" will find
 * the check it was pointed at, change it, and report success. It has no
 * reason to suspect the same check exists in a middleware three
 * directories away. The change looks complete, reviews as complete, and
 * ships half-applied.
 *
 * ## What it deliberately does not claim
 *
 * That the duplication is a bug. Two matching rules may be correct
 * today. The finding is that they are *independently maintained* — there
 * is no mechanism keeping them in agreement, so the next edit to either
 * one is unobserved by the other.
 *
 * ## False-positive boundaries
 *
 * - Trivial null and truthiness checks are never extracted (parser-side).
 * - Tests, fixtures, migrations, generated, and vendored files never
 *   contribute occurrences.
 * - A rule appearing twice in one file is not reported: that is a local
 *   branch, not a split source of truth.
 * - **A clone with no unambiguously-business vocabulary is never
 *   reported, at any repetition count.** `buffer.length > 0` appears in
 *   fifty files of any large codebase and is not a policy; neither is
 *   `count <= 0` or `detector.pack === "language-py"`. The gate uses the
 *   narrow `strongDomainTokensIn` tier — `role`, `permission`, `plan`,
 *   `tenant`, `status`, `entitlement` — rather than the generous
 *   catalogue used for confidence, precisely so that generic predicates
 *   cannot reach a finding by sheer repetition.
 *
 * ## Boundary with `duplicated_role_status_plan_check`
 *
 * The 0.6.0 detector `duplicated_role_status_plan_check` already owns one
 * specific shape: **the same role / status / plan literal compared with
 * two or more *different* expressions across three or more files.** That
 * is a divergence report, and it fires where this detector's near-clone
 * pass would fire on the same evidence.
 *
 * So the near-clone pass here **skips** pairs that are bare single
 * comparisons on one of those policy names once three or more files are
 * involved. Everything else is this detector's: exact clones (which the
 * older detector cannot report, because it requires two distinct
 * expression shapes), compound predicates, guards, switch tables, and
 * comparisons on any field the older detector's fixed name list does not
 * cover. Neither detector reports the other's territory, so one crime
 * never produces two findings.
 */

const optionsSchema = z
  .object({
    /** Distinct production files a clone must span. Default 2. */
    minFiles: z.number().int().min(2).max(50).optional(),
    /**
     * Normalised-token floor. Three — one comparison — is the built-in
     * minimum and also the floor the risk index applies, so lowering it
     * further has no effect. Raise it to report only compound rules.
     */
    minTokens: z.number().int().min(3).max(200).optional(),
    /**
     * Report near-clones (two rules differing in exactly one literal).
     * Default true — this is the highest-value half of the detector.
     */
    reportNearClones: z.boolean().optional(),
    /** Property-path tails to ignore entirely, e.g. `["env"]`. */
    ignorePaths: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const DEFAULT_MIN_FILES = 2;
const DEFAULT_MIN_TOKENS = 3;

/** Cap on findings per scan so one repetitive repo can't flood a report. */
const MAX_FINDINGS = 12;

export const duplicatedPolicyDetector: LanguageJsDetector = {
  id: "duplicated_policy",
  name: "Policy Doppelgänger",
  description:
    "Flags business, authorization, eligibility, validation, pricing, or " +
    "state-transition rules that appear to be implemented independently in " +
    "more than one production location.",
  whyItMatters:
    "A rule implemented twice has no mechanism keeping the two copies in " +
    "agreement. Changing one is a complete-looking edit that silently " +
    "leaves the other enforcing the old policy, and neither the type " +
    "checker nor the test suite can see across the gap. Agents are " +
    "especially prone to this: asked to change a permission rule, an " +
    "agent edits the site it was shown and has no reason to suspect a " +
    "second copy exists in a middleware three directories away.",

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    const risk = ctx.risk;
    if (!risk) return [];

    const options = readOptions(ctx.config);
    const minFiles = options.minFiles ?? DEFAULT_MIN_FILES;
    const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;
    const ignorePaths = new Set((options.ignorePaths ?? []).map((p) => p.toLowerCase()));

    const findings: Finding[] = [];

    for (const group of risk.policy.clones) {
      if (findings.length >= MAX_FINDINGS) break;
      // Emit once, at the group's own lexicographically-first file. This
      // keeps the finding stable when unrelated files change and keeps
      // `--changed` scans honest: touching a member surfaces the group
      // only when that member is the anchor.
      if (group.anchorFile !== ctx.file) continue;
      if (group.files.length < minFiles) continue;
      if (!meetsTokenFloor(group, minTokens)) continue;
      if (isIgnored(group.occurrences, ignorePaths)) continue;

      const finding = buildCloneFinding(group);
      if (finding) findings.push(finding);
    }

    if (options.reportNearClones !== false) {
      for (const family of risk.policy.nearClones) {
        if (findings.length >= MAX_FINDINGS) break;
        if (family.anchorFile !== ctx.file) continue;
        if (!family.variants.every((v) => meetsTokenFloor(v, minTokens))) continue;
        const occurrences = family.variants.flatMap((v) => v.occurrences);
        if (isIgnored(occurrences, ignorePaths)) continue;
        // Territory owned by `duplicated_role_status_plan_check` — see the
        // boundary note in this module's header.
        if (ownedByRoleStatusPlanCheck(family)) continue;
        const finding = buildNearCloneFinding(family);
        if (finding) findings.push(finding);
      }
    }

    // Stable order: by first evidence line, then by summary. Two findings
    // anchored on the same file must not swap between runs.
    findings.sort((a, b) => {
      const lineDelta = (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0);
      return lineDelta !== 0 ? lineDelta : a.summary.localeCompare(b.summary);
    });
    return findings;
  },
};

/* ------------------------------------------------------------------ *
 * Exact clones
 * ------------------------------------------------------------------ */

function buildCloneFinding(group: PolicyCloneGroup): Finding | undefined {
  const strong = strongVocabularyOf(group.occurrences);
  // Hard gate. Two matching predicates with no business vocabulary are a
  // shared idiom, however many files they appear in — and repetition is
  // evidence of idiom, not of policy.
  if (strong.length === 0) return undefined;

  const vocabulary = vocabularyOf(group.occurrences);
  const concepts = conceptsOf(group.occurrences);
  const crossBoundary = boundaryCrossings(group.files);
  const distinctOwners = distinctEnclosing(group.occurrences);

  const confidence = new ConfidenceLadder(0.6)
    .add(group.files.length >= 3, `appears in ${group.files.length} files`, 0.1)
    .add(
      vocabulary.length > 0,
      `domain vocabulary: ${vocabulary.slice(0, 4).join(", ")}`,
      0.12,
    )
    .add(crossBoundary.length > 0, crossBoundary[0] ?? "", 0.1)
    .add(distinctOwners >= 2, `${distinctOwners} distinct enclosing functions`, 0.06)
    .add(
      group.occurrences[0]!.tokens >= 8,
      "substantial rule (8+ normalised tokens)",
      0.04,
    );

  const severity = new SeverityLadder(0.42)
    .add(concepts.includes("authorization"), "authorization rule", 0.18)
    .add(concepts.includes("billing"), "billing / pricing rule", 0.14)
    .add(concepts.includes("tenancy"), "tenancy rule", 0.12)
    .add(group.files.length >= 3, "three or more independent copies", 0.1)
    .add(crossBoundary.length > 0, "spans an architectural boundary", 0.08);

  const anchor = group.occurrences.find((o) => o.file === group.anchorFile)!;

  const built = cloneEvidence(group, vocabulary, crossBoundary, confidence, severity);
  return {
    id: "",
    type: "duplicated_policy",
    charge: "Policy Doppelgänger",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: group.anchorFile,
    lines: [anchor.line, anchor.endLine],
    symbol: ruleIdentity(group.occurrences, "rule"),
    // `ruleIdentity` is built from the rule's vocabulary and literals, so
    // two genuinely different rules over the same domain nouns collapse
    // to one symbol — n8n's packages/cli lost 5 findings this way, four
    // of them under `duplicated_policy::…::credential rule`. The
    // normalised form is what makes them different and is already in the
    // evidence.
    discriminator: hashSlice(group.normalized).exact.slice(0, 12),
    summary:
      `The same ${describeKind(anchor.kind)} appears in ${group.files.length} ` +
      `production files with no shared definition. Each copy is maintained ` +
      `independently, so changing one leaves the others enforcing the old rule.`,
    evidence: built.evidence,
    score_rationale: built.rationale,
    effort: "medium",
    fix_shape: "extract one authoritative policy function; every site calls it",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "extract_policy_function",
        description:
          `Move the rule into a single exported function (for example ` +
          `\`${suggestName(anchor)}\`) and replace each of the ` +
          `${group.occurrences.length} inline copies with a call to it.`,
        risk: "medium",
      },
      {
        kind: "pin_with_test",
        description:
          "Add one test against the extracted function covering each " +
          "branch, so a future change to the rule fails loudly rather than " +
          "silently applying in one place only.",
        risk: "low",
      },
    ],
    related_files: group.files.filter((f) => f !== group.anchorFile),
  };
}

function cloneEvidence(
  group: PolicyCloneGroup,
  vocabulary: string[],
  crossBoundary: string[],
  confidence: ConfidenceLadder,
  severity: SeverityLadder,
): { evidence: string[]; rationale: string[] } {
  const evidence: string[] = [];
  evidence.push(`normalised rule: ${group.normalized}`);
  evidence.push(
    `${group.occurrences.length} occurrence(s) across ${group.files.length} file(s)`,
  );

  for (const occ of group.occurrences.slice(0, 6)) {
    const where = occ.enclosing !== undefined ? ` in ${occ.enclosing}()` : "";
    evidence.push(`${occ.file}:${occ.line}${where}: ${occ.readable}`);
  }
  if (group.occurrences.length > 6) {
    evidence.push(`+${group.occurrences.length - 6} further occurrence(s)`);
  }

  const anchor = group.occurrences[0]!;
  if (anchor.literals.length > 0) {
    evidence.push(`shared literal value(s): ${anchor.literals.map(quote).join(", ")}`);
  }
  if (anchor.paths.length > 0) {
    evidence.push(`shared property path(s): ${anchor.paths.slice(0, 5).join(", ")}`);
  }
  if (anchor.calls.length > 0) {
    evidence.push(`shared call(s): ${anchor.calls.slice(0, 5).join(", ")}`);
  }
  if (vocabulary.length > 0) {
    evidence.push(`domain vocabulary: ${vocabulary.join(", ")}`);
  }
  for (const crossing of crossBoundary) evidence.push(crossing);

  evidence.push(authorityRationale(group.occurrences));
  // The ladder trace is arithmetic about the finding, not a fact
  // about the code, so it leaves `evidence` and rides alongside it.
  return { evidence, rationale: scoreRationale(confidence, severity) };
}

/* ------------------------------------------------------------------ *
 * Near clones
 * ------------------------------------------------------------------ */

function buildNearCloneFinding(family: PolicyNearCloneFamily): Finding | undefined {
  const occurrences = family.variants.flatMap((v) => v.occurrences);
  // Same hard gate as the exact-clone path: without business vocabulary
  // this is a set of similar comparisons, which is not evidence of anything.
  const strong = strongVocabularyOf(occurrences);
  if (strong.length === 0) return undefined;

  const vocabulary = vocabularyOf(occurrences);
  const concepts = conceptsOf(occurrences);
  const files = [...new Set(occurrences.map((o) => o.file))].sort();
  const crossBoundary = boundaryCrossings(files);

  const confidence = new ConfidenceLadder(0.55)
    .add(true, `domain vocabulary: ${strong.slice(0, 4).join(", ")}`, 0.12)
    .add(crossBoundary.length > 0, crossBoundary[0] ?? "", 0.1)
    .add(files.length >= 3, `spans ${files.length} files`, 0.06)
    .add(
      family.variants.length >= 3,
      `${family.variants.length} distinct variants`,
      0.06,
    );

  const severity = new SeverityLadder(0.5)
    .add(concepts.includes("authorization"), "authorization rule", 0.18)
    .add(concepts.includes("billing"), "billing / pricing rule", 0.14)
    .add(concepts.includes("tenancy"), "tenancy rule", 0.1)
    .add(crossBoundary.length > 0, "spans an architectural boundary", 0.08)
    .add(family.variants.length >= 3, "three or more variants of one rule", 0.08);

  const anchor = occurrences.find((o) => o.file === family.anchorFile) ?? occurrences[0]!;

  const evidence: string[] = [
    `${family.variants.length} variants of one rule shape, differing only in value`,
    `shared shape: ${family.shape}`,
  ];
  family.variants.forEach((variant, i) => {
    const label = String.fromCharCode(65 + i);
    evidence.push(`variant ${label}: ${variant.normalized}`);
    for (const occ of variant.occurrences.slice(0, 3)) {
      const where = occ.enclosing !== undefined ? ` in ${occ.enclosing}()` : "";
      evidence.push(`  ${label} — ${occ.file}:${occ.line}${where}: ${occ.readable}`);
    }
    if (variant.occurrences.length > 3) {
      evidence.push(
        `  ${label} — +${variant.occurrences.length - 3} further occurrence(s)`,
      );
    }
  });
  for (const difference of family.differences.slice(0, 4)) {
    evidence.push(`difference: ${difference}`);
  }
  evidence.push(`domain vocabulary: ${vocabulary.join(", ")}`);
  for (const crossing of crossBoundary) evidence.push(crossing);
  evidence.push(
    "the sites share a rule shape but disagree on a value — either one is " +
      "stale, or the difference is deliberate and undocumented",
  );
  const rationale = scoreRationale(confidence, severity);

  return {
    id: "",
    type: "duplicated_policy",
    charge: "Policy Doppelgänger",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: family.anchorFile,
    lines: [anchor.line, anchor.endLine],
    symbol: ruleIdentity(occurrences, "variants"),
    // Same collapse as the exact-clone arm; here the shared shape is
    // what identifies the family.
    discriminator: hashSlice(family.shape).exact.slice(0, 12),
    summary:
      `${family.variants.length} variants of the same ${describeKind(anchor.kind)} ` +
      `exist across ${files.length} files and disagree on a value ` +
      `(${family.differences[0] ?? "differing literals"}). At most one of them ` +
      "can be current.",
    evidence,
    score_rationale: rationale,
    effort: "medium",
    fix_shape: "reconcile the variants into one authoritative rule",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "reconcile_policy_variants",
        description:
          "Decide which value is correct, then extract the reconciled rule " +
          "into one function every site calls. If the difference is " +
          "intentional, make it a named parameter so the divergence is visible.",
        risk: "medium",
      },
    ],
    related_files: files.filter((f) => f !== family.anchorFile),
  };
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.duplicated_policy;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  // The config loader already validated this; a failure here means a
  // programmatic caller bypassed it. Fall back to defaults rather than
  // throwing mid-scan.
  return parsed.success ? parsed.data : {};
}

function meetsTokenFloor(group: PolicyCloneGroup, minTokens: number): boolean {
  return group.occurrences.every((o) => o.tokens >= minTokens);
}

/**
 * Property-path tails `duplicated_role_status_plan_check` scans for.
 * Kept in sync with that detector's `POLICY_NAMES`; a name in one list
 * and not the other would open a double-report gap.
 */
const ROLE_STATUS_PLAN_NAMES: ReadonlySet<string> = new Set([
  "role",
  "status",
  "plan",
  "tier",
  "permission",
  "permissions",
  "subscription",
  "state",
]);

/**
 * Would `duplicated_role_status_plan_check` already report this pair?
 *
 * Its conditions are: the same policy-name literal, compared with two or
 * more distinct expression shapes, across three or more files. A
 * near-clone pair matching all three is that detector's finding, and this
 * one steps aside.
 */
function ownedByRoleStatusPlanCheck(family: PolicyNearCloneFamily): boolean {
  const occurrences = family.variants.flatMap((v) => v.occurrences);
  const files = new Set(occurrences.map((o) => o.file));
  if (files.size < 3) return false;

  // Both sides must be a bare single comparison — one operator, one path,
  // one literal. Anything richer is outside the older detector's regex.
  const isBareComparison = (group: PolicyCloneGroup): boolean =>
    group.occurrences.every(
      (o) =>
        o.operators.length === 1 &&
        COMPARISON_OPERATORS.has(o.operators[0]!) &&
        o.paths.length === 1 &&
        o.literals.length === 1 &&
        o.calls.length === 0,
    );
  if (!family.variants.every(isBareComparison)) return false;

  return occurrences.every((o) =>
    o.paths.every((path: string) =>
      ROLE_STATUS_PLAN_NAMES.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase()),
    ),
  );
}

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);

function isIgnored(occurrences: PolicyOccurrence[], ignorePaths: Set<string>): boolean {
  if (ignorePaths.size === 0) return false;
  return occurrences.some((occ) =>
    occ.paths.some((path) => {
      const tail = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      return ignorePaths.has(tail) || ignorePaths.has(path.toLowerCase());
    }),
  );
}

/**
 * Unambiguously-business tokens across the rule's names — the gate.
 *
 * Enclosing function names are deliberately *excluded* here. A generic
 * predicate that happens to sit inside `checkPermission()` is still a
 * generic predicate, and letting the surrounding function vouch for it
 * reopens exactly the hole this tier exists to close.
 */
function strongVocabularyOf(occurrences: PolicyOccurrence[]): string[] {
  const names: string[] = [];
  for (const occ of occurrences) {
    names.push(...occ.paths, ...occ.literals, ...occ.calls);
  }
  return strongDomainTokensAcross(names);
}

/** Domain tokens across every name the rule touches — the booster. */
function vocabularyOf(occurrences: PolicyOccurrence[]): string[] {
  const names: string[] = [];
  for (const occ of occurrences) {
    names.push(...occ.paths, ...occ.literals, ...occ.calls);
    if (occ.enclosing !== undefined) names.push(occ.enclosing);
  }
  return domainTokensAcross(names);
}

function conceptsOf(occurrences: PolicyOccurrence[]): string[] {
  const out = new Set<string>();
  for (const occ of occurrences) {
    for (const name of [...occ.paths, ...occ.literals, ...occ.calls]) {
      for (const concept of conceptsIn(name)) out.add(concept);
    }
  }
  return [...out];
}

/**
 * Architectural boundaries the clone set spans.
 *
 * Two copies in `src/routes/` and `src/services/` are more alarming than
 * two copies in the same directory, because the second pair is at least
 * visible to one reader at one time.
 */
function boundaryCrossings(files: string[]): string[] {
  const out: string[] = [];
  const topLevel = new Set(files.map((f) => f.split("/")[0] ?? f));
  const packages = new Set(
    files
      .map((f) => {
        const match = f.match(/^(packages|apps|services|libs)\/([^/]+)\//);
        return match ? `${match[1]}/${match[2]}` : undefined;
      })
      .filter((p): p is string => p !== undefined),
  );

  if (packages.size >= 2) {
    out.push(`spans ${packages.size} packages: ${[...packages].sort().join(", ")}`);
  } else if (topLevel.size >= 2) {
    out.push(
      `spans ${topLevel.size} top-level directories: ${[...topLevel].sort().join(", ")}`,
    );
  }

  const layers = new Set(
    files.map((f) => LAYER_RE.exec(f)?.[1]).filter((l): l is string => l !== undefined),
  );
  if (layers.size >= 2) {
    out.push(`spans ${layers.size} layers: ${[...layers].sort().join(", ")}`);
  }
  return out;
}

const LAYER_RE =
  /(?:^|\/)(routes?|controllers?|handlers?|middlewares?|services?|repositories|models?|components?|pages?|api|workers?|jobs?)\//;

function distinctEnclosing(occurrences: PolicyOccurrence[]): number {
  return new Set(occurrences.map((o) => `${o.file}::${o.enclosing ?? "<module>"}`)).size;
}

/**
 * Why each location reads as independently authoritative. This is the
 * evidence line that answers "so what?" — without it a reader has a
 * duplicate report and no reason to act.
 */
function authorityRationale(occurrences: PolicyOccurrence[]): string {
  const enclosings = [
    ...new Set(
      occurrences.map((o) => o.enclosing).filter((e): e is string => e !== undefined),
    ),
  ].sort();
  if (enclosings.length >= 2) {
    return (
      `each copy is inlined in a different function (${enclosings.slice(0, 4).join(", ")}) ` +
      `rather than delegating to a shared one — no call site links them`
    );
  }
  return (
    "each copy is written inline rather than delegating to a shared " +
    "function — nothing links the sites, so nothing keeps them in agreement"
  );
}

function describeKind(kind: PolicyOccurrence["kind"]): string {
  switch (kind) {
    case "guard_clause":
      return "guard clause";
    case "boolean_predicate":
      return "boolean rule";
    case "switch_case":
      return "state-transition table";
    case "conditional":
      return "conditional rule";
  }
}

/**
 * A stable, human-meaningful identity for a policy rule.
 *
 * This becomes `Finding.symbol`, which means it becomes part of the
 * fingerprint (`<type>::<file>::<symbol>`). Using the enclosing function
 * name — the obvious choice — collides whenever two different rules are
 * anchored in the same function, and shifts whenever the rule moves.
 * A key built from the rule's own vocabulary and values is unique per
 * rule and survives both refactors and line moves, which is exactly what
 * a fingerprint needs.
 */
function ruleIdentity(occurrences: PolicyOccurrence[], suffix: string): string {
  const tokens = strongVocabularyOf(occurrences).slice(0, 2);
  const literals = [...new Set(occurrences.flatMap((o) => o.literals))]
    .sort()
    .slice(0, 2);
  const parts = [...tokens, ...literals.map((l) => JSON.stringify(l))];
  return parts.length > 0 ? `${parts.join(" ")} ${suffix}` : `policy ${suffix}`;
}

/** A plausible name for the extracted helper, from the rule's vocabulary. */
function suggestName(occurrence: PolicyOccurrence): string {
  const tokens = domainTokensAcross([...occurrence.paths, ...occurrence.literals]);
  if (tokens.length === 0) return "checkPolicy";
  const parts = tokens.slice(0, 2).map((t) => t.charAt(0).toUpperCase() + t.slice(1));
  return `is${parts.join("")}Allowed`;
}

function quote(value: string): string {
  return `"${value}"`;
}
