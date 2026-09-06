import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { commandProjectRoot, maintainProjectSkills } from "./lifecycle.js";
import {
  AGENT_SKILL_TEXT,
  managedSkill,
  SKILL_PATHS,
  SKILL_VERSION,
} from "./template.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "crimes-lifecycle-"));
  roots.push(root);
  return root;
}
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function maintain(root: string, interactive = true): string {
  let output = "";
  maintainProjectSkills({
    root,
    interactive,
    write: (message) => {
      output += message;
    },
  });
  return output;
}
const old = managedSkill("Older workflow\n", "0.28.1");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ordinary-use skill lifecycle", () => {
  it("refreshes intact skills, preserves config/hooks, and is silent when current", () => {
    const root = fixture();
    write(root, SKILL_PATHS.codex, old);
    write(root, "crimes.config.json", "custom config bytes");
    write(root, ".claude/settings.local.json", '{"permissions": {"allow": ["Read"]}}');
    expect(maintain(root)).toContain("refreshed agent skills");
    expect(readFileSync(join(root, SKILL_PATHS.codex), "utf8")).toBe(AGENT_SKILL_TEXT);
    expect(readFileSync(join(root, "crimes.config.json"), "utf8")).toBe(
      "custom config bytes",
    );
    expect(readFileSync(join(root, ".claude/settings.local.json"), "utf8")).toContain(
      '"allow": ["Read"]',
    );
    expect(maintain(root)).toBe("");
  });
  it("does not write in an agent or piped invocation but supplies the update action", () => {
    const root = fixture();
    write(root, SKILL_PATHS.claude, old);
    expect(maintain(root, false)).toContain("crimes init --refresh-skills");
    expect(readFileSync(join(root, SKILL_PATHS.claude), "utf8")).toBe(old);
  });
  it("preserves a custom host while refreshing an independent generated host", () => {
    const root = fixture();
    const custom = old.replace("Older workflow", "Team policy");
    write(root, SKILL_PATHS.codex, custom);
    write(root, SKILL_PATHS.claude, old);
    expect(maintain(root)).toContain("customized agent skills preserved");
    expect(readFileSync(join(root, SKILL_PATHS.codex), "utf8")).toBe(custom);
    expect(readFileSync(join(root, SKILL_PATHS.claude), "utf8")).toBe(AGENT_SKILL_TEXT);
  });
  it("does not nag about a current customized template or downgrade newer skills", () => {
    const root = fixture();
    const custom = managedSkill("Team policy\n", SKILL_VERSION).replace(
      "Team policy",
      "Edited policy",
    );
    const future = managedSkill("Future workflow\n", "99.0.0");
    write(root, SKILL_PATHS.codex, custom);
    write(root, SKILL_PATHS.claude, future);
    expect(maintain(root)).toBe("");
    expect(readFileSync(join(root, SKILL_PATHS.codex), "utf8")).toBe(custom);
    expect(readFileSync(join(root, SKILL_PATHS.claude), "utf8")).toBe(future);
  });
  it("never installs missing skills and refuses symlinked copies without failing the report", () => {
    const root = fixture();
    expect(maintain(root)).toBe("");
    write(root, "shared.md", old);
    mkdirSync(dirname(join(root, SKILL_PATHS.codex)), { recursive: true });
    symlinkSync(join(root, "shared.md"), join(root, SKILL_PATHS.codex));
    expect(maintain(root)).toContain("skill refresh skipped");
    expect(readFileSync(join(root, "shared.md"), "utf8")).toBe(old);
  });
  it("surfaces a legacy executable hook for explicit setup without changing settings", () => {
    const root = fixture();
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "npx -y crimes hook --format compact || true",
                timeout: 8000,
              },
            ],
          },
        ],
      },
    });
    write(root, ".claude/settings.local.json", settings);
    expect(maintain(root)).toContain("crimes init --agent-skill");
    expect(readFileSync(join(root, ".claude/settings.local.json"), "utf8")).toBe(
      settings,
    );
  });
});

describe("integration root selection", () => {
  function command(name: string, args: string[] = []): Command {
    const cmd = new Command(name)
      .argument("[path]")
      .option("--root <path>")
      .action(() => {});
    cmd.parse(args, { from: "user" });
    return cmd;
  }
  it("uses the scanned repository, including invocation from a workspace package", async () => {
    const root = fixture();
    mkdirSync(join(root, ".git"));
    write(root, SKILL_PATHS.codex, old);
    write(root, "packages/app/package.json", "{}");
    expect(await commandProjectRoot(command("scan"), join(root, "packages/app"))).toBe(
      root,
    );
    expect(await commandProjectRoot(command("scan", [root]), fixture())).toBe(root);
  });
  it("respects a nested git boundary and external explicit context root", async () => {
    const root = fixture();
    write(root, SKILL_PATHS.codex, old);
    mkdirSync(join(root, "nested/.git"), { recursive: true });
    expect(await commandProjectRoot(command("scan"), join(root, "nested"))).toBe(
      join(root, "nested"),
    );
    const external = fixture();
    write(external, "src.ts", "export const value = 1;");
    expect(
      await commandProjectRoot(command("context", ["src.ts", "--root", external]), root),
    ).toBe(external);
  });
  it("does not run maintenance for setup, hooks, or stored-report explanations", async () => {
    const root = fixture();
    for (const name of ["init", "hook", "feedback", "save", "migrate-pins"]) {
      expect(await commandProjectRoot(command(name), root)).toBeUndefined();
    }
    const explain = new Command("explain").option("--from <path>").action(() => {});
    explain.parse(["--from", "stored.json"], { from: "user" });
    expect(await commandProjectRoot(explain, root)).toBeUndefined();
  });
});
