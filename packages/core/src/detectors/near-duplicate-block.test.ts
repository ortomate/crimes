import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFiles } from "../discovery/index.js";
import { buildFunctionHashIndex } from "../ast-hash/function-index.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { DetectorContext } from "../detector.js";
import { nearDuplicateBlockDetector } from "./near-duplicate-block.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-ndb-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function ctxFor(file: string, root: string): Promise<DetectorContext> {
  const all = await discoverFiles({
    root,
    include: DEFAULT_CONFIG.include,
    exclude: DEFAULT_CONFIG.exclude,
  });
  const functionHashIndex = await buildFunctionHashIndex({ root, files: all });
  return {
    file,
    absolutePath: join(root, file),
    source: "",
    parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
    config: DEFAULT_CONFIG,
    functionHashIndex,
  };
}

// 40+ token body — same shape across both functions, different names.
const VARIANT_A = `export function compute(items, opts) {
  const collected = [];
  let counter = 0;
  for (const candidate of items) {
    if (candidate.active && opts.includeActive) {
      collected.push({ id: candidate.id, weight: opts.factor });
      counter += 1;
    } else {
      collected.push({ id: candidate.legacyId, weight: 0 });
    }
  }
  return { collected, counter };
}
`;

const VARIANT_B = `export function gather(records, settings) {
  const aggregated = [];
  let tally = 0;
  for (const entry of records) {
    if (entry.active && settings.includeActive) {
      aggregated.push({ id: entry.id, weight: settings.factor });
      tally += 1;
    } else {
      aggregated.push({ id: entry.legacyId, weight: 0 });
    }
  }
  return { aggregated, tally };
}
`;

describe("nearDuplicateBlockDetector", () => {
  it("fires when two files share a shape (renamed identifiers)", async () => {
    const root = await makeRepo({
      "src/a.ts": VARIANT_A,
      "src/b.ts": VARIANT_B,
    });
    const ctx = await ctxFor("src/a.ts", root);
    const findings = await nearDuplicateBlockDetector.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("near_duplicate_block");
    expect(findings[0]!.severity).toBe("medium");
  });

  it("defers to exact_duplicate when the bodies are verbatim-identical", async () => {
    const root = await makeRepo({
      "src/a.ts": VARIANT_A,
      "src/b.ts": VARIANT_A,
    });
    const ctx = await ctxFor("src/a.ts", root);
    const findings = await nearDuplicateBlockDetector.run(ctx);
    // exact_duplicate handles this; near_duplicate stays quiet.
    expect(findings).toEqual([]);
  });

  it("emits nothing when ctx.functionHashIndex is absent", async () => {
    const findings = await nearDuplicateBlockDetector.run({
      file: "src/a.ts",
      absolutePath: "/tmp/src/a.ts",
      source: "",
      parsed: { lineCount: 0, functions: [], dateNowOrNewDateUses: [] },
      config: DEFAULT_CONFIG,
    });
    expect(findings).toEqual([]);
  });
});
