import type { LanguageJsDetector, DetectorContext } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { IaIndex } from "../ia/types.js";

/**
 * Fires when a markdown document in `docs/` (or root-level `*.md`) links to
 * a local file that does not exist. Broken doc links are the cheapest IA
 * crime to detect deterministically -- the IA index already resolves links
 * against the filesystem during the build pass.
 *
 * Command-drift detection (docs referencing a CLI command the bin doesn't
 * implement) is intentionally deferred to a later release -- it requires
 * deterministic command-registration scanning we do not have yet.
 */
export const docsCodeDriftDetector: LanguageJsDetector = {
  id: "docs_code_drift",
  name: "Docs-Code Drift",
  description:
    "Flags documents that reference local files which no longer exist. " +
    "Broken doc links lead agents to follow stale instructions.",
  whyItMatters:
    "Documents that reference local files which no longer exist lead " +
    "agents to follow stale instructions. Updating the docs in the same " +
    "PR as the code change is the only durable fix; orphaned references " +
    "compound silently over time.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    if (!isPrimaryAnchor(ctx)) return [];
    return analyse(ctx.ia);
  },
};

const MAX_BROKEN_EVIDENCE = 5;

function analyse(ia: IaIndex): Finding[] {
  const findings: Finding[] = [];

  for (const doc of ia.docs) {
    const broken = doc.links.filter((l) => l.isLocal && l.brokenLocal);
    if (broken.length === 0) continue;

    const shown = broken.slice(0, MAX_BROKEN_EVIDENCE);
    const evidence: string[] = [];
    for (const link of shown) {
      evidence.push(`${doc.file}:${link.line} → ${link.target} (not found)`);
    }
    if (broken.length > shown.length) {
      evidence.push(`+${broken.length - shown.length} more broken link(s)`);
    }

    const confidence = 0.9;

    findings.push({
      id: "",
      type: "docs_code_drift",
      charge: "Docs-Code Drift",
      severity: "low",
      confidence,
      file: doc.file,
      summary:
        `${broken.length} local link${broken.length === 1 ? "" : "s"} in ${doc.file} ` +
        "point at file(s) that do not exist on disk. Agents reading this doc " +
        "may follow stale instructions.",
      evidence,
      effort: "small",
      fix_shape: "sync the doc to the code, or move the assertion into a test",
      scores: {
        severity: 0.35,
        confidence,
        agent_risk: 0.6,
      },
      suggested_actions: [
        {
          kind: "fix_doc_link",
          description:
            "Update the docs or restore the referenced file so agents do not " +
            "follow stale instructions.",
          risk: "low",
        },
      ],
    });
  }

  // Sort findings deterministically (the per-file detector loop sees IA
  // findings emitted in the same order each run regardless of disk
  // iteration order).
  findings.sort((a, b) => a.file.localeCompare(b.file));
  return findings;
}

function isPrimaryAnchor(ctx: DetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}
