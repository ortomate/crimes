import { mergeClaudeHook, serializeClaudeSettings } from "../hook-templates.js";
import { generateConfig } from "../init-detect.js";
import { readSetupFile, type SetupFile } from "../setup-files.js";
import { inspectSkill, type SkillState } from "./inspect.js";
import { AGENT_SKILL_TEXT, SKILL_PATHS } from "./template.js";

export interface InitOptions {
  agents: boolean;
  agentSkill: boolean;
  codexSkill: boolean;
  refreshSkills: boolean;
  check: boolean;
  force: boolean;
  detect: boolean;
  hooks: boolean;
}

export interface PlannedSkill extends SkillState {
  file: SetupFile;
  conflict: boolean;
}

export interface SetupPlan {
  files: SetupFile[];
  skills: PlannedSkill[];
  keptConfig: boolean;
}

function skillTargets(root: string, options: InitOptions): string[] {
  if (options.agents) return Object.values(SKILL_PATHS);
  const targets: string[] = [];
  if (options.agentSkill) targets.push(SKILL_PATHS.claude);
  if (options.codexSkill) targets.push(SKILL_PATHS.codex);
  if (targets.length > 0 || !options.refreshSkills) return targets;
  return Object.values(SKILL_PATHS).filter(
    (path) => readSetupFile(root, path) !== undefined,
  );
}

function planSkill(root: string, path: string, force: boolean): PlannedSkill {
  const before = readSetupFile(root, path);
  const state = inspectSkill(before);
  return {
    ...state,
    file: { path, before, after: AGENT_SKILL_TEXT },
    conflict: !force && (state.status === "customized" || state.status === "newer"),
  };
}

function planClaudeHook(root: string): SetupFile | undefined {
  const path = ".claude/settings.local.json";
  const before = readSetupFile(root, path);
  try {
    const existing = before === undefined ? undefined : JSON.parse(before);
    const merged = mergeClaudeHook(existing);
    if (merged.action === "skipped") return undefined;
    return { path, before, after: serializeClaudeSettings(merged.document) };
  } catch {
    throw new Error(
      `${path} is malformed or has an unexpected shape; repair it before setup, or use --no-hooks. No files were written.`,
    );
  }
}

export async function planSetup(root: string, options: InitOptions): Promise<SetupPlan> {
  if (options.check && (!options.refreshSkills || options.force)) {
    throw new Error(
      "--check requires --refresh-skills and cannot be combined with --force",
    );
  }
  const targets = skillTargets(root, options);
  if (options.refreshSkills && targets.length === 0) {
    throw new Error(
      "No project skills found. Use init --refresh-skills --agents to install both hosts, or select --agent-skill / --codex-skill.",
    );
  }
  const skills = targets.map((path) => planSkill(root, path, options.force));
  const files = skills
    .filter((skill) => skill.status !== "current")
    .map((skill) => skill.file);
  let keptConfig = false;
  if (!options.refreshSkills) {
    const path = "crimes.config.json";
    const before = readSetupFile(root, path);
    // --force with agents only replaces skills. Resetting config is a separate
    // explicit operation: init --force, without any agent-selection flags.
    keptConfig = before !== undefined && (targets.length > 0 || !options.force);
    if (!keptConfig) {
      const after = await generateConfig({ root, detect: options.detect });
      files.unshift({ path, before, after });
    }
    if (targets.includes(SKILL_PATHS.claude) && options.hooks !== false) {
      const hook = planClaudeHook(root);
      if (hook) files.push(hook);
    }
  }
  return { files, skills, keptConfig };
}
