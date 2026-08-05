import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scan } from "./scan.js";

/**
 * The working set: `--files` and `--related-to`.
 *
 * Field notes from choreograph.cc (2026-08-05): crimes was used
 * mid-design to scope cleanup for a refactor touching ~19 files. Bare
 * `scan` returned 499 findings across 209 files; `crimes context` takes
 * exactly one file. Doing that scoping by hand was called "the single
 * part of the task most worth automating, and the thing crimes is
 * closest to already solving".
 *
 * Step 0 re-verification found why `--changed` is not the answer for
 * that half of the loop: at the moment an agent is *planning* a change
 * the tree is clean, so `--changed --base main` returns nothing. The
 * working set has to be nameable before the edits exist.
 *
 * Invariant that must hold for all three selectors (`--changed`,
 * `--files`, `--related-to`): they narrow which files *emit* findings.
 * Cross-file indexes — the import graph, scoring, the risk index — are
 * always built from the whole repo, or `blast_radius` on a working-set
 * scan would report the blast radius of the working set rather than of
 * the repo.
 */

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-ws-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

/** Past the default 300-line threshold, so every file is flagged. */
function bigSource(imports: string[] = []): string {
  const head = imports.map((i) => `import "${i}";`).join("\n");
  return `${head}\n${Array.from({ length: 400 }, () => "// line").join("\n")}\n`;
}

/**
 * A ── imports ──▶ B ── imports ──▶ C
 * D is unrelated to all of them.
 */
async function chainRepo(): Promise<string> {
  return makeRepo({
    "src/a.ts": bigSource(["./b.js"]),
    "src/b.ts": bigSource(["./c.js"]),
    "src/c.ts": bigSource(),
    "src/d.ts": bigSource(),
  });
}

function filesIn(findings: { file: string }[]): string[] {
  return [...new Set(findings.map((f) => f.file))].sort();
}

describe("scan --files", () => {
  it("reports only the named files", async () => {
    const root = await chainRepo();
    try {
      const report = await scan({ root, files: ["src/a.ts", "src/d.ts"] });
      expect(filesIn(report.findings)).toEqual(["src/a.ts", "src/d.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts absolute paths as well as repo-relative ones", async () => {
    const root = await chainRepo();
    try {
      const report = await scan({ root, files: [join(root, "src/a.ts")] });
      expect(filesIn(report.findings)).toEqual(["src/a.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps blast_radius measured against the whole repo, not the working set", async () => {
    // The whole point of scoping to a working set is to ask "what should
    // I know about these files" — and the answer depends on the files
    // *outside* the set that depend on them. A working-set scan that
    // rebuilt the graph from the working set would report src/c.ts as
    // having no importers, which is the opposite of true.
    const root = await chainRepo();
    try {
      const scoped = await scan({ root, files: ["src/c.ts"] });
      const whole = await scan({ root });
      const scopedC = scoped.findings.find((f) => f.file === "src/c.ts");
      const wholeC = whole.findings.find((f) => f.file === "src/c.ts");
      expect(scopedC?.scores.blast_radius_transitive_importers).toBe(
        wholeC?.scores.blast_radius_transitive_importers,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a path that matched nothing rather than silently scanning less", async () => {
    // A typo'd path that quietly narrows the scan to nothing is the
    // worst outcome: the report reads "clean".
    const root = await chainRepo();
    try {
      const report = await scan({ root, files: ["src/typo.ts"] });
      expect(report.findings).toEqual([]);
      expect(report.coverage?.warnings ?? []).toContainEqual(
        expect.objectContaining({ kind: "working_set_path_unmatched" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("scan --related-to", () => {
  it("includes the seed and its direct import-graph neighbours", async () => {
    const root = await chainRepo();
    try {
      const report = await scan({ root, relatedTo: ["src/b.ts"] });
      // b imports c; a imports b. All three, not d.
      expect(filesIn(report.findings)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("walks further at a greater depth", async () => {
    const root = await chainRepo();
    try {
      const fromA = await scan({ root, relatedTo: ["src/a.ts"], relatedDepth: 2 });
      expect(filesIn(fromA.findings)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at depth 1 by default", async () => {
    const root = await chainRepo();
    try {
      const fromA = await scan({ root, relatedTo: ["src/a.ts"] });
      expect(filesIn(fromA.findings)).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("follows importers as well as imports", async () => {
    // "What else should I look at before changing this" is symmetric:
    // the files it depends on can break it, and the files that depend on
    // it are what it can break.
    const root = await chainRepo();
    try {
      const fromC = await scan({ root, relatedTo: ["src/c.ts"] });
      expect(filesIn(fromC.findings)).toEqual(["src/b.ts", "src/c.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the resolved working set on the report", async () => {
    // An agent must be able to confirm what was actually scanned. A
    // graph walk that silently included or excluded a file, with no way
    // to check, is exactly the shape this codebase keeps getting bitten
    // by.
    const root = await chainRepo();
    try {
      const report = await scan({ root, relatedTo: ["src/b.ts"] });
      expect(report.working_set).toEqual({
        selector: "related-to",
        seeds: ["src/b.ts"],
        depth: 1,
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the working set for --files too", async () => {
    const root = await chainRepo();
    try {
      const report = await scan({ root, files: ["src/a.ts"] });
      expect(report.working_set?.selector).toBe("files");
      expect(report.working_set?.files).toEqual(["src/a.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sets no working_set on a plain scan", async () => {
    const root = await chainRepo();
    try {
      const report = await scan({ root });
      expect(report.working_set).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
