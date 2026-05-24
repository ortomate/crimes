import type { LanguageJsDetector, DetectorContext } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import type { IaIndex } from "../ia/types.js";

/**
 * Fires when the same domain action or object appears in UI / code
 * under different labels across the repo: "Delete" / "Remove" /
 * "Archive"; "User" / "Member" / "Seat".
 *
 * Action / object groups are a small seeded catalogue: ≥3 distinct
 * aliases from one group must appear, each in ≥2 different files,
 * before the detector fires. Anchored on the lex-first contributing
 * file so the per-file detector loop emits each finding exactly once.
 *
 * Reuses the IA index's label and nav signals (JSX text plus
 * string-valued button props). The frontend variant of this detector
 * (`copy_ia_drift`) restricts inputs to JSX text nodes only; this
 * variant is broader and runs across the whole code surface the IA
 * index already touches.
 */
export const actionLabelDriftDetector: LanguageJsDetector = {
  id: "action_label_drift",
  name: "Action Label Drift",
  description:
    "Flags actions or objects labelled differently across UI copy and " +
    "code (Delete / Remove / Archive; User / Member / Seat).",
  whyItMatters:
    "When the same action goes by different verbs in different views, " +
    "agents extending one screen pick a synonym that diverges from the " +
    "rest. Reviewers struggle to tell whether two buttons do the same " +
    "thing or not.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    if (!isPrimaryAnchor(ctx)) return [];
    return analyse(
      ctx.ia,
      ACTION_GROUPS,
      "action_label_drift",
      "Action Label Drift",
      "pick one verb per action; update labels uniformly",
    );
  },
};

export interface ActionGroup {
  id: string;
  aliases: string[];
}

export const ACTION_GROUPS: ActionGroup[] = [
  { id: "delete", aliases: ["delete", "remove", "archive", "trash", "destroy"] },
  { id: "user", aliases: ["user", "member", "seat", "account_user"] },
  { id: "owner", aliases: ["owner", "admin", "manager", "founder"] },
  { id: "save", aliases: ["save", "submit", "apply", "confirm", "update"] },
  { id: "cancel", aliases: ["cancel", "discard", "abort", "dismiss"] },
];

interface AliasHit {
  alias: string;
  file: string;
  context: string;
}

/**
 * Shared analysis used by both `action_label_drift` and the
 * frontend-restricted `copy_ia_drift` variant. Exported so the latter
 * can reuse the same fingerprint without re-implementing the loop.
 */
export function analyse(
  ia: IaIndex,
  groups: ActionGroup[],
  type: string,
  charge: string,
  /**
   * Per-call fix_shape phrasing. Required so each caller
   * (action-label-drift vs copy-ia-drift) carries the right
   * detector-defaults entry onto the emitted finding.
   */
  fixShape: string,
  options: { restrictToJsxLabel?: boolean } = {},
): Finding[] {
  const findings: Finding[] = [];

  for (const group of groups) {
    const aliasSet = new Set(group.aliases);
    const hits: AliasHit[] = [];
    for (const [file, signals] of Object.entries(ia.files)) {
      for (const label of signals.labels) {
        if (options.restrictToJsxLabel && !label.kind.startsWith("jsx_")) continue;
        const tokens = label.value.toLowerCase().split(/[^a-z_]+/);
        for (const tok of tokens) {
          if (aliasSet.has(tok)) {
            hits.push({ alias: tok, file, context: `label "${label.value}"` });
          }
        }
      }
      if (options.restrictToJsxLabel) continue;
      for (const nav of signals.navEntries) {
        for (const entry of nav.entries) {
          for (const v of [entry.label, ...Object.values(entry.attributes)]) {
            if (!v) continue;
            const tokens = v.toLowerCase().split(/[^a-z_]+/);
            for (const tok of tokens) {
              if (aliasSet.has(tok)) {
                hits.push({ alias: tok, file, context: `nav text "${v}"` });
              }
            }
          }
        }
      }
    }

    const filesByAlias = new Map<string, Set<string>>();
    for (const h of hits) {
      if (!filesByAlias.has(h.alias)) filesByAlias.set(h.alias, new Set());
      filesByAlias.get(h.alias)!.add(h.file);
    }
    const qualifyingAliases: string[] = [];
    for (const [alias, files] of filesByAlias) {
      if (files.size >= 2) qualifyingAliases.push(alias);
    }
    if (qualifyingAliases.length < 3) continue;

    const allFiles = Array.from(new Set(hits.map((h) => h.file))).sort();
    const anchor = allFiles[0]!;
    const severity: Severity = qualifyingAliases.length >= 4 ? "medium" : "low";
    const confidence = 0.6;

    const evidence: string[] = [];
    evidence.push(`group: ${group.id}`);
    evidence.push(`aliases: ${qualifyingAliases.sort().join(", ")}`);
    for (const alias of qualifyingAliases.sort().slice(0, 4)) {
      const files = Array.from(filesByAlias.get(alias) ?? []).sort();
      evidence.push(
        `"${alias}" in ${files.length} file(s): ${files.slice(0, 3).join(", ")}` +
          (files.length > 3 ? `, +${files.length - 3} more` : ""),
      );
    }

    findings.push({
      id: "",
      type,
      charge,
      severity,
      confidence,
      file: anchor,
      summary:
        `${qualifyingAliases.length} aliases from the "${group.id}" action ` +
        "group appear across the repo. The same action may be labelled " +
        "different ways in different views — pick a canonical verb to keep " +
        "agents and reviewers aligned.",
      evidence,
      effort: "small",
      fix_shape: fixShape,
      scores: {
        severity: severity === "medium" ? 0.55 : 0.4,
        confidence,
      },
      suggested_actions: [
        {
          kind: "pick_canonical_label",
          description:
            "Pick the canonical label for this action and align every " +
            "surface; document the choice in your design system or copy guide.",
          risk: "low",
        },
      ],
      related_files: allFiles.filter((f) => f !== anchor),
    });
  }

  findings.sort((a, b) => a.file.localeCompare(b.file));
  return findings;
}

function isPrimaryAnchor(ctx: DetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}
