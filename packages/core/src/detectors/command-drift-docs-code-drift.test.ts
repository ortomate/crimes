import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import type {
  IaAgentInventory,
  IaDocSignal,
  IaFileSignals,
  IaIndex,
} from "../ia/types.js";
import { commandDriftDocsCodeDriftDetector as _commandDriftDocsCodeDriftDetector } from "./command-drift-docs-code-drift.js";
const commandDriftDocsCodeDriftDetector = _commandDriftDocsCodeDriftDetector as LanguageJsDetector;

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-cmd-drift-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

function buildIndex(args: {
  root: string;
  agentContext: IaAgentInventory;
  docs: IaDocSignal[];
}): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  for (const doc of args.docs) {
    files[doc.file] = {
      file: doc.file,
      tokens: [],
      componentName: undefined,
      routes: [],
      labels: [],
      navEntries: [],
      permissions: [],
      isNavSource: false,
    };
  }
  return {
    root: args.root,
    files,
    routes: [],
    navSources: [],
    docs: args.docs,
    agentContext: args.agentContext,
    aliasGroups: [],
  };
}

function ctxFor(file: string, ia: IaIndex): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `${ia.root}/${file}`,
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    ia,
  };
}

describe("commandDriftDocsCodeDriftDetector", () => {
  it("fires when a doc references a subcommand the bin no longer advertises", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "crimes",
        bin: { crimes: "dist/index.js" },
      }),
      "dist/index.js": `program.command("scan").command("context").command("hotspots")`,
    });
    const ia = buildIndex({
      root,
      agentContext: {
        agentsMdPath: "AGENTS.md",
        claudeMdPath: undefined,
        claudeSkills: [],
        declaredBins: ["crimes"],
        referencedCommands: [],
      },
      docs: [
        {
          file: "docs/agent-usage.md",
          headings: [],
          fencedCommands: [
            { command: "crimes ask", line: 42, deferred: false },
          ],
          links: [],
        },
      ],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await commandDriftDocsCodeDriftDetector.run(
      ctxFor(anchor, ia),
    );
    const drift = findings.find((f) => f.type === "command_drift_docs_code_drift");
    expect(drift).toBeDefined();
    expect(drift!.evidence.some((e) => e.includes("crimes ask"))).toBe(true);
    expect(drift!.evidence.some((e) => e.includes("advertised:"))).toBe(true);
  });

  it("does not fire when every referenced command exists in the bin", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "crimes",
        bin: { crimes: "dist/index.js" },
      }),
      "dist/index.js": `program.command("scan")`,
    });
    const ia = buildIndex({
      root,
      agentContext: {
        agentsMdPath: undefined,
        claudeMdPath: undefined,
        claudeSkills: [],
        declaredBins: ["crimes"],
        referencedCommands: [],
      },
      docs: [
        {
          file: "docs/agent-usage.md",
          headings: [],
          fencedCommands: [
            { command: "crimes scan", line: 1, deferred: false },
          ],
          links: [],
        },
      ],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await commandDriftDocsCodeDriftDetector.run(
      ctxFor(anchor, ia),
    );
    expect(findings).toEqual([]);
  });

  it("skips deferred fenced commands", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "crimes",
        bin: { crimes: "dist/index.js" },
      }),
      "dist/index.js": `program.command("scan")`,
    });
    const ia = buildIndex({
      root,
      agentContext: {
        agentsMdPath: undefined,
        claudeMdPath: undefined,
        claudeSkills: [],
        declaredBins: ["crimes"],
        referencedCommands: [],
      },
      docs: [
        {
          file: "docs/agent-usage.md",
          headings: [],
          fencedCommands: [
            { command: "crimes ask", line: 1, deferred: true },
          ],
          links: [],
        },
      ],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await commandDriftDocsCodeDriftDetector.run(
      ctxFor(anchor, ia),
    );
    expect(findings).toEqual([]);
  });

  it("emits nothing when no bins are declared", async () => {
    const root = await makeRepo({
      "docs/agent-usage.md": "no bins",
    });
    const ia = buildIndex({
      root,
      agentContext: {
        agentsMdPath: undefined,
        claudeMdPath: undefined,
        claudeSkills: [],
        declaredBins: [],
        referencedCommands: [],
      },
      docs: [
        {
          file: "docs/agent-usage.md",
          headings: [],
          fencedCommands: [
            { command: "crimes ask", line: 1, deferred: false },
          ],
          links: [],
        },
      ],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await commandDriftDocsCodeDriftDetector.run(
      ctxFor(anchor, ia),
    );
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.ia is absent", async () => {
    const findings = await commandDriftDocsCodeDriftDetector.run({
      kind: "language-js",
      file: "docs/agent-usage.md",
      absolutePath: "/tmp/docs/agent-usage.md",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
