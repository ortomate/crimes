import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles } from "../discovery/index.js";
import { DEFAULT_CONFIG } from "../config.js";
import { buildIaIndex } from "./build.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-ia-build-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function discover(root: string): Promise<string[]> {
  return discoverFiles({
    root,
    include: DEFAULT_CONFIG.include,
    exclude: DEFAULT_CONFIG.exclude,
  });
}

describe("buildIaIndex", () => {
  it("returns an empty-ish index for an empty repo", async () => {
    const root = await makeRepo({});
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });
    expect(index.files).toEqual({});
    expect(index.routes).toEqual([]);
    expect(index.navSources).toEqual([]);
    expect(index.docs).toEqual([]);
    expect(index.agentContext.declaredBins).toEqual([]);
    expect(index.aliasGroups.length).toBeGreaterThan(0);
  });

  it("records path tokens and component names per file", async () => {
    const root = await makeRepo({
      "src/team/permissions.ts": `export default function TeamPermissions() { return null; }\n`,
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });

    const signal = index.files["src/team/permissions.ts"]!;
    expect(signal).toBeDefined();
    expect(signal.tokens).toContain("team");
    expect(signal.tokens).toContain("permission");
    expect(signal.componentName).toBe("TeamPermissions");
  });

  it("captures route paths for route-convention files", async () => {
    const root = await makeRepo({
      "src/pages/settings/billing.tsx": `export default function PricingPage() { return null; }\n`,
      "src/billing/tax.ts": `export const tax = 0;\n`,
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });

    expect(index.routes).toHaveLength(1);
    expect(index.routes[0]!.routePath).toBe("/settings/billing");
    expect(index.routes[0]!.componentName).toBe("PricingPage");
    expect(index.files["src/billing/tax.ts"]!.routes).toEqual([]);
  });

  it("captures nav sources from top-level nav arrays", async () => {
    const root = await makeRepo({
      "src/nav/sidebar.ts": `
        export const sidebar = [
          { href: "/settings/billing", label: "Billing" },
          { href: "/team", label: "Team" },
        ];
      `,
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });

    expect(index.navSources).toHaveLength(1);
    expect(index.navSources[0]!.file).toBe("src/nav/sidebar.ts");
    expect(index.navSources[0]!.entries[0]!.entries[0]!.destination).toBe(
      "/settings/billing",
    );
    expect(index.files["src/nav/sidebar.ts"]!.isNavSource).toBe(true);
  });

  it("captures UI string literals as label signals", async () => {
    const root = await makeRepo({
      "src/pages/settings/billing.tsx":
        `export const metadata = { title: "Subscription" };\n` +
        `export default function PricingPage() { return null; }\n`,
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });

    const signal = index.files["src/pages/settings/billing.tsx"]!;
    expect(signal.labels).toContainEqual(
      expect.objectContaining({ value: "Subscription", kind: "metadata_title" }),
    );
    expect(index.routes[0]!.titles).toContain("Subscription");
  });

  it("captures permission-like strings", async () => {
    const root = await makeRepo({
      "src/auth/roles.ts": `const r = "owner"; const p = "billing.manage";\n`,
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });

    const signal = index.files["src/auth/roles.ts"]!;
    const values = signal.permissions.map((p) => p.value).sort();
    expect(values).toEqual(["billing.manage", "owner"]);
  });

  it("walks markdown docs and marks broken local links", async () => {
    const root = await makeRepo({
      "docs/billing.md": `# Billing\n\n[setup](./setup.md) and [other](./real.md)\n`,
      "docs/real.md": "exists",
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });

    const billing = index.docs.find((d) => d.file === "docs/billing.md")!;
    expect(billing.headings[0]!.text).toBe("Billing");
    const broken = billing.links.find((l) => l.target === "./setup.md")!;
    const ok = billing.links.find((l) => l.target === "./real.md")!;
    expect(broken.brokenLocal).toBe(true);
    expect(ok.brokenLocal).toBe(false);
    expect(ok.resolved).toBe("docs/real.md");
  });

  it("captures the agent inventory at the repo root", async () => {
    const root = await makeRepo({
      "AGENTS.md": `# AGENTS\n\nUse \`mycli scan\` before editing.\n\n\`\`\`bash\nmycli context foo\n\`\`\`\n`,
      "package.json": JSON.stringify({
        name: "mycli",
        bin: { mycli: "dist/index.js" },
      }),
      ".claude/skills/example/SKILL.md": "---\nname: example\n---\n",
      ".agents/skills/crimes/SKILL.md": "---\nname: crimes\n---\n",
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });

    expect(index.agentContext.agentsMdPath).toBe("AGENTS.md");
    expect(index.agentContext.declaredBins).toEqual(["mycli"]);
    expect(index.agentContext.claudeSkills).toEqual([".claude/skills/example/SKILL.md"]);
    expect(index.agentContext.codexSkills).toEqual([".agents/skills/crimes/SKILL.md"]);
    expect(index.agentContext.referencedCommands.sort()).toEqual([
      "mycli context",
      "mycli scan",
    ]);
  });

  it("reports declared bins from string-form package.json bin", async () => {
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "mycli",
        bin: "dist/index.js",
      }),
    });
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });
    expect(index.agentContext.declaredBins).toEqual(["mycli"]);
  });

  it("returns the alias-group catalogue actually used", async () => {
    const root = await makeRepo({});
    const files = await discover(root);
    const index = await buildIaIndex({ root, files });
    const ids = index.aliasGroups.map((g) => g.id);
    expect(ids).toContain("tenant");
    expect(ids).toContain("plan");
  });
});
