import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUniversalFile } from "./universal-file.js";

describe("buildUniversalFile", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "crimes-universal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns file metadata + lazy source loader", async () => {
    const abs = join(root, "a.ts");
    const source = "line1\nline2\nline3";
    await writeFile(abs, source);
    const uf = await buildUniversalFile({ root, absolutePath: abs });
    expect(uf.file).toBe("a.ts");
    expect(uf.absolutePath).toBe(abs);
    expect(uf.extension).toBe(".ts");
    expect(uf.byteSize).toBe(source.length);
    expect(await uf.readSource()).toBe(source);
    expect(uf.lineCount).toBe(3);
  });

  it("caches source reads across calls", async () => {
    const abs = join(root, "b.ts");
    await writeFile(abs, "x");
    const uf = await buildUniversalFile({ root, absolutePath: abs });
    const first = await uf.readSource();
    await writeFile(abs, "different");
    const second = await uf.readSource();
    expect(second).toBe(first);
  });

  it("computes lineCount after readSource()", async () => {
    const abs = join(root, "c.ts");
    const source = "a\nb\nc\nd";
    await writeFile(abs, source);
    const uf = await buildUniversalFile({ root, absolutePath: abs });
    await uf.readSource();
    expect(uf.lineCount).toBe(4);
  });
});
