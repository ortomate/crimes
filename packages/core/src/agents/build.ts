import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import fg from "fast-glob";
import type {
  AgentConfigIndex,
  AgentHook,
  AgentInstruction,
  AgentMcpServer,
  AgentPermissionRule,
  AgentPlatform,
} from "./types.js";

/**
 * Build the repository-local agent-configuration inventory.
 *
 * Everything is read as text. No hook is executed, no MCP server is
 * started, no settings file is applied. That is the single most important
 * property of this module.
 */

/**
 * Files inspected. `dot: true` is required — every one of these lives
 * under a dot directory, and the shared `discoverFiles` deliberately
 * skips those.
 */
const AGENT_CONFIG_GLOBS: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks/**/*",
  ".claude/skills/*/SKILL.md",
  ".agents/skills/*/SKILL.md",
  ".mcp.json",
  ".cursor/rules/**/*",
  ".cursorrules",
  ".codex/config.toml",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
];

const EXCLUDE_GLOBS: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
];

export interface BuildAgentConfigIndexOptions {
  root: string;
}

export async function buildAgentConfigIndex(
  options: BuildAgentConfigIndexOptions,
): Promise<AgentConfigIndex> {
  const paths = await fg([...AGENT_CONFIG_GLOBS], {
    cwd: options.root,
    ignore: [...EXCLUDE_GLOBS],
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });

  const permissions: AgentPermissionRule[] = [];
  const hooks: AgentHook[] = [];
  const mcpServers: AgentMcpServer[] = [];
  const instructions: AgentInstruction[] = [];
  const files: string[] = [];

  for (const absolutePath of [...paths].sort()) {
    let raw: string;
    try {
      raw = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const file = toRepoPath(options.root, absolutePath);
    files.push(file);

    if (file.endsWith(".json")) {
      readJsonConfig(file, raw, permissions, hooks, mcpServers);
      continue;
    }
    if (file.endsWith(".md") || file === ".cursorrules" || file.startsWith(".cursor/")) {
      readInstructionProse(file, raw, instructions);
      continue;
    }
    // Anything else under `.claude/hooks/` is an executable hook script.
    if (file.startsWith(".claude/hooks/")) {
      readHookScript(file, raw, hooks);
    }
  }

  return {
    permissions: permissions.sort(compareLocated),
    hooks: hooks.sort(compareLocated),
    mcpServers: mcpServers.sort(compareLocated),
    instructions: instructions.sort(compareLocated),
    files: files.sort(),
  };
}

/* ------------------------------------------------------------------ *
 * JSON settings
 * ------------------------------------------------------------------ */

function readJsonConfig(
  file: string,
  raw: string,
  permissions: AgentPermissionRule[],
  hooks: AgentHook[],
  mcpServers: AgentMcpServer[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A settings file that doesn't parse configures nothing. Silence is
    // the right answer, not a finding about the JSON.
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const root = parsed as Record<string, unknown>;
  const lines = raw.split(/\r?\n/);
  const platform: AgentPlatform = file === ".mcp.json" ? "mcp" : "claude";

  // `permissions: { allow: [...], deny: [...], ask: [...] }`
  const perms = root.permissions;
  if (typeof perms === "object" && perms !== null) {
    for (const [bucket, value] of Object.entries(perms as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      for (const rule of value) {
        if (typeof rule !== "string") continue;
        permissions.push({
          file,
          platform,
          bucket,
          rule,
          line: findLine(lines, rule),
        });
      }
    }
  }

  collectHooksTree(root.hooks, file, platform, lines, hooks, undefined, 0);

  const servers = root.mcpServers;
  if (typeof servers === "object" && servers !== null) {
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      const command = typeof entry.command === "string" ? entry.command : "";
      const args = Array.isArray(entry.args)
        ? entry.args.filter((a): a is string => typeof a === "string")
        : [];
      const env = entry.env;
      const envNames =
        typeof env === "object" && env !== null && !Array.isArray(env)
          ? Object.keys(env as Record<string, unknown>).sort()
          : [];
      mcpServers.push({
        file,
        name,
        command: [command, ...args].filter((p) => p.length > 0).join(" "),
        line: findLine(lines, name),
        envNames,
      });
    }
  }
}

/**
 * Walk the `hooks` tree.
 *
 * The shape varies by version — an object keyed by event name, holding
 * arrays of matcher objects, each holding an array of hook entries with a
 * `command`. Rather than pin one revision, the walk descends generically
 * and records every `command` string it finds, remembering the nearest
 * enclosing key as the event name.
 */
function collectHooksTree(
  node: unknown,
  file: string,
  platform: AgentPlatform,
  lines: string[],
  out: AgentHook[],
  event: string | undefined,
  depth: number,
): void {
  if (depth > 8 || out.length >= 200) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectHooksTree(item, file, platform, lines, out, event, depth + 1);
    }
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const record = node as Record<string, unknown>;
  const command = record.command;
  if (typeof command === "string" && command.length > 0) {
    out.push({
      file,
      platform,
      command,
      line: findLine(lines, command),
      ...(event !== undefined ? { event } : {}),
    });
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "command") continue;
    // A key that looks like an event name (PascalCase) becomes the event
    // for everything below it.
    const nextEvent = /^[A-Z][A-Za-z]+$/.test(key) ? key : event;
    collectHooksTree(value, file, platform, lines, out, nextEvent, depth + 1);
  }
}

/** A shell script committed under `.claude/hooks/`. */
function readHookScript(file: string, raw: string, out: AgentHook[]): void {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    out.push({
      file,
      platform: "claude",
      command: line,
      line: i + 1,
      event: "script",
    });
  }
}

/* ------------------------------------------------------------------ *
 * Instruction prose
 * ------------------------------------------------------------------ */

/**
 * Prose directives that try to change an agent's behaviour in ways a
 * reviewer would want to know about.
 *
 * These are **advisory only**. A sentence is not an execution path, and
 * a repo may have entirely legitimate reasons to say "skip the slow
 * tests". The detector reports these at low confidence and says so.
 */
const INSTRUCTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  {
    id: "override_higher_instructions",
    re: /\b(ignore|disregard|override|bypass|do not follow)\b[^.\n]{0,60}\b(previous|prior|earlier|higher|system|above|global|user)\b[^.\n]{0,40}\b(instruction|prompt|rule|guideline|direction)s?\b/i,
  },
  {
    id: "disable_verification",
    re: /\b(skip|disable|bypass|do not run|don't run|never run|avoid running)\b[^.\n]{0,40}\b(test|tests|typecheck|type check|lint|linting|verification|verify|ci|check|checks)\b/i,
  },
  {
    id: "expose_secrets",
    re: /\b(print|echo|output|reveal|show|dump|log|send|share|paste|upload)\b[^.\n]{0,40}\b(secret|secrets|credential|credentials|api[ _-]?key|token|password|\.env|environment variable)s?\b/i,
  },
  {
    id: "edit_outside_repo",
    re: /\b(edit|modify|write|change|update|delete|remove)\b[^.\n]{0,50}\b(outside|beyond|other than)\b[^.\n]{0,30}\b(repo|repository|project|directory|workspace)\b/i,
  },
  {
    id: "unattended_push",
    re: /\b(always|automatically|without asking|no need to ask|do not ask|don't ask)\b[^.\n]{0,50}\b(push|publish|deploy|force[ -]?push|commit and push|merge)\b/i,
  },
];

function readInstructionProse(file: string, raw: string, out: AgentInstruction[]): void {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < 100; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    for (const { id, re } of INSTRUCTION_PATTERNS) {
      if (!re.test(line)) continue;
      out.push({
        file,
        text: condense(line),
        line: i + 1,
        pattern: id,
      });
      // One finding per line: a sentence matching two patterns is still
      // one sentence.
      break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

/**
 * Mask anything token-shaped before a fragment reaches `Finding.evidence`.
 *
 * Applied to every quoted command and rule. The list is not a claim to
 * catch every secret format — it is a floor, backed by the stronger rule
 * that evidence quotes the *shape* of a command rather than its
 * arguments wherever possible.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // `KEY=value`, `--token value`, `Authorization: Bearer xyz`
      .replace(
        /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*=\s*\S+/g,
        "$1=<redacted>",
      )
      .replace(
        /(--?(?:token|key|secret|password|auth|api[-_]?key)[= ])\S+/gi,
        "$1<redacted>",
      )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
      // Common provider token prefixes.
      .replace(
        /\b(sk|pk|ghp|gho|ghs|ghu|ghr|xox[abposr])[-_][A-Za-z0-9_-]{8,}/g,
        "<redacted-token>",
      )
      // Long opaque base64-ish runs.
      .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<redacted>")
  );
}

/** Condense to one line and cap length, then redact. */
export function quoteFragment(text: string, maxLength = 120): string {
  return condense(redactSecrets(text), maxLength);
}

function condense(text: string, maxLength = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}

function findLine(lines: string[], needle: string): number {
  const probe = needle.length > 60 ? needle.slice(0, 60) : needle;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(probe)) return i + 1;
  }
  return 1;
}

function compareLocated<T extends { file: string; line: number }>(a: T, b: T): number {
  return a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);
}

function toRepoPath(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? relative(root, abs) : abs;
  return rel.split(sep).join("/");
}
