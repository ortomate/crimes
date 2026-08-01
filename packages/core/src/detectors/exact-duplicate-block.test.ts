import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles } from "../discovery/index.js";
import { buildFunctionHashIndex } from "../ast-hash/function-index.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { LanguageJsDetectorContext } from "../detector.js";
import { exactDuplicateBlockDetector } from "./exact-duplicate-block.js";

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

  it("carries the body hash as a discriminator matching its evidence", async () => {
    const root = await makeRepo({ "src/a.ts": FN, "src/b.ts": FN });
    const ctx = await ctxFor("src/a.ts", root);
    const findings = await exactDuplicateBlockDetector.run(ctx);
    const discriminator = findings[0]!.discriminator;
    expect(discriminator).toMatch(/^[0-9a-f]{12}$/);
    // Same string a reader sees in the evidence line, so a fingerprint
    // and the finding it names can be matched up by eye.
    expect(findings[0]!.evidence[0]).toContain(`hash ${discriminator}…`);
  });

  it("gives one anchor file a distinct fingerprint per duplicate group", async () => {
    // `src/a.ts` is the lex-first member of two unrelated duplicate
    // groups. Before the discriminator these two findings shared one
    // fingerprint, so `crimes ignore` on either silenced both.
    const other = FN.replace("compute", "tally").replace("item.legacyId", "item.oldId");
    const root = await makeRepo({
      "src/a.ts": `${FN}\n${other}`,
      "src/b.ts": FN,
      "src/c.ts": other,
    });
    const ctx = await ctxFor("src/a.ts", root);
    const findings = await exactDuplicateBlockDetector.run(ctx);
    expect(findings).toHaveLength(2);
    const discriminators = findings.map((f) => f.discriminator);
    expect(new Set(discriminators).size).toBe(2);
    expect(discriminators.every((d) => d !== undefined)).toBe(true);
  });

  it("emits the same findings, in the same order, across repeated runs", async () => {
    // Regression guard for the reported non-determinism: map insertion
    // order used to track `readFile` completion order, so a function in
    // more than one group picked its group differently run to run.
    const other = FN.replace("compute", "tally").replace("item.legacyId", "item.oldId");
    const root = await makeRepo({
      "src/a.ts": `${FN}\n${other}`,
      "src/b.ts": FN,
      "src/c.ts": other,
      "src/d.ts": `${other}\n${FN}`,
    });
    const runs: string[][] = [];
    for (let i = 0; i < 5; i += 1) {
      const ctx = await ctxFor("src/a.ts", root);
      const findings = await exactDuplicateBlockDetector.run(ctx);
      runs.push(findings.map((f) => `${f.discriminator}|${f.evidence.join(";")}`));
    }
    for (const run of runs) expect(run).toEqual(runs[0]);
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
