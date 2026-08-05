import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { extractComments } from "../petty/comments.js";
import { hashSlice } from "../ast-hash/hash.js";

const RULE_TERMS = [
  "must",
  "never",
  "always",
  "only",
  "required",
  "forbidden",
  "unless",
  "except",
  "until",
  "after",
  "before",
  "do not",
  "don't",
  "cannot",
  "can't",
  "important",
];

/**
 * Domain vocabulary, matched as whole words (see {@link containsTerm}).
 *
 * **Spell out every form you mean.** These used to be matched with
 * `String.includes`, which made short entries behave as stems — and the
 * two silliest false positives this detector produced on a real repo
 * came from exactly that: `auth` matched "**Auth**ored by the Curator"
 * and `utc` matched "captured that o**utc**ome".
 *
 * Word-boundary matching fixes those, but it also means a stem no longer
 * covers the words built on it. `auth` alone would stop matching
 * "authorization", which is how the concept is usually written — cal.com
 * has "Do not move this before authorization check", a finding worth
 * keeping. So the forms are listed rather than inferred. Regular
 * inflections (`-s`, `-ed`, `-ing`, …) are still handled automatically;
 * derivations are not, because "authored" and "authorization" are the
 * same three letters plus a suffix and only one of them is the concept.
 */
const DOMAIN_CONCEPTS: Record<string, string[]> = {
  admin: ["admin", "administrator"],
  owner: ["owner", "ownership"],
  role: ["role"],
  plan: ["plan"],
  tier: ["tier"],
  billing: ["billing"],
  payment: ["payment"],
  refund: ["refund"],
  timezone: ["timezone"],
  utc: ["utc"],
  cache: ["cache"],
  retry: ["retry", "retries"],
  idempotent: ["idempotent", "idempotency"],
  permission: ["permission"],
  auth: [
    "auth",
    "authz",
    "authn",
    "authorize",
    "authorise",
    "authorization",
    "authorisation",
    "authenticate",
    "authentication",
  ],
};

const DOMAIN_CONCEPT_NAMES = Object.keys(DOMAIN_CONCEPTS);

const TODO_MARKER_PATTERN = new RegExp(
  ["TO" + "DO", "FIX" + "ME", "X" + "XX", "HA" + "CK"].join("|"),
  "i",
);

export const logicInCommentsDetector: LanguageJsDetector = {
  id: "logic_in_comments",
  name: "Logic in Comments",
  description:
    "Flags comments that appear to carry business rules or safety constraints.",
  whyItMatters:
    "Rules that live only in prose are not enforceable. Anyone (or any " +
    "agent) editing the file can drop the constraint without the type " +
    "system, tests, or runtime guards catching the change. Encoding the " +
    "rule in code is the only way to make it survive.",

  pack: "language-js",
  run(ctx) {
    const sourceLines = ctx.source.split(/\r?\n/);
    const findings: Finding[] = [];

    for (const comment of extractComments(ctx.source)) {
      if (comment.raw.trimStart().startsWith("/**")) continue;
      if (TODO_MARKER_PATTERN.test(comment.text)) continue;

      const commentText = comment.text.toLowerCase();
      const ruleTerms = RULE_TERMS.filter((term) => containsTerm(commentText, term));
      // Grouped by concept, not by spelling: a comment saying "admin"
      // and "administrator" mentions one concept, and counting it twice
      // would inflate both confidence and severity.
      const domainTerms = DOMAIN_CONCEPT_NAMES.filter((concept) =>
        DOMAIN_CONCEPTS[concept]!.some((form) => containsTerm(commentText, form)),
      );
      if (ruleTerms.length < 2 || domainTerms.length < 1) continue;

      const nearby = nearbySource(sourceLines, comment.endLine, 16).toLowerCase();
      const missingTerms = domainTerms.filter(
        (concept) =>
          !DOMAIN_CONCEPTS[concept]!.some((form) => encodedNearby(nearby, form)),
      );
      if (missingTerms.length === 0) continue;

      const severity = pickSeverity(ctx.file, ruleTerms.length, domainTerms.length);
      const confidence = round(
        Math.min(0.54 + ruleTerms.length * 0.04 + missingTerms.length * 0.03, 0.76),
      );
      const quoted = truncate(comment.text.replace(/\s+/g, " ").trim(), 110);

      findings.push({
        id: "",
        type: "logic_in_comments",
        charge: "Logic in the Alibi",
        severity,
        confidence,
        file: ctx.file,
        lines: [comment.startLine, comment.endLine],
        // One finding per comment block and no `symbol`, so without a
        // discriminator every block in a file shares
        // `logic_in_comments::<file>::` — 18 findings were lost to it on
        // n8n. Unlike the symbol-bearing detectors, which only
        // disambiguate the findings that actually collide, this one
        // hashes unconditionally: the triple is unique only when the
        // file holds exactly one finding, and keying on the block's own
        // text means adding a neighbouring comment does not move an
        // existing fingerprint. Same treatment as `commented_out_code`,
        // which reads the same comment stream.
        discriminator: hashSlice(comment.text).exact.slice(0, 12),
        summary:
          `Comment appears to carry a rule that nearby code does not obviously encode. ` +
          `Hidden prose rules are easy for agents and new maintainers to miss.`,
        evidence: [
          `comment says: "${quoted}"`,
          `rule terms: ${ruleTerms.slice(0, 5).join(", ")}`,
          `domain terms not found nearby: ${missingTerms.slice(0, 5).join(", ")}`,
        ],
        effort: "small",
        fix_shape: "lift the prose rule to an assert / type / test / config check",
        scores: {
          severity: severityScore(severity),
          confidence,
          agent_risk: round(
            Math.min(0.55 + ruleTerms.length * 0.05 + missingTerms.length * 0.03, 0.8),
          ),
        },
        suggested_actions: [
          {
            kind: "encode_comment_rule",
            description:
              "Move the rule into a named guard, type, config value, or test; keep comments for rationale.",
            risk: "low",
          },
        ],
      });
    }

    return findings.slice(0, 5);
  },
};

function nearbySource(lines: string[], endLine: number, window: number): string {
  return lines.slice(endLine, Math.min(lines.length, endLine + window)).join("\n");
}

/** Cached per term — these lists are constant and this runs per comment. */
const TERM_PATTERNS = new Map<string, RegExp>();

/**
 * Does `text` contain `term` as a **word**, rather than as a run of
 * letters inside a longer one?
 *
 * `String.includes` was the original test and it produced the detector's
 * two silliest false positives on choreograph.cc: the domain term `auth`
 * matched "**Auth**ored by the Curator persona", and `utc` matched
 * "captured that o**utc**ome". Neither file has anything to do with
 * authentication or timezones, and both findings led an agent to open a
 * file for no reason.
 *
 * This is the same rule as `2e9b2da` — *never resolve a symbol by name
 * alone* — applied to prose. A concept is not mentioned just because its
 * letters appear.
 *
 * The boundary is `[a-z0-9]` rather than `\b`, because several terms
 * contain punctuation (`don't`, `can't`, `do not`) where `\b` sits in
 * the wrong place. Letters and digits only: `cache-buster` and
 * `admin_id` are mentions, `Authored` is not.
 *
 * A **closed set of inflections** is allowed after the term, because
 * prose pluralises: "Only **owners** can refund **plans**" is a
 * genuine mention of `owner` and `plan`, and a rule that missed it
 * would have traded two false positives for a dead detector. The set is
 * an allowlist rather than "any trailing letters" precisely because
 * that is what separates `owner` + `s` from `auth` + `ored`.
 */
const INFLECTIONS = "(?:s|es|d|ed|ing|er|ers|ies)?";

function containsTerm(text: string, term: string): boolean {
  let pattern = TERM_PATTERNS.get(term);
  if (pattern === undefined) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // English drops a trailing `e` before `-ing` / `-ed`: cache →
    // caching. Written as an alternation rather than as a general rule
    // because the term list is fixed and small.
    const stem = term.endsWith("e")
      ? `(?:${escaped}${INFLECTIONS}|${escaped.slice(0, -1)}(?:ing|ed))`
      : `${escaped}${INFLECTIONS}`;
    pattern = new RegExp(`(?<![a-z0-9])${stem}(?![a-z0-9])`);
    TERM_PATTERNS.set(term, pattern);
  }
  return pattern.test(text);
}

/**
 * Does the nearby code encode `term`?
 *
 * Looser than {@link containsTerm} on purpose, and in one specific
 * direction: an identifier is allowed to *end* with more letters, so
 * `cached`, `caching` and `cacheKey` all count as encoding `cache`.
 *
 * The asymmetry is deliberate. This test decides whether a finding is
 * emitted at all, so a miss here is a false positive — the detector
 * claiming "the code does not encode this rule" about code that plainly
 * does. Over-crediting the code costs a finding; under-crediting it
 * costs the user's trust. A prefix match errs toward the cheaper
 * mistake.
 *
 * It still requires the term to start at a word boundary, so `outcome`
 * does not encode `utc` here either.
 */
function encodedNearby(nearby: string, term: string): boolean {
  let pattern = NEARBY_PATTERNS.get(term);
  if (pattern === undefined) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`(?<![a-z0-9])${escaped}`);
    NEARBY_PATTERNS.set(term, pattern);
  }
  return pattern.test(nearby);
}

const NEARBY_PATTERNS = new Map<string, RegExp>();

function pickSeverity(file: string, ruleCount: number, domainCount: number): Severity {
  if (/\/routes?\//.test(file) || ruleCount + domainCount >= 6) return "medium";
  return "low";
}

function severityScore(severity: Severity): number {
  return severity === "medium" ? 0.5 : 0.3;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
