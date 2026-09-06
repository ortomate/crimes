import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findNearestPackageRoot } from "@crimes/core";
import type { Command } from "commander";
import { isLegacyCrimesHook } from "../hook-templates.js";
import { applySetupFiles, readSetupFile, type SetupFile } from "../setup-files.js";
import { inspectSkill } from "./inspect.js";
import { AGENT_SKILL_TEXT, SKILL_PATHS, SKILL_VERSION } from "./template.js";

/** Follow the command's target, never an unrelated launch directory. */
export async function commandProjectRoot(
  command: Command,
  cwd: string,
): Promise<string | undefined> {
  const name = command.name();
  const options = command.opts<{ root?: string; from?: string }>();
  let start: string;
  if (
    ["scan", "hotspots"].includes(name) ||
    (name === "check" && command.parent?.name() === "baseline")
  ) {
    start = resolve(cwd, command.args[0] ?? ".");
  } else if (name === "context") {
    const lookup = resolve(cwd, options.root ?? ".");
    const file = resolve(lookup, command.args[0] ?? ".");
    if (!existsSync(file)) return undefined;
    start = options.root
      ? lookup
      : ((await findNearestPackageRoot(dirname(file))) ?? cwd);
  } else if (["diff", "verdict"].includes(name)) {
    start = resolve(cwd, options.root ?? ".");
  } else if (name === "crimes" || (name === "explain" && !options.from)) {
    start = cwd;
  } else {
    return undefined;
  }
  if (!existsSync(start) || !statSync(start).isDirectory()) return undefined;
  // Inside a git checkout, host skills can live above a workspace package.
  // Outside git, stop at the command's package root; never adopt home skills.
  let cursor = start;
  let nearestSkills: string | undefined;
  let packageRoot: string | undefined;
  while (cursor !== dirname(cursor) && cursor !== homedir()) {
    if (Object.values(SKILL_PATHS).some((path) => existsSync(join(cursor, path)))) {
      nearestSkills ??= cursor;
    }
    if (existsSync(join(cursor, ".git"))) return nearestSkills ?? cursor;
    if (
      [
        "package.json",
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "crimes.config.json",
      ].some((marker) => existsSync(join(cursor, marker)))
    )
      packageRoot ??= cursor;
    cursor = dirname(cursor);
  }
  return packageRoot ?? start;
}

interface LifecycleOptions {
  root: string;
  interactive: boolean;
  write: (message: string) => void;
}

/** Offline, advisory maintenance. Never install missing skills or modify hooks. */
export function maintainProjectSkills({
  root,
  interactive,
  write,
}: LifecycleOptions): void {
  const updates: SetupFile[] = [];
  const review: string[] = [];
  try {
    for (const path of Object.values(SKILL_PATHS)) {
      const before = readSetupFile(root, path);
      const state = inspectSkill(before);
      if (state.status === "outdated")
        updates.push({ path, before, after: AGENT_SKILL_TEXT });
      if (state.status === "customized" && state.version !== SKILL_VERSION)
        review.push(path);
    }
    if (updates.length > 0 && interactive) {
      applySetupFiles(root, updates);
      write(
        `crimes: refreshed agent skills to template ${SKILL_VERSION} in ${root}: ${updates.map((file) => file.path).join(", ")}. Review and commit the updated files.\n`,
      );
    } else if (updates.length > 0) {
      write(
        `crimes: agent skills are outdated in ${root}; run crimes init --refresh-skills there.\n`,
      );
    }
    if (review.length > 0) {
      write(
        `crimes: customized agent skills preserved in ${root}: ${review.join(", ")}. Run crimes init --refresh-skills --check there to review template ${SKILL_VERSION}.\n`,
      );
    }
  } catch (error) {
    write(
      `crimes: skill refresh skipped in ${root} (${error instanceof Error ? error.message : String(error)}). Review with crimes init --refresh-skills --check.\n`,
    );
  }
  noticeLegacyHook(root, write);
}

function noticeLegacyHook(root: string, write: LifecycleOptions["write"]): void {
  try {
    const text = readSetupFile(root, ".claude/settings.local.json");
    if (!text) return;
    const settings = JSON.parse(text);
    // Only notify about recognized old hooks, not absent or unrelated hooks.
    if (
      settings.hooks?.PreToolUse?.some(
        (entry: { hooks?: Array<{ command?: unknown }> }) =>
          entry.hooks?.some(isLegacyCrimesHook),
      )
    ) {
      write(
        `crimes: Claude hook setup is outdated in ${root}; run crimes init --agent-skill there to update it. Hook settings were preserved.\n`,
      );
    }
  } catch {
    // An advisory skill check must not interpret or repair unrelated settings.
  }
}
