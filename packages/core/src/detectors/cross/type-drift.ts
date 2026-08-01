import type { CrossLanguageDetector, PackedFile } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { intrinsicFor, plural, severityScore } from "../py/shared.js";

/**
 * A closed set of values declared in both languages, where the two
 * copies have diverged.
 *
 * The canonical shape is a Python `Enum` and a TS string-literal union
 * that are supposed to describe the same thing:
 *
 *     class Plan(str, Enum):        type Plan =
 *         FREE = "free"               | "free"
 *         PRO  = "pro"                | "pro"
 *         TEAM = "team"               | "enterprise"   ← drift
 *
 * Symmetric by construction: the detector does not care which side
 * "owns" the type, only that two sides named the same concept and
 * listed different members.
 */

/**
 * How much of the *smaller* set must be shared before two same-named
 * sets count as the same concept.
 *
 * Measured against the smaller set, not the union. Using the union as
 * the denominator is inverted for this purpose: the more two sets have
 * drifted, the lower the union ratio, so the more real the drift the
 * less likely it is to be reported. A four-member Python enum and a
 * three-member TS union sharing two values — an obvious, textbook drift
 * — scores 2/5 = 0.4 against the union and would be silently dropped.
 * Against the smaller set it is 2/3, which is the answer a reader would
 * give.
 */
const MIN_OVERLAP_RATIO = 0.5;

/** A set this small is more likely coincidence than a shared concept. */
const MIN_MEMBERS = 2;

interface ClosedSet {
  file: string;
  /** Declaring symbol name (`Plan`). */
  name: string;
  /** Member *values* lowercased for comparison. */
  members: string[];
  line: number;
  language: "py" | "js";
}

export const crossLanguageTypeDriftDetector: CrossLanguageDetector = {
  id: "cross_language_type_drift",
  name: "Cross-language type drift",
  description:
    "Flags a closed set of string values — a Python Enum and a TypeScript string-literal " +
    "union of the same name — whose members have diverged.",
  whyItMatters:
    "A closed set restated in two languages is two sources of truth for the same rule, " +
    "and nothing checks that they still agree. Adding a member on one side leaves the " +
    "other silently rejecting a value the system now produces, which surfaces as a " +
    "validation error or a dropped branch far from the change. Neither type checker can " +
    "see across the boundary, so the divergence is invisible until a real value hits the " +
    "narrower side — and an agent asked to add a plan tier will add it where it was " +
    "asked and nowhere else.",

  pack: "cross-language",
  run(ctx) {
    const py = collectPythonSets(ctx.files);
    const js = collectTsSets(ctx.files);
    if (py.length === 0 || js.length === 0) return [];

    const findings: Finding[] = [];
    const seen = new Set<string>();

    for (const pySet of py) {
      for (const jsSet of js) {
        if (normaliseName(pySet.name) !== normaliseName(jsSet.name)) continue;

        const pyMembers = new Set(pySet.members);
        const jsMembers = new Set(jsSet.members);
        const shared = [...pyMembers].filter((m) => jsMembers.has(m));
        const onlyPy = [...pyMembers].filter((m) => !jsMembers.has(m)).sort();
        const onlyJs = [...jsMembers].filter((m) => !pyMembers.has(m)).sort();

        if (onlyPy.length === 0 && onlyJs.length === 0) continue;

        // Require real overlap. Two unrelated `Status` types that happen
        // to share a name but nothing else are not drift — they are
        // different concepts, and calling them drift would be a
        // fabricated finding.
        const smaller = Math.min(pyMembers.size, jsMembers.size);
        if (shared.length === 0 || shared.length / smaller < MIN_OVERLAP_RATIO) {
          continue;
        }

        const key = `${pySet.file}::${jsSet.file}::${normaliseName(pySet.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push(buildFinding({ pySet, jsSet, shared, onlyPy, onlyJs }));
      }
    }
    return findings;
  },
};

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Python side: classes that read as a closed set. An `Enum` base is the
 * strong signal; a class whose members are *all* string-literal
 * assignments is the weaker one that catches plain constant classes.
 */
function collectPythonSets(files: PackedFile[]): ClosedSet[] {
  const out: ClosedSet[] = [];
  for (const entry of files) {
    if (entry.pack !== "language-py") continue;
    for (const cls of entry.parsed.classes) {
      const valued = cls.members.filter((m) => m.value !== undefined);
      if (valued.length < MIN_MEMBERS) continue;

      const isEnum = cls.bases.some((b) => /(^|\.)(Enum|StrEnum|IntEnum)$/.test(b));
      // Every member carrying a string literal is what makes this a
      // closed set rather than a config object with mixed types.
      const allValued = valued.length === cls.members.length;
      if (!isEnum && !allValued) continue;

      out.push({
        file: entry.file,
        name: cls.name,
        members: valued.map((m) => m.value!.toLowerCase()),
        line: cls.startLine,
        language: "py",
      });
    }
  }
  return out;
}

function collectTsSets(files: PackedFile[]): ClosedSet[] {
  const out: ClosedSet[] = [];
  for (const entry of files) {
    if (entry.pack !== "language-js") continue;
    for (const union of entry.parsed.stringUnionTypes ?? []) {
      if (union.members.length < MIN_MEMBERS) continue;
      out.push({
        file: entry.file,
        name: union.name,
        members: union.members.map((m) => m.toLowerCase()),
        line: union.line,
        language: "js",
      });
    }
  }
  return out;
}

function buildFinding(args: {
  pySet: ClosedSet;
  jsSet: ClosedSet;
  shared: string[];
  onlyPy: string[];
  onlyJs: string[];
}): Finding {
  const { pySet, jsSet, shared, onlyPy, onlyJs } = args;
  const divergent = onlyPy.length + onlyJs.length;
  // Both sides having exclusive members means they drifted apart in two
  // directions, which is materially worse than one side simply being
  // behind.
  const severity: Severity = onlyPy.length > 0 && onlyJs.length > 0 ? "high" : "medium";

  const evidence: string[] = [
    `${pySet.file}:${pySet.line} — ${pySet.name} declares [${pySet.members.join(", ")}]`,
    `${jsSet.file}:${jsSet.line} — ${jsSet.name} declares [${jsSet.members.join(", ")}]`,
    `shared: ${shared.sort().join(", ")}`,
  ];
  if (onlyPy.length > 0) {
    evidence.push(
      `only in Python: ${onlyPy.join(", ")} — the TypeScript side will reject ${plural(onlyPy.length, "this value", "these values")}`,
    );
  }
  if (onlyJs.length > 0) {
    evidence.push(
      `only in TypeScript: ${onlyJs.join(", ")} — the Python side will reject ${plural(onlyJs.length, "this value", "these values")}`,
    );
  }

  return {
    id: "",
    type: "cross_language_type_drift",
    charge: "Cross-Language Type Drift",
    severity,
    confidence: 0.75,
    file: pySet.file,
    symbol: pySet.name,
    lines: [pySet.line, pySet.line],
    summary:
      `\`${pySet.name}\` is declared as a closed set in both languages and the two have ` +
      `diverged by ${divergent} ${plural(divergent, "value")}. Whichever side is narrower ` +
      "rejects values the other already produces.",
    evidence,
    effort: "medium",
    fix_shape: "generate one side from the other, or share a schema",
    scores: {
      severity: severityScore(severity),
      confidence: 0.75,
      agent_risk: intrinsicFor({
        count: divergent,
        base: 0.65,
        step: 0.08,
        cap: 0.92,
      }),
    },
    suggested_actions: [
      {
        kind: "unify_closed_set",
        description:
          "Pick one side as canonical and generate the other from it — OpenAPI, a " +
          "shared JSON schema, or a codegen step. Keeping two hand-maintained copies " +
          "in sync is the thing that already failed here.",
        risk: "medium",
      },
    ],
    related_files: [jsSet.file],
  };
}
