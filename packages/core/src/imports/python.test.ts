import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildImportGraph } from "./build.js";

/**
 * The Python contribution to the shared import graph. These tests are
 * the guard on blocker 2 of the 0.14.0 release: before this, every
 * Python file scored `blast_radius: 0`, which since 0.13.0 is 0.20 of
 * `agent_risk`.
 */

let root: string;

async function write(rel: string, source: string): Promise<string> {
  const abs = join(root, rel);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(abs, source);
  return abs;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "crimes-pyimports-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildImportGraph — Python edges", () => {
  it("resolves absolute, single-dot, and double-dot imports", async () => {
    const files = [
      await write("billing/__init__.py", ""),
      await write("billing/rates.py", "STANDARD = 0.2\n"),
      await write("billing/service.py", "from .rates import STANDARD\n"),
      await write("billing/tax/__init__.py", ""),
      await write("billing/tax/vat.py", "from ..rates import STANDARD\n"),
      await write("app.py", "from billing.service import compute\n"),
    ];

    const graph = await buildImportGraph({ root, files });
    const resolved = graph.edges
      .filter((e) => e.to.length > 0)
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();

    expect(resolved).toEqual([
      "app.py -> billing/service.py",
      "billing/service.py -> billing/rates.py",
      "billing/tax/vat.py -> billing/rates.py",
    ]);
  });

  it("marks stdlib imports external rather than unresolved", async () => {
    const files = [await write("app.py", "import datetime\nimport os.path\n")];
    const graph = await buildImportGraph({ root, files });
    expect(graph.edges.map((e) => [e.specifier, e.external])).toEqual([
      ["datetime", true],
      ["os.path", true],
    ]);
  });

  it("populates in-edges so blast radius has something to count", async () => {
    const files = [
      await write("pkg/__init__.py", ""),
      await write("pkg/core.py", "VALUE = 1\n"),
      await write("pkg/a.py", "from .core import VALUE\n"),
      await write("pkg/b.py", "from .core import VALUE\n"),
      await write("pkg/c.py", "from .a import VALUE\n"),
    ];
    const graph = await buildImportGraph({ root, files });

    const importers = (graph.in.get("pkg/core.py") ?? []).map((e) => e.from);
    expect(importers.sort()).toEqual(["pkg/a.py", "pkg/b.py"]);
  });

  it("registers Python files with no imports as graph nodes", async () => {
    const files = [await write("leaf.py", "VALUE = 1\n")];
    const graph = await buildImportGraph({ root, files });
    expect(graph.files.has("leaf.py")).toBe(true);
  });

  it("carries JS and Python edges in one graph", async () => {
    const files = [
      await write("src/util.ts", "export const x = 1;\n"),
      await write("src/main.ts", 'import { x } from "./util.js";\n'),
      await write("svc/__init__.py", ""),
      await write("svc/core.py", "VALUE = 1\n"),
      await write("svc/api.py", "from .core import VALUE\n"),
    ];
    const graph = await buildImportGraph({ root, files });

    const resolved = graph.edges
      .filter((e) => e.to.length > 0)
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();
    expect(resolved).toEqual(["src/main.ts -> src/util.ts", "svc/api.py -> svc/core.py"]);
  });

  it("never emits typeOnly or dynamic on a Python edge", async () => {
    const files = [
      await write("pkg/__init__.py", ""),
      await write("pkg/core.py", "VALUE = 1\n"),
      await write("pkg/a.py", "from .core import VALUE\n"),
    ];
    const graph = await buildImportGraph({ root, files });
    const pyEdges = graph.edges.filter((e) => e.from.endsWith(".py"));
    expect(pyEdges.length).toBeGreaterThan(0);
    for (const edge of pyEdges) {
      expect(edge.typeOnly).toBe(false);
      expect(edge.dynamic).toBe(false);
    }
  });

  it("detects a Python import cycle as a pair of edges", async () => {
    const files = [
      await write("pkg/__init__.py", ""),
      await write("pkg/a.py", "from .b import thing\n"),
      await write("pkg/b.py", "from .a import other\n"),
    ];
    const graph = await buildImportGraph({ root, files });
    const resolved = graph.edges
      .filter((e) => e.to.length > 0)
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();
    expect(resolved).toEqual(["pkg/a.py -> pkg/b.py", "pkg/b.py -> pkg/a.py"]);
  });

  it("does not throw on a Python file with syntax errors", async () => {
    const files = [
      await write("pkg/__init__.py", ""),
      await write("pkg/broken.py", "def oops(:\n"),
      await write("pkg/fine.py", "VALUE = 1\n"),
    ];
    await expect(buildImportGraph({ root, files })).resolves.toBeDefined();
  });

  it("produces identical edge order across repeated builds", async () => {
    const files = [
      await write("pkg/__init__.py", ""),
      await write("pkg/a.py", "from .c import x\nfrom .b import y\n"),
      await write("pkg/b.py", "from .c import x\n"),
      await write("pkg/c.py", "x = 1\ny = 2\n"),
    ];
    const first = await buildImportGraph({ root, files });
    const second = await buildImportGraph({ root, files });
    expect(first.edges).toEqual(second.edges);
  });
});
