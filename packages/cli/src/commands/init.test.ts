import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@crimes/core";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "..", "dist", "index.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "number") {
          resolvePromise({ stdout, stderr, exitCode: error.code });
          return;
        }
        if (error && (error as NodeJS.ErrnoException).code !== undefined) {
          resolvePromise({
            stdout,
            stderr: `${stderr}\nspawn error: ${error.message}`,
            exitCode: -1,
          });
          return;
        }
        resolvePromise({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

describe("crimes init", () => {
  it("writes crimes.config.json when none exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init"], root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Wrote crimes.config.json");
    expect(existsSync(join(root, "crimes.config.json"))).toBe(true);
  });

  it("refuses to overwrite without --force (exit 2)", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    writeFileSync(join(root, "crimes.config.json"), `{ "include": ["custom"] }`);

    const result = await runCli(["init"], root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("already exists");
    // File contents unchanged.
    const raw = readFileSync(join(root, "crimes.config.json"), "utf8");
    expect(raw).toBe(`{ "include": ["custom"] }`);
  });

  it("--force overwrites the existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    writeFileSync(join(root, "crimes.config.json"), `{ "include": ["custom"] }`);

    const result = await runCli(["init", "--force"], root);

    expect(result.exitCode).toBe(0);
    const raw = readFileSync(join(root, "crimes.config.json"), "utf8");
    expect(raw).toContain("$schema");
  });

  it("written file passes loadConfig validation (round-trip)", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init"], root);
    expect(result.exitCode).toBe(0);

    // Should not throw.
    const config = loadConfig(root);
    expect(config.include?.[0]).toContain("ts");
  });

  it("--agent-skill writes a Claude Code skill file", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--agent-skill"], root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".claude/skills/crimes/SKILL.md");
    const skillPath = join(root, ".claude", "skills", "crimes", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const raw = readFileSync(skillPath, "utf8");
    expect(raw).toContain("name: crimes-codebase-risk");
  });

  it("--codex-skill writes a Codex skill file", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--codex-skill"], root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".agents/skills/crimes/SKILL.md");
    const skillPath = join(root, ".agents", "skills", "crimes", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const raw = readFileSync(skillPath, "utf8");
    expect(raw).toContain("name: crimes-codebase-risk");
  });

  it("--agents writes Claude Code and Codex skill files", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--agents"], root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".claude/skills/crimes/SKILL.md");
    expect(result.stdout).toContain(".agents/skills/crimes/SKILL.md");
    expect(existsSync(join(root, ".claude", "skills", "crimes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "crimes", "SKILL.md"))).toBe(true);
  });

  it("--agents keeps an existing config while adding missing skill files", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    writeFileSync(join(root, "crimes.config.json"), `{ "include": ["custom"] }`);

    const result = await runCli(["init", "--agents"], root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Kept existing crimes.config.json");
    expect(readFileSync(join(root, "crimes.config.json"), "utf8")).toBe(
      `{ "include": ["custom"] }`,
    );
    expect(existsSync(join(root, ".claude", "skills", "crimes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "crimes", "SKILL.md"))).toBe(true);
  });

  it("--agent-skill refuses to overwrite an existing skill without --force", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const skillPath = join(root, ".claude", "skills", "crimes", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "custom skill", { encoding: "utf8", flag: "w" });

    const result = await runCli(["init", "--agent-skill"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("already exists");
    expect(readFileSync(skillPath, "utf8")).toBe("custom skill");
  });

  it("--codex-skill refuses to overwrite an existing skill without --force", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const skillPath = join(root, ".agents", "skills", "crimes", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "custom skill", { encoding: "utf8", flag: "w" });

    const result = await runCli(["init", "--codex-skill"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("already exists");
    expect(readFileSync(skillPath, "utf8")).toBe("custom skill");
  });

  it("--agent-skill --force overwrites an existing skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const skillPath = join(root, ".claude", "skills", "crimes", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(join(root, "crimes.config.json"), `{ "include": ["custom"] }`);
    writeFileSync(skillPath, "custom skill", { encoding: "utf8", flag: "w" });

    const result = await runCli(["init", "--agent-skill", "--force"], root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(skillPath, "utf8")).not.toBe("custom skill");
  });

  it("--codex-skill --force overwrites an existing skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const skillPath = join(root, ".agents", "skills", "crimes", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(join(root, "crimes.config.json"), `{ "include": ["custom"] }`);
    writeFileSync(skillPath, "custom skill", { encoding: "utf8", flag: "w" });

    const result = await runCli(["init", "--codex-skill", "--force"], root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(skillPath, "utf8")).not.toBe("custom skill");
  });

  it("--agents writes .claude/settings.local.json with a crimes PreToolUse hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--agents"], root);

    expect(result.exitCode).toBe(0);
    const settingsPath = join(root, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Edit|Write|NotebookEdit");
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("crimes hook");
  });

  it("--agents installs a skill without an inert Codex settings file", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--agents"], root);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, ".agents", "skills", "crimes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "settings.local.json"))).toBe(false);
  });

  it("--no-hooks skips both settings.local.json writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--agents", "--no-hooks"], root);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(join(root, ".agents", "settings.local.json"))).toBe(false);
    // SKILL.md files should still be written.
    expect(existsSync(join(root, ".claude", "skills", "crimes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "crimes", "SKILL.md"))).toBe(true);
  });

  it("--agents merges into existing .claude/settings.local.json without losing other hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const settingsPath = join(root, ".claude", "settings.local.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["bash"] },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "echo hello" }],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runCli(["init", "--agents"], root);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(parsed.permissions).toEqual({ allow: ["bash"] });
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(parsed.hooks.PreToolUse[1].matcher).toBe("Edit|Write|NotebookEdit");
  });

  it("--agents is idempotent — second run does not duplicate the crimes hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const first = await runCli(["init", "--agents"], root);
    expect(first.exitCode).toBe(0);

    const second = await runCli(["init", "--agents", "--force"], root);
    expect(second.exitCode).toBe(0);

    const settingsPath = join(root, ".claude", "settings.local.json");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    const crimesEntries = parsed.hooks.PreToolUse.filter(
      (entry: { hooks: Array<{ command: string }> }) =>
        entry.hooks.some(
          (h) =>
            h.command.includes("crimes hook") || h.command.includes("crimes context"),
        ),
    );
    expect(crimesEntries).toHaveLength(1);
  });

  it("--agents refuses to modify a malformed .claude/settings.local.json without --force", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const settingsPath = join(root, ".claude", "settings.local.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ not valid json", "utf8");

    const result = await runCli(["init", "--agents"], root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("malformed");
    // File untouched.
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not valid json");
  });

  it("--agents --force overwrites a malformed .claude/settings.local.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const settingsPath = join(root, ".claude", "settings.local.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ not valid json", "utf8");

    const result = await runCli(["init", "--agents", "--force"], root);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Edit|Write|NotebookEdit");
  });

  it("--codex-skill writes no speculative hook settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--codex-skill"], root);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, ".agents", "settings.local.json"))).toBe(false);
    expect(existsSync(join(root, ".claude", "settings.local.json"))).toBe(false);
  });

  it("installs the same maintained workflow for both hosts", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-init-"));
    const result = await runCli(["init", "--agents"], root);
    expect(result.exitCode).toBe(0);
    const installed = readFileSync(
      join(root, ".agents", "skills", "crimes", "SKILL.md"),
      "utf8",
    );
    expect(
      readFileSync(join(root, ".claude", "skills", "crimes", "SKILL.md"), "utf8"),
    ).toBe(installed);
    expect(installed).toBe(
      readFileSync(resolve(here, "../../../../.agents/skills/crimes/SKILL.md"), "utf8"),
    );
  });
});
