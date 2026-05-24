import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import type { IaIndex, IaNavSignal } from "../ia/types.js";
import { duplicatedNavigationSourceDetector as _duplicatedNavigationSourceDetector } from "./duplicated-navigation-source.js";
const duplicatedNavigationSourceDetector = _duplicatedNavigationSourceDetector as LanguageJsDetector;

function buildIndex(
  sources: { file: string; entries: { destination?: string; label?: string }[] }[],
): IaIndex {
  return {
    root: "/tmp/repo",
    files: {},
    routes: [],
    navSources: sources.map((s) => ({
      file: s.file,
      entries: [
        {
          identifier: "items",
          line: 1,
          entries: s.entries.map((e) => ({
            destination: e.destination,
            label: e.label,
            attributes: {},
          })),
        } satisfies IaNavSignal,
      ],
    })),
    docs: [],
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

describe("duplicatedNavigationSourceDetector", () => {
  it("returns nothing when ctx.ia is missing", async () => {
    const findings = await duplicatedNavigationSourceDetector.run({
      kind: "language-js",
      file: "src/nav/sidebar.ts",
      absolutePath: "/tmp/x",
      source: "",
      parsed: { lineCount: 1, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it("fires when /settings/billing has different labels in two files", async () => {
    const ia = buildIndex([
      {
        file: "src/nav/sidebar.ts",
        entries: [{ destination: "/settings/billing", label: "Billing" }],
      },
      {
        file: "src/nav/registry.ts",
        entries: [{ destination: "/settings/billing", label: "Plans" }],
      },
    ]);
    const findings = await duplicatedNavigationSourceDetector.run(
      ctxFor("src/nav/registry.ts", ia),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.type).toBe("duplicated_navigation_source");
    expect(f.charge).toBe("Duplicated Navigation Source");
    expect(f.severity).toBe("medium");
    expect(f.file).toBe("src/nav/registry.ts");
    expect(f.related_files).toEqual(["src/nav/sidebar.ts"]);
    const evidence = f.evidence.join(" | ");
    expect(evidence).toContain("/settings/billing");
    expect(evidence).toContain("Billing");
    expect(evidence).toContain("Plans");
  });

  it("does not fire when the same destination has the same label everywhere", async () => {
    const ia = buildIndex([
      {
        file: "src/nav/sidebar.ts",
        entries: [{ destination: "/settings/billing", label: "Billing" }],
      },
      {
        file: "src/nav/registry.ts",
        entries: [{ destination: "/settings/billing", label: "Billing" }],
      },
    ]);
    for (const f of ["src/nav/registry.ts", "src/nav/sidebar.ts"]) {
      expect(
        await duplicatedNavigationSourceDetector.run(ctxFor(f, ia)),
      ).toEqual([]);
    }
  });

  it("anchors emission on the lexicographically first nav file (single emission)", async () => {
    const ia = buildIndex([
      {
        file: "src/nav/sidebar.ts",
        entries: [{ destination: "/settings/billing", label: "Plans" }],
      },
      {
        file: "src/nav/registry.ts",
        entries: [{ destination: "/settings/billing", label: "Billing" }],
      },
    ]);
    const onRegistry = await duplicatedNavigationSourceDetector.run(
      ctxFor("src/nav/registry.ts", ia),
    );
    const onSidebar = await duplicatedNavigationSourceDetector.run(
      ctxFor("src/nav/sidebar.ts", ia),
    );
    // registry.ts < sidebar.ts lexicographically.
    expect(onRegistry).toHaveLength(1);
    expect(onSidebar).toEqual([]);
  });

  it("ignores external URLs", async () => {
    const ia = buildIndex([
      {
        file: "src/nav/a.ts",
        entries: [{ destination: "https://example.com", label: "Home" }],
      },
      {
        file: "src/nav/b.ts",
        entries: [{ destination: "https://example.com", label: "External" }],
      },
    ]);
    for (const f of ["src/nav/a.ts", "src/nav/b.ts"]) {
      expect(
        await duplicatedNavigationSourceDetector.run(ctxFor(f, ia)),
      ).toEqual([]);
    }
  });

  it("ignores anchor-only links", async () => {
    const ia = buildIndex([
      {
        file: "src/nav/a.ts",
        entries: [{ destination: "#top", label: "Top" }],
      },
      {
        file: "src/nav/b.ts",
        entries: [{ destination: "#top", label: "Skip" }],
      },
    ]);
    for (const f of ["src/nav/a.ts", "src/nav/b.ts"]) {
      expect(
        await duplicatedNavigationSourceDetector.run(ctxFor(f, ia)),
      ).toEqual([]);
    }
  });

  it("treats labels as same when they only differ in case/whitespace", async () => {
    const ia = buildIndex([
      {
        file: "src/nav/a.ts",
        entries: [{ destination: "/team", label: "Team" }],
      },
      {
        file: "src/nav/b.ts",
        entries: [{ destination: "/team", label: "  team  " }],
      },
    ]);
    for (const f of ["src/nav/a.ts", "src/nav/b.ts"]) {
      expect(
        await duplicatedNavigationSourceDetector.run(ctxFor(f, ia)),
      ).toEqual([]);
    }
  });

  it("emits one finding per drifting destination", async () => {
    const ia = buildIndex([
      {
        file: "src/nav/a.ts",
        entries: [
          { destination: "/team", label: "Team" },
          { destination: "/settings/billing", label: "Billing" },
        ],
      },
      {
        file: "src/nav/b.ts",
        entries: [
          { destination: "/team", label: "Workspace" },
          { destination: "/settings/billing", label: "Plans" },
        ],
      },
    ]);
    const onA = await duplicatedNavigationSourceDetector.run(
      ctxFor("src/nav/a.ts", ia),
    );
    expect(onA).toHaveLength(2);
    const destinations = onA
      .flatMap((f) => f.evidence)
      .filter((e) => e.startsWith("destination:"));
    expect(destinations.length).toBe(2);
  });
});
