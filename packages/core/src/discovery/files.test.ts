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

  it("skips hidden directories by default", async () => {
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, ".hidden", "x.ts"), "");
    const files = await discoverFiles({
      root,
      include: ["**/*.ts"],
      exclude: [],
    });
    expect(files.some((f) => f.includes(".hidden"))).toBe(false);
  });
});
