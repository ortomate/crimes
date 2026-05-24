import type { Detector, DetectorContext } from "../detector.js";
import type { Finding } from "../finding.js";
import { tokenise } from "../ia/tokenise.js";
import type { IaConceptAliasGroup, IaIndex } from "../ia/types.js";

/**
 * Conservative Concept Alias Drift detector.
 *
 * Uses the seeded alias catalogue in `packages/core/src/ia/aliases.ts`.
 * Emits at most one finding per alias group, capped at 3 groups per scan,
 * with a strict quorum (≥3 aliases from the group, each appearing in ≥2
 * distinct directories, with ≥1 directory contributing a product-surface
 * signal like a route, label, nav entry, or doc heading -- not just a
 * file path or comment).
 */
export const conceptAliasDriftDetector: Detector = {
  id: "concept_alias_drift",
  name: "Concept Alias Drift",
  description:
    "Flags repos where multiple seeded aliases from one concept group " +
    "describe overlapping product surface (routes, labels, nav, docs).",
  whyItMatters:
    "When the same product concept appears under different names in " +
    "different files, agents extending one vocabulary quietly duplicate " +
    "logic that already exists under another name. Reviewers reading " +
    "later struggle to tell which alias is canonical.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    if (!isPrimaryAnchor(ctx)) return [];
    return analyse(ctx.ia);
  },
};

const MAX_GROUPS = 3;

interface AliasHit {
  alias: string;
  file: string;
  directory: string;
  source: HitSource;
}

type HitSource = "route" | "label" | "nav" | "doc" | "path";

function analyse(ia: IaIndex): Finding[] {
  const groups = ia.aliasGroups.length > 0 ? ia.aliasGroups : [];
  if (groups.length === 0) return [];

  const evaluated = groups
    .map((g) => evaluateGroup(g, ia))
    .filter((e) => e.fired);

  // Rank by strength: more aliases × more directories × more product hits.
  evaluated.sort((a, b) => b.strength - a.strength);

  return evaluated.slice(0, MAX_GROUPS).map((e) => e.finding);
}

interface GroupEvaluation {
  fired: boolean;
  strength: number;
  finding: Finding;
}

function evaluateGroup(
  group: IaConceptAliasGroup,
  ia: IaIndex,
): GroupEvaluation {
  const hits = collectHits(group, ia);

  // Per-alias directory count.
  const dirsByAlias = new Map<string, Set<string>>();
  const filesByAlias = new Map<string, Set<string>>();
  for (const hit of hits) {
    if (!dirsByAlias.has(hit.alias)) dirsByAlias.set(hit.alias, new Set());
    dirsByAlias.get(hit.alias)!.add(hit.directory);
    if (!filesByAlias.has(hit.alias)) filesByAlias.set(hit.alias, new Set());
    filesByAlias.get(hit.alias)!.add(hit.file);
  }

  // Strict quorum: ≥3 aliases each appearing in ≥2 distinct directories.
  const qualifyingAliases: string[] = [];
  for (const [alias, dirs] of dirsByAlias) {
    if (dirs.size >= 2) qualifyingAliases.push(alias);
  }
  if (qualifyingAliases.length < 3) {
    return notFired();
  }

  // At least one product-surface hit (not just path tokens or comments).
  const productSurface = hits.filter((h) => h.source !== "path");
  if (productSurface.length === 0) {
    return notFired();
  }

  // Cap evidence to keep the finding readable.
  const evidence: string[] = [];
  evidence.push(`alias group: ${group.id}`);
  evidence.push(`aliases found: ${qualifyingAliases.sort().join(", ")}`);

  const sortedAliases = qualifyingAliases.sort();
  for (const alias of sortedAliases.slice(0, 4)) {
    const files = Array.from(filesByAlias.get(alias) ?? []).sort();
    const display = files.slice(0, 3).join(", ");
    const suffix = files.length > 3 ? `, +${files.length - 3} more` : "";
    evidence.push(`"${alias}" in ${files.length} file(s): ${display}${suffix}`);
  }

  const allFiles = Array.from(
    new Set(hits.map((h) => h.file)),
  ).sort();

  // Anchor on the lexicographically first file with a product-surface hit.
  const anchorFiles = Array.from(
    new Set(productSurface.map((h) => h.file)),
  ).sort();
  const anchorFile = anchorFiles[0]!;

  // Strength signal: total distinct aliases + total distinct files + product-surface count.
  const strength =
    qualifyingAliases.length * 100 +
    allFiles.length * 10 +
    productSurface.length;

  // Confidence sits in the 0.6-0.75 band per the plan. Lift slightly when
  // product-surface signal is high.
  const confidence = round(
    Math.min(0.6 + Math.min(productSurface.length, 6) * 0.025, 0.75),
  );

  // Severity is medium when product surface contributes; otherwise the
  // detector would have skipped above.
  const severity = productSurface.length >= 2 ? "medium" : "low";

  const finding: Finding = {
    id: "",
    type: "concept_alias_drift",
    charge: "Concept Alias Drift",
    severity,
    confidence,
    file: anchorFile,
    summary:
      `${qualifyingAliases.length} aliases from the "${group.id}" concept ` +
      `group appear across ${allFiles.length} files. An agent extending one ` +
      "vocabulary may duplicate logic that already exists under another name.",
    evidence,
    effort: "small",
    fix_shape: "rename the alias to match the canonical term; one term per concept",
    scores: {
      severity: severity === "medium" ? 0.55 : 0.4,
      confidence,
      agent_risk: round(Math.min(0.7 + (qualifyingAliases.length - 3) * 0.05, 0.85)),
    },
    suggested_actions: [
      {
        kind: "consolidate_concept",
        description:
          "Pick or document the canonical term, and use aliases deliberately " +
          "rather than accidentally.",
        risk: "medium",
      },
    ],
    related_files: allFiles.filter((f) => f !== anchorFile),
  };

  return { fired: true, strength, finding };
}

function notFired(): GroupEvaluation {
  return {
    fired: false,
    strength: 0,
    finding: undefined as unknown as Finding,
  };
}

function collectHits(group: IaConceptAliasGroup, ia: IaIndex): AliasHit[] {
  const aliasSet = new Set(group.aliases);
  const hits: AliasHit[] = [];

  for (const [file, signal] of Object.entries(ia.files)) {
    if (isTestlike(file)) continue;
    const dir = directoryOf(file);

    // Path tokens (weak signal).
    for (const token of signal.tokens) {
      if (aliasSet.has(token)) {
        hits.push({ alias: token, file, directory: dir, source: "path" });
      }
    }

    // Route paths (product surface).
    for (const route of signal.routes) {
      const tokens = tokenise(route);
      for (const tok of tokens) {
        if (aliasSet.has(tok)) {
          hits.push({ alias: tok, file, directory: dir, source: "route" });
        }
      }
    }

    // Labels (product surface).
    for (const label of signal.labels) {
      const tokens = tokenise(label.value);
      for (const tok of tokens) {
        if (aliasSet.has(tok)) {
          hits.push({ alias: tok, file, directory: dir, source: "label" });
        }
      }
    }

    // Nav entries (product surface).
    for (const nav of signal.navEntries) {
      for (const entry of nav.entries) {
        const sources = [
          entry.destination ? tokenise(entry.destination) : [],
          entry.label ? tokenise(entry.label) : [],
        ];
        for (const tokens of sources) {
          for (const tok of tokens) {
            if (aliasSet.has(tok)) {
              hits.push({ alias: tok, file, directory: dir, source: "nav" });
            }
          }
        }
      }
    }
  }

  // Doc headings (product surface).
  for (const doc of ia.docs) {
    const dir = directoryOf(doc.file);
    for (const heading of doc.headings) {
      const tokens = tokenise(heading.text);
      for (const tok of tokens) {
        if (aliasSet.has(tok)) {
          hits.push({ alias: tok, file: doc.file, directory: dir, source: "doc" });
        }
      }
    }
  }

  return hits;
}

function directoryOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? "" : file.slice(0, i);
}

const TEST_LIKE = [
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /(^|\/)tests?\//,
  /\.test\./,
  /\.spec\./,
  /(^|\/)fixtures?\//,
  /(^|\/)mocks?\//,
];

function isTestlike(file: string): boolean {
  return TEST_LIKE.some((re) => re.test(file));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function isPrimaryAnchor(ctx: DetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}
