import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { discoverFiles } from "../discovery/index.js";
import { DEFAULT_CONFIG } from "../config.js";
import { buildImportGraph } from "../imports/build.js";
import {
  buildScoringContext,
  computeAgentRisk,
  finaliseFindingScores,
  recencyForDate,
} from "./build.js";

const execFileAsync = promisify(execFile);

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-scoring-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function discover(root: string): Promise<string[]> {
  return discoverFiles({
    root,
    include: DEFAULT_CONFIG.include,
    exclude: DEFAULT_CONFIG.exclude,
  });
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "crimes-test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "crimes-test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function initRepo(root: string): Promise<void> {
  await git(root, "init", "--initial-branch=main", "--quiet");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "initial", "--quiet");
}

async function commitFile(
  root: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(root, file), content, "utf8");
  await git(root, "add", file);
  await git(root, "commit", "-m", message, "--quiet");
}

describe("buildScoringContext > churn", () => {
  it("returns 0 for a file not present in the git log window", async () => {
    const root = await makeRepo({
      "src/a.ts": "export const a = 1;\n",
    });
    await initRepo(root);
    const files = await discover(root);
    const ctx = await buildScoringContext({ root, files, imports: undefined });
    expect(ctx.churn.forFile("src/unknown.ts")).toBe(0);
  });

  it("scales linearly with commit count up to the saturation cap", async () => {
    // 5 additional commits (plus the initial) = 6 total → 6/20 = 0.30.
    // Keeping the count small so the test stays fast under the full
    // suite's parallelism contention.
    const root = await makeRepo({ "src/a.ts": "export const a = 0;\n" });
    await initRepo(root);
    for (let i = 1; i <= 5; i++) {
      await commitFile(root, "src/a.ts", `export const a = ${i};\n`, `bump ${i}`);
    }
    const files = await discover(root);
    const ctx = await buildScoringContext({ root, files, imports: undefined });
    // 6 commits / 20 cap = 0.30; allow ±0.05 in case the platform's git
    // collapses identical-tree commits.
    expect(ctx.churn.forFile("src/a.ts")).toBeGreaterThan(0.2);
    expect(ctx.churn.forFile("src/a.ts")).toBeLessThanOrEqual(1);
    expect(ctx.churn.limited).toBe(false);
  }, 20_000);

  it("marks the index as `limited` when the repo is a shallow clone", async () => {
    const root = await makeRepo({ "src/a.ts": "export const a = 1;\n" });
    await initRepo(root);
    // Mark the repo as shallow by creating the marker file directly —
    // `git clone --depth` would require network.
    await writeFile(join(root, ".git/shallow"), "", "utf8");
    const files = await discover(root);
    const ctx = await buildScoringContext({ root, files, imports: undefined });
    expect(ctx.churn.limited).toBe(true);
    expect(ctx.churn.limitedReason).toMatch(/shallow/);
  });

  it("marks the index as `limited` when there is no git repo", async () => {
    const root = await makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const files = await discover(root);
    const ctx = await buildScoringContext({ root, files, imports: undefined });
    expect(ctx.churn.limited).toBe(true);
    expect(ctx.churn.forFile("src/a.ts")).toBe(0);
  });
});

describe("buildScoringContext > test_gap", () => {
  it("returns 0 for a file with a sibling .test.ts that imports it", async () => {
    const root = await makeRepo({
      "src/util.ts": "export const u = 1;\n",
      "src/util.test.ts": `import { u } from "./util";\n` + `console.log(u);\n`,
    });
    const files = await discover(root);
    const imports = await buildImportGraph({ root, files });
    const ctx = await buildScoringContext({ root, files, imports });
    expect(ctx.testGap.forFile("src/util.ts")).toBe(0);
  });

  it("returns 0 for a file imported by a test file under __tests__", async () => {
    const root = await makeRepo({
      "src/util.ts": "export const u = 1;\n",
      "src/__tests__/util.test.ts":
        `import { u } from "../util";\n` + `console.log(u);\n`,
    });
    const files = await discover(root);
    const imports = await buildImportGraph({ root, files });
    const ctx = await buildScoringContext({ root, files, imports });
    expect(ctx.testGap.forFile("src/util.ts")).toBe(0);
  });

  it("returns 1 for a totally untested file", async () => {
    const root = await makeRepo({
      "src/util.ts": "export const u = 1;\n",
    });
    const files = await discover(root);
    const imports = await buildImportGraph({ root, files });
    const ctx = await buildScoringContext({ root, files, imports });
    expect(ctx.testGap.forFile("src/util.ts")).toBe(1);
  });

  it("returns 0 for test files themselves", async () => {
    const root = await makeRepo({
      "src/util.test.ts": `test("ok", () => {});\n`,
    });
    const files = await discover(root);
    const imports = await buildImportGraph({ root, files });
    const ctx = await buildScoringContext({ root, files, imports });
    expect(ctx.testGap.forFile("src/util.test.ts")).toBe(0);
  });

  it("returns 0 for files no language pack claims", async () => {
    // A README having no unit test is a category error, not a risk.
    // Before 0.12.2 these scored 1.0 and were quartile-ranked against
    // code, pushing every doc into the top test_gap quartile.
    const root = await makeRepo({
      "src/util.ts": "export const u = 1;\n",
      "README.md": "# hello\n",
      "config.json": "{}\n",
    });
    const files = await discover(root);
    const imports = await buildImportGraph({ root, files });
    const ctx = await buildScoringContext({ root, files, imports });
    expect(ctx.testGap.forFile("README.md")).toBe(0);
    expect(ctx.testGap.forFile("config.json")).toBe(0);
    // The untested .ts file still registers a gap.
    expect(ctx.testGap.forFile("src/util.ts")).toBeGreaterThan(0);
  });

  it("excludes unclaimed files from the quartile population", async () => {
    // Four docs plus one untested source file: if the docs were in the
    // population they would occupy quartiles and displace the code.
    const root = await makeRepo({
      "src/a.ts": "export const a = 1;\n",
      "docs/one.md": "# 1\n",
      "docs/two.md": "# 2\n",
      "docs/three.md": "# 3\n",
      "docs/four.md": "# 4\n",
    });
    const files = await discover(root);
    const imports = await buildImportGraph({ root, files });
    const ctx = await buildScoringContext({ root, files, imports });
    for (const doc of ["docs/one.md", "docs/two.md", "docs/three.md", "docs/four.md"]) {
      expect(ctx.testGap.forFile(doc), doc).toBe(0);
    }
    expect(ctx.testGap.forFile("src/a.ts")).toBeGreaterThan(0);
  });
});

describe("buildScoringContext > blast_radius", () => {
  it("counts transitive importers", async () => {
    const root = await makeRepo({
      "src/leaf.ts": "export const v = 1;\n",
      "src/mid.ts": `import { v } from "./leaf";\nexport const m = v;\n`,
      "src/a.ts": `import { m } from "./mid";\nexport const a = m;\n`,
      "src/b.ts": `import { m } from "./mid";\nexport const b = m;\n`,
    });
    const files = await discover(root);
    const imports = await buildImportGraph({ root, files });
    const ctx = await buildScoringContext({ root, files, imports });
    // leaf has 3 transitive importers (mid + a + b); min(3/50, 1) = 0.06.
    expect(ctx.blastRadius.forFile("src/leaf.ts")).toBe(0.06);
    expect(ctx.blastRadius.forFile("src/mid.ts")).toBe(0.04);
    expect(ctx.blastRadius.forFile("src/a.ts")).toBe(0);
    // countForFile exposes the same raw count the renderer uses to print
    // "blast top-quartile (3 importers)".
    expect(ctx.blastRadius.countForFile("src/leaf.ts")).toBe(3);
    expect(ctx.blastRadius.countForFile("src/mid.ts")).toBe(2);
    expect(ctx.blastRadius.countForFile("src/a.ts")).toBe(0);
  });

  it("returns 0 when no import graph is available", async () => {
    const root = await makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const files = await discover(root);
    const ctx = await buildScoringContext({ root, files, imports: undefined });
    expect(ctx.blastRadius.forFile("src/a.ts")).toBe(0);
    expect(ctx.blastRadius.countForFile("src/a.ts")).toBe(0);
  });
});

describe("test_gap quartile pass", () => {
  it("returns the raw value for the inspected file via rawForFile", async () => {
    const dir = await makeRepo({
      "src/a.ts": "export const a = 1;",
      "src/a.test.ts": "import { a } from './a';",
      "src/b.ts": "export const b = 2;",
      "src/c.ts": "export const c = 3;",
      "src/d.ts": "export const d = 4;",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({
      root: dir,
      files,
      imports: undefined,
    });
    // a.ts has a sibling test → raw 0.5
    expect(ctx.testGap.rawForFile("src/a.ts")).toBe(0.5);
    // b.ts has no test → raw 1.0
    expect(ctx.testGap.rawForFile("src/b.ts")).toBe(1);
    // test files themselves → raw 0 (they're not under test)
    expect(ctx.testGap.rawForFile("src/a.test.ts")).toBe(0);
  });

  it("quartile-ranks test_gap across the scan when >= 4 files are present", async () => {
    const dir = await makeRepo({
      "src/a.ts": "x",
      "src/a.test.ts": "import './a';",
      "src/b.ts": "x",
      "src/b.test.ts": "import './b';",
      "src/c.ts": "x",
      "src/d.ts": "x",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({
      root: dir,
      files,
      imports: undefined,
    });
    // 4 source files: 2 have sibling tests (raw 0.5), 2 don't (raw 1.0).
    // After quartile pass:
    //   - 2 entries at raw 0.5: occupy sorted indices [0, 2) → midpoint 2/8 = 0.25 → bucket 0.25
    //     BUT snapToQuartile uses `< 0.25 → 0`, so 0.25 itself maps to bucket 0.25
    //     Wait — re-check: percentile EXACTLY 0.25 ≥ 0.25 (not <), so bucket 0.25.
    //   - 2 entries at raw 1.0: occupy sorted indices [2, 4) → midpoint 6/8 = 0.75 → bucket 0.75 (≥ 0.75 → 1)
    // The expected values per the snap thresholds at 0.25 / 0.4375 / 0.5625 / 0.75:
    //   - percentile 0.25 → bucket 0.25 (since 0.25 is the boundary and rule is `< 0.4375 → 0.25`)
    //   - percentile 0.75 → bucket 1 (since 0.75 is the boundary and rule is `>= 0.75 → 1`)
    expect(ctx.testGap.forFile("src/a.ts")).toBe(0.25);
    expect(ctx.testGap.forFile("src/c.ts")).toBe(1);
    expect(ctx.testGap.forFile("src/d.ts")).toBe(1);
  });

  it("falls back to raw values when fewer than 4 files are scanned", async () => {
    const dir = await makeRepo({
      "src/a.ts": "x",
      "src/b.ts": "x",
      "src/c.ts": "x",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({
      root: dir,
      files,
      imports: undefined,
    });
    // 3 files, all raw 1.0 → no quartile pass → forFile === rawForFile
    expect(ctx.testGap.forFile("src/a.ts")).toBe(1);
    expect(ctx.testGap.rawForFile("src/a.ts")).toBe(1);
  });
});

/**
 * Blocker 1 of the 0.14.0 Python pack.
 *
 * Python's dominant test convention is a *prefix* (`test_billing.py`
 * covers `billing.py`) where every other language crimes supports uses a
 * suffix. `TEST_FILE_RE` classified those files correctly all along, but
 * the pairing logic only stripped `.test` / `.spec` suffixes — so
 * `test_billing !== billing`, no sibling was ever found, and every
 * Python file scored `test_gap: 1.0` regardless of how well tested it
 * was. Since 0.13.0 that is 0.20 of `agent_risk`.
 */
describe("test_gap — Python naming conventions", () => {
  it("pairs test_<name>.py with <name>.py as a sibling", async () => {
    const dir = await makeRepo({
      "src/billing.py": "def charge(): pass",
      "src/test_billing.py": "from .billing import charge",
      "src/rates.py": "STANDARD = 1",
      "src/invoice.py": "def render(): pass",
      "src/ledger.py": "def post(): pass",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({ root: dir, files, imports: undefined });

    // Tested module: a sibling test exists → raw 0.5.
    expect(ctx.testGap.rawForFile("src/billing.py")).toBe(0.5);
    // Untested modules → raw 1.0.
    expect(ctx.testGap.rawForFile("src/rates.py")).toBe(1);
    expect(ctx.testGap.rawForFile("src/invoice.py")).toBe(1);
    // The test file itself is not "under test".
    expect(ctx.testGap.rawForFile("src/test_billing.py")).toBe(0);
  });

  it("pairs <name>_test.py with <name>.py", async () => {
    const dir = await makeRepo({
      "src/billing.py": "def charge(): pass",
      "src/billing_test.py": "from .billing import charge",
      "src/rates.py": "STANDARD = 1",
      "src/invoice.py": "def render(): pass",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({ root: dir, files, imports: undefined });
    expect(ctx.testGap.rawForFile("src/billing.py")).toBe(0.5);
    expect(ctx.testGap.rawForFile("src/rates.py")).toBe(1);
  });

  it("puts a tested Python module in a better quartile than an untested one", async () => {
    // The assertion that actually matters: it is not enough for the raw
    // values to differ, they have to survive the quartile pass into a
    // visibly different agent_risk contribution.
    const dir = await makeRepo({
      "src/billing.py": "def charge(): pass",
      "src/test_billing.py": "from .billing import charge",
      "src/rates.py": "STANDARD = 1",
      "src/test_rates.py": "from .rates import STANDARD",
      "src/invoice.py": "def render(): pass",
      "src/ledger.py": "def post(): pass",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({ root: dir, files, imports: undefined });

    const tested = ctx.testGap.forFile("src/billing.py");
    const untested = ctx.testGap.forFile("src/invoice.py");
    expect(tested).toBeLessThan(untested);
    expect(untested).toBe(1);

    // And the resulting agent_risk gap is real, not rounding noise: the
    // whole point is that a well-tested Python module stops being ranked
    // as if it had no test at all.
    const riskTested = computeAgentRisk({
      severity: "medium",
      intrinsic: 0.5,
      churn: 0,
      test_gap: tested,
      blast_radius: 0,
    });
    const riskUntested = computeAgentRisk({
      severity: "medium",
      intrinsic: 0.5,
      churn: 0,
      test_gap: untested,
      blast_radius: 0,
    });
    expect(riskUntested - riskTested).toBeGreaterThanOrEqual(0.15);
  });

  it("scores a Python module imported by a test file at 0", async () => {
    // The `test_gap: 0` tier needs the import graph, which Python only
    // gained in 0.14.0. Before that the best a covered module could do
    // was the 0.5 sibling tier.
    const dir = await makeRepo({
      "pkg/__init__.py": "",
      "pkg/billing.py": "def charge(): pass",
      "pkg/rates.py": "STANDARD = 1",
      "pkg/invoice.py": "def render(): pass",
      "tests/test_everything.py": "from pkg.billing import charge",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const imports = await buildImportGraph({ root: dir, files });
    const ctx = await buildScoringContext({ root: dir, files, imports });

    expect(ctx.testGap.rawForFile("pkg/billing.py")).toBe(0);
    expect(ctx.testGap.rawForFile("pkg/rates.py")).toBe(1);
  });

  it("does not pair a test with an unrelated module", async () => {
    const dir = await makeRepo({
      "src/billing.py": "def charge(): pass",
      "src/test_helpers.py": "def helper(): pass",
      "src/rates.py": "STANDARD = 1",
      "src/invoice.py": "def render(): pass",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({ root: dir, files, imports: undefined });
    expect(ctx.testGap.rawForFile("src/billing.py")).toBe(1);
  });

  it("pairs tests/test_<name>.py with <name>.py by basename", async () => {
    const dir = await makeRepo({
      "src/billing.py": "def charge(): pass",
      "src/rates.py": "STANDARD = 1",
      "src/invoice.py": "def render(): pass",
      "tests/test_billing.py": "def test_charge(): pass",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({ root: dir, files, imports: undefined });
    expect(ctx.testGap.rawForFile("src/billing.py")).toBe(0.5);
    expect(ctx.testGap.rawForFile("src/rates.py")).toBe(1);
  });

  it("recognises a JS tests/ directory the same way as __tests__/", async () => {
    // The `tests/` widening applies to both languages. A JS repo that
    // keeps tests outside src/ was previously scored as having no tests
    // at all.
    const dir = await makeRepo({
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;",
      "src/c.ts": "export const c = 3;",
      "tests/a.test.ts": "import '../src/a';",
      "__tests__/b.test.ts": "import '../src/b';",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({ root: dir, files, imports: undefined });
    expect(ctx.testGap.rawForFile("src/a.ts")).toBe(0.5);
    expect(ctx.testGap.rawForFile("src/b.ts")).toBe(0.5);
    expect(ctx.testGap.rawForFile("src/c.ts")).toBe(1);
  });

  it("leaves the JS suffix convention working unchanged", async () => {
    const dir = await makeRepo({
      "src/a.ts": "export const a = 1;",
      "src/a.test.ts": "import './a';",
      "src/b.ts": "export const b = 2;",
      "src/c.spec.ts": "import './c';",
      "src/c.ts": "export const c = 3;",
      "src/d.ts": "export const d = 4;",
    });
    await initRepo(dir);
    const files = await discover(dir);
    const ctx = await buildScoringContext({ root: dir, files, imports: undefined });
    expect(ctx.testGap.rawForFile("src/a.ts")).toBe(0.5);
    expect(ctx.testGap.rawForFile("src/c.ts")).toBe(0.5);
    expect(ctx.testGap.rawForFile("src/b.ts")).toBe(1);
  });
});

describe("computeAgentRisk", () => {
  it("follows the documented unified formula", () => {
    const got = computeAgentRisk({
      severity: "high",
      intrinsic: 0.8,
      churn: 0.65,
      test_gap: 0.2,
      blast_radius: 0.55,
    });
    // 0.40 * 0.8 + 0.20 * 0.65 + 0.20 * 0.2 + 0.20 * 0.55
    //  = 0.32 + 0.13 + 0.04 + 0.11 = 0.60
    expect(got).toBe(0.6);
  });

  it("clamps to <= 1 when every input is at maximum", () => {
    const got = computeAgentRisk({
      severity: "high",
      intrinsic: 1,
      churn: 1,
      test_gap: 1,
      blast_radius: 1,
    });
    expect(got).toBeLessThanOrEqual(1);
    expect(got).toBeGreaterThan(0.9);
  });

  it("falls back to a severity-derived intrinsic when the detector sets none", () => {
    const high = computeAgentRisk({
      severity: "high",
      churn: 0,
      test_gap: 0,
      blast_radius: 0,
    });
    const low = computeAgentRisk({
      severity: "low",
      churn: 0,
      test_gap: 0,
      blast_radius: 0,
    });
    expect(high).toBe(0.3); // 0.40 * 0.75
    expect(low).toBe(0.16); // 0.40 * 0.40
    expect(high).toBeGreaterThan(low);
  });

  it("lets the detector's own judgement outrank severity", () => {
    // The point of the 0.12.2 reweight: a low-severity finding the
    // detector considers agent-hostile (multiple sources of truth,
    // misleading name) must be able to outrank a high-severity one it
    // considers mechanical.
    const lowButConfusing = computeAgentRisk({
      severity: "low",
      intrinsic: 0.85,
      churn: 0,
      test_gap: 0,
      blast_radius: 0,
    });
    const highButMechanical = computeAgentRisk({
      severity: "high",
      intrinsic: 0.35,
      churn: 0,
      test_gap: 0,
      blast_radius: 0,
    });
    expect(lowButConfusing).toBeGreaterThan(highButMechanical);
  });

  it("ignores a non-finite intrinsic rather than producing NaN", () => {
    const got = computeAgentRisk({
      severity: "medium",
      intrinsic: Number.NaN,
      churn: 0.5,
      test_gap: 0,
      blast_radius: 0,
    });
    expect(Number.isFinite(got)).toBe(true);
    expect(got).toBe(0.32); // 0.40 * 0.55 + 0.20 * 0.5
  });
});

describe("recencyForDate", () => {
  const now = new Date("2026-05-20T12:00:00Z").getTime();

  it("returns 1.0 for a commit today", () => {
    expect(recencyForDate("2026-05-20T11:00:00Z", now)).toBe(1);
  });

  it("returns 1.0 at exactly the 7-day boundary", () => {
    expect(recencyForDate("2026-05-13T12:00:00Z", now)).toBe(1);
  });

  it("returns 1.0 for a commit a few days ago (mid-window)", () => {
    expect(recencyForDate("2026-05-17T12:00:00Z", now)).toBe(1);
  });

  it("linearly decays between 7 and 14 days", () => {
    // 10.5d old → 3.5 / 7 of the way through decay → 1 - 3.5/7 = 0.5
    const tenAndAHalfDaysAgo = new Date(now - 10.5 * 86400 * 1000).toISOString();
    expect(recencyForDate(tenAndAHalfDaysAgo, now)).toBeCloseTo(0.5, 2);
  });

  it("returns 0 for commits older than 14 days", () => {
    expect(recencyForDate("2026-05-01T12:00:00Z", now)).toBe(0);
  });

  it("returns 0 for missing/undefined input (no churn signal)", () => {
    expect(recencyForDate(undefined, now)).toBe(0);
  });

  it("returns 0 for an unparsable date string", () => {
    expect(recencyForDate("not-a-date", now)).toBe(0);
  });
});

describe("ScoringContext.recency", () => {
  it("is exposed on the context and falls back to 0 when git is unavailable", async () => {
    // Bare temp dir, no git init
    const dir = await makeRepo({ "src/a.ts": "x" });
    const files = await discover(dir);
    const ctx = await buildScoringContext({
      root: dir,
      files,
      imports: undefined,
    });
    expect(ctx.recency.forFile("src/a.ts")).toBe(0);
    expect(ctx.recency.limited).toBe(true);
  });
});

function stubFinding(
  overrides: Partial<import("../finding.js").Finding> = {},
): import("../finding.js").Finding {
  return {
    id: "crime_00001",
    type: "large_function",
    charge: "God Function",
    severity: "medium",
    confidence: 0.8,
    file: "src/foo.ts",
    summary: "stub",
    evidence: [],
    scores: { severity: 0.5, confidence: 0.8 },
    effort: "medium" as const,
    fix_shape: "placeholder — finalisation overrides if missing",
    ...overrides,
  } as import("../finding.js").Finding;
}

describe("finaliseFindingScores — applies detector defaults", () => {
  it("fills effort and fix_shape from DETECTOR_DEFAULTS when detector omits them", () => {
    const finding = stubFinding({
      effort: undefined as never,
      fix_shape: undefined as never,
    });
    finaliseFindingScores(finding, undefined);
    expect(finding.effort).toBe("small");
    expect(finding.fix_shape).toBe("extract pure helpers; keep the orchestrator thin");
  });

  it("keeps detector-supplied effort and fix_shape when set", () => {
    const finding = stubFinding({ effort: "large", fix_shape: "bespoke override" });
    finaliseFindingScores(finding, undefined);
    expect(finding.effort).toBe("large");
    expect(finding.fix_shape).toBe("bespoke override");
  });

  it("falls back to GENERIC_DEFAULT for an unknown detector type", () => {
    const finding = stubFinding({
      type: "not_a_real_detector",
      effort: undefined as never,
      fix_shape: undefined as never,
    });
    finaliseFindingScores(finding, undefined);
    expect(finding.effort).toBe("medium");
    expect(finding.fix_shape).toContain("refactor");
  });
});

describe("finaliseFindingScores — recency", () => {
  it("populates scores.recency from the scoring context", () => {
    const finding = {
      file: "src/a.ts",
      severity: "high" as const,
      scores: { severity: 0.9, confidence: 0.8 },
    } as unknown as import("../finding.js").Finding;
    const scoring = {
      churn: { forFile: () => 0, limited: false },
      testGap: { forFile: () => 1, rawForFile: () => 1 },
      blastRadius: { forFile: () => 0, countForFile: () => 0 },
      recency: { forFile: () => 0.6, limited: false },
    } as import("./build.js").ScoringContext;
    finaliseFindingScores(finding, scoring);
    expect(finding.scores.recency).toBe(0.6);
  });

  it("leaves recency undefined when scoring context is absent", () => {
    const finding = {
      file: "src/a.ts",
      severity: "low" as const,
      scores: { severity: 0.45, confidence: 0.5 },
    } as unknown as import("../finding.js").Finding;
    finaliseFindingScores(finding, undefined);
    expect(finding.scores.recency).toBeUndefined();
  });
});
