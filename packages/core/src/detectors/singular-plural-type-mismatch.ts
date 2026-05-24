import { z } from "zod";
import type { TypedDeclaration } from "@crimes/language-js";
import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import {
  isUncountable,
  looksPlural,
  pluralise,
  singularise,
} from "../util/pluraliser.js";
import { isTestFile } from "../util/test-files.js";

const optionsSchema = z
  .object({
    /**
     * Project-specific names whose plural/singular shape diverges from
     * the heuristic. Listing a name here exempts it from the detector.
     */
    allowedNames: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Detects two clear mismatches between a name and its annotated type:
 *
 *   `users: User`     → name plural, type singular
 *   `user: User[]`    → name singular, type array of singular
 *
 * v1 is conservative: only fires when the type annotation is a bare
 * `Identifier` or a simple array shape (`Identifier[]` / `Array<Identifier>`),
 * AND the name maps cleanly through the hand-rolled pluraliser.
 * Aliased types (`type UserId = string`) and generic types are skipped
 * — the FN rate is accepted (documented under finding-types/structural.md).
 */
export const singularPluralTypeMismatchDetector: Detector = {
  id: "singular_plural_type_mismatch",
  name: "Plural Mismatch",
  description:
    "Flags declarations where the identifier's plural form disagrees " +
    "with the annotated type's array shape (e.g. `users: User`, " +
    "`user: User[]`).",
  whyItMatters:
    "When an identifier's plural form lies about the value's shape, " +
    "readers and coding agents iterate the wrong way: `for (const u of " +
    "users)` against a `User`, or `.find(...)` on a `User[]`. Names " +
    "that match the shape they hold remove the guesswork.",
  optionsSchema,

  pack: "language-js",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    const decls = ctx.parsed.typedDeclarations;
    if (!decls || decls.length === 0) return [];

    const allowed = readAllowed(ctx.config.detectors?.options);
    const offenders: Array<TypedDeclaration & { reason: string }> = [];

    for (const d of decls) {
      if (allowed.has(d.name) || allowed.has(d.name.toLowerCase())) continue;
      const verdict = classify(d);
      if (verdict) offenders.push({ ...d, reason: verdict });
    }
    if (offenders.length === 0) return [];

    const severity: Severity = offenders.length >= 4 ? "medium" : "low";
    const samples = offenders
      .slice(0, 4)
      .map((d) => `${d.reason}: \`${d.name}: ${d.type}\` @L${d.line}`);
    const overflow = offenders.length > 4 ? `…and ${offenders.length - 4} more` : "";

    const finding: Finding = {
      id: "",
      type: "singular_plural_type_mismatch",
      charge: "Plural Mismatch",
      severity,
      confidence: 0.7,
      file: ctx.file,
      lines: [offenders[0]!.line, offenders[offenders.length - 1]!.line],
      summary:
        `${offenders.length} declaration${offenders.length === 1 ? "" : "s"} ` +
        `whose plural form disagrees with the annotated type's array shape.`,
      evidence: [
        ...samples,
        ...(overflow ? [overflow] : []),
        `v1 detector — type aliases and generic types are silently skipped`,
      ],
      effort: "quick",
      fix_shape: "make the name agree with the type — `users` for array, `user` for scalar",
      scores: {
        severity: severity === "medium" ? 0.55 : 0.3,
        confidence: 0.7,
        agent_risk: round(Math.min(0.4 + (offenders.length - 1) * 0.06, 0.7)),
      },
      suggested_actions: [
        {
          kind: "rename_or_reshape",
          description:
            "Rename the variable to match the type's shape, or change the " +
            "type to match the name. If the project intentionally diverges, " +
            "add the name to `detectors.options.singular_plural_type_mismatch.allowedNames`.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

/**
 * Returns a short reason string when the declaration looks like a
 * mismatch, or undefined when the heuristic doesn't apply.
 */
function classify(d: TypedDeclaration): string | undefined {
  if (!d.type) return undefined;
  if (isUncountable(d.name)) return undefined;

  const arrayMatch = parseArrayType(d.type);
  const typeIsArray = arrayMatch !== undefined;
  const typeElement = arrayMatch ?? parseIdentifierType(d.type);
  if (!typeElement) return undefined;

  const namePlural = looksPlural(d.name);
  const nameSingular = !namePlural;

  if (typeIsArray && nameSingular) {
    // `user: User[]` — name singular, type array.
    if (typeElement.toLowerCase() === d.name.toLowerCase()) {
      return "singular name, array type";
    }
    return undefined;
  }

  if (!typeIsArray && namePlural) {
    // `users: User` — name plural, type singular.
    const nameSingularForm = singularise(d.name);
    if (typeElement.toLowerCase() === nameSingularForm.toLowerCase()) {
      return "plural name, singular type";
    }
    return undefined;
  }

  return undefined;
}

function parseArrayType(t: string): string | undefined {
  let m = /^([A-Za-z_$][\w$]*)\[\]$/.exec(t);
  if (m) return m[1];
  m = /^Array<\s*([A-Za-z_$][\w$]*)\s*>$/.exec(t);
  if (m) return m[1];
  m = /^ReadonlyArray<\s*([A-Za-z_$][\w$]*)\s*>$/.exec(t);
  if (m) return m[1];
  return undefined;
}

function parseIdentifierType(t: string): string | undefined {
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return t;
  return undefined;
}

function readAllowed(
  options: Record<string, unknown> | undefined,
): Set<string> {
  const raw = options?.["singular_plural_type_mismatch"];
  if (!raw) return new Set();
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.allowedNames ?? []);
}

// `pluralise` is exported alongside `singularise` for completeness;
// the runtime path here only needs `singularise`. Reference it so
// the import isn't flagged as unused.
void pluralise;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
