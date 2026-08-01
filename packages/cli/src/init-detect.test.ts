import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRepoShape, generateConfig } from "./init-detect.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-init-detect-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

describe("detectRepoShape", () => {
  it("detects pnpm workspaces", async () => {
    const dir = await makeRepo({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    });
    const shape = await detectRepoShape(dir);
    expect(shape.isMonorepo).toBe(true);
  });

  it("detects Next.js", async () => {
    const dir = await makeRepo({ "next.config.js": "module.exports = {};" });
    const shape = await detectRepoShape(dir);
    expect(shape.isNextJs).toBe(true);
  });

  it("detects Vite", async () => {
    const dir = await makeRepo({ "vite.config.ts": "" });
    const shape = await detectRepoShape(dir);
    expect(shape.isVite).toBe(true);
  });

  it("detects TS-only when no JS-family files exist", async () => {
    const dir = await makeRepo({ "src/a.ts": "export {}", "src/b.tsx": "" });
    const shape = await detectRepoShape(dir);
    expect(shape.isTsOnly).toBe(true);
  });

  it("returns isTsOnly=false when even one .js / .mjs / .cjs / .jsx file exists", async () => {
    const dir = await makeRepo({ "src/a.ts": "", "scripts/legacy.js": "" });
    const shape = await detectRepoShape(dir);
    expect(shape.isTsOnly).toBe(false);
  });

  it("picks scopeTier patterns whose target exists", async () => {
    const dir = await makeRepo({
      "scripts/x.ts": "",
      "examples/y.ts": "",
    });
    const shape = await detectRepoShape(dir);
    expect(shape.scopeTiers).toContain("scripts/**");
    expect(shape.scopeTiers).toContain("examples/**");
    expect(shape.scopeTiers).not.toContain("fixtures/**");
    // Test globs are always appended:
    expect(shape.scopeTiers).toContain("**/*.test.{ts,tsx,js,jsx}");
  });
});

describe("generateConfig", () => {
  it("emits the static template when detect=false", async () => {
    const out = await generateConfig({ root: ".", detect: false });
    expect(out).toMatch(/"\$schema": "https:\/\/crimes\.sh\/schema/);
    expect(out).toMatch(/"include": \["\*\*\/\*\.\{ts/);
  });

  it("tightens include to ts-only when no JS files are present", async () => {
    const dir = await makeRepo({ "src/a.ts": "" });
    const out = await generateConfig({ root: dir, detect: true });
    expect(out).toContain('"include": ["**/*.{ts,tsx}"]');
  });

  it("adds .next/.vercel excludes when next.config.* exists", async () => {
    const dir = await makeRepo({ "next.config.js": "", "src/a.ts": "" });
    const out = await generateConfig({ root: dir, detect: true });
    expect(out).toContain('"**/.next/**"');
    expect(out).toContain('"**/.vercel/**"');
  });

  it("populates scopeTiers.nonDomain with only existing patterns + test globs", async () => {
    const dir = await makeRepo({ "scripts/x.ts": "" });
    const out = await generateConfig({ root: dir, detect: true });
    const parsed = JSON.parse(out);
    expect(parsed.scopeTiers.nonDomain).toContain("scripts/**");
    expect(parsed.scopeTiers.nonDomain).not.toContain("examples/**");
    expect(parsed.scopeTiers.nonDomain).toContain("**/*.test.{ts,tsx,js,jsx}");
  });
});
