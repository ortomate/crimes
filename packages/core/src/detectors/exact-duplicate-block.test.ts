import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles } from "../discovery/index.js";
import { buildFunctionHashIndex } from "../ast-hash/function-index.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetector, LanguageJsDetectorContext } from "../detector.js";
import { exactDuplicateBlockDetector as _exactDuplicateBlockDetector } from "./exact-duplicate-block.js";
const exactDuplicateBlockDetector = _exactDuplicateBlockDetector as LanguageJsDetector;

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-edb-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function ctxFor(file: string, root: string): Promise<LanguageJsDetectorContext> {
  const all = await discoverFiles({
    root,
    include: DEFAULT_CONFIG.include,
    exclude: DEFAULT_CONFIG.exclude,
  });
  const functionHashIndex = await buildFunctionHashIndex({ root, files: all });
  return {
    kind: "language-js",
    file,
    absolutePath: join(root, file),
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    functionHashIndex,
  };
}

const FN = `export function compute(items) {
  const out = [];
  for (const item of items) {
    if (item.active) {
      out.push(item.id);
    } else {
      out.push(item.legacyId);
    }
  }
  return out.sort();
}
`;

describe("exactDuplicateBlockDetector", () => {
  it("fires on two files with the same function body", async () => {
    const root = await makeRepo({
      "src/a.ts": FN,
      "src/b.ts": FN,
    });
    const ctx = await ctxFor("src/a.ts", root);
    const findings = await exactDuplicateBlockDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("exact_duplicate_block");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.related_files).toEqual(["src/b.ts"]);
  });

  it("anchors on the lex-first file (b emits nothing)", async () => {
    const root = await makeRepo({ "src/a.ts": FN, "src/b.ts": FN });
    const ctxB = await ctxFor("src/b.ts", root);
    const findings = await exactDuplicateBlockDetector.run(ctxB);
    expect(findings).toEqual([]);
  });

  it("ignores trivially-short helpers below the token threshold", async () => {
    const root = await makeRepo({
      "src/a.ts": `export const x = () => 1;`,
      "src/b.ts": `export const x = () => 1;`,
    });
    const ctx = await ctxFor("src/a.ts", root);
    const findings = await exactDuplicateBlockDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("ignores dense but short helpers below the line threshold", async () => {
    const body = `export function tiny(input) {
  return input.filter((item) => item.active && item.enabled && item.visible).map((item) => item.id).sort().join(",");
}
`;
    const root = await makeRepo({
      "src/a.ts": body,
      "src/b.ts": body,
    });
    const ctx = await ctxFor("src/a.ts", root);
    const findings = await exactDuplicateBlockDetector.run(ctx);
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.functionHashIndex is absent", async () => {
    const findings = await exactDuplicateBlockDetector.run({
      kind: "language-js",
      file: "src/a.ts",
      absolutePath: "/tmp/src/a.ts",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
