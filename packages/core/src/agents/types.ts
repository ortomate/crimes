/**
 * Repository-local agent configuration inventory.
 *
 * Consumed by `agent_permission_sprawl`. The subject is the repo's *own*
 * committed agent configuration — the settings, hooks, and instruction
 * files that any agent opening this checkout will load and act on.
 *
 * Two hard rules govern everything in this module:
 *
 *  1. **Nothing here is ever executed.** Hook commands are read as text.
 *     A tool that ran a repo's hooks in order to analyse them would be a
 *     remote code execution vector wearing a linter costume.
 *  2. **Values are redacted, names are not.** Evidence quotes the minimal
 *     fragment needed to explain a permission or an execution path, with
 *     anything token-shaped masked. See `redactSecrets` in `build.ts`.
 */

/** Which agent toolchain a configuration file belongs to. */
export type AgentPlatform = "claude" | "codex" | "cursor" | "mcp" | "generic";

/** What kind of artefact a finding is anchored on. */
export type AgentArtefactKind =
  | "permission_rule"
  | "hook_command"
  | "mcp_server"
  | "instruction_prose";

/** One permission rule granted by a settings file. */
export interface AgentPermissionRule {
  file: string;
  platform: AgentPlatform;
  /** `allow` / `deny` / `ask` bucket the rule was listed under. */
  bucket: string;
  /** Rule text as written, e.g. `Bash(*)`. */
  rule: string;
  line: number;
}

/** One executable hook the repo registers. */
export interface AgentHook {
  file: string;
  platform: AgentPlatform;
  /** Event the hook fires on, when the format names one. */
  event?: string;
  /** Command text as written. Never executed. */
  command: string;
  line: number;
}

/** One MCP server the repo configures. */
export interface AgentMcpServer {
  file: string;
  name: string;
  /** Launch command as written. */
  command: string;
  line: number;
  /** Environment variable names passed through. Values are never read. */
  envNames: string[];
}

/** One prose directive found in an agent instruction file. */
export interface AgentInstruction {
  file: string;
  /** The matched sentence, condensed. */
  text: string;
  line: number;
  /** Stable id of the pattern that matched. */
  pattern: string;
}

export interface AgentConfigIndex {
  permissions: AgentPermissionRule[];
  hooks: AgentHook[];
  mcpServers: AgentMcpServer[];
  instructions: AgentInstruction[];
  /** Every agent-configuration file inspected, sorted. */
  files: string[];
}
