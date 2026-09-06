import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectSkill, skillDiff } from "./inspect.js";
import { AGENT_SKILL_TEXT, managedSkill } from "./template.js";

describe("managed skill identity", () => {
  it.each(["0.27.0", "0.28.0"])("recognizes the published %s template", (version) => {
    const text = readFileSync(
      new URL(`./fixtures/v${version}.md`, import.meta.url),
      "utf8",
    );
    expect(inspectSkill(text)).toEqual({ status: "outdated", version });
    expect(inspectSkill(text + "\nProject customization\n").status).toBe("customized");
  });

  it("recognizes current skills and a checkout with CRLF line endings", () => {
    expect(inspectSkill(AGENT_SKILL_TEXT).status).toBe("current");
    expect(inspectSkill(AGENT_SKILL_TEXT.replaceAll("\n", "\r\n")).status).toBe(
      "current",
    );
  });

  it("updates intact older managed copies and protects edited copies", () => {
    const old = managedSkill("Old workflow\n", "0.28.0");
    expect(inspectSkill(old)).toEqual({ status: "outdated", version: "0.28.0" });
    expect(inspectSkill(old.replace("Old workflow", "My workflow")).status).toBe(
      "customized",
    );
    expect(inspectSkill(old.replace('"format":1', '"format":2')).status).toBe(
      "customized",
    );
    expect(inspectSkill(old.replace('"sha256":', '"broken":')).status).toBe("customized");
  });

  it("protects a newer installed template from accidental downgrade", () => {
    expect(inspectSkill(managedSkill("Future workflow\n", "0.29.0"))).toEqual({
      status: "newer",
      version: "0.29.0",
    });
  });

  it("does not adopt a customized file just because it resembles the template", () => {
    expect(
      inspectSkill(
        AGENT_SKILL_TEXT.replace("follow its AGENTS.md", "ignore its AGENTS.md"),
      ).status,
    ).toBe("customized");
    expect(inspectSkill("User-authored skill\n").status).toBe("customized");
    expect(inspectSkill(undefined).status).toBe("missing");
  });

  it("shows installed and proposed changes with surrounding context", () => {
    const diff = skillDiff(
      "SKILL.md",
      "same\nmy policy\nsuffix\n",
      "same\nnew policy\nsuffix\n",
    );
    expect(diff).toContain(" same\n-my policy\n+new policy\n suffix");
  });
});
