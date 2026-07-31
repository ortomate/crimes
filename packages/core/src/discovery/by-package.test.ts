import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildByPackage } from "./by-package.js";
import { resolveLanguagePackRouter } from "./language-pack-router.js";

let root: string;
const files: string[] = [];

async function write(rel: string, source = "x"): Promise<void> {
  const abs = join(root, rel);
  await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  await writeFile(abs, source);
  // Manifests are not part of the discovered file set — `include`
  // covers source and docs — so only source files are pushed.
  if (!/\/(package\.json|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod)$/.test(rel)) {
    files.push(abs);
  }
}

function build() {
  return buildByPackage({ root, files, router: resolveLanguagePackRouter() });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "crimes-bypkg-"));
  files.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildByPackage", () => {
  it("is undefined for a single-package repo", async () => {
    await write("package.json", "{}");
    await write("src/a.ts", "export const a = 1;");
    // Presence of `by_package` is the "this is a monorepo" signal, so
    // one entry restating the repo total would be worse than nothing.
    expect(build()).toBeUndefined();
  });

  it("reports each package in a polyglot monorepo with its dominant language", async () => {
    await write("package.json", "{}");
    await write("packages/web/package.json", "{}");
    await write("packages/web/src/app.ts", "export const a = 1;");
    await write("packages/web/src/ui.tsx", "export const b = 2;");
    await write("packages/api/pyproject.toml", "[project]\nname='api'");
    await write("packages/api/svc/main.py", "x = 1");
    await write("packages/api/svc/models.py", "y = 2");
    await write("packages/api/svc/routes.py", "z = 3");

    expect(build()).toEqual([
      {
        path: "packages/api",
        files_total: 3,
        files_by_language: { py: 3 },
        dominant_language: "py",
      },
      {
        path: "packages/web",
        files_total: 2,
        files_by_language: { js: 2 },
        dominant_language: "js",
      },
    ]);
  });

  it("attributes a file to the deepest enclosing package", async () => {
    await write("packages/outer/package.json", "{}");
    await write("packages/outer/a.ts", "export const a = 1;");
    await write("packages/outer/inner/package.json", "{}");
    await write("packages/outer/inner/b.ts", "export const b = 2;");

    const result = build();
    expect(result?.find((p) => p.path === "packages/outer")?.files_total).toBe(1);
    expect(result?.find((p) => p.path === "packages/outer/inner")?.files_total).toBe(1);
  });

  it("returns null for dominant_language when no language holds a majority", async () => {
    // 2 of 4 is not a strict majority. Labelling one dominant here
    // would put a confident label on a coin flip.
    await write("packages/a/package.json", "{}");
    await write("packages/a/x.ts", "export const x = 1;");
    await write("packages/a/y.ts", "export const y = 2;");
    await write("packages/a/p.py", "p = 1");
    await write("packages/a/q.py", "q = 2");
    await write("packages/b/package.json", "{}");
    await write("packages/b/z.ts", "export const z = 1;");

    const a = build()?.find((p) => p.path === "packages/a");
    expect(a?.files_by_language).toEqual({ js: 2, py: 2 });
    expect(a?.dominant_language).toBeNull();
  });

  it("recognises Rust and Go manifests even without a pack for them", async () => {
    await write("crates/engine/Cargo.toml", "[package]");
    await write("crates/engine/src/main.rs", "fn main() {}");
    await write("services/gw/go.mod", "module gw");
    await write("services/gw/main.go", "package main");

    expect(build()).toEqual([
      {
        path: "crates/engine",
        files_total: 1,
        files_by_language: {},
        dominant_language: null,
      },
      {
        path: "services/gw",
        files_total: 1,
        files_by_language: {},
        dominant_language: null,
      },
    ]);
  });

  it("sorts entries by path", async () => {
    await write("packages/zebra/package.json", "{}");
    await write("packages/zebra/z.ts", "export const z = 1;");
    await write("packages/alpha/package.json", "{}");
    await write("packages/alpha/a.ts", "export const a = 1;");

    expect(build()?.map((p) => p.path)).toEqual([
      "packages/alpha",
      "packages/zebra",
    ]);
  });
});
