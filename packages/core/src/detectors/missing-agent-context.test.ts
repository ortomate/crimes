import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import type {
  IaAgentInventory,
  IaFileSignals,
  IaIndex,
} from "../ia/types.js";
import { missingAgentContextDetector } from "./missing-agent-context.js";

function makeIndex(args: {
  agent?: Partial<IaAgentInventory>;
  files?: string[];
}): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  for (const f of args.files ?? ["src/a.ts"]) {
    files[f] = {
      file: f,
      tokens: [],
      routes: [],
      labels: [],
      navEntries: [],
      permissions: [],
      isNavSource: false,
    };
  }
  return {
    root: "/tmp/repo",
    files,
    routes: [],
    navSources: [],
    docs: [],
    agentContext: {
      agentsMdPath: undefined,
      claudeMdPath: undefined,
      claudeSkills: [],
      declaredBins: ["mycli"],
      referencedCommands: [],
      ...(args.agent ?? {}),
    },
    aliasGroups: [],
  };
}

function makeCtx(file: string, ia?: IaIndex): UniversalDetectorContext {
  return {
    kind: "universal",
    file,
    absolutePath: `/tmp/${file}`,
    extension: file.match(/\.[^./]+$/)?.[0] ?? "",
    byteSize: 0,
    readSource: async () => "",
    get lineCount() {
      return 1;
    },
    config: DEFAULT_CONFIG,
    ia,
  };
}

describe("missingAgentContextDetector", () => {
  it("returns nothing when ctx.ia is absent", async () => {
    const findings = await missingAgentContextDetector.run(makeCtx("src/a.ts"));
    expect(findings).toEqual([]);
  });

  it("fires when no agent context files are present (and a bin is declared)", async () => {
    const ia = makeIndex({ files: ["src/a.ts"] });
    const findings = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("missing_agent_context");
    expect(findings[0]!.charge).toBe("Missing Agent Context");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.confidence).toBe(0.9);
    // Anchored on the lex-first source file -- the finding's subject is the
    // absent AGENTS.md but the `file` field has to be a real path.
    expect(findings[0]!.file).toBe("src/a.ts");
    expect(findings[0]!.evidence.join(" ")).toContain("AGENTS.md");
    expect(findings[0]!.evidence.join(" ")).toContain("mycli");
  });

  it("does not fire when no bin is declared (library/fixture path)", async () => {
    const ia = makeIndex({ agent: { declaredBins: [] } });
    const findings = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    expect(findings).toEqual([]);
  });

  it("suppresses when AGENTS.md is present", async () => {
    const ia = makeIndex({
      agent: { agentsMdPath: "AGENTS.md" },
    });
    const findings = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    expect(findings).toEqual([]);
  });

  it("suppresses when CLAUDE.md is present", async () => {
    const ia = makeIndex({
      agent: { claudeMdPath: "CLAUDE.md" },
    });
    const findings = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    expect(findings).toEqual([]);
  });

  it("suppresses when a Claude skill is present", async () => {
    const ia = makeIndex({
      agent: { claudeSkills: [".claude/skills/example/SKILL.md"] },
    });
    const findings = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    expect(findings).toEqual([]);
  });

  it("suppresses when a Codex skill is present", async () => {
    const ia = makeIndex({
      agent: { codexSkills: [".agents/skills/example/SKILL.md"] },
    });
    const findings = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    expect(findings).toEqual([]);
  });

  it("fires only on the lexicographically first file (single emission per scan)", async () => {
    const ia = makeIndex({ files: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    const first = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    const second = await missingAgentContextDetector.run(
      makeCtx("src/b.ts", ia),
    );
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("lists declared bins in evidence", async () => {
    const ia = makeIndex({ agent: { declaredBins: ["mycli", "mytool"] } });
    const findings = await missingAgentContextDetector.run(
      makeCtx("src/a.ts", ia),
    );
    expect(findings[0]!.evidence.join(" ")).toContain("mycli");
    expect(findings[0]!.evidence.join(" ")).toContain("mytool");
  });
});
