import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type {
  IaFileSignals,
  IaIndex,
  IaLabelSignal,
  IaNavSignal,
  IaRouteSignal,
} from "../ia/types.js";
import { routeMetadataDriftDetector } from "./route-metadata-drift.js";

interface BuildOptions {
  routes: IaRouteSignal[];
  fileLabels?: Record<string, IaLabelSignal[]>;
  navSources?: { file: string; entries: IaNavSignal[] }[];
}

function buildIndex(opts: BuildOptions): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  for (const route of opts.routes) {
    files[route.file] = {
      file: route.file,
      tokens: [],
      componentName: route.componentName,
      routes: [route.routePath],
      labels: opts.fileLabels?.[route.file] ?? [],
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

describe("routeMetadataDriftDetector", () => {
  it("returns nothing when ctx.ia is missing", async () => {
    const findings = await routeMetadataDriftDetector.run({
      kind: "language-js",
      file: "src/pages/settings/billing.tsx",
      absolutePath: "/tmp/x",
      source: "",
      parsed: { lineCount: 1, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it("fires when /settings/billing has competing labels across sources", async () => {
    const routeFile = "src/pages/settings/billing.tsx";
    const ia = buildIndex({
      routes: [
        {
          file: routeFile,
          routePath: "/settings/billing",
          componentName: "PricingPage",
          titles: ["Subscription"],
          labels: ["Subscription"],
        },
      ],
      fileLabels: {
        [routeFile]: [
          {
            value: "Subscription",
            line: 1,
            kind: "metadata_title",
            source: "metadata.title",
          },
        ],
      },
      navSources: [
        {
          file: "src/nav/sidebar.ts",
          entries: [
            {
              identifier: "sidebar",
              line: 1,
              entries: [{ destination: "/settings/billing", label: "Plans", attributes: {} }],
            },
          ],
        },
      ],
    });

    const findings = await routeMetadataDriftDetector.run(ctxFor(routeFile, ia));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.type).toBe("route_metadata_drift");
    expect(f.file).toBe(routeFile);
    expect(f.severity).toBe("medium");
    const evidence = f.evidence.join(" | ");
    expect(evidence).toContain("/settings/billing");
    expect(evidence).toContain("PricingPage");
    expect(evidence).toContain("Subscription");
    expect(evidence).toContain("Plans");
    expect(f.related_files).toContain("src/nav/sidebar.ts");
  });

  it("does not fire when labels all share the same headline token", async () => {
    const routeFile = "src/pages/settings/billing.tsx";
    const ia = buildIndex({
      routes: [
        {
          file: routeFile,
          routePath: "/settings/billing",
          componentName: "BillingPage",
          titles: ["Billing"],
          labels: ["Billing"],
        },
      ],
      fileLabels: {
        [routeFile]: [
          {
            value: "Billing",
            line: 1,
            kind: "metadata_title",
            source: "metadata.title",
          },
        ],
      },
      navSources: [
        {
          file: "src/nav/sidebar.ts",
          entries: [
            {
              identifier: "sidebar",
              line: 1,
              entries: [{ destination: "/settings/billing", label: "Billing", attributes: {} }],
            },
          ],
        },
      ],
    });

    const findings = await routeMetadataDriftDetector.run(ctxFor(routeFile, ia));
    expect(findings).toEqual([]);
  });

  it("does not fire on a generic root/index route with no concept tokens", async () => {
    const routeFile = "src/pages/index.tsx";
    const ia = buildIndex({
      routes: [
        {
          file: routeFile,
          routePath: "/",
          componentName: "HomePage",
          titles: ["Home"],
          labels: ["Home"],
        },
      ],
      fileLabels: {
        [routeFile]: [
          {
            value: "Home",
            line: 1,
            kind: "metadata_title",
          },
        ],
      },
    });
    const findings = await routeMetadataDriftDetector.run(ctxFor(routeFile, ia));
    expect(findings).toEqual([]);
  });

  it("only fires once per route file (anchored on the route file itself)", async () => {
    const routeFile = "src/pages/settings/billing.tsx";
    const ia = buildIndex({
      routes: [
        {
          file: routeFile,
          routePath: "/settings/billing",
          componentName: "PricingPage",
          titles: ["Subscription"],
          labels: ["Subscription"],
        },
      ],
      fileLabels: {
        [routeFile]: [
          {
            value: "Subscription",
            line: 1,
            kind: "metadata_title",
          },
        ],
      },
      navSources: [
        {
          file: "src/nav/sidebar.ts",
          entries: [
            {
              identifier: "sidebar",
              line: 1,
              entries: [{ destination: "/settings/billing", label: "Plans", attributes: {} }],
            },
          ],
        },
      ],
    });
    const otherFile = "src/nav/sidebar.ts";
    expect(
      await routeMetadataDriftDetector.run(ctxFor(otherFile, ia)),
    ).toEqual([]);
    expect(
      await routeMetadataDriftDetector.run(ctxFor(routeFile, ia)),
    ).toHaveLength(1);
  });

  it("ignores routes with fewer than 3 evidence sources", async () => {
    const routeFile = "src/pages/settings/billing.tsx";
    const ia = buildIndex({
      routes: [
        {
          file: routeFile,
          routePath: "/settings/billing",
          componentName: "PricingPage",
          titles: [],
          labels: [],
        },
      ],
    });
    const findings = await routeMetadataDriftDetector.run(ctxFor(routeFile, ia));
    expect(findings).toEqual([]);
  });
});
