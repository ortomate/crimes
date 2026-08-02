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
    // The include list mirrors the zero-config default, so it is a
    // multi-language array rather than a single collapsed JS glob.
    expect(out).toContain('"**/*.{ts,tsx,js,jsx,mjs,cjs,cts,mts}"');
    expect(out).toContain('"**/*.{py,pyi}"');
  });

  it("tightens the JS glob to ts-only when no JS files are present", async () => {
    const dir = await makeRepo({ "src/a.ts": "" });
    const out = await generateConfig({ root: dir, detect: true });
    expect(out).toContain('"**/*.{ts,tsx}"');
    expect(out).not.toContain('"**/*.{ts,tsx,js,jsx,mjs,cjs,cts,mts}"');
    // Narrowing the JS glob must not drop the other language globs.
    expect(out).toContain('"**/*.{py,pyi}"');
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

/** Does any glob in `include` claim a file with this extension? */
function claims(include: string[], ext: string): boolean {
  return include.some((glob) => {
    const braced = glob.match(/\{([^}]+)\}/);
    if (braced?.[1]) return braced[1].split(",").includes(ext);
    return glob.endsWith(`.${ext}`);
  });
}

describe("generateConfig does not narrow the scan below zero-config", () => {
  it("claims Python when the repo contains Python", async () => {
    const dir = await makeRepo({
      "src/app.ts": "export const a = 1;",
      "svc/main.py": "def main():\n    pass\n",
    });
    const parsed = JSON.parse(await generateConfig({ root: dir, detect: true }));
    expect(claims(parsed.include, "py")).toBe(true);
  });

  it("claims every language present in the repo", async () => {
    const dir = await makeRepo({
      "src/app.ts": "export const a = 1;",
      "svc/main.py": "def main():\n    pass\n",
      "core/lib.rs": "fn main() {}",
      "docs/guide.md": "# Guide",
    });
    const parsed = JSON.parse(await generateConfig({ root: dir, detect: true }));
    for (const ext of ["ts", "py", "rs", "md"]) {
      expect(claims(parsed.include, ext), `include should claim .${ext}`).toBe(true);
    }
  });

  it("still narrows the JS glob when no .js-family files exist", async () => {
    const dir = await makeRepo({ "src/a.ts": "", "svc/main.py": "" });
    const parsed = JSON.parse(await generateConfig({ root: dir, detect: true }));
    expect(claims(parsed.include, "ts")).toBe(true);
    expect(claims(parsed.include, "js")).toBe(false);
    // ...without dropping Python on the way past.
    expect(claims(parsed.include, "py")).toBe(true);
  });

  it("claims Python with detect=false too", async () => {
    const parsed = JSON.parse(await generateConfig({ root: ".", detect: false }));
    expect(claims(parsed.include, "py")).toBe(true);
    expect(claims(parsed.include, "ts")).toBe(true);
  });

  it("treats Python test conventions as non-domain", async () => {
    const dir = await makeRepo({
      "svc/main.py": "def main():\n    pass\n",
      "tests/test_main.py": "def test_main():\n    assert True\n",
    });
    const parsed = JSON.parse(await generateConfig({ root: dir, detect: true }));
    const tiers: string[] = parsed.scopeTiers.nonDomain;
    expect(
      tiers.some((t) => t.includes("test_") || t.includes("_test")),
      `scopeTiers should recognise a Python test file, got ${JSON.stringify(tiers)}`,
    ).toBe(true);
  });
});
