import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import type { IaFileSignals, IaIndex } from "../ia/types.js";
import { duplicatedRoleStatusPlanCheckDetector } from "./duplicated-role-status-plan-check.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-drspc-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

function buildIndex(root: string, files: string[]): IaIndex {
  const fileSignals: Record<string, IaFileSignals> = {};
  for (const f of files) {
    fileSignals[f] = {
      file: f,
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
    root,
    files: fileSignals,
    routes: [],
    navSources: [],
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
    absolutePath: `${ia.root}/${file}`,
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    ia,
  };
}

describe("duplicatedRoleStatusPlanCheckDetector", () => {
  it("fires on three files comparing role to 'admin' with different shapes", async () => {
    const root = await makeRepo({
      "src/a.ts": `if (user.role === "admin") { allow(); }`,
      "src/b.ts": `if (user.role !== "admin") { deny(); }`,
      "src/c.ts": `const isAdmin = user.role === "admin" || user.role === "owner";`,
    });
    const ia = buildIndex(root, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await duplicatedRoleStatusPlanCheckDetector.run(ctxFor(anchor, ia));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("duplicated_role_status_plan_check");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.evidence.some((e) => e.includes("admin"))).toBe(true);
  });

  it("does not fire when all comparisons share the same expression shape", async () => {
    const root = await makeRepo({
      "src/a.ts": `if (user.role === "admin") {}`,
      "src/b.ts": `if (user.role === "admin") {}`,
      "src/c.ts": `if (user.role === "admin") {}`,
    });
    const ia = buildIndex(root, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await duplicatedRoleStatusPlanCheckDetector.run(ctxFor(anchor, ia));
    expect(findings).toEqual([]);
  });

  it("does not fire when only two files reference the literal", async () => {
    const root = await makeRepo({
      "src/a.ts": `if (user.role === "admin") {}`,
      "src/b.ts": `if (user.role !== "admin") {}`,
    });
    const ia = buildIndex(root, ["src/a.ts", "src/b.ts"]);
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await duplicatedRoleStatusPlanCheckDetector.run(ctxFor(anchor, ia));
    expect(findings).toEqual([]);
  });

  it("gives each literal anchored on one file its own discriminator", async () => {
    // One finding per literal, no `symbol`, all anchored on the lex-first
    // file — so two literals anchored on one file share
    // `duplicated_role_status_plan_check::<file>::`. Measured on n8n:
    // 8 findings lost this way.
    const root = await makeRepo({
      "src/a.ts": `if (user.role === "admin") { allow(); }\nif (job.status === "running") { wait(); }`,
      "src/b.ts": `if (user.role !== "admin") { deny(); }\nif (job.status !== "running") { stop(); }`,
      "src/c.ts": `const isAdmin = user.role === "admin" || user.role === "owner";\nconst busy = job.status === "running" || job.status === "queued";`,
    });
    const ia = buildIndex(root, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const anchor = Object.keys(ia.files).sort()[0]!;
    const findings = await duplicatedRoleStatusPlanCheckDetector.run(ctxFor(anchor, ia));
    expect(findings.length).toBeGreaterThan(1);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(findings.length);
  });

  it("emits nothing when ctx.ia is absent", async () => {
    const findings = await duplicatedRoleStatusPlanCheckDetector.run({
      kind: "language-js",
      file: "src/a.ts",
      absolutePath: "/tmp/src/a.ts",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
