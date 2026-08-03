import { z } from "zod";
import type { UniversalDetector, UniversalDetectorContext } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type {
  AgentConfigIndex,
  AgentHook,
  AgentMcpServer,
  AgentPermissionRule,
} from "../agents/types.js";
import { quoteFragment } from "../agents/build.js";
import {
  ConfidenceLadder,
  SeverityLadder,
  scoreRationale,
} from "../scoring/confidence.js";

/**
 * Loaded Agent — repository-local agent configuration that grants more
 * than the work requires, or that executes repository-controlled text.
 *
 * ## Subject
 *
 * The repo's own committed agent configuration: `.claude/settings.json`,
 * hooks, `.mcp.json`, and agent instruction files. These are loaded
 * automatically by any agent that opens the checkout, which makes them
 * the one part of a repository that acts before anybody reviews it.
 *
 * **No discovered hook or configuration is ever executed.** Everything is
 * read as text.
 *
 * ## Three tiers, deliberately separated
 *
 *  1. **Executable configuration** — a wildcard shell permission, a hook
 *     that pipes a remote URL into a shell, a hook that prints the
 *     environment. Medium to high severity: these run.
 *  2. **Broad-but-scoped grants** — a write permission reaching outside
 *     the repository, an unattended network action on an edit event.
 *     Medium.
 *  3. **Prose directives** — an instruction file telling an agent to skip
 *     verification or ignore higher-level instructions. **Low severity,
 *     low confidence, always.** A sentence is not an execution path, and
 *     a repository may have entirely legitimate reasons to say "don't run
 *     the slow suite here". The finding says the sentence exists, and
 *     says explicitly that it is advisory.
 *
 * A scoped development command — `Bash(pnpm test)`, `Bash(git status)` —
 * is never a finding. That is the tool working as intended.
 *
 * ## Evidence redaction
 *
 * Every quoted fragment passes through a redactor that masks
 * token-shaped values, `KEY=value` pairs, and `Authorization` headers
 * before it reaches a finding. Evidence names the permission or the
 * execution path; it does not reproduce credentials.
 */

const optionsSchema = z
  .object({
    /** Report advisory prose directives in instruction files. Default true. */
    reportInstructionProse: z.boolean().optional(),
    /** Report broad permission rules. Default true. */
    reportPermissions: z.boolean().optional(),
    /** Report hook execution hazards. Default true. */
    reportHooks: z.boolean().optional(),
    /** Permission rules to accept verbatim, e.g. `["Bash(pnpm *)"]`. */
    allowedRules: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS = 10;

export const agentPermissionSprawlDetector: UniversalDetector = {
  id: "agent_permission_sprawl",
  name: "Loaded Agent",
  description:
    "Inspects repository-local agent settings, hooks, MCP servers, and " +
    "instruction files for wildcard execution grants, hooks that " +
    "interpolate repository-controlled text into a shell, remote content " +
    "piped into an interpreter, environment exfiltration, and prose that " +
    "tells agents to skip verification or ignore higher-level instructions.",
  whyItMatters:
    "Agent configuration is the one part of a repository that acts before " +
    "anyone reviews it. A wildcard shell permission or a hook that pipes " +
    "a URL into a shell turns `git clone` into arbitrary code execution " +
    "on a contributor's machine, and neither shows up in a code review of " +
    "the change that introduced it. Configuration is also the least-read " +
    "part of most repos: permissions accumulate one emergency at a time " +
    "and nobody narrows them afterwards.",

  pack: "universal",
  optionsSchema,

  run(ctx) {
    const index = ctx.agentConfig;
    if (!index || index.files.length === 0) return [];
    // Repo-level detector: emit once, at the deterministic anchor.
    if (!isRepoAnchorFile(ctx)) return [];

    const options = readOptions(ctx.config);
    const allowed = new Set(options.allowedRules ?? []);

    const findings: Finding[] = [];
    if (options.reportPermissions !== false) {
      findings.push(...reportPermissions(index, allowed));
    }
    if (options.reportHooks !== false) {
      findings.push(...reportHooks(index));
      findings.push(...reportMcpServers(index));
    }
    if (options.reportInstructionProse !== false) {
      const prose = reportInstructions(index);
      if (prose) findings.push(prose);
    }

    findings.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0);
    });
    return findings.slice(0, MAX_FINDINGS);
  },
};

/* ------------------------------------------------------------------ *
 * Permission rules
 * ------------------------------------------------------------------ */

/**
 * A permission rule granting unrestricted execution.
 *
 * `Bash(*)` and a bare `Bash` grant everything. `Bash(rm *)` is
 * unrestricted *destruction* specifically. `Bash(pnpm test)` and
 * `Bash(git status:*)` are scoped and never reported.
 */
interface PermissionHazard {
  rule: AgentPermissionRule;
  reason: string;
  severityDelta: number;
}

const UNRESTRICTED_TOOL_RE = /^(Bash|Shell|Execute|Run|Terminal)(\(\s*\*?\s*\))?$/i;
const WILDCARD_ARG_RE = /^(Bash|Shell|Execute|Run|Terminal)\(\s*\*\s*\)$/i;
const DESTRUCTIVE_RE =
  /\b(rm\s+-[rf]|rm\s+-rf|rmdir|mkfs|dd\s+if=|shred|:\s*\(\s*\)\s*\{|chmod\s+777|sudo|curl[^)]*\|\s*(?:ba)?sh|wget[^)]*\|\s*(?:ba)?sh)/i;
const WRITE_TOOL_RE = /^(Write|Edit|MultiEdit|NotebookEdit|Create)\(/i;
const OUTSIDE_REPO_RE = /(^|[("\s])(\/(?!\/)|~\/|\.\.\/\.\.)/;

function reportPermissions(index: AgentConfigIndex, allowed: Set<string>): Finding[] {
  const hazards: PermissionHazard[] = [];

  for (const rule of index.permissions) {
    // Only grants matter. A `deny` entry naming `rm -rf` is the repo
    // protecting itself — reporting it would be exactly backwards.
    if (rule.bucket !== "allow") continue;
    if (allowed.has(rule.rule)) continue;

    if (WILDCARD_ARG_RE.test(rule.rule) || UNRESTRICTED_TOOL_RE.test(rule.rule)) {
      hazards.push({
        rule,
        reason: "grants shell execution with no command restriction",
        severityDelta: 0.35,
      });
      continue;
    }
    if (DESTRUCTIVE_RE.test(rule.rule)) {
      hazards.push({
        rule,
        reason: "pre-approves a destructive or self-elevating command",
        severityDelta: 0.3,
      });
      continue;
    }
    if (WRITE_TOOL_RE.test(rule.rule) && OUTSIDE_REPO_RE.test(rule.rule)) {
      hazards.push({
        rule,
        reason: "grants file writes to a scope outside the repository",
        severityDelta: 0.25,
      });
    }
  }

  if (hazards.length === 0) return [];

  const byFile = groupBy(hazards, (h) => h.rule.file);
  const findings: Finding[] = [];

  for (const [file, group] of byFile) {
    const confidence = new ConfidenceLadder(0.82)
      .add(true, "rule read verbatim from committed settings", 0.06)
      .add(group.length >= 3, `${group.length} broad rules in one file`, 0.04);

    const severity = new SeverityLadder(0.35);
    for (const hazard of group) {
      severity.add(true, hazard.reason, hazard.severityDelta);
    }

    const evidence: string[] = [
      `settings file: ${file}`,
      `${group.length} allow-rule(s) granting more than a scoped command:`,
    ];
    for (const hazard of group.slice(0, 6)) {
      evidence.push(
        `  line ${hazard.rule.line}: \`${quoteFragment(hazard.rule.rule, 60)}\` — ${hazard.reason}`,
      );
    }
    if (group.length > 6) evidence.push(`  +${group.length - 6} more`);
    evidence.push(
      "these rules are pre-approvals: an agent working in this repo will run " +
        "matching commands without asking",
    );
    evidence.push(
      "scoped development commands in the same file are not reported — only " +
        "rules that place no bound on what may run",
    );
    const rationale = scoreRationale(confidence, severity);

    findings.push({
      id: "",
      type: "agent_permission_sprawl",
      charge: "Loaded Agent",
      severity: severity.severity(),
      confidence: confidence.value(),
      file,
      lines: [group[0]!.rule.line, group[group.length - 1]!.rule.line],
      symbol: "permissions.allow",
      summary:
        `${group.length} committed permission rule(s) pre-approve unrestricted ` +
        "execution or out-of-repository writes for any agent that opens this " +
        "checkout.",
      evidence,
      score_rationale: rationale,
      effort: "quick",
      fix_shape: "narrow each rule to the specific commands the work needs",
      scores: { severity: severity.score(), confidence: confidence.value() },
      suggested_actions: [
        {
          kind: "narrow_permission_scope",
          description:
            "Replace the wildcard with the specific commands this project " +
            "actually runs (`Bash(pnpm test:*)`, `Bash(git status)`), so an " +
            "unexpected command still prompts.",
          risk: "low",
        },
      ],
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

interface HookHazard {
  hook: AgentHook;
  reason: string;
  severityDelta: number;
}

/** `curl … | sh`, `wget … | bash`, `eval "$(curl …)"`. */
const REMOTE_PIPE_RE =
  /(curl|wget|fetch|iwr|invoke-webrequest)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b|eval\s+["'`]?\$\((curl|wget)/i;

/** Interpolation of a value the repository or its inputs control. */
const SHELL_INTERPOLATION_RE =
  /\$\{?(?:CLAUDE_|AGENT_|HOOK_|TOOL_|USER_|INPUT_|FILE_|PROMPT_)[A-Z_]*\}?|\$\(\s*(?:cat|jq|git\s+log|git\s+diff|echo\s+"?\$)/i;

/** Printing or transmitting the environment. */
const ENV_EXFIL_RE =
  /\b(env|printenv|set)\b\s*(\||>|$)|echo\s+\$[A-Z_]{3,}|process\.env\b[^\n]{0,40}\b(fetch|curl|post|send)\b|\bcurl\b[^\n]*\b(-d|--data)\b[^\n]*\$(?:\{)?[A-Z_]{3,}/i;

/** Network egress. */
const NETWORK_RE = /\b(curl|wget|nc|netcat|ssh|scp|rsync|npm\s+publish|git\s+push)\b/i;

/** Events that fire around an edit, where an unattended network call is unexpected. */
const EDIT_EVENT_RE =
  /^(PreToolUse|PostToolUse|PreEdit|PostEdit|PreWrite|PostWrite|UserPromptSubmit)$/i;

function reportHooks(index: AgentConfigIndex): Finding[] {
  const hazards: HookHazard[] = [];

  for (const hook of index.hooks) {
    if (REMOTE_PIPE_RE.test(hook.command)) {
      hazards.push({
        hook,
        reason: "pipes remote content directly into a shell",
        severityDelta: 0.45,
      });
      continue;
    }
    if (ENV_EXFIL_RE.test(hook.command)) {
      hazards.push({
        hook,
        reason: "prints or transmits environment variables",
        severityDelta: 0.4,
      });
      continue;
    }
    if (SHELL_INTERPOLATION_RE.test(hook.command)) {
      hazards.push({
        hook,
        reason:
          "interpolates a repository- or input-controlled value into a shell command",
        severityDelta: 0.3,
      });
      continue;
    }
    if (
      hook.event !== undefined &&
      EDIT_EVENT_RE.test(hook.event) &&
      NETWORK_RE.test(hook.command)
    ) {
      hazards.push({
        hook,
        reason: `performs an unattended network action on the \`${hook.event}\` event`,
        severityDelta: 0.22,
      });
    }
  }

  if (hazards.length === 0) return [];

  const byFile = groupBy(hazards, (h) => h.hook.file);
  const findings: Finding[] = [];

  for (const [file, group] of byFile) {
    const confidence = new ConfidenceLadder(0.78)
      .add(
        group.some((h) => h.reason.startsWith("pipes remote")),
        "remote-content pipe is unambiguous",
        0.12,
      )
      .add(
        group.every((h) => h.reason.startsWith("performs an unattended")),
        "only the event/network combination matched",
        -0.16,
      );

    const severity = new SeverityLadder(0.3);
    for (const hazard of group) severity.add(true, hazard.reason, hazard.severityDelta);

    const evidence: string[] = [
      `hook configuration: ${file}`,
      `${group.length} hook command(s) with an execution hazard:`,
    ];
    for (const hazard of group.slice(0, 6)) {
      const event = hazard.hook.event !== undefined ? ` [${hazard.hook.event}]` : "";
      evidence.push(
        `  line ${hazard.hook.line}${event}: \`${quoteFragment(hazard.hook.command, 90)}\` — ${hazard.reason}`,
      );
    }
    if (group.length > 6) evidence.push(`  +${group.length - 6} more`);
    evidence.push(
      "hooks run automatically for anyone who opens this repository with a " +
        "matching agent — no prompt, no review of the change that added them",
    );
    evidence.push(
      "no hook was executed to produce this finding; the commands were read " +
        "as text and quoted with token-shaped values masked",
    );
    const rationale = scoreRationale(confidence, severity);

    findings.push({
      id: "",
      type: "agent_permission_sprawl",
      charge: "Loaded Agent",
      severity: severity.severity(),
      confidence: confidence.value(),
      file,
      lines: [group[0]!.hook.line, group[group.length - 1]!.hook.line],
      symbol: "hooks",
      summary:
        `${group.length} committed hook command(s) execute automatically and ` +
        `${group[0]!.reason}.`,
      evidence,
      score_rationale: rationale,
      effort: "small",
      fix_shape: "remove the hazard, or move the logic into a reviewed script",
      scores: { severity: severity.score(), confidence: confidence.value() },
      suggested_actions: [
        {
          kind: "harden_hook",
          description:
            "Replace the inline command with a committed script that takes no " +
            "interpolated input, fetches nothing at run time, and can be " +
            "reviewed like any other code.",
          risk: "low",
        },
      ],
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * MCP servers
 * ------------------------------------------------------------------ */

function reportMcpServers(index: AgentConfigIndex): Finding[] {
  const risky: Array<{ server: AgentMcpServer; reason: string }> = [];

  for (const server of index.mcpServers) {
    if (REMOTE_PIPE_RE.test(server.command)) {
      risky.push({
        server,
        reason: "launch command pipes remote content into a shell",
      });
      continue;
    }
    // `npx -y some-package` fetches and runs code that is not pinned in
    // this repo's lockfile.
    if (/\bnpx\b\s+(-y|--yes)\b/.test(server.command)) {
      risky.push({
        server,
        reason:
          "launches an unpinned package with `npx -y`, which downloads and " +
          "runs code that no lockfile in this repo pins",
      });
    }
  }

  if (risky.length === 0) return [];
  const file = risky[0]!.server.file;

  const confidence = new ConfidenceLadder(0.7).add(
    true,
    "launch command read verbatim from committed configuration",
    0.05,
  );
  const severity = new SeverityLadder(0.4).add(
    risky.some((r) => r.reason.startsWith("launch command pipes")),
    "remote content piped into a shell",
    0.3,
  );

  const evidence: string[] = [`MCP configuration: ${file}`];
  for (const { server, reason } of risky.slice(0, 6)) {
    evidence.push(
      `  \`${server.name}\` (line ${server.line}): \`${quoteFragment(server.command, 80)}\` — ${reason}`,
    );
    if (server.envNames.length > 0) {
      evidence.push(
        `    environment passed through: ${server.envNames.join(", ")} (names only; no values read)`,
      );
    }
  }
  evidence.push("MCP servers start with the agent session and inherit its environment");
  const rationale = scoreRationale(confidence, severity);

  return [
    {
      id: "",
      type: "agent_permission_sprawl",
      charge: "Loaded Agent",
      severity: severity.severity(),
      confidence: confidence.value(),
      file,
      lines: [risky[0]!.server.line, risky[risky.length - 1]!.server.line],
      symbol: "mcpServers",
      summary:
        `${risky.length} MCP server(s) configured in this repo launch code that ` +
        "is fetched at start-up rather than pinned in the repository.",
      evidence,
      score_rationale: rationale,
      effort: "small",
      fix_shape: "pin the server package, or vendor the launch script",
      scores: { severity: severity.score(), confidence: confidence.value() },
      suggested_actions: [
        {
          kind: "pin_mcp_server",
          description:
            "Declare the server package as a dependency at a fixed version so " +
            "the lockfile covers it, and launch it from `node_modules` rather " +
            "than fetching at start-up.",
          risk: "low",
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Instruction prose — advisory only
 * ------------------------------------------------------------------ */

function reportInstructions(index: AgentConfigIndex): Finding | undefined {
  if (index.instructions.length === 0) return undefined;

  const byFile = groupBy(index.instructions, (i) => i.file);
  const [file, group] = [...byFile.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )[0]!;

  // Deliberately capped low. Prose is not an execution path, and a
  // detector that shouts about sentences would be ignored — correctly.
  const confidence = new ConfidenceLadder(0.35)
    .add(group.length >= 3, `${group.length} matching directives in one file`, 0.08)
    .add(
      group.some((i) => i.pattern === "override_higher_instructions"),
      "one directive tells agents to disregard higher-level instructions",
      0.1,
    );

  const severity = new SeverityLadder(0.2)
    .add(
      group.some((i) => i.pattern === "expose_secrets"),
      "a directive mentions printing or sending secrets",
      0.15,
    )
    .add(
      group.some((i) => i.pattern === "override_higher_instructions"),
      "a directive tells agents to ignore higher-level instructions",
      0.1,
    );

  const evidence: string[] = [
    `instruction file: ${file}`,
    `${group.length} directive(s) that would change how an agent behaves:`,
  ];
  for (const instruction of group.slice(0, 6)) {
    evidence.push(
      `  line ${instruction.line} [${instruction.pattern}]: "${quoteFragment(instruction.text, 110)}"`,
    );
  }
  if (group.length > 6) evidence.push(`  +${group.length - 6} more`);
  evidence.push(
    "ADVISORY: this is prose, not an execution path. A repository may have " +
      "entirely legitimate reasons for each of these sentences — the finding " +
      "is that they exist and are worth a reviewer's eye, not that they are wrong",
  );
  evidence.push(
    "confidence is capped low for this reason and no severity above `low` is " +
      "assigned to prose alone",
  );
  const rationale = scoreRationale(confidence, severity);

  return {
    id: "",
    type: "agent_permission_sprawl",
    charge: "Loaded Agent",
    severity: "low",
    confidence: confidence.value(),
    file,
    lines: [group[0]!.line, group[group.length - 1]!.line],
    symbol: "agent instructions",
    summary:
      `${group.length} committed instruction(s) direct agents to skip ` +
      "verification, ignore higher-level instructions, or handle secrets " +
      "unusually. Advisory — worth a reviewer's eye, not necessarily wrong.",
    evidence,
    score_rationale: rationale,
    effort: "quick",
    fix_shape: "confirm each directive is intended; scope or delete the rest",
    scores: {
      // Held at the low band regardless of the ladder, so prose can never
      // outrank an executable hazard in the default ranking.
      severity: Math.min(severity.score(), 0.39),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "review_agent_directives",
        description:
          "Confirm each directive is deliberate. If one exists to work around " +
          'a slow check, say so inline — an unexplained "skip the tests" ' +
          "reads the same whether it was added by a maintainer or a drive-by PR.",
        risk: "low",
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  // Sorted so the emitted finding order is stable.
  return new Map([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function isRepoAnchorFile(ctx: UniversalDetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.agent_permission_sprawl;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
