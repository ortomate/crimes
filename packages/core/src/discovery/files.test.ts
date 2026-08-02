import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFiles } from "./files.js";

describe("discoverFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "crimes-discovery-"));
    await writeFile(join(root, "a.ts"), "");
    await writeFile(join(root, "b.js"), "");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "c.tsx"), "");
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(root, "node_modules", "x", "ignored.ts"), "");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns absolute paths sorted alphabetically", async () => {
    const files = await discoverFiles({
      root,
      include: ["**/*.{ts,tsx,js}"],
      exclude: ["node_modules/**"],
    });
    expect(files).toHaveLength(3);
    for (const f of files) expect(f.startsWith(root)).toBe(true);
    expect(files).toEqual([...files].sort());
  });

  it("honours exclude patterns", async () => {
    const files = await discoverFiles({
      root,
      include: ["**/*.ts"],
      exclude: ["node_modules/**"],
    });
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("walks dot-directories, which hold real source", async () => {
    // `.agents/`, `.claude/`, `.github/`, `.server/` all hold source that
    // a scanner reporting "no crimes detected" must have actually read.
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await writeFile(join(root, ".agents", "skills", "x.ts"), "");
    const files = await discoverFiles({
      root,
      include: ["**/*.ts"],
      exclude: [],
    });
    expect(files.some((f) => f.includes(".agents"))).toBe(true);
  });

  it("never walks .git, however the user has configured exclude", async () => {
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await writeFile(join(root, ".git", "objects", "hook.ts"), "");
    const files = await discoverFiles({
      root,
      include: ["**/*.ts"],
      exclude: [],
    });
    expect(files.some((f) => f.includes("/.git/"))).toBe(false);
  });

  it("never walks vendored dot-directories like .venv", async () => {
    await mkdir(join(root, ".venv", "lib"), { recursive: true });
    await writeFile(join(root, ".venv", "lib", "dep.ts"), "");
    const files = await discoverFiles({
      root,
      include: ["**/*.ts"],
      exclude: [],
    });
    expect(files.some((f) => f.includes(".venv"))).toBe(false);
  });
});

describe("discoverFiles honours .gitignore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "crimes-gitignore-"));
    await writeFile(join(root, "real.ts"), "");
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "bundle.ts"), "");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("excludes a directory named in .gitignore", async () => {
    await writeFile(join(root, ".gitignore"), "generated/\n");
    const files = await discoverFiles({ root, include: ["**/*.ts"], exclude: [] });
    expect(files.some((f) => f.includes("generated"))).toBe(false);
    expect(files.some((f) => f.endsWith("real.ts"))).toBe(true);
  });

  it("excludes a single file named in .gitignore", async () => {
    await writeFile(join(root, ".gitignore"), "real.ts\n");
    const files = await discoverFiles({ root, include: ["**/*.ts"], exclude: [] });
    expect(files.some((f) => f.endsWith("real.ts"))).toBe(false);
  });

  it("honours ! negation", async () => {
    // `generated/*` excludes the contents, not the directory itself, so
    // the negation can re-include. Verified against real `git
    // check-ignore`, which reports this file as NOT ignored.
    await writeFile(join(root, ".gitignore"), "generated/*\n!generated/bundle.ts\n");
    const files = await discoverFiles({ root, include: ["**/*.ts"], exclude: [] });
    expect(files.some((f) => f.includes("bundle.ts"))).toBe(true);
  });

  it("matches git: a negation cannot re-include under an excluded directory", async () => {
    // `generated/` excludes the directory itself. `git check-ignore -v`
    // reports `generated/bundle.ts` as ignored by rule 1 despite the
    // negation on rule 2. Excluding a whole directory is final.
    await writeFile(join(root, ".gitignore"), "generated/\n!generated/bundle.ts\n");
    const files = await discoverFiles({ root, include: ["**/*.ts"], exclude: [] });
    expect(files.some((f) => f.includes("bundle.ts"))).toBe(false);
  });

  it("honours a nested .gitignore relative to its own directory", async () => {
    await mkdir(join(root, "pkg", "out"), { recursive: true });
    await writeFile(join(root, "pkg", "out", "gen.ts"), "");
    await writeFile(join(root, "pkg", ".gitignore"), "out/\n");
    const files = await discoverFiles({ root, include: ["**/*.ts"], exclude: [] });
    expect(files.some((f) => f.includes("gen.ts"))).toBe(false);
    expect(files.some((f) => f.endsWith("real.ts"))).toBe(true);
  });

  it("can be turned off", async () => {
    await writeFile(join(root, ".gitignore"), "generated/\n");
    const files = await discoverFiles({
      root,
      include: ["**/*.ts"],
      exclude: [],
      respectGitignore: false,
    });
    expect(files.some((f) => f.includes("generated"))).toBe(true);
  });

  it("reports nothing unusual when there is no .gitignore", async () => {
    const files = await discoverFiles({ root, include: ["**/*.ts"], exclude: [] });
    expect(files).toHaveLength(2);
  });
});
