import type { CrossLanguageDetector, PackedFile } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import type { IaConceptAliasGroup } from "../../ia/types.js";
import { intrinsicFor, plural, severityScore } from "../py/shared.js";

/**
 * The same product concept called different things on either side of a
 * language boundary — `workspace` in the TypeScript app, `team` in the
 * Python service.
 *
 * This is deliberately **not** an extension of 0.3.0's
 * `concept_alias_drift`, and it does not feed Python into the IA index.
 * Two reasons:
 *
 *  1. Widening the IA index would change what the existing single-
 *     language detector fires on in every polyglot repo — a calibration
 *     change bundled into a feature release, which is what the eval
 *     policy exists to prevent.
 *  2. The interesting finding is specifically that the drift *crosses
 *     the boundary*. Same-language drift is already charged. A finding
 *     that fires only when both languages disagree is a different
 *     claim, and one no single-language tool can make.
 *
 * So this computes its own hits from the parsed corpus and fires only
 * when a group's aliases split across languages.
 */

/** A group needs this many distinct aliases before it reads as drift. */
const MIN_ALIASES = 2;

/** Cap so one noisy vocabulary can't dominate a scan. */
const MAX_FINDINGS = 3;

interface AliasHit {
  alias: string;
  file: string;
  language: "py" | "js";
  /** What surfaced the alias, quoted into evidence. */
  source: string;
  line: number;
}

export const crossLanguageConceptAliasDriftDetector: CrossLanguageDetector = {
  id: "cross_language_concept_alias_drift",
  name: "Cross-language concept alias drift",
  description:
    "Flags a product concept named one way in Python and another way in TypeScript — " +
    "competing vocabulary for the same thing, split across the language boundary.",
  whyItMatters:
    "When the backend calls it a `team` and the frontend calls it a `workspace`, every " +
    "reader has to hold a translation table that exists nowhere in the code. The cost " +
    "lands hardest on agents: asked to 'add a field to the workspace', an agent greps " +
    "for `workspace`, finds only the TypeScript half, and edits one side of a two-sided " +
    "change. The mapping is usually obvious to whoever wrote it and invisible to " +
    "everyone since, which is why this survives long past the point where anyone " +
    "remembers it was a rename that only half-happened.",

  pack: "cross-language",
  run(ctx) {
    const groups = ctx.ia?.aliasGroups ?? [];
    if (groups.length === 0) return [];

    const hasPy = ctx.files.some((f) => f.pack === "language-py");
    const hasJs = ctx.files.some((f) => f.pack === "language-js");
    if (!hasPy || !hasJs) return [];

    const scored: Array<{ finding: Finding; strength: number }> = [];

    for (const group of groups) {
      const hits = collectHits(ctx.files, group);
      if (hits.length === 0) continue;

      const pyAliases = new Set(
        hits.filter((h) => h.language === "py").map((h) => h.alias),
      );
      const jsAliases = new Set(
        hits.filter((h) => h.language === "js").map((h) => h.alias),
      );
      if (pyAliases.size === 0 || jsAliases.size === 0) continue;

      const allAliases = new Set([...pyAliases, ...jsAliases]);
      if (allAliases.size < MIN_ALIASES) continue;

      // The charge is that the two languages *disagree*. If both sides
      // use exactly the same vocabulary, there is no cross-language
      // drift no matter how many aliases the group has — that is the
      // single-language detector's business.
      const onlyPy = [...pyAliases].filter((a) => !jsAliases.has(a));
      const onlyJs = [...jsAliases].filter((a) => !pyAliases.has(a));
      if (onlyPy.length === 0 || onlyJs.length === 0) continue;

      const files = new Set(hits.map((h) => h.file));
      scored.push({
        finding: buildFinding({ group, hits, onlyPy, onlyJs, files }),
        strength: allAliases.size * 10 + files.size,
      });
    }

    return scored
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_FINDINGS)
      .map((s) => s.finding);
  },
};

/**
 * Alias occurrences across both languages.
 *
 * Only *declaration* surfaces count — a class name, a function name, a
 * type alias, a docstring. Deliberately not free-text source scanning:
 * an alias in a comment or a string literal is far weaker evidence and
 * would balloon the false-positive surface, which for a cross-language
 * detector is already roughly squared.
 *
 * Docstrings are in the pool on purpose, and the consequence is worth
 * knowing: a Python docstring that uses the frontend's word — "the
 * team, called a workspace in the UI" — puts both aliases on the Python
 * side, so the vocabulary is no longer cleanly split and no finding is
 * emitted. That is the right outcome. A codebase that documents its own
 * mapping where a reader will find it has the problem this detector
 * exists to catch far less than one that does not.
 */
function collectHits(files: PackedFile[], group: IaConceptAliasGroup): AliasHit[] {
  const hits: AliasHit[] = [];
  const aliases = group.aliases.map((a) => a.toLowerCase());

  // Every alias present, not just the first. A docstring reading "the
  // team, called a workspace in the UI" names both; recording only the
  // first would make the outcome depend on the order aliases happen to
  // be listed in the group, and would report a clean language split
  // where the text plainly documents the mapping.
  const match = (text: string): string[] =>
    aliases.filter((a) => containsToken(text, a));

  for (const entry of files) {
    if (entry.pack === "language-py") {
      for (const cls of entry.parsed.classes) {
        for (const alias of match(cls.name)) {
          hits.push({
            alias,
            file: entry.file,
            language: "py",
            source: `class ${cls.name}`,
            line: cls.startLine,
          });
        }
        for (const alias of match(cls.docstring ?? "")) {
          hits.push({
            alias,
            file: entry.file,
            language: "py",
            source: `docstring of ${cls.name}`,
            line: cls.startLine,
          });
        }
      }
      for (const fn of entry.parsed.functions) {
        if (fn.name === undefined) continue;
        for (const alias of match(fn.name)) {
          hits.push({
            alias,
            file: entry.file,
            language: "py",
            source: `def ${fn.name}`,
            line: fn.startLine,
          });
        }
      }
      continue;
    }

    for (const union of entry.parsed.stringUnionTypes ?? []) {
      for (const alias of match(union.name)) {
        hits.push({
          alias,
          file: entry.file,
          language: "js",
          source: `type ${union.name}`,
          line: union.line,
        });
      }
    }
    for (const fn of entry.parsed.functions) {
      if (fn.name === undefined) continue;
      for (const alias of match(fn.name)) {
        hits.push({
          alias,
          file: entry.file,
          language: "js",
          source: `${fn.name}()`,
          line: fn.startLine,
        });
      }
    }
    if (entry.parsed.defaultExport) {
      for (const alias of match(entry.parsed.defaultExport)) {
        hits.push({
          alias,
          file: entry.file,
          language: "js",
          source: `default export ${entry.parsed.defaultExport}`,
          line: 1,
        });
      }
    }
  }
  return hits;
}

/**
 * Whole-word-ish containment over an identifier.
 *
 * `TeamService` contains `team`; `steam` must not. Identifiers are
 * split on case boundaries and separators first so the check is about
 * word components rather than substrings.
 */
function containsToken(identifier: string, alias: string): boolean {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
  return words.some((w) => w === alias || w === `${alias}s`);
}

function buildFinding(args: {
  group: IaConceptAliasGroup;
  hits: AliasHit[];
  onlyPy: string[];
  onlyJs: string[];
  files: Set<string>;
}): Finding {
  const { group, hits, onlyPy, onlyJs, files } = args;
  const severity: Severity = files.size >= 4 ? "medium" : "low";
  const sorted = [...hits].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
  const anchor = sorted[0]!;

  const evidence: string[] = [
    `concept group "${group.id}" is named differently on each side of the boundary`,
    `Python uses: ${onlyPy.sort().join(", ")}`,
    `TypeScript uses: ${onlyJs.sort().join(", ")}`,
    ...sorted
      .slice(0, 8)
      .map((h) => `${h.file}:${h.line} — ${h.source} (${h.alias})`),
    ...(sorted.length > 8 ? [`…+${sorted.length - 8} more`] : []),
  ];
  if (group.preferred) {
    evidence.push(`preferred form for this group: "${group.preferred}"`);
  }

  return {
    id: "",
    type: "cross_language_concept_alias_drift",
    charge: "Cross-Language Concept Alias Drift",
    severity,
    confidence: 0.65,
    file: anchor.file,
    lines: [anchor.line, anchor.line],
    summary:
      `The "${group.id}" concept is called ${onlyPy.sort().join("/")} in Python and ` +
      `${onlyJs.sort().join("/")} in TypeScript, across ${files.size} ` +
      `${plural(files.size, "file")}. An agent searching for one name finds only half ` +
      "the code it needs to change.",
    evidence,
    effort: "medium",
    fix_shape: "pick one name for the concept and rename across both languages",
    scores: {
      severity: severityScore(severity),
      confidence: 0.65,
      agent_risk: intrinsicFor({
        count: files.size,
        base: 0.5,
        step: 0.06,
        cap: 0.82,
      }),
    },
    suggested_actions: [
      {
        kind: "unify_concept_name",
        description:
          `Choose one name for the "${group.id}" concept` +
          (group.preferred ? ` (suggested: "${group.preferred}")` : "") +
          " and rename in both languages. If the boundary name has to differ for " +
          "external reasons, document the mapping where both sides will see it.",
        risk: "medium",
      },
    ],
    related_files: [...files].filter((f) => f !== anchor.file).sort().slice(0, 8),
  };
}
