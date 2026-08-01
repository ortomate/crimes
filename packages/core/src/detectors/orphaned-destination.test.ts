import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type {
  IaDocSignal,
  IaFileSignals,
  IaIndex,
  IaNavSignal,
  IaRouteSignal,
} from "../ia/types.js";
import { orphanedDestinationDetector } from "./orphaned-destination.js";

interface BuildOptions {
  routes: IaRouteSignal[];
  navSources?: { file: string; entries: IaNavSignal[] }[];
  docs?: IaDocSignal[];
}

function buildIndex(opts: BuildOptions): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  for (const r of opts.routes) {
    files[r.file] = {
      file: r.file,
      tokens: [],
      componentName: r.componentName,
      routes: [r.routePath],
      labels: [],
      navEntries: [],
      permissions: [],
      isNavSource: false,
    };
  }
  return {
    root: "/tmp/repo",
    files,
    routes: opts.routes,
    navSources: opts.navSources ?? [],
    docs: opts.docs ?? [],
    agentContext: {
      agentsMdPath: undefined,
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
    absolutePath: `/tmp/repo/${file}`,
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    ia,
  };
}

describe("orphanedDestinationDetector", () => {
  it("fires on a route with no nav, doc, or import reference", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/admin/legacy.tsx",
          routePath: "/admin/legacy",
          componentName: "LegacyPage",
          titles: [],
          labels: [],
        },
      ],
    });
    const findings = await orphanedDestinationDetector.run(
      ctxFor("src/pages/admin/legacy.tsx", ia),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("orphaned_destination");
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.summary).toMatch(/\/admin\/legacy/);
  });

  it("does not fire when a nav source references the destination", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/admin/legacy.tsx",
          routePath: "/admin/legacy",
          componentName: "LegacyPage",
          titles: [],
          labels: [],
        },
      ],
      navSources: [
        {
          file: "src/nav.ts",
          entries: [
            {
              line: 1,
              entries: [
                { destination: "/admin/legacy", label: "Legacy", attributes: {} },
              ],
            },
          ],
        },
      ],
    });
    const findings = await orphanedDestinationDetector.run(
      ctxFor("src/pages/admin/legacy.tsx", ia),
    );
    expect(findings).toEqual([]);
  });

  it("does not fire when an internal doc link resolves to the route file", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/billing.tsx",
          routePath: "/billing",
          componentName: "BillingPage",
          titles: [],
          labels: [],
        },
      ],
      docs: [
        {
          file: "docs/billing.md",
          headings: [],
          fencedCommands: [],
          links: [
            {
              target: "../src/pages/billing.tsx",
              line: 1,
              isLocal: true,
              resolved: "src/pages/billing.tsx",
              brokenLocal: false,
            },
          ],
        },
      ],
    });
    const findings = await orphanedDestinationDetector.run(
      ctxFor("src/pages/billing.tsx", ia),
    );
    expect(findings).toEqual([]);
  });

  it("returns nothing for non-route files", async () => {
    const ia = buildIndex({ routes: [] });
    const findings = await orphanedDestinationDetector.run(ctxFor("src/lib/util.ts", ia));
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.ia is absent", async () => {
    const findings = await orphanedDestinationDetector.run({
      kind: "language-js",
      file: "src/pages/admin/legacy.tsx",
      absolutePath: "/tmp/repo/src/pages/admin/legacy.tsx",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
