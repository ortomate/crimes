import { z } from "zod";
import type { TypedDeclaration } from "@crimes/language-js";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";
import { intrinsicFrom } from "../scoring/intrinsic.js";

const optionsSchema = z
  .object({
    /**
     * Extra identifier names to treat as acceptable boolean names
     * beyond the built-in React-state idioms. Useful for project-
     * specific UI-state vocabulary (`pristine`, `processed`, …).
     */
    allowedNames: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Built-in React-state allowlist. These names are idiomatic boolean
 * variables that don't carry an `is/has/should/can` prefix because
 * the prefix would be redundant — the variable is already used as a
 * boolean condition (`if (loading) …`).
 */
const REACT_STATE_ALLOWLIST = new Set([
  "loading",
  "loaded",
  "ready",
  "active",
  "disabled",
  "expanded",
  "pending",
  "open",
  "closed",
  "visible",
  "hidden",
  "selected",
  "focused",
  "dirty",
  "valid",
  "submitting",
  "editing",
  "dragging",
  "hovering",
  "checked",
  "busy",
  "empty",
  "full",
  "online",
  "offline",
  "mounted",
  "unmounted",
  "found",
  "settled",
  "overflow",
  "typeonly",
  "interpolated",
  "limited",
  "existed",
]);

/**
 * Prefixes that mark an identifier as boolean by convention.
 */
const BOOLEAN_PREFIX_RE =
  /^(is|has|should|can|will|did|was|were|are|needs|wants|allows|supports|owns|knows|expects|requires|enables|prevents|blocks|denies)[A-Z_]/;

export const booleanNamingDriftDetector: LanguageJsDetector = {
  id: "boolean_naming_drift",
  name: "Unprefixed Boolean",
  description:
    "Flags declarations that are clearly boolean (annotated `: boolean` " +
    "or initialised from `true`/`false`/`!x`/`a === b`/`a || b`) whose " +
    "name doesn't start with a recognised boolean prefix.",
  whyItMatters:
    "Booleans named without an `is`/`has`/`should`/`can` prefix read " +
    "as nouns to skimming reviewers and coding agents. The convention " +
    "is cheap and lets every caller's `if (x.thing)` line match the " +
    "reader's expectation. The detector ignores React-state idioms " +
    "(`loading`, `ready`, `active`, …) because the convention there is " +
    "already established.",
  optionsSchema,

  pack: "language-js",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    const decls = ctx.parsed.typedDeclarations;
    if (!decls || decls.length === 0) return [];

    const allowed = readAllowed(ctx.config.detectors?.options);

    const offenders = decls.filter((d) => isBooleanish(d) && !isWellNamed(d, allowed));
    if (offenders.length === 0) return [];

    const severity: Severity = offenders.length >= 5 ? "medium" : "low";
    const samples = offenders.slice(0, 4).map((d) => `\`${d.name}\` @L${d.line}`);
    const lineList = offenders.map((d) => d.line).slice(0, 10);
    const overflow = offenders.length > 4 ? `…and ${offenders.length - 4} more` : "";

    const finding: Finding = {
      id: "",
      type: "boolean_naming_drift",
      charge: "Unprefixed Boolean",
      severity,
      confidence: 0.8,
      file: ctx.file,
      lines: [offenders[0]!.line, offenders[offenders.length - 1]!.line],
      summary:
        `${offenders.length} boolean-typed declaration${offenders.length === 1 ? "" : "s"} ` +
        `without a recognised boolean prefix. Booleans read as nouns when ` +
        `unprefixed; \`is\`/\`has\`/\`should\`/\`can\` makes intent obvious to ` +
        `the reader.`,
      evidence: [
        ...samples,
        ...(overflow ? [overflow] : []),
        `lines: ${lineList.join(", ")}${offenders.length > 10 ? `, …+${offenders.length - 10} more` : ""}`,
        `built-in React-state names (loading/ready/active/…) are exempt; add project-specific names via \`detectors.options.boolean_naming_drift.allowedNames\``,
      ],
      effort: "quick",
      fix_shape: "rename to `isX`/`hasX`/`shouldX`; consistent across the module",
      scores: {
        severity: severity === "medium" ? 0.55 : 0.3,
        confidence: 0.8,
        agent_risk: intrinsicFrom(offenders.length, { base: 0.35, step: 0.06, cap: 0.7 }),
      },
      suggested_actions: [
        {
          kind: "prefix_boolean",
          description:
            "Rename to `is*` / `has*` / `should*` / `can*` (or add to " +
            "`detectors.options.boolean_naming_drift.allowedNames` if the " +
            "current name is a project idiom).",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function isBooleanish(d: TypedDeclaration): boolean {
  if (d.type === "boolean") return true;
  if (
    d.initializerKind === "boolean_literal" ||
    d.initializerKind === "negation" ||
    d.initializerKind === "comparison"
  )
    return true;
  return false;
}

function isWellNamed(d: TypedDeclaration, extraAllowed: Set<string>): boolean {
  const lower = d.name.toLowerCase();
  if (REACT_STATE_ALLOWLIST.has(lower)) return true;
  if (extraAllowed.has(d.name)) return true;
  if (extraAllowed.has(lower)) return true;
  if (BOOLEAN_PREFIX_RE.test(d.name)) return true;
  // All-uppercase constants (`READY`, `ENABLED`) read as enum-ish
  // sentinels — exempt to avoid noise on config-style modules.
  if (/^[A-Z][A-Z0-9_]*$/.test(d.name)) return true;
  // Single letter — usually a loop or short-scope local; skip.
  if (d.name.length <= 1) return true;
  return false;
}

function readAllowed(options: Record<string, unknown> | undefined): Set<string> {
  const raw = options?.boolean_naming_drift;
  if (!raw) return new Set();
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.allowedNames ?? []);
}
