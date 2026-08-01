import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { hashFunction, hashJsxSubtree, hashSlice } from "./hash.js";

async function parseTs(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "crimes-hash-"));
  const file = join(dir, "snippet.ts");
  await writeFile(file, source, "utf8");
  return { source, ast: parseFile({ absolutePath: file, source }) };
}

async function parseTsx(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "crimes-hash-"));
  const file = join(dir, "Component.tsx");
  await writeFile(file, source, "utf8");
  return { source, ast: parseFile({ absolutePath: file, source }) };
}

describe("hashSlice", () => {
  it("ignores whitespace and comments for both hashes", () => {
    const a = hashSlice(`function foo() { return 1; }`);
    const b = hashSlice(
      `function   foo() {\n` + `  // comment\n` + `  return /* inline */ 1;\n` + `}`,
    );
    expect(a.exact).toBe(b.exact);
    expect(a.shape).toBe(b.shape);
    expect(a.tokens).toBe(b.tokens);
  });

  it("returns zero-token hashes for an empty slice", () => {
    const h = hashSlice("");
    expect(h.tokens).toBe(0);
    expect(h.exact).toBe(h.shape);
  });
});

describe("hashFunction", () => {
  it("produces identical exact + shape hashes for identical functions", async () => {
    const { source: src1, ast: ast1 } = await parseTs(
      `function plus(a: number, b: number) {\n` + `  return a + b;\n` + `}\n`,
    );
    const { source: src2, ast: ast2 } = await parseTs(
      `function plus(a: number, b: number) {\n` + `  return a + b;\n` + `}\n`,
    );
    const h1 = hashFunction(ast1.functions[0]!, src1);
    const h2 = hashFunction(ast2.functions[0]!, src2);
    expect(h1.exact).toBe(h2.exact);
    expect(h1.shape).toBe(h2.shape);
  });

  it("yields the same shape hash and a different exact hash when identifiers are renamed", async () => {
    const { source: src1, ast: ast1 } = await parseTs(
      `function add(a: number, b: number) {\n` +
        `  const sum = a + b;\n` +
        `  return sum;\n` +
        `}\n`,
    );
    const { source: src2, ast: ast2 } = await parseTs(
      `function add(x: number, y: number) {\n` +
        `  const total = x + y;\n` +
        `  return total;\n` +
        `}\n`,
    );
    const h1 = hashFunction(ast1.functions[0]!, src1);
    const h2 = hashFunction(ast2.functions[0]!, src2);
    expect(h1.shape).toBe(h2.shape);
    expect(h1.exact).not.toBe(h2.exact);
  });

  it("produces different shape hashes for different control flow", async () => {
    const { source: src1, ast: ast1 } = await parseTs(
      `function describe(n: number) {\n` +
        `  if (n > 0) {\n` +
        `    return "positive";\n` +
        `  }\n` +
        `  return "other";\n` +
        `}\n`,
    );
    const { source: src2, ast: ast2 } = await parseTs(
      `function describe(n: number) {\n` +
        `  switch (n) {\n` +
        `    case 0: return "zero";\n` +
        `    default: return "other";\n` +
        `  }\n` +
        `}\n`,
    );
    const h1 = hashFunction(ast1.functions[0]!, src1);
    const h2 = hashFunction(ast2.functions[0]!, src2);
    expect(h1.shape).not.toBe(h2.shape);
    expect(h1.exact).not.toBe(h2.exact);
  });

  it("counts tokens — useful for filtering trivially short candidates", async () => {
    const { source, ast } = await parseTs(`function tiny() { return 1; }\n`);
    const h = hashFunction(ast.functions[0]!, source);
    expect(h.tokens).toBeGreaterThan(0);
    expect(h.tokens).toBeLessThan(20);
  });
});

describe("hashJsxSubtree", () => {
  it("collides on identical components", async () => {
    const { source: src1, ast: ast1 } = await parseTsx(
      `export default function A() {\n` +
        `  return (\n` +
        `    <Card title="hi">\n` +
        `      <Button label="ok" />\n` +
        `    </Card>\n` +
        `  );\n` +
        `}\n`,
    );
    const { source: src2, ast: ast2 } = await parseTsx(
      `export default function B() {\n` +
        `  return (\n` +
        `    <Card title="hi">\n` +
        `      <Button label="ok" />\n` +
        `    </Card>\n` +
        `  );\n` +
        `}\n`,
    );
    const card1 = ast1.jsxElements![0]!;
    const card2 = ast2.jsxElements![0]!;
    const h1 = hashJsxSubtree(card1, src1);
    const h2 = hashJsxSubtree(card2, src2);
    expect(h1.exact).toBe(h2.exact);
    expect(h1.shape).toBe(h2.shape);
  });
});
