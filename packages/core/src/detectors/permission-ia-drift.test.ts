import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type {
  IaDocSignal,
  IaFileSignals,
  IaIndex,
  IaPermissionSignal,
  IaRouteSignal,
} from "../ia/types.js";
import { permissionIaDriftDetector } from "./permission-ia-drift.js";

interface BuildOptions {
  routes: IaRouteSignal[];
  permissions?: Record<string, IaPermissionSignal[]>;
  navSources?: IaIndex["navSources"];
  docs?: IaDocSignal[];
  extraFiles?: string[];
}

function buildIndex(opts: BuildOptions): IaIndex {
  const files: Record<string, IaFileSignals> = {};
  const allFiles = new Set<string>();
  for (const r of opts.routes) allFiles.add(r.file);
  for (const f of opts.extraFiles ?? []) allFiles.add(f);
  for (const s of opts.navSources ?? []) allFiles.add(s.file);
  for (const file of allFiles) {
    files[file] = {
      file,
      tokens: [],
      componentName: undefined,
      routes: opts.routes.find((r) => r.file === file)
        ? [opts.routes.find((r) => r.file === file)!.routePath]
        : [],
      labels: [],
      navEntries: [],
      permissions: opts.permissions?.[file] ?? [],
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

describe("permissionIaDriftDetector", () => {
  it("fires when nav, route guard, and docs use different tokens for the same destination", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/admin/users.tsx",
          routePath: "/admin/users",
          componentName: "AdminUsers",
          titles: [],
          labels: [],
        },
      ],
      permissions: {
        "src/pages/admin/users.tsx": [
          { value: "owner", line: 12, kind: "role" },
        ],
      },
      navSources: [
        {
          file: "src/nav.ts",
          entries: [
            {
              line: 1,
              entries: [
                {
                  destination: "/admin/users",
                  label: "Admin Users",
                  attributes: { role: "admin" },
                },
              ],
            },
          ],
        },
      ],
      docs: [
        {
          file: "docs/teams.md",
          headings: [{ text: "Team Owners can manage users", level: 2, line: 5 }],
          fencedCommands: [],
          links: [
            {
              target: "/admin/users",
              line: 7,
              isLocal: true,
              resolved: "src/pages/admin/users.tsx",
              brokenLocal: false,
            },
          ],
        },
      ],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await permissionIaDriftDetector.run(ctxFor(anchor, ia));
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const drift = findings.find((f) => f.type === "permission_ia_drift");
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe("medium");
    expect(drift!.evidence.some((e) => e.startsWith("tokens:"))).toBe(true);
  });

  it("does not fire when nav and route guard agree on the same role", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/admin/users.tsx",
          routePath: "/admin/users",
          componentName: "AdminUsers",
          titles: [],
          labels: [],
        },
      ],
      permissions: {
        "src/pages/admin/users.tsx": [
          { value: "admin", line: 12, kind: "role" },
        ],
      },
      navSources: [
        {
          file: "src/nav.ts",
          entries: [
            {
              line: 1,
              entries: [
                {
                  destination: "/admin/users",
                  label: "Admin Users",
                  attributes: { role: "admin" },
                },
              ],
            },
          ],
        },
      ],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await permissionIaDriftDetector.run(ctxFor(anchor, ia));
    expect(findings.filter((f) => f.type === "permission_ia_drift")).toEqual([]);
  });

  it("emits nothing when fewer than 3 sources contribute", async () => {
    const ia = buildIndex({
      routes: [
        {
          file: "src/pages/admin/users.tsx",
          routePath: "/admin/users",
          componentName: "AdminUsers",
          titles: [],
          labels: [],
        },
      ],
      permissions: {
        "src/pages/admin/users.tsx": [
          { value: "owner", line: 12, kind: "role" },
        ],
      },
      navSources: [
        {
          file: "src/nav.ts",
          entries: [
            {
              line: 1,
              entries: [
                {
                  destination: "/admin/users",
                  label: "Admin Users",
                  attributes: { role: "admin" },
                },
              ],
            },
          ],
        },
      ],
    });
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await permissionIaDriftDetector.run(ctxFor(anchor, ia));
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.ia is absent", async () => {
    const findings = await permissionIaDriftDetector.run({
      kind: "language-js",
      file: "src/pages/admin/users.tsx",
      absolutePath: "/tmp/repo/src/pages/admin/users.tsx",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
