import type { LanguageJsDetector, DetectorContext } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { IaAgentInventory } from "../ia/types.js";

/**
 * Fires when the repo ships no agent-readable instructions at all -- no
 * AGENTS.md, no CLAUDE.md, no .claude/skills/*\/SKILL.md, no
 * .agents/skills/*\/SKILL.md.
 *
 * IA detectors are emitted by `scan` once per repo, not once per file. To
 * achieve that with the existing per-file detector loop, we fire only when
 * `ctx.file` is the lexicographically first source file in the IA index --
 * a deterministic, repo-stable anchor.
 */
export const missingAgentContextDetector: LanguageJsDetector = {
  id: "missing_agent_context",
  name: "Missing Agent Context",
  description:
    "Flags repos that ship no agent-readable instruction files. Agents may " +
    "miss project conventions, commands, and safety checks when they have " +
    "nothing to load.",
  whyItMatters:
    "Agents land in repos without the project-specific commands, " +
    "architecture rules, and safety checks the team takes for granted. " +
    "Without AGENTS.md / CLAUDE.md / skill files, the agent invents its " +
    "own conventions — usually badly.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    const anchor = primaryAnchor(ctx);
    if (anchor !== ctx.file) return [];

    const agentContext = ctx.ia.agentContext;
    if (hasAgentContext(agentContext)) return [];

    // Only fire when there is a clear "this repo is meant to be used by
    // agents" signal -- a published bin. Libraries, internal packages, and
    // tiny test fixtures without a bin produce too many false positives
    // otherwise. The plan calls out per-package bin support as future work.
    if (agentContext.declaredBins.length === 0) return [];

    return [missingAgentContextFinding(anchor, agentContext)];
  },
};

function hasAgentContext(agentContext: IaAgentInventory): boolean {
  return (
    agentContext.agentsMdPath !== undefined ||
    agentContext.claudeMdPath !== undefined ||
    agentContext.claudeSkills.length > 0 ||
    (agentContext.codexSkills?.length ?? 0) > 0
  );
}

function missingAgentContextFinding(
  anchor: string,
  agentContext: IaAgentInventory,
): Finding {
  return {
    id: "",
    type: "missing_agent_context",
    charge: "Missing Agent Context",
    severity: "medium",
    confidence: 0.9,
    file: anchor,
    summary:
      "Repo ships no agent-readable instruction files (AGENTS.md, " +
      "CLAUDE.md, .claude/skills/*/SKILL.md, " +
      ".agents/skills/*/SKILL.md). Agents loading this repo will not see " +
      "project commands, conventions, or safety rules and are more likely " +
      "to make confident-but-wrong edits.",
    evidence: missingAgentContextEvidence(agentContext),
    effort: "small",
    fix_shape: "write a SKILL.md so agents discover the entry points",
    scores: {
      severity: 0.6,
      confidence: 0.9,
      agent_risk: 0.8,
    },
    suggested_actions: [
      {
        kind: "add_agent_context",
        description:
          "Add AGENTS.md, a Claude skill, or a Codex skill so coding " +
          "agents can discover repo conventions before editing.",
        risk: "low",
      },
    ],
  };
}

function missingAgentContextEvidence(agentContext: IaAgentInventory): string[] {
  return [
    "no AGENTS.md found at repo root",
    "no CLAUDE.md found at repo root",
    "no .claude/skills/*/SKILL.md present",
    "no .agents/skills/*/SKILL.md present",
    `package.json declares bin(s): ${agentContext.declaredBins.join(", ")} — agents have no way to discover commands`,
  ];
}

/**
 * Returns the lexicographically first source file tracked in the IA index,
 * or `undefined` when the index has no files. IA detectors that need to
 * fire once per scan compare against this to choose a deterministic
 * emission point in the per-file detector loop.
 */
function primaryAnchor(ctx: DetectorContext): string | undefined {
  if (!ctx.ia) return undefined;
  const files = Object.keys(ctx.ia.files).sort();
  return files[0];
}
