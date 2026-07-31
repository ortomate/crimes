import { BOOLEAN_INITIALIZER_KINDS } from "@crimes/language-py";
import type { PyAssignment } from "@crimes/language-py";
import { z } from "zod";
import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, plural, severityScore } from "./shared.js";

/**
 * Prefixes PEP 8-adjacent Python style treats as marking a boolean.
 * `is_` / `has_` / `should_` / `can_` are the common four; `was_`,
 * `did_`, `will_` and `allow_` show up often enough in real code to be
 * accepted rather than flagged.
 */
const BOOLEAN_PREFIX_RE =
  /^_?(is|has|had|should|can|could|must|may|was|were|did|does|do|will|would|allow|allows|enable|enables|use|uses|include|includes|require|requires|needs?|supports?|contains?|exists?|force|skip|ignore)_/;

/**
 * Bare names that read as booleans without a prefix and are idiomatic
 * enough that renaming them would be worse than leaving them. Mirrors
 * the JS detector's React-state allowlist in spirit — that one exists
 * because `loading` / `ready` are the conventional names in that
 * ecosystem, and these are the conventional ones here.
 */
const ALLOWED_BARE_NAMES = new Set([
  "ok",
  "valid",
  "invalid",
  "found",
  "done",
  "ready",
  "active",
  "enabled",
  "disabled",
  "visible",
  "hidden",
  "verbose",
  "quiet",
  "debug",
  "dry_run",
  "strict",
  "recursive",
  "force",
  "overwrite",
  "success",
  "failed",
  "dirty",
  "empty",
  "loaded",
  "cached",
  "closed",
  "open",
  "running",
  "stopped",
  "expired",
  "deleted",
  "archived",
  "published",
  "required",
  "optional",
  "default",
  "reverse",
  "sort",
  "flag",
]);

const optionsSchema = z
  .object({
    allowedNames: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const booleanNamingDriftPyDetector: LanguagePyDetector = {
  id: "boolean_naming_drift.py",
  name: "Boolean naming drift (Python)",
  description:
    "Flags names bound to boolean expressions that carry neither a boolean-signalling " +
    "prefix (is_ / has_ / should_ / can_) nor an idiomatic bare boolean name.",
  whyItMatters:
    "Python has no type annotation on most local bindings, so a reader's only clue " +
    "that `retry` holds a boolean rather than a count is the expression it was bound " +
    "to — which may be fifty lines away. When the name gives no signal, an agent " +
    "editing the file has to re-derive the type from the assignment every time, and " +
    "the failure mode is quiet: `if retry:` is valid whether `retry` is a bool, an " +
    "int, or a list, and each one means something different. A prefix makes the type " +
    "part of the name.",

  pack: "language-py",
  optionsSchema,
  run(ctx) {
    if (isTestFile(ctx.file)) return [];

    const allowed = readAllowedNames(ctx.config);

    // Dedupe per binding, keeping the first assignment. The charge is
    // "this *name* doesn't signal that it holds a boolean", which is
    // true once per name — counting `retry = True` followed by
    // `retry = False` as two offenders would inflate the count, and the
    // count drives severity. Keyed with the enclosing function so the
    // same name in two functions stays two distinct bindings.
    const seen = new Set<string>();
    const offenders = ctx.parsed.assignments.filter((a) => {
      if (!isDrift(a, allowed)) return false;
      const key = `${a.functionName ?? "<module>"}::${a.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (offenders.length === 0) return [];

    const severity: Severity = offenders.length >= 4 ? "medium" : "low";
    const shown = offenders.slice(0, 8);

    const finding: Finding = {
      id: "",
      type: "boolean_naming_drift",
      charge: "Boolean Naming Drift",
      severity,
      confidence: 0.7,
      file: ctx.file,
      lines: [offenders[0]!.line, offenders[offenders.length - 1]!.line],
      summary:
        `${offenders.length} ${plural(offenders.length, "name")} bound to a boolean ` +
        `expression without a boolean-signalling prefix. Nothing at the call site says ` +
        `these hold true/false rather than a count or a collection.`,
      evidence: [
        ...shown.map(
          (a) =>
            `\`${a.name}\` = <${a.initializerKind.replace(/_/g, " ")}> at line ${a.line}` +
            (a.functionName !== undefined ? ` in ${a.functionName}()` : "") +
            (a.attributeTarget ? " (instance attribute)" : ""),
        ),
        ...(offenders.length > shown.length
          ? [`…+${offenders.length - shown.length} more`]
          : []),
        "convention: is_ / has_ / should_ / can_ prefix, or an idiomatic bare name",
      ],
      effort: "quick",
      fix_shape: "rename to an is_/has_/should_ prefix",
      scores: {
        severity: severityScore(severity),
        confidence: 0.7,
        // Deliberately the lowest ramp of the eight. This is a
        // readability charge, not a correctness one — it should not
        // outrank a naive-datetime or a blocked event loop.
        agent_risk: intrinsicFor({
          count: offenders.length,
          base: 0.3,
          step: 0.05,
          cap: 0.6,
        }),
      },
      suggested_actions: [
        {
          kind: "rename_symbol",
          description:
            `Rename to a boolean-signalling form (e.g. \`${suggestName(shown[0]!.name)}\`) ` +
            "so the type is visible at every use site, or add a `: bool` annotation.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

function isDrift(assignment: PyAssignment, allowed: ReadonlySet<string>): boolean {
  // Only names we are certain hold a boolean. An annotated `: bool` also
  // counts — the annotation proves the type, but the name still hides it
  // from every call site that doesn't look at the declaration.
  const annotatedBool = assignment.annotation === "bool";
  if (!annotatedBool && !BOOLEAN_INITIALIZER_KINDS.has(assignment.initializerKind)) {
    return false;
  }
  const name = assignment.name;
  // Module-level constants are shouted, not prefixed: `DEBUG = True` is
  // conventional and renaming it to `IS_DEBUG` would be worse.
  if (name === name.toUpperCase()) return false;
  if (name.startsWith("__")) return false;
  if (BOOLEAN_PREFIX_RE.test(name)) return false;
  const bare = name.replace(/^_+/, "").toLowerCase();
  return !allowed.has(bare);
}

function suggestName(name: string): string {
  const bare = name.replace(/^_+/, "");
  return `is_${bare}`;
}

function readAllowedNames(
  config: Parameters<LanguagePyDetector["run"]>[0]["config"],
): ReadonlySet<string> {
  const raw = config.detectors?.options?.["boolean_naming_drift.py"];
  const parsed = optionsSchema.safeParse(raw ?? {});
  const extra = parsed.success ? (parsed.data.allowedNames ?? []) : [];
  return new Set([...ALLOWED_BARE_NAMES, ...extra.map((n) => n.toLowerCase())]);
}

/** Exported for the unit tests. */
export const PY_BOOLEAN_ALLOWED_NAMES = ALLOWED_BARE_NAMES;
