import { describe, expect, it } from "vitest";
import {
  dependencyProvenanceGapDetector,
  packageNameOf,
} from "./dependency-provenance-gap.js";
import {
  configWithOptions,
  makeRepo,
  repoAnchorFile,
  universalContext,
  type TestRepo,
} from "../risk/test-harness.js";
import type { CrimesConfig } from "../config.js";
import type { PreFinding } from "../finding.js";

async function runOn(
  repo: TestRepo,
  config?: CrimesConfig,
): Promise<PreFinding[]> {
  const anchor = await repoAnchorFile(repo);
  const ctx = await universalContext(repo, anchor, config);
  return dependencyProvenanceGapDetector.run(ctx) as Promise<PreFinding[]>;
}

function bySymbol(findings: PreFinding[], symbol: string): PreFinding | undefined {
  return findings.find((f) => f.symbol === symbol);
}

const PNPM_LOCK = `lockfileVersion: '9.0'

packages:

  'zod@3.22.4':
    resolution: {integrity: sha512-abc==}

  'lodash@4.17.21':
    resolution: {integrity: sha512-def==}
`;

describe("packageNameOf", () => {
  it("resolves bare, scoped, and subpath specifiers", () => {
    expect(packageNameOf("lodash")).toBe("lodash");
    expect(packageNameOf("lodash/fp")).toBe("lodash");
    expect(packageNameOf("@scope/pkg")).toBe("@scope/pkg");
    expect(packageNameOf("@scope/pkg/sub/deep")).toBe("@scope/pkg");
  });

  it("rejects everything that is not a package specifier", () => {
    expect(packageNameOf("./local")).toBeUndefined();
    expect(packageNameOf("../up")).toBeUndefined();
    expect(packageNameOf("/abs")).toBeUndefined();
    expect(packageNameOf("#internal/thing")).toBeUndefined();
    expect(packageNameOf("https://cdn.example/x.js")).toBeUndefined();
    expect(packageNameOf("@/components/Button")).toBeUndefined();
    expect(packageNameOf("~/lib/x")).toBeUndefined();
  });

  it("passes node: specifiers through for the built-in check", () => {
    expect(packageNameOf("node:fs")).toBe("node:fs");
  });
});

describe("dependency_provenance_gap — undeclared imports", () => {
  it("reports an import with no declaring manifest", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", dependencies: { zod: "3.22.4" } }),
      "pnpm-lock.yaml": PNPM_LOCK,
      "src/a.ts": `import { z } from "zod";\nimport chalk from "chalk";\nexport const x = z;\nexport const y = chalk;\n`,
    });
    const finding = bySymbol(await runOn(repo), "undeclared imports");
    expect(finding).toBeDefined();
    expect(finding!.file).toBe("package.json");

    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("1 external package(s) imported with no declaring manifest");
    expect(evidence).toContain('`chalk` — imported at src/a.ts as "chalk"');
    expect(evidence).not.toContain("`zod`");
  });

  it("states plainly that no registry was contacted", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app" }),
      "src/a.ts": `import chalk from "chalk";\nexport const y = chalk;\n`,
    });
    const finding = bySymbol(await runOn(repo), "undeclared imports")!;
    expect(finding.evidence.join("\n")).toContain(
      "no registry was contacted and no claim is made about the packages themselves",
    );
    // The summary must never imply the package is unknown or malicious.
    expect(finding.summary).toContain("declared in no applicable package.json");
    expect(finding.summary.toLowerCase()).not.toMatch(
      /malicious|hallucinat|unknown package|does not exist/,
    );
  });

  it("excludes node built-ins, relative imports, and path aliases", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app" }),
      "src/a.ts": `
        import { readFile } from "node:fs/promises";
        import path from "path";
        import { local } from "./local.js";
        import { aliased } from "@/lib/thing";
        export const x = [readFile, path, local, aliased];
      `,
      "src/local.ts": "export const local = 1;\n",
    });
    expect(bySymbol(await runOn(repo), "undeclared imports")).toBeUndefined();
  });

  it("counts a subpath import against its package", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", dependencies: { lodash: "4.17.21" } }),
      "pnpm-lock.yaml": PNPM_LOCK,
      "src/a.ts": `import fp from "lodash/fp";\nexport const x = fp;\n`,
    });
    expect(bySymbol(await runOn(repo), "undeclared imports")).toBeUndefined();
  });

  it("accepts a type-only import backed by an @types package", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "app",
        devDependencies: { "@types/lodash": "4.14.0" },
      }),
      "src/a.ts": `import type { List } from "lodash";\nexport type X = List<number>;\n`,
    });
    expect(bySymbol(await runOn(repo), "undeclared imports")).toBeUndefined();
  });

  it("resolves through parent manifests in a monorepo", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
        dependencies: { zod: "3.22.4" },
      }),
      "pnpm-lock.yaml": PNPM_LOCK,
      "packages/api/package.json": JSON.stringify({ name: "@app/api" }),
      "packages/api/src/a.ts": `import { z } from "zod";\nexport const x = z;\n`,
    });
    // `zod` is declared at the workspace root; hoisting makes that valid.
    expect(bySymbol(await runOn(repo), "undeclared imports")).toBeUndefined();
  });

  it("treats workspace package names as internal", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@app/core" }),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "packages/api/package.json": JSON.stringify({ name: "@app/api" }),
      "packages/api/src/a.ts": `import { core } from "@app/core";\nexport const x = core;\n`,
    });
    expect(bySymbol(await runOn(repo), "undeclared imports")).toBeUndefined();
  });

  it("ignores manifests outside the workspace", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "pnpm-lock.yaml": PNPM_LOCK,
      "packages/api/package.json": JSON.stringify({ name: "@app/api" }),
      "packages/api/src/a.ts": "export const x = 1;\n",
      // A self-contained sample app: its dependencies are its own business.
      "examples/demo/package.json": JSON.stringify({
        name: "demo",
        dependencies: { react: "latest", "some-lib": "^1.0.0" },
      }),
      "examples/demo/src/a.ts": `import React from "react";\nexport const x = React;\n`,
    });
    const findings = await runOn(repo);
    const all = findings.map((f) => f.evidence.join("\n")).join("\n");
    expect(all).not.toContain("some-lib");
    expect(all).not.toContain("`react`");
  });
});

describe("dependency_provenance_gap — lockfile gaps", () => {
  it("reports a declared dependency with no lock entry", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { zod: "3.22.4", "missing-pkg": "^2.0.0" },
      }),
      "pnpm-lock.yaml": PNPM_LOCK,
      "src/a.ts": "export const x = 1;\n",
    });
    const finding = bySymbol(await runOn(repo), "manifest/lockfile disagreement");
    expect(finding).toBeDefined();
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("pnpm-lock.yaml (pnpm, 2 entries)");
    expect(evidence).toContain("`missing-pkg`@^2.0.0 — declared in package.json:1 (dependencies)");
    expect(evidence).not.toContain("`zod`@");
  });

  it("excludes peer, optional, workspace, and file dependencies", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "app",
        peerDependencies: { react: "^18" },
        optionalDependencies: { fsevents: "^2" },
        dependencies: { "@app/core": "workspace:*", local: "file:../local" },
      }),
      "pnpm-lock.yaml": PNPM_LOCK,
      "src/a.ts": "export const x = 1;\n",
    });
    expect(bySymbol(await runOn(repo), "manifest/lockfile disagreement")).toBeUndefined();
  });

  it("says nothing when the lockfile could not be parsed", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", dependencies: { zod: "3.22.4" } }),
      "pnpm-lock.yaml": "this is not a lockfile\n",
      "src/a.ts": "export const x = 1;\n",
    });
    expect(bySymbol(await runOn(repo), "manifest/lockfile disagreement")).toBeUndefined();
  });

  it("reads a package-lock.json v3 packages tree", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { zod: "3.22.4", "missing-pkg": "^2.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/zod": { version: "3.22.4" } },
      }),
      "src/a.ts": "export const x = 1;\n",
    });
    const finding = bySymbol(await runOn(repo), "manifest/lockfile disagreement");
    expect(finding!.evidence.join("\n")).toContain("`missing-pkg`");
    expect(finding!.evidence.join("\n")).toContain("(npm, 1 entries)");
  });

  it("reads a yarn.lock entry header", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { zod: "^3.22.4", "missing-pkg": "^2.0.0" },
      }),
      "yarn.lock": `zod@^3.22.4:\n  version "3.22.4"\n`,
      "src/a.ts": "export const x = 1;\n",
    });
    const finding = bySymbol(await runOn(repo), "manifest/lockfile disagreement");
    expect(finding!.evidence.join("\n")).toContain("`missing-pkg`");
    expect(finding!.evidence.join("\n")).not.toContain("`zod`@");
  });
});

describe("dependency_provenance_gap — unpinned specifiers", () => {
  it("reports git branches, URLs, wildcards, and escaping paths", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: {
          branchdep: "git+https://github.com/o/r.git#main",
          tarball: "https://example.com/pkg.tgz",
          anything: "*",
          escaping: "file:../../outside/pkg",
          pinned: "git+https://github.com/o/r.git#0123456789abcdef0123456789abcdef01234567",
          normal: "^1.2.3",
        },
      }),
      "src/a.ts": "export const x = 1;\n",
    });
    const finding = bySymbol(await runOn(repo), "unpinned specifiers")!;
    const evidence = finding.evidence.join("\n");
    expect(evidence).toContain("`branchdep`");
    expect(evidence).toContain("`tarball`");
    expect(evidence).toContain("`anything`");
    expect(evidence).toContain("`escaping`");
    // A commit-pinned git dependency and a normal range are fine.
    expect(evidence).not.toContain("`pinned`");
    expect(evidence).not.toContain("`normal`");
  });

  it("says nothing when every specifier is pinned", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { a: "^1.0.0", b: "2.0.0", c: "workspace:*" },
      }),
      "src/a.ts": "export const x = 1;\n",
    });
    expect(bySymbol(await runOn(repo), "unpinned specifiers")).toBeUndefined();
  });
});

describe("dependency_provenance_gap — configuration and stability", () => {
  const REPO = {
    "package.json": JSON.stringify({ name: "app", dependencies: { anything: "*" } }),
    "src/a.ts": `import chalk from "chalk";\nexport const x = chalk;\n`,
  };

  it("honours each report toggle", async () => {
    const repo = await makeRepo(REPO);
    expect(bySymbol(await runOn(repo), "undeclared imports")).toBeDefined();
    expect(
      bySymbol(
        await runOn(repo, configWithOptions("dependency_provenance_gap", {
          reportUndeclaredImports: false,
        })),
        "undeclared imports",
      ),
    ).toBeUndefined();
    expect(
      bySymbol(
        await runOn(repo, configWithOptions("dependency_provenance_gap", {
          reportUnpinnedSpecifiers: false,
        })),
        "unpinned specifiers",
      ),
    ).toBeUndefined();
  });

  it("honours allowedPackages", async () => {
    const repo = await makeRepo(REPO);
    expect(
      bySymbol(
        await runOn(repo, configWithOptions("dependency_provenance_gap", {
          allowedPackages: ["chalk"],
        })),
        "undeclared imports",
      ),
    ).toBeUndefined();
  });

  it("validates its options schema", () => {
    const schema = dependencyProvenanceGapDetector.optionsSchema!;
    expect(schema.safeParse({ allowedPackages: ["a"] }).success).toBe(true);
    expect(schema.safeParse({ allowedPackages: "a" }).success).toBe(false);
    expect(schema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it("is deterministic across runs", async () => {
    const repo = await makeRepo(REPO);
    expect(JSON.stringify(await runOn(repo))).toBe(JSON.stringify(await runOn(repo)));
  });

  it("emits once per scan, not once per file", async () => {
    const repo = await makeRepo({
      ...REPO,
      "src/b.ts": `import chalk from "chalk";\nexport const y = chalk;\n`,
    });
    const anchor = await repoAnchorFile(repo);
    const nonAnchor = repo.files
      .map((p) => p.slice(repo.root.length + 1))
      .find((f) => f !== anchor && f.endsWith(".ts"))!;
    const atNonAnchor = await dependencyProvenanceGapDetector.run(
      await universalContext(repo, nonAnchor),
    );
    expect(atNonAnchor).toHaveLength(0);
  });
});
