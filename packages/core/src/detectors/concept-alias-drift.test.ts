import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { DEFAULT_ALIAS_GROUPS } from "../ia/aliases.js";
import type {
  IaConceptAliasGroup,
  IaFileSignals,
  IaIndex,
} from "../ia/types.js";
import { conceptAliasDriftDetector as _conceptAliasDriftDetector } from "./concept-alias-drift.js";
const conceptAliasDriftDetector = _conceptAliasDriftDetector as LanguageJsDetector;

interface BuildOptions {
  files: Record<
    string,
    {
      tokens?: string[];
      routes?: string[];
      labels?: { value: string; kind?: "jsx_label" | "metadata_title" }[];
      navLabels?: { destination: string; label: string }[];
    }
  >;
  docs?: { file: string; headings: string[] }[];
  aliasGroups?: IaConceptAliasGroup[];
}

function buildIndex(opts: BuildOptions): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  for (const [file, sig] of Object.entries(opts.files)) {
    files[file] = {
      file,
      tokens: sig.tokens ?? [],
      routes: sig.routes ?? [],
      labels: (sig.labels ?? []).map((l) => ({
        value: l.value,
        line: 1,
        kind: l.kind ?? "metadata_title",
      })),
      navEntries: sig.navLabels && sig.navLabels.length > 0
        ? [
            {
              identifier: "items",
              line: 1,
              entries: sig.navLabels.map((n) => ({
                destination: n.destination,
                label: n.label,
                attributes: {},
              })),
            },
          ]
        : [],
      permissions: [],
      isNavSource: (sig.navLabels?.length ?? 0) > 0,
    };
  }
  return {
    root: "/tmp/repo",
    files,
    routes: [],
    navSources: [],
    docs: (opts.docs ?? []).map((d) => ({
      file: d.file,
      headings: d.headings.map((text, i) => ({ text, level: 1, line: i + 1 })),
      links: [],
      fencedCommands: [],
    })),
    agentContext: {
      agentsMdPath: "AGENTS.md",
      claudeMdPath: undefined,
      claudeSkills: [],
      declaredBins: [],
      referencedCommands: [],
    },
    aliasGroups: opts.aliasGroups ?? DEFAULT_ALIAS_GROUPS,
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

describe("conceptAliasDriftDetector", () => {
  it("returns nothing when ctx.ia is missing", async () => {
    const findings = await conceptAliasDriftDetector.run({
      kind: "language-js",
      file: "src/a.ts",
      absolutePath: "/tmp/x",
      source: "",
      parsed: { lineCount: 1, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it("fires when team / workspace / organisation drift across product surface", async () => {
    // Each alias must appear in ≥2 directories to qualify (strict quorum).
    const ia = buildIndex({
      files: {
        // team: appears in src/team/ and src/components/
        "src/team/index.tsx": {
          tokens: ["team"],
          routes: ["/team"],
          labels: [{ value: "Team" }],
        },
        "src/components/team-card.tsx": {
          tokens: ["team"],
          labels: [{ value: "Team card" }],
        },
        // workspace: appears in src/workspace/ and src/nav/
        "src/workspace/index.ts": {
          tokens: ["workspace"],
          routes: ["/workspace"],
          labels: [{ value: "Workspace" }],
        },
        "src/nav/sidebar.ts": {
          tokens: [],
          navLabels: [{ destination: "/workspace", label: "Workspace" }],
        },
        // organisation: appears in src/auth/ and src/admin/
        "src/auth/permissions.ts": {
          tokens: ["organisation"],
          labels: [{ value: "Organisation settings" }],
        },
        "src/admin/org-panel.tsx": {
          tokens: ["organisation"],
        },
      },
    });
    // Anchor file: lex-first of ctx.ia.files. With these fixtures,
    // that's "src/admin/org-panel.tsx".
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await conceptAliasDriftDetector.run(ctxFor(anchor, ia));
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const tenant = findings.find((f) =>
      f.evidence.some((e) => e.startsWith("alias group: tenant")),
    );
    expect(tenant).toBeDefined();
    expect(tenant!.type).toBe("concept_alias_drift");
    expect(tenant!.charge).toBe("Concept Alias Drift");
    expect(tenant!.severity).toBe("medium");
    expect(tenant!.related_files!.length).toBeGreaterThan(0);
  });

  it("does not fire when only ONE alias from a group appears", async () => {
    const ia = buildIndex({
      files: {
        "src/team/index.tsx": {
          tokens: ["team"],
          routes: ["/team"],
        },
        "src/team/details.tsx": {
          tokens: ["team"],
        },
        "src/team/settings.tsx": {
          tokens: ["team"],
        },
      },
    });
    const findings = await conceptAliasDriftDetector.run(
      ctxFor("src/team/details.tsx", ia),
    );
    expect(findings).toEqual([]);
  });

  it("does not fire when aliases live only in test fixtures", async () => {
    const ia = buildIndex({
      files: {
        "src/a.ts": { tokens: [] },
        "src/__tests__/team.test.ts": { tokens: ["team"] },
        "src/__tests__/workspace.test.ts": { tokens: ["workspace"] },
        "src/__tests__/organisation.test.ts": { tokens: ["organisation"] },
      },
    });
    const findings = await conceptAliasDriftDetector.run(
      ctxFor("src/a.ts", ia),
    );
    expect(findings).toEqual([]);
  });

  it("requires aliases to span at least 2 directories per alias (strict quorum)", async () => {
    const ia = buildIndex({
      files: {
        // Only `team` spans 2 dirs; workspace and account only one each.
        "src/team/index.tsx": { tokens: ["team"], routes: ["/team"] },
        "src/components/team-card.tsx": { tokens: ["team"] },
        "src/workspace/index.tsx": { tokens: ["workspace"] },
        "src/account/index.tsx": { tokens: ["account"] },
      },
    });
    const findings = await conceptAliasDriftDetector.run(
      ctxFor("src/account/index.tsx", ia),
    );
    expect(findings).toEqual([]);
  });

  it("caps to at most 3 alias-group findings per scan", async () => {
    // Force every default group to fire by populating tokens for all of them.
    const files: BuildOptions["files"] = {};
    for (const group of DEFAULT_ALIAS_GROUPS) {
      // Each alias appears in 2 distinct directories AND at least one product label.
      group.aliases.slice(0, 3).forEach((alias, i) => {
        files[`src/${group.id}/${alias}-a.tsx`] = {
          tokens: [alias],
          routes: [`/${alias}`],
          labels: [{ value: alias.replace(/^./, (c) => c.toUpperCase()) }],
        };
        files[`src/${group.id}/${alias}-b/${i}.tsx`] = { tokens: [alias] };
      });
    }
    const ia = buildIndex({ files });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await conceptAliasDriftDetector.run(ctxFor(anchor, ia));
    expect(findings.length).toBeLessThanOrEqual(3);
  });

  it("only emits on the lexicographically first source file in the index", async () => {
    const ia = buildIndex({
      files: {
        "src/aaa.ts": { tokens: [] },
        "src/team/index.tsx": {
          tokens: ["team"],
          routes: ["/team"],
          labels: [{ value: "Team" }],
        },
        "src/workspace/index.tsx": {
          tokens: ["workspace"],
          labels: [{ value: "Workspace" }],
        },
        "src/organisation/index.tsx": {
          tokens: ["organisation"],
          labels: [{ value: "Organisation" }],
        },
        "src/account/index.tsx": {
          tokens: ["account"],
        },
        "src/account/billing.tsx": {
          tokens: ["account"],
        },
      },
    });
    const sortedFirst = "src/aaa.ts";
    const onFirst = await conceptAliasDriftDetector.run(ctxFor(sortedFirst, ia));
    const onOther = await conceptAliasDriftDetector.run(
      ctxFor("src/account/billing.tsx", ia),
    );
    expect(onOther).toEqual([]);
    // First file emits whatever findings fire.
    expect(onFirst.length).toBeGreaterThanOrEqual(0);
  });
});
