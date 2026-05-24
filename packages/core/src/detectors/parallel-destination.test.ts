import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type {
  IaFileSignals,
  IaIndex,
  IaNavSignal,
  IaRouteSignal,
} from "../ia/types.js";
import { parallelDestinationDetector } from "./parallel-destination.js";

interface BuildOptions {
  routes: IaRouteSignal[];
  navSources?: { file: string; entries: IaNavSignal[] }[];
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
    docs: [],
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

describe("parallelDestinationDetector", () => {
  it("fires once on the lex-first file of a parallel pair", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/account/billing/subscription.tsx",
          routePath: "/account/billing/subscription",
          componentName: "AccountBillingSubscription",
          titles: [],
          labels: [],
        },
        {
          file: "src/screens/team/billing/subscription.tsx",
          routePath: "/team/billing/subscription",
          componentName: "TeamBillingSubscription",
          titles: [],
          labels: [],
        },
      ],
    });
    const aFindings = await parallelDestinationDetector.run(
      ctxFor("src/pages/account/billing/subscription.tsx", ia),
    );
    const bFindings = await parallelDestinationDetector.run(
      ctxFor("src/screens/team/billing/subscription.tsx", ia),
    );
    expect(aFindings).toHaveLength(1);
    expect(bFindings).toHaveLength(0);
    expect(aFindings[0]!.type).toBe("parallel_destination");
    expect(aFindings[0]!.severity).toBe("medium");
    expect(aFindings[0]!.related_files).toEqual([
      "src/screens/team/billing/subscription.tsx",
    ]);
  });

  it("does not fire when the two routes are linked via nav entry", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/account/billing/subscription.tsx",
          routePath: "/account/billing/subscription",
          componentName: "AccountBillingSubscription",
          titles: [],
          labels: [],
        },
        {
          file: "src/screens/team/billing/subscription.tsx",
          routePath: "/team/billing/subscription",
          componentName: "TeamBillingSubscription",
          titles: [],
          labels: [],
        },
      ],
      navSources: [
        {
          file: "src/pages/account/billing/subscription.tsx",
          entries: [
            {
              line: 1,
              entries: [
                {
                  destination: "/team/billing/subscription",
                  label: "Team Billing",
                  attributes: {},
                },
              ],
            },
          ],
        },
      ],
    });
    const findings = await parallelDestinationDetector.run(
      ctxFor("src/pages/account/billing/subscription.tsx", ia),
    );
    expect(findings).toEqual([]);
  });

  it("does not fire on sibling routes that share a route-root segment", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/billing/index.tsx",
          routePath: "/billing",
          componentName: "BillingIndex",
          titles: [],
          labels: [],
        },
        {
          file: "src/pages/billing/subscription.tsx",
          routePath: "/billing/subscription",
          componentName: "BillingSubscription",
          titles: [],
          labels: [],
        },
      ],
    });
    const findings = await parallelDestinationDetector.run(
      ctxFor("src/pages/billing/index.tsx", ia),
    );
    expect(findings).toEqual([]);
  });

  it("does not fire when route token overlap is below 2", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/dashboard.tsx",
          routePath: "/dashboard",
          componentName: "Dashboard",
          titles: [],
          labels: [],
        },
        {
          file: "src/screens/profile.tsx",
          routePath: "/profile",
          componentName: "Profile",
          titles: [],
          labels: [],
        },
      ],
    });
    const findings = await parallelDestinationDetector.run(
      ctxFor("src/pages/dashboard.tsx", ia),
    );
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.ia is absent", async () => {
    const findings = await parallelDestinationDetector.run({
      kind: "language-js",
      file: "src/pages/account/billing/subscription.tsx",
      absolutePath: "/tmp/repo/src/pages/account/billing/subscription.tsx",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
