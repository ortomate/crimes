import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles } from "../discovery/index.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { buildJsxShapeIndex } from "../jsx/shape-index.js";
import { duplicateComponentShapeDetector } from "./duplicate-component-shape.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-dcs-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function ctxFor(file: string, root: string): Promise<LanguageJsDetectorContext> {
  const allFiles = await discoverFiles({
    root,
    include: DEFAULT_CONFIG.include,
    exclude: DEFAULT_CONFIG.exclude,
  });
  const jsxShapeIndex = await buildJsxShapeIndex({ root, files: allFiles });
  return {
    kind: "language-js",
    file,
    absolutePath: join(root, file),
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    jsxShapeIndex,
  };
}

const CARD = `export default function C() {
  return (
    <Card>
      <CardHeader>Title</CardHeader>
      <CardBody>Body text</CardBody>
      <CardFooter>Footer text</CardFooter>
    </Card>
  );
}
`;

const PANEL = `export function P() {
  return (
    <Panel>
      <PanelTitle>Heading</PanelTitle>
      <PanelSection>Section one</PanelSection>
    </Panel>
  );
}
`;

describe("duplicateComponentShapeDetector", () => {
  it("fires on three files sharing the same JSX shape", async () => {
    const root = await makeRepo({
      "src/a/Card.tsx": CARD,
      "src/b/Card.tsx": CARD,
      "src/c/Card.tsx": CARD,
    });
    const ctx = await ctxFor("src/a/Card.tsx", root);
    const findings = await duplicateComponentShapeDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("duplicate_component_shape");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.related_files).toEqual(["src/b/Card.tsx", "src/c/Card.tsx"]);
  });

  it("does not fire when only two files share the shape", async () => {
    const root = await makeRepo({
      "src/a/Card.tsx": CARD,
      "src/b/Card.tsx": CARD,
    });
    const ctx = await ctxFor("src/a/Card.tsx", root);
    const findings = await duplicateComponentShapeDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("anchors on the lex-first file (b should emit nothing)", async () => {
    const root = await makeRepo({
      "src/a/Card.tsx": CARD,
      "src/b/Card.tsx": CARD,
      "src/c/Card.tsx": CARD,
    });
    const ctxB = await ctxFor("src/b/Card.tsx", root);
    const findings = await duplicateComponentShapeDetector.run(ctxB);
    expect(findings).toEqual([]);
  });

  it("gives two shape groups anchored on one file distinct fingerprints", async () => {
    // This detector carries neither `symbol` nor `lines`, so two shape
    // groups anchored on the same file share
    // `duplicate_component_shape::<file>::`. Measured on hono: three
    // findings on one benchmarks/jsx file, two of them lost.
    const root = await makeRepo({
      "src/a/Card.tsx": `${CARD}\n${PANEL}`,
      "src/b/Card.tsx": `${CARD}\n${PANEL}`,
      "src/c/Card.tsx": `${CARD}\n${PANEL}`,
    });
    const ctx = await ctxFor("src/a/Card.tsx", root);
    const findings = await duplicateComponentShapeDetector.run(ctx);
    expect(findings.length).toBeGreaterThan(1);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(findings.length);
  });

  it("keys the discriminator on the shape hash, not on emission order", async () => {
    const files = {
      "src/a/Card.tsx": CARD,
      "src/b/Card.tsx": CARD,
      "src/c/Card.tsx": CARD,
    };
    const first = await duplicateComponentShapeDetector.run(
      await ctxFor("src/a/Card.tsx", await makeRepo(files)),
    );
    const second = await duplicateComponentShapeDetector.run(
      await ctxFor(
        "src/a/Card.tsx",
        await makeRepo({ ...files, "src/d/Other.tsx": PANEL }),
      ),
    );
    expect(first[0]!.discriminator).toBeDefined();
    expect(second[0]!.discriminator).toBe(first[0]!.discriminator);
  });

  it("emits nothing when jsxShapeIndex is absent", async () => {
    const findings = await duplicateComponentShapeDetector.run({
      kind: "language-js",
      file: "src/a/Card.tsx",
      absolutePath: "/tmp/src/a/Card.tsx",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
