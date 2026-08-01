import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "@crimes/language-js";
import { findJsxElements, walkJsx } from "./walk.js";

async function parseTsx(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "crimes-jsx-"));
  const file = join(dir, "Component.tsx");
  await writeFile(file, source, "utf8");
  return { source, ast: parseFile({ absolutePath: file, source }) };
}

describe("walkJsx", () => {
  it("returns an empty list for a file with no JSX", async () => {
    const { source, ast } = await parseTsx(`export const greeting = "hello";\n`);
    expect(walkJsx({ source, ast })).toEqual([]);
    expect(ast.jsxElements).toBeUndefined();
  });

  it("captures self-closing elements as roots with no children", async () => {
    const { source, ast } = await parseTsx(
      `export default function App() {\n` +
        `  return <Button label="Save" disabled />;\n` +
        `}\n`,
    );
    const roots = walkJsx({ source, ast });
    expect(roots).toHaveLength(1);
    const button = roots[0]!;
    expect(button.name).toBe("Button");
    expect(button.selfClosing).toBe(true);
    expect(button.children).toEqual([]);
    expect(button.attributes.get("label")).toEqual({
      kind: "string",
      value: "Save",
    });
    expect(button.attributes.get("disabled")).toEqual({
      kind: "boolean",
      value: true,
    });
  });

  it("nests children inside their parent element and skips fragment wrappers", async () => {
    const { source, ast } = await parseTsx(
      `export default function App() {\n` +
        `  return (\n` +
        `    <>\n` +
        `      <Card title="A"><span>hi</span></Card>\n` +
        `      <Card title="B" />\n` +
        `    </>\n` +
        `  );\n` +
        `}\n`,
    );
    const roots = walkJsx({ source, ast });
    expect(roots.map((r) => r.name)).toEqual(["Card", "Card"]);
    expect(roots[0]!.selfClosing).toBe(false);
    expect(roots[0]!.children).toHaveLength(1);
    const inner = roots[0]!.children[0]!;
    expect(inner.kind).toBe("element");
    if (inner.kind !== "element") throw new Error();
    expect(inner.element.name).toBe("span");
    expect(inner.element.children).toEqual([{ kind: "text", value: "hi" }]);
  });

  it("captures expression and spread attributes verbatim", async () => {
    const { source, ast } = await parseTsx(
      `export default function App(props: any) {\n` +
        `  return <Foo style={{ width: 800 }} {...props} count={count + 1} />;\n` +
        `}\n`,
    );
    const roots = walkJsx({ source, ast });
    expect(roots).toHaveLength(1);
    const foo = roots[0]!;
    const style = foo.attributes.get("style");
    expect(style?.kind).toBe("expression");
    if (style?.kind !== "expression") throw new Error();
    expect(style.source).toBe("{ width: 800 }");

    const spreadKey = [...foo.attributes.keys()].find((k) => k.startsWith("..."))!;
    const spread = foo.attributes.get(spreadKey);
    expect(spread?.kind).toBe("spread");
    if (spread?.kind !== "spread") throw new Error();
    expect(spread.source).toBe("props");

    const count = foo.attributes.get("count");
    expect(count?.kind).toBe("expression");
    if (count?.kind !== "expression") throw new Error();
    expect(count.source).toBe("count + 1");
  });

  it("captures dotted JSX tag names like `Pricing.Tier`", async () => {
    const { source, ast } = await parseTsx(
      `export default function App() {\n` +
        `  return <Pricing.Tier name="pro" />;\n` +
        `}\n`,
    );
    const roots = walkJsx({ source, ast });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe("Pricing.Tier");
  });

  it("does not return nested elements as roots; findJsxElements recurses through them", async () => {
    const { source, ast } = await parseTsx(
      `export default function App() {\n` +
        `  return (\n` +
        `    <Card>\n` +
        `      <Button label="One" />\n` +
        `      <Section>\n` +
        `        <Button label="Two" />\n` +
        `      </Section>\n` +
        `    </Card>\n` +
        `  );\n` +
        `}\n`,
    );
    const roots = walkJsx({ source, ast });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe("Card");

    const buttons = findJsxElements(roots, (el) => el.name === "Button");
    expect(buttons.map((b) => b.attributes.get("label"))).toEqual([
      { kind: "string", value: "One" },
      { kind: "string", value: "Two" },
    ]);
  });
});
