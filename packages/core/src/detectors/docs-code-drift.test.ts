import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { IaDocLink, IaFileSignals, IaIndex } from "../ia/types.js";
import { docsCodeDriftDetector } from "./docs-code-drift.js";

function buildIndex(opts: {
  files?: string[];
  docs: { file: string; links: IaDocLink[] }[];
}): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  for (const f of opts.files ?? ["src/a.ts"]) {
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
    docs: opts.docs.map((d) => ({
      file: d.file,
      headings: [],
      links: d.links,
      fencedCommands: [],
    })),
    agentContext: {
      agentsMdPath: "AGENTS.md",
      claudeMdPath: undefined,
      claudeSkills: [],
      declaredBins: [],
      referencedCommands: [],
    },
    aliasGroups: [],
  };
}

function ctxFor(file: string, ia: IaIndex): LanguageJsDetectorContext {
  return {
    kind: "language-js",
    file,
    absolutePath: `/tmp/${file}`,
    source: "",
    parsed: { lineCount: 1, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    ia,
  };
}

describe("docsCodeDriftDetector", () => {
  it("returns nothing when ctx.ia is missing", async () => {
    const findings = await docsCodeDriftDetector.run({
      kind: "language-js",
      file: "src/a.ts",
      absolutePath: "/tmp/x",
      source: "",
      parsed: { lineCount: 1, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it("fires on a broken local link", async () => {
    const ia = buildIndex({
      docs: [
        {
          file: "docs/billing.md",
          links: [
            { target: "./setup.md", line: 5, isLocal: true, brokenLocal: true },
          ],
        },
      ],
    });
    const findings = await docsCodeDriftDetector.run(ctxFor("src/a.ts", ia));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.type).toBe("docs_code_drift");
    expect(f.charge).toBe("Docs-Code Drift");
    expect(f.severity).toBe("low");
    expect(f.file).toBe("docs/billing.md");
    expect(f.evidence.join(" | ")).toContain("./setup.md");
  });

  it("does not fire on valid local links", async () => {
    const ia = buildIndex({
      docs: [
        {
          file: "docs/billing.md",
          links: [
            {
              target: "./real.md",
              line: 5,
              isLocal: true,
              brokenLocal: false,
              resolved: "docs/real.md",
            },
          ],
        },
      ],
    });
    const findings = await docsCodeDriftDetector.run(ctxFor("src/a.ts", ia));
    expect(findings).toEqual([]);
  });

  it("ignores external links", async () => {
    const ia = buildIndex({
      docs: [
        {
          file: "docs/billing.md",
          links: [
            {
              target: "https://example.com",
              line: 5,
              isLocal: false,
              brokenLocal: false,
            },
          ],
        },
      ],
    });
    const findings = await docsCodeDriftDetector.run(ctxFor("src/a.ts", ia));
    expect(findings).toEqual([]);
  });

  it("only emits on the lexicographically first file in the index", async () => {
    const ia = buildIndex({
      files: ["src/a.ts", "src/b.ts"],
      docs: [
        {
          file: "docs/x.md",
          links: [
            { target: "./gone.md", line: 1, isLocal: true, brokenLocal: true },
          ],
        },
      ],
    });
    expect(
      (await docsCodeDriftDetector.run(ctxFor("src/a.ts", ia))).length,
    ).toBe(1);
    expect(
      await docsCodeDriftDetector.run(ctxFor("src/b.ts", ia)),
    ).toEqual([]);
  });

  it("emits one finding per doc with broken links, with multi-link evidence", async () => {
    const ia = buildIndex({
      docs: [
        {
          file: "docs/a.md",
          links: [
            { target: "./gone1.md", line: 1, isLocal: true, brokenLocal: true },
            { target: "./gone2.md", line: 7, isLocal: true, brokenLocal: true },
          ],
        },
        {
          file: "docs/b.md",
          links: [
            { target: "./broken.md", line: 3, isLocal: true, brokenLocal: true },
          ],
        },
      ],
    });
    const findings = await docsCodeDriftDetector.run(ctxFor("src/a.ts", ia));
    expect(findings).toHaveLength(2);
    const a = findings.find((f) => f.file === "docs/a.md")!;
    expect(a.evidence.length).toBeGreaterThanOrEqual(2);
  });
});
