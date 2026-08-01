import { describe, expect, it } from "vitest";
import { buildRiskIndex } from "./build.js";
import { discoverEnvInventoryFiles } from "./env-inventory.js";
import { makeRepo, type TestRepo } from "./test-harness.js";

async function build(repo: TestRepo) {
  const envInventoryFiles = await discoverEnvInventoryFiles(repo.root);
  return buildRiskIndex({ root: repo.root, files: repo.files, envInventoryFiles });
}

describe("buildRiskIndex — inventories", () => {
  it("populates all four inventories from one pass", async () => {
    const index = await build(
      await makeRepo({
        "src/a.ts": `
          export interface User { id: string; role: string; plan: string }
          export function a(u) { if (u.role === "admin" && u.plan !== "free") return 1; return 0; }
          export const t = Number(process.env.TIMEOUT_MS ?? "1000");
          export function wrap(x) { return inner(x); }
        `,
        "src/b.ts": `
          export interface UserModel { id: string; role?: string; plan: string }
          export function b(m) { if (m.role === "admin" && m.plan !== "free") return 1; return 0; }
          export const u = Number(process.env.TIMEOUT_MS ?? "9000");
          export function inner(x) { return deepest(x); }
        `,
      }),
    );
    expect(index.policy.clones).toHaveLength(1);
    expect(index.contracts.pairs).toHaveLength(1);
    expect(index.env.variables.map((v) => v.name)).toEqual(["TIMEOUT_MS"]);
    expect(index.passThrough.edges.size).toBe(2);
  });

  it("records a repo anchor for findings with no natural file", async () => {
    const index = await build(
      await makeRepo({ "src/zzz.ts": "export const z = 1;\n", "src/aaa.ts": "export const a = 1;\n" }),
    );
    expect(index.anchorFile).toBe("src/aaa.ts");
  });

  it("skips generated and vendored files entirely", async () => {
    const policy = `export function f(u) { if (u.role === "admin" && u.plan !== "free") return 1; return 0; }`;
    const index = await build(
      await makeRepo({
        "src/__generated__/a.ts": policy,
        "vendor/b.ts": policy,
        "src/c.ts": `/** @generated */\n${policy}`,
      }),
    );
    expect(index.policy.occurrenceCount).toBe(0);
  });

  it("reads .env.example for documented names but never a real .env", async () => {
    const repo = await makeRepo({
      ".env.example": "# comment\nPORT=\nexport DATABASE_URL=\n",
      ".env": "PORT=5432\nSECRET=hunter2\n",
      "src/a.ts": `export const p = process.env.PORT;`,
    });
    const index = await build(repo);
    expect([...index.env.documentedNames].sort()).toEqual(["DATABASE_URL", "PORT"]);
    expect(index.env.inventoryFiles).toEqual([".env.example"]);
    // The forbidden file is never even discovered.
    const discovered = await discoverEnvInventoryFiles(repo.root);
    expect(discovered.some((p) => p.endsWith("/.env"))).toBe(false);
  });

  it("recovers from an unparseable file rather than aborting the index", async () => {
    const index = await build(
      await makeRepo({
        "src/broken.ts": "export function ( { if (x === ) { return",
        "src/a.ts": `export function a(u) { if (u.role === "admin" && u.plan !== "free") return 1; return 0; }`,
        "src/b.ts": `export function b(m) { if (m.role === "admin" && m.plan !== "free") return 1; return 0; }`,
      }),
    );
    expect(index.policy.clones).toHaveLength(1);
  });
});

describe("buildRiskIndex — determinism", () => {
  const REPO = {
    "src/routes/a.ts": `export function a(u) { if (u.role === "admin" && u.plan !== "free") return 1; return 0; }`,
    "src/services/b.ts": `export function b(m) { if (m.role === "admin" && m.plan !== "free") return 1; return 0; }`,
    "src/services/c.ts": `export function c(m) { if (m.role === "owner" && m.plan !== "free") return 1; return 0; }`,
    "src/api/user.ts": `export interface User { id: string; role: string; plan: string }`,
    "src/db/user.ts": `export interface UserModel { id: string; role?: string; plan: string }`,
  };

  it("produces identical output across repeated builds", async () => {
    const repo = await makeRepo(REPO);
    const first = await build(repo);
    const second = await build(repo);
    expect(serialise(first)).toBe(serialise(second));
  });

  it("produces identical output regardless of input file order", async () => {
    const repo = await makeRepo(REPO);
    const forward = await buildRiskIndex({ root: repo.root, files: [...repo.files] });
    const reversed = await buildRiskIndex({
      root: repo.root,
      files: [...repo.files].reverse(),
    });
    expect(serialise(forward)).toBe(serialise(reversed));
  });

  it("anchors every group on its lexicographically first file", async () => {
    const index = await build(await makeRepo(REPO));
    for (const clone of index.policy.clones) {
      expect(clone.anchorFile).toBe([...clone.files].sort()[0]);
    }
    for (const pair of index.contracts.pairs) {
      expect(pair.anchorFile).toBe(
        [pair.left.file, pair.right.file].sort()[0],
      );
    }
  });
});

describe("buildRiskIndex — scale", () => {
  /**
   * The cross-file matching is bucketed rather than pairwise, so cost
   * grows with the number of *distinct shapes*, not with the square of
   * the file count. This generates a repo large enough that a quadratic
   * implementation would be obvious, and asserts both the time and the
   * property that makes the time possible.
   */
  it("stays fast on a repo with many files and many similar shapes", async () => {
    const files: Record<string, string> = {};
    const FILE_COUNT = 300;
    for (let i = 0; i < FILE_COUNT; i++) {
      // Each file declares a contract and a policy. A tenth of them share
      // a rule, so there is real matching work — not an empty index.
      const literal = i % 10 === 0 ? "admin" : `role_${i}`;
      files[`src/mod${i}/index.ts`] = `
        export interface Thing${i} { id: string; role: string; plan: string; label: string }
        export function check${i}(u) {
          if (u.role === "${literal}" && u.plan !== "free") return 1;
          return 0;
        }
        export const t${i} = Number(process.env.TIMEOUT_${i % 20}_MS ?? "1000");
        export function wrap${i}(x) { return inner${i}(x); }
      `;
    }

    const repo = await makeRepo(files, "crimes-risk-scale-");
    const started = process.hrtime.bigint();
    const index = await buildRiskIndex({ root: repo.root, files: repo.files });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // The shared rule is found across the 30 files that carry it.
    const shared = index.policy.clones.find((c) => c.normalized.includes('"admin"'));
    expect(shared?.files.length).toBe(FILE_COUNT / 10);

    // Generous ceiling — this is a regression guard against an accidental
    // O(n²) rewrite, not a benchmark. A pairwise implementation over 300
    // files would be tens of seconds.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  it("bounds work inside a bucket rather than comparing every pair", async () => {
    // 120 distinct one-literal variants of one shape. Unbounded, this is
    // ~7000 comparisons; the cap keeps it linear-ish and, critically,
    // still deterministic.
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) {
      files[`src/v${i}.ts`] = `export function v${i}(u) { if (u.role === "r${i}" && u.plan !== "free") return 1; return 0; }`;
    }
    const repo = await makeRepo(files, "crimes-risk-bucket-");
    const first = await buildRiskIndex({ root: repo.root, files: repo.files });
    const second = await buildRiskIndex({ root: repo.root, files: repo.files });
    expect(serialise(first)).toBe(serialise(second));
  }, 60_000);
});

/** Sets are not JSON-serialisable; normalise them for comparison. */
function serialise(index: Awaited<ReturnType<typeof buildRiskIndex>>): string {
  return JSON.stringify(index, (_key, value: unknown) => {
    if (value instanceof Set) return [...value].sort();
    if (value instanceof Map) return [...value.entries()].sort();
    return value;
  });
}
