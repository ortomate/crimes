import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles } from "../discovery/index.js";
import { DEFAULT_CONFIG } from "../config.js";
import { buildImportGraph } from "./build.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-imports-"));
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

describe("buildImportGraph", () => {
  it("returns an empty-ish graph for an empty repo", async () => {
    const root = await makeRepo({});
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });
    expect(graph.edges).toEqual([]);
    expect(graph.files.size).toBe(0);
    expect(graph.in.size).toBe(0);
    expect(graph.out.size).toBe(0);
    expect(graph.limited).toBeUndefined();
  });

  it("walks a three-file chain a → b → c", async () => {
    const root = await makeRepo({
      "src/a.ts": `import { b } from "./b";\nexport const a = b;\n`,
      "src/b.ts": `import { c } from "./c";\nexport const b = c;\n`,
      "src/c.ts": `export const c = 1;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const aOut = graph.out.get("src/a.ts") ?? [];
    expect(aOut).toHaveLength(1);
    expect(aOut[0]!.to).toBe("src/b.ts");
    expect(aOut[0]!.external).toBe(false);

    const cIn = graph.in.get("src/c.ts") ?? [];
    expect(cIn).toHaveLength(1);
    expect(cIn[0]!.from).toBe("src/b.ts");

    // c is a source and a target — it appears in `files`.
    expect(graph.files.has("src/c.ts")).toBe(true);
  });

  it("captures a cycle a → b → a without looping forever", async () => {
    const root = await makeRepo({
      "src/a.ts": `import { b } from "./b";\nexport const a = b;\n`,
      "src/b.ts": `import { a } from "./a";\nexport const b = a;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    expect(graph.out.get("src/a.ts")?.[0]?.to).toBe("src/b.ts");
    expect(graph.out.get("src/b.ts")?.[0]?.to).toBe("src/a.ts");
    expect(graph.in.get("src/a.ts")?.[0]?.from).toBe("src/b.ts");
    expect(graph.in.get("src/b.ts")?.[0]?.from).toBe("src/a.ts");
  });

  it("resolves a relative specifier with the omitted extension", async () => {
    const root = await makeRepo({
      "src/a.ts": `import { b } from "./b";\nexport const a = b;\n`,
      "src/b.ts": `export const b = 1;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const aOut = graph.out.get("src/a.ts") ?? [];
    expect(aOut).toHaveLength(1);
    expect(aOut[0]!.specifier).toBe("./b");
    expect(aOut[0]!.to).toBe("src/b.ts");
  });

  it("resolves a NodeNext-style specifier where ./b.js means ./b.ts", async () => {
    const root = await makeRepo({
      "src/a.ts": `import { b } from "./b.js";\nexport const a = b;\n`,
      "src/b.ts": `export const b = 1;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const aOut = graph.out.get("src/a.ts") ?? [];
    expect(aOut).toHaveLength(1);
    expect(aOut[0]!.specifier).toBe("./b.js");
    expect(aOut[0]!.to).toBe("src/b.ts");
  });

  it("resolves an index re-export when the specifier names a directory", async () => {
    const root = await makeRepo({
      "src/a.ts": `import { b } from "./util";\nexport const a = b;\n`,
      "src/util/index.ts": `export const b = 1;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const aOut = graph.out.get("src/a.ts") ?? [];
    expect(aOut[0]!.to).toBe("src/util/index.ts");
  });

  it("resolves tsconfig.json `paths` aliases", async () => {
    const root = await makeRepo({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
      "src/a.ts": `import { b } from "@/lib/b";\nexport const a = b;\n`,
      "src/lib/b.ts": `export const b = 1;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const aOut = graph.out.get("src/a.ts") ?? [];
    expect(aOut).toHaveLength(1);
    expect(aOut[0]!.specifier).toBe("@/lib/b");
    expect(aOut[0]!.to).toBe("src/lib/b.ts");
    expect(aOut[0]!.external).toBe(false);
  });

  it("marks bare module specifiers as external and excludes them from in/out", async () => {
    const root = await makeRepo({
      "src/a.ts":
        `import { readFileSync } from "node:fs";\n` +
        `import React from "react";\n` +
        `export const a = readFileSync;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const edges = graph.edges.filter((e) => e.from === "src/a.ts");
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.external)).toBe(true);
    // Externals show up in the `out` list (so consumers can see them) but
    // never produce a real `to` and never appear as an in-edge.
    expect(graph.in.size).toBe(0);
    const externalSpecifiers = edges.map((e) => e.specifier).sort();
    expect(externalSpecifiers).toEqual(["node:fs", "react"]);
  });

  it("captures dynamic import() with a literal specifier", async () => {
    const root = await makeRepo({
      "src/a.ts":
        `export async function load() {\n` +
        `  const mod = await import("./b");\n` +
        `  return mod;\n` +
        `}\n`,
      "src/b.ts": `export const b = 1;\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const aOut = graph.out.get("src/a.ts") ?? [];
    expect(aOut).toHaveLength(1);
    expect(aOut[0]!.dynamic).toBe(true);
    expect(aOut[0]!.to).toBe("src/b.ts");
  });

  it("skips dynamic import() with a non-literal specifier without erroring", async () => {
    const root = await makeRepo({
      "src/a.ts":
        `export async function load(name: string) {\n` +
        `  const mod = await import(name);\n` +
        `  return mod;\n` +
        `}\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    expect(graph.edges).toEqual([]);
  });

  it("flags type-only imports on the edge", async () => {
    const root = await makeRepo({
      "src/a.ts": `import type { B } from "./b";\nexport type A = B;\n`,
      "src/b.ts": `export interface B { kind: "b" }\n`,
    });
    const files = await discover(root);
    const graph = await buildImportGraph({ root, files });

    const aOut = graph.out.get("src/a.ts") ?? [];
    expect(aOut).toHaveLength(1);
    expect(aOut[0]!.typeOnly).toBe(true);
    expect(aOut[0]!.to).toBe("src/b.ts");
  });

  it("sets `limited` when more files were discovered than the budget allows", async () => {
    // Build six source files, then run with a budget of three.
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) {
      files[`src/f${i}.ts`] = `export const f${i} = ${i};\n`;
    }
    const root = await makeRepo(files);
    const discovered = await discover(root);
    const graph = await buildImportGraph({
      root,
      files: discovered,
      maxFiles: 3,
    });
    expect(graph.limited).toBe(true);
    expect(graph.limitedReason).toMatch(/truncated/);
  });
});
