# Release A: Front-door redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `crimes scan` from a flat catalogue of findings into a file-grouped editing plan with a concrete next command, expose `clues` on `context --json` for agents, and offer auto-init on first run.

**Architecture:** All work lives in the existing pnpm monorepo (`@crimes/core`, `@crimes/reporter`, `@crimes/cli`). Changes are additive at the JSON schema level (`schema_version` stays `0.1.0`). Core gains a quartile-rank pass on `test_gap`, a recency index, a `tier` field on `Finding`, a `recency` field on `FindingScores`, and a `clues` object on `ContextReport`. Reporter rewrites the human `scan` layout and renders `clues` on `context`. CLI adds `--top` / `--flat` / `--no-recency` / `--init` / `--no-init` flags, a generator-driven `init`, and a two-prompt auto-init module wired into a global Commander pre-action hook.

**Tech Stack:** TypeScript 5.6, Node ≥18, Vitest, Commander.js 12, zod, tsup, pnpm workspaces. Existing test patterns: vitest `describe`/`it`/`expect`, `mkdtemp` + `git` spawn for repo fixtures (see `packages/core/src/scoring/build.test.ts`).

**Companion spec:** `docs/superpowers/specs/2026-05-20-release-a-front-door-design.md`. Every decision in the plan traces back to a section there.

**Versioning:** Patch-bump `packages/cli/package.json` on every commit that changes finding ordering, scoring, or detector behaviour, and re-run `pnpm run evals` (committing `evals/results/<version>/` alongside). No Changesets between tasks. One Changeset at Task 17 cuts the release as a minor (`0.9.2 → 0.10.0`).

**Tests-first:** every code-touching task starts with a failing test. The "Run test to verify it fails" step is mandatory: if it passes, the test isn't actually exercising the new behaviour.

---

<span id="task-1-config-schema--scopetiersnondomain-and-scantopfiles"></span>

## Task 1: Config schema: `scopeTiers.nonDomain` and `scan.topFiles`

**Spec ref:** §5.5 (scope tiers), §5.2 (top-N default).

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config.test.ts`

**Background:** Config uses zod for validation; `loadConfig` returns `CrimesConfig`. New keys must be optional, zod-validated, and surface in `DEFAULT_CONFIG`. The runtime default for `scopeTiers.nonDomain` is the static seven-pattern list from spec §5.5; `scan.topFiles` defaults to `5`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/config.test.ts`:

```typescript
describe("scopeTiers", () => {
  it("defaults to the static seven-pattern non-domain list", async () => {
    const root = await makeTempDir();
    const cfg = loadConfig(root);
    expect(cfg.scopeTiers).toBeDefined();
    expect(cfg.scopeTiers!.nonDomain).toEqual([
      "scripts/**",
      "examples/**",
      "fixtures/**",
      "public/**",
      "**/__tests__/**",
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}",
    ]);
  });

  it("honours a user-supplied empty list (opt-out)", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scopeTiers: { nonDomain: [] } });
    expect(loadConfig(root).scopeTiers!.nonDomain).toEqual([]);
  });

  it("honours a user-supplied custom list", async () => {
    const root = await makeTempDir();
    await writeConfig(root, {
      scopeTiers: { nonDomain: ["packages/legacy/**"] },
    });
    expect(loadConfig(root).scopeTiers!.nonDomain).toEqual([
      "packages/legacy/**",
    ]);
  });

  it("rejects non-string entries", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scopeTiers: { nonDomain: [42] } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });
});

describe("scan.topFiles", () => {
  it("defaults to 5", async () => {
    const root = await makeTempDir();
    expect(loadConfig(root).scan?.topFiles).toBe(5);
  });

  it("honours a user-supplied value", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scan: { topFiles: 10 } });
    expect(loadConfig(root).scan!.topFiles).toBe(10);
  });

  it("rejects non-positive integers", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scan: { topFiles: 0 } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });

  it("rejects non-integer values", async () => {
    const root = await makeTempDir();
    await writeConfig(root, { scan: { topFiles: 3.5 } });
    expect(() => loadConfig(root)).toThrowError(ConfigParseError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @crimes/core test config`
Expected: 6 new tests FAIL (no `scopeTiers`, no `scan` keys in config).

- [ ] **Step 3: Add the schema, defaults, and types**

In `packages/core/src/config.ts`:

```typescript
// Add near the other constants (top of file):
export const DEFAULT_NON_DOMAIN_PATTERNS: string[] = [
  "scripts/**",
  "examples/**",
  "fixtures/**",
  "public/**",
  "**/__tests__/**",
  "**/*.test.{ts,tsx,js,jsx}",
  "**/*.spec.{ts,tsx,js,jsx}",
];

export const DEFAULT_TOP_FILES = 5;
```

Extend the `CrimesConfig` interface (after `detectors`):

```typescript
  /**
   * Two-tier scope classification. Patterns under `nonDomain` mark files
   * whose findings should appear in a separate "Also flagged elsewhere"
   * section instead of competing with domain findings for the default
   * top-N. Empty array opts out of tiering entirely.
   */
  scopeTiers?: {
    nonDomain: string[];
  };
  /**
   * `crimes scan` rendering knobs.
   *
   * - `topFiles`: how many files appear in the default file-grouped view.
   *   `--top N` (CLI) and `--all` (CLI) override per invocation.
   */
  scan?: {
    topFiles: number;
  };
```

In the zod schema (find the existing object literal in `loadConfigDetailed`):

```typescript
  scopeTiers: z
    .object({
      nonDomain: z.array(z.string()),
    })
    .optional(),
  scan: z
    .object({
      topFiles: z.number().int().positive(),
    })
    .optional(),
```

In `DEFAULT_CONFIG` (extend the literal at file-bottom):

```typescript
  scopeTiers: { nonDomain: DEFAULT_NON_DOMAIN_PATTERNS },
  scan: { topFiles: DEFAULT_TOP_FILES },
```

Apply the same defaults in `loadConfig` so user configs missing these keys get the runtime defaults (parallel to how `thresholds` is back-filled).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test config`
Expected: all 6 new tests PASS plus existing passes unchanged.

- [ ] **Step 5: Re-export the new constants**

In `packages/core/src/index.ts`, add to the existing config re-export block:

```typescript
export {
  ConfigParseError,
  DEFAULT_CONFIG,
  DEFAULT_NON_DOMAIN_PATTERNS,
  DEFAULT_TOP_FILES,
  DEFAULT_SUPPRESSIONS_PATH,
  loadConfig,
  loadConfigDetailed,
  resolveSuppressionsPath,
} from "./config.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): add scopeTiers.nonDomain and scan.topFiles config keys

Lays the schema foundation for the Release A front-door redesign. No
runtime behaviour changes yet — detector wiring and reporter changes
come in subsequent tasks. Defaults are the static seven-pattern list
documented in the design spec; existing configs that don't set
scopeTiers get the runtime defaults automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none. No version bump.

---

## Task 2: Quartile-rank utility

**Spec ref:** §5.4 (tiebreak rule: average percentile across the tied block).

**Files:**
- Create: `packages/core/src/scoring/quartile.ts`
- Create: `packages/core/src/scoring/quartile.test.ts`

**Background:** Pure function library, no I/O. Consumed in Task 3 by `buildScoringContext`. Tests are self-contained so we can verify the tied-rank-avg behaviour in isolation.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/scoring/quartile.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { quartileScores } from "./quartile.js";

describe("quartileScores", () => {
  it("returns 0 for the lowest, 1 for the highest, 0.5/0.75 for middle quartiles on a wide distribution", () => {
    const raw = [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1, 1];
    const out = quartileScores(raw);
    // 30% at 0 → midpoint percentile 0.15 → quartile 0.0
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(0);
    // 30% at 0.5 → midpoint percentile (0.3 + 0.6)/2 = 0.45 → quartile 0.5
    expect(out[3]).toBe(0.5);
    expect(out[5]).toBe(0.5);
    // 40% at 1 → midpoint percentile (0.6 + 1.0)/2 = 0.8 → quartile 1.0
    expect(out[6]).toBe(1);
    expect(out[9]).toBe(1);
  });

  it("assigns identical scores to all tied entries (rank-average tiebreak)", () => {
    const raw = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const out = quartileScores(raw);
    // Every entry tied → midpoint 0.5 → quartile 0.5 (NOT 1.0).
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toBe(0.5);
  });

  it("falls back to raw values when input length is less than 4", () => {
    expect(quartileScores([1, 0.5, 0])).toEqual([1, 0.5, 0]);
    expect(quartileScores([1])).toEqual([1]);
    expect(quartileScores([])).toEqual([]);
  });

  it("snaps to the nearest 0.25 quartile bucket", () => {
    // 4 entries, all distinct, ascending: percentiles 0.125, 0.375, 0.625, 0.875
    // → quartiles 0.0, 0.25, 0.75, 1.0
    expect(quartileScores([0, 0.3, 0.7, 1])).toEqual([0, 0.25, 0.75, 1]);
  });

  it("preserves input order in the output array", () => {
    const raw = [1, 0, 0.5, 1, 0, 0.5];
    const out = quartileScores(raw);
    expect(out.length).toBe(raw.length);
    // Index 0 should match index 3 (both raw 1), etc.
    expect(out[0]).toBe(out[3]);
    expect(out[1]).toBe(out[4]);
    expect(out[2]).toBe(out[5]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @crimes/core test quartile`
Expected: ERROR (module not found).

- [ ] **Step 3: Implement quartileScores**

Create `packages/core/src/scoring/quartile.ts`:

```typescript
/**
 * Convert an array of raw values to per-entry quartile scores using the
 * rank-average tiebreak rule. Output preserves input order.
 *
 * For each tied block of identical raw values, every entry in the block
 * gets the same quartile score, computed from the midpoint of the
 * contiguous percentile range the block occupies in the sorted array.
 * This is the standard rank-avg behaviour and avoids the pathology
 * where N tied entries at the worst raw value all get quartile 1.0.
 *
 * Falls back to identity for arrays shorter than 4 — the design spec
 * §5.4 calls this the "small-repo fallback".
 */
export function quartileScores(raw: number[]): number[] {
  if (raw.length < 4) return raw.slice();

  // Sort with index attached so we can fan results back out in original order.
  const indexed = raw.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const out = new Array<number>(raw.length);
  let i = 0;
  while (i < indexed.length) {
    // Find the contiguous tied block starting at i.
    let j = i;
    while (j < indexed.length && indexed[j]!.v === indexed[i]!.v) j += 1;
    // The block occupies indices [i, j) in the sorted array.
    // Midpoint percentile = (i + j) / (2 * length).
    const percentile = (i + j) / (2 * indexed.length);
    const quartile = snapToQuartile(percentile);
    for (let k = i; k < j; k += 1) {
      out[indexed[k]!.i] = quartile;
    }
    i = j;
  }
  return out;
}

/** Snap a percentile in [0,1] to the nearest 0.25 bucket. */
function snapToQuartile(percentile: number): number {
  if (percentile < 0.25) return 0;
  if (percentile < 0.5) return 0.25;
  if (percentile < 0.75) return 0.5;
  if (percentile < 0.95) return 0.75;
  return 1;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test quartile`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scoring/quartile.ts packages/core/src/scoring/quartile.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add quartile-rank utility for test_gap normalization

Pure function with rank-average tiebreak — every entry in a tied block
gets the same quartile score, computed from the midpoint of the block's
percentile range. Falls back to identity for fewer than 4 inputs
(small-repo case from design spec §5.4). Consumed by buildScoringContext
in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none yet (no detector behaviour change). No version bump.

---

## Task 3: `test_gap` quartile pass in `buildScoringContext`

**Spec ref:** §5.4 (repo-relative quartile), §8 (small-repo fallback).

**Files:**
- Modify: `packages/core/src/scoring/build.ts`
- Modify: `packages/core/src/scoring/build.test.ts`

**Background:** `buildTestGapIndex` returns one of `{0, 0.5, 1.0}` per file. After this task, `forFile(repoPath)` returns the *quartile-ranked* version of that raw value relative to all scanned files. We need to keep the raw value reachable from `context()` for `clues.test_gap.raw`, so `TestGapIndex` gets a second method.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/scoring/build.test.ts`:

```typescript
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
    // Quartile-ranked: the 0.5 block midpoint = 0.25 → quartile 0; the 1.0
    // block midpoint = 0.75 → quartile 0.75 (top quartile threshold is
    // < 0.75 → 0.5; >= 0.75 → 0.75; >= 0.95 → 1.0).
    expect(ctx.testGap.forFile("src/a.ts")).toBe(0);
    expect(ctx.testGap.forFile("src/c.ts")).toBe(0.75);
    expect(ctx.testGap.forFile("src/d.ts")).toBe(0.75);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @crimes/core test build`
Expected: 3 new tests FAIL: `rawForFile` doesn't exist, and `forFile` returns raw values.

- [ ] **Step 3: Extend the index interface**

In `packages/core/src/scoring/build.ts`:

```typescript
export interface TestGapIndex {
  /** Quartile-ranked test gap for this file. See spec §5.4. */
  forFile(repoPath: string): number;
  /** Raw {0, 0.5, 1.0} value before quartile normalisation. Used by context.clues. */
  rawForFile(repoPath: string): number;
}
```

- [ ] **Step 4: Implement the quartile pass in `buildTestGapIndex`**

Rewrite the function (preserving the raw classifier exactly as today):

```typescript
import { quartileScores } from "./quartile.js";

function buildTestGapIndex(args: {
  repoPaths: string[];
  imports: ImportGraph | undefined;
}): TestGapIndex {
  const { repoPaths, imports } = args;
  const fileSet = new Set(repoPaths);
  const testFiles = new Set(repoPaths.filter((p) => isTestFile(p)));

  // Existing helpers verbatim:
  const siblingTestFor = (file: string): boolean => { /* unchanged */ };
  const tellsTestCoversBasename = (file: string): boolean => { /* unchanged */ };
  const importedByTest = (file: string): boolean => { /* unchanged */ };

  const rawFor = (repoPath: string): number => {
    if (isTestFile(repoPath)) return 0;
    if (!fileSet.has(repoPath)) return 1;
    if (importedByTest(repoPath)) return 0;
    if (siblingTestFor(repoPath) || tellsTestCoversBasename(repoPath)) {
      return 0.5;
    }
    return 1;
  };

  // Compute raw for every file once, then quartile-rank in one pass.
  const sourcePaths = repoPaths.filter((p) => !isTestFile(p));
  const rawValues = sourcePaths.map((p) => rawFor(p));
  const quartiles = quartileScores(rawValues);
  const quartileByPath = new Map<string, number>();
  sourcePaths.forEach((p, i) => quartileByPath.set(p, quartiles[i]!));

  return {
    forFile(repoPath) {
      if (isTestFile(repoPath)) return 0;
      return quartileByPath.get(repoPath) ?? rawFor(repoPath);
    },
    rawForFile(repoPath) {
      return rawFor(repoPath);
    },
  };
}
```

The `agent_risk` formula in `computeAgentRisk` is unchanged: it still consumes `forFile`'s output as the `test_gap` weight. The score is still `[0,1]`, only the distribution shifts.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test build`
Expected: all build tests PASS, including the 3 new ones.

- [ ] **Step 6: Patch-bump version, commit, re-run evals**

The test_gap distribution change shifts `agent_risk` for many findings → eval baseline moves.

```bash
# Bump cli version
sed -i '' 's/"version": "0.9.2"/"version": "0.9.3"/' packages/cli/package.json

git add packages/cli/package.json packages/core/src/scoring/build.ts packages/core/src/scoring/build.test.ts
git commit -m "$(cat <<'EOF'
feat(core): repo-relative quartile pass on test_gap (0.9.2 → 0.9.3)

Replaces the 0/0.5/1 absolute test_gap value with a repo-relative
quartile-ranked score. agent_risk math is unchanged; the score is
still [0,1]. Behaviour change visible to JSON consumers: same field,
same range, different distribution. Spec §5.4 covers tiebreak rules
and small-repo fallback. Raw value remains reachable via rawForFile
for context.clues.test_gap.raw.

This is a CALIBRATION CHANGE — the eval baseline moves because
findings re-rank, not because we found new ones.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

pnpm run evals
git add evals/results/0.9.3
git commit -m "chore: refresh eval baseline for 0.9.3 (test_gap quartile pass)"
```

**Eval impact:** yes (calibration). Patch-bump to `0.9.3`.

---

<span id="task-4-churn-collector--last_commit_at-and-unique_authors_90d"></span>

## Task 4: Churn collector: `last_commit_at` and `unique_authors_90d`

**Spec ref:** §5.7 (clues.churn shape), §6 (extend `collectChurn`).

**Files:**
- Modify: `packages/core/src/git/churn.ts`
- Modify: `packages/core/src/git/churn.test.ts`

**Background:** `FileChurn` already exposes `latestChange` (ISO 8601). We add `uniqueAuthors: number`. The `git log` format becomes `CRIMES_COMMIT %cI %ae` and `parseGitLog` tracks per-file author sets. `latestChange` is reused for `last_commit_at` in clues.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/git/churn.test.ts`:

```typescript
describe("collectChurn — author tracking", () => {
  it("counts unique committers per file across the window", async () => {
    const root = await makeRepo({ "src/a.ts": "x" });
    await git(root, "init", "--initial-branch=main", "--quiet");
    await git(root, "config", "commit.gpgsign", "false");
    await git(root, "add", "-A");
    // Three commits, two distinct authors.
    await git(
      root,
      "-c", "user.name=Alice", "-c", "user.email=alice@example.com",
      "commit", "-m", "c1", "--quiet",
    );
    await writeFile(join(root, "src/a.ts"), "y");
    await git(root, "add", "-A");
    await git(
      root,
      "-c", "user.name=Bob", "-c", "user.email=bob@example.com",
      "commit", "-m", "c2", "--quiet",
    );
    await writeFile(join(root, "src/a.ts"), "z");
    await git(root, "add", "-A");
    await git(
      root,
      "-c", "user.name=Alice", "-c", "user.email=alice@example.com",
      "commit", "-m", "c3", "--quiet",
    );

    const r = await collectChurn({ root, since: "1y" });
    const a = r.files.find((f) => f.file === "src/a.ts");
    expect(a).toBeDefined();
    expect(a!.changeCount).toBe(3);
    expect(a!.uniqueAuthors).toBe(2);
    expect(a!.latestChange).toMatch(/^\d{4}-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test churn`
Expected: FAIL: `uniqueAuthors` is undefined on `FileChurn`.

- [ ] **Step 3: Extend `FileChurn` and the parser**

In `packages/core/src/git/churn.ts`:

```typescript
export interface FileChurn {
  file: string;
  changeCount: number;
  latestChange: string;
  /** Number of distinct committer emails in the window. */
  uniqueAuthors: number;
}
```

Change the `pretty` format and parser:

```typescript
const logArgs = [
  "log",
  `--since=${sinceArg}`,
  `--pretty=format:${COMMIT_MARKER} %cI %ae`,  // ← add %ae
  "--name-only",
  "--no-merges",
];
```

In `parseGitLog`:

```typescript
export function parseGitLog(output: string): FileChurn[] {
  const byFile = new Map<
    string,
    { count: number; latest: string; authors: Set<string> }
  >();
  let currentDate: string | null = null;
  let currentAuthor: string | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      currentDate = null;
      currentAuthor = null;
      continue;
    }
    if (line.startsWith(COMMIT_MARKER)) {
      const payload = line.slice(COMMIT_MARKER.length).trim();
      const spaceIdx = payload.indexOf(" ");
      if (spaceIdx === -1) {
        currentDate = payload;
        currentAuthor = "";
      } else {
        currentDate = payload.slice(0, spaceIdx);
        currentAuthor = payload.slice(spaceIdx + 1);
      }
      continue;
    }
    if (currentDate === null) continue;

    const file = line.trim();
    if (file.length === 0) continue;

    const existing = byFile.get(file);
    if (existing) {
      existing.count += 1;
      if (existing.latest < currentDate) existing.latest = currentDate;
      if (currentAuthor) existing.authors.add(currentAuthor);
    } else {
      byFile.set(file, {
        count: 1,
        latest: currentDate,
        authors: new Set(currentAuthor ? [currentAuthor] : []),
      });
    }
  }

  const result: FileChurn[] = [];
  for (const [file, { count, latest, authors }] of byFile) {
    result.push({
      file,
      changeCount: count,
      latestChange: latest,
      uniqueAuthors: authors.size,
    });
  }
  result.sort((a, b) => {
    if (b.changeCount !== a.changeCount) return b.changeCount - a.changeCount;
    return a.file.localeCompare(b.file);
  });
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test churn`
Expected: all churn tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/git/churn.ts packages/core/src/git/churn.test.ts
git commit -m "$(cat <<'EOF'
feat(core): track unique committer count per file in collectChurn

Adds uniqueAuthors to FileChurn by extending the `git log` --pretty
format with %ae and accumulating per-file author sets in parseGitLog.
latestChange (ISO 8601) is reused as last_commit_at in the upcoming
context.clues.churn block. No behaviour changes for hotspots — it
ignores uniqueAuthors today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none (data-only). No version bump.

---

## Task 5: Recency index in scoring context

**Spec ref:** §5.3 (multiplicative boost), §8 (git-unavailable degradation).

**Files:**
- Modify: `packages/core/src/scoring/build.ts`
- Modify: `packages/core/src/scoring/build.test.ts`

**Background:** Recency is derived from `FileChurn.latestChange`. `recency = 1` for files committed ≤7d ago, linearly decaying to `0` at 14d, then `0`. The index is exposed via `ScoringContext` alongside `churn`/`testGap`/`blastRadius`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/scoring/build.test.ts`:

```typescript
import { recencyForDate } from "./build.js";

describe("recencyForDate", () => {
  const now = new Date("2026-05-20T12:00:00Z").getTime();

  it("returns 1.0 for a commit today", () => {
    expect(recencyForDate("2026-05-20T11:00:00Z", now)).toBe(1);
  });

  it("returns 1.0 for any commit within the last 7 days", () => {
    expect(recencyForDate("2026-05-14T12:00:00Z", now)).toBe(1);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @crimes/core test build`
Expected: FAIL: `recencyForDate` not exported, `ctx.recency` undefined.

- [ ] **Step 3: Implement the recency index**

In `packages/core/src/scoring/build.ts`:

```typescript
const RECENCY_FULL_DAYS = 7;
const RECENCY_DECAY_DAYS = 14;
const MS_PER_DAY = 86_400_000;

export function recencyForDate(
  iso: string | undefined,
  nowMs: number = Date.now(),
): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const days = (nowMs - t) / MS_PER_DAY;
  if (days <= RECENCY_FULL_DAYS) return 1;
  if (days >= RECENCY_DECAY_DAYS) return 0;
  // Linear decay from 1 → 0 across (FULL, DECAY].
  return 1 - (days - RECENCY_FULL_DAYS) / (RECENCY_DECAY_DAYS - RECENCY_FULL_DAYS);
}

export interface RecencyIndex {
  /** Returns [0,1] recency boost for a file. 0 when git is unavailable. */
  forFile(repoPath: string): number;
  /** True when git history is shallow or absent. */
  limited: boolean;
  limitedReason?: string;
}

export interface ScoringContext {
  churn: ChurnIndex;
  testGap: TestGapIndex;
  blastRadius: BlastRadiusIndex;
  recency: RecencyIndex;  // ← new
}
```

In `buildScoringContext`, after computing `churnResult`:

```typescript
  const latestByFile = new Map<string, string>();
  for (const c of churnResult.files) {
    latestByFile.set(c.file, c.latestChange);
  }
  const recency: RecencyIndex = {
    forFile(repoPath) {
      return recencyForDate(latestByFile.get(repoPath));
    },
    limited: !churnResult.gitAvailable,
    ...(churnResult.gitAvailable ? {} : {
      limitedReason: "not a git repository or git is unavailable; recency is unknown",
    }),
  };
```

Return `{ churn, testGap, blastRadius, recency }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scoring/build.ts packages/core/src/scoring/build.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add recency index to ScoringContext

Derives a per-file recency value in [0,1] from FileChurn.latestChange:
1.0 within 7 days, linear decay to 0 over 7→14 days, then 0. When git
is unavailable, every file returns 0 (the multiplicative ranking
multiplier in the upcoming sort pass collapses to 1, preserving order).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none yet (index is unused). No version bump.

---

## Task 6: `Finding.tier` field + tier classification helper

**Spec ref:** §5.5 (tier glob matching), §8 (backwards-compat default).

**Files:**
- Modify: `packages/core/src/finding.ts`
- Create: `packages/core/src/scoring/tier.ts`
- Create: `packages/core/src/scoring/tier.test.ts`
- Modify: `packages/core/src/index.ts`

**Background:** Tier is computed from `finding.file` against `config.scopeTiers.nonDomain` globs. We reuse the same `picomatch`-style matching the existing exclude/include logic uses: `@crimes/language-js` already has a glob matcher; check `discoverFiles` for the canonical pattern. New helper because tier is also needed in `context.ts` for "is this file a domain file?" decisions.

- [ ] **Step 1: Find the existing glob matcher**

Run: `grep -rn "picomatch\|micromatch\|ignore" /Users/andrew/dev/crimes/packages/language-js/src | head -10`
Use whichever library the existing `discoverFiles` uses. Throughout this task substitute that import.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/scoring/tier.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { DEFAULT_NON_DOMAIN_PATTERNS } from "../config.js";
import { classifyTier, makeTierClassifier } from "./tier.js";

describe("classifyTier", () => {
  it("returns 'domain' for files under src/", () => {
    expect(classifyTier("src/billing/invoice.ts", DEFAULT_NON_DOMAIN_PATTERNS)).toBe("domain");
  });

  it("returns 'nonDomain' for scripts/", () => {
    expect(classifyTier("scripts/_probe-x.ts", DEFAULT_NON_DOMAIN_PATTERNS)).toBe("nonDomain");
  });

  it("returns 'nonDomain' for test files anywhere", () => {
    expect(classifyTier("src/billing/invoice.test.ts", DEFAULT_NON_DOMAIN_PATTERNS)).toBe("nonDomain");
    expect(classifyTier("packages/core/__tests__/x.ts", DEFAULT_NON_DOMAIN_PATTERNS)).toBe("nonDomain");
  });

  it("returns 'domain' when the pattern list is empty (opt-out)", () => {
    expect(classifyTier("scripts/x.ts", [])).toBe("domain");
  });

  it("memoises via makeTierClassifier", () => {
    const c = makeTierClassifier(DEFAULT_NON_DOMAIN_PATTERNS);
    expect(c("scripts/x.ts")).toBe("nonDomain");
    expect(c("scripts/x.ts")).toBe("nonDomain");  // second call hits cache
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @crimes/core test tier`
Expected: ERROR (module not found).

- [ ] **Step 4: Implement the tier helper**

Create `packages/core/src/scoring/tier.ts`:

```typescript
// Use whichever matcher discoverFiles uses; substitute the actual import.
import picomatch from "picomatch";

export type Tier = "domain" | "nonDomain";

/**
 * Classify a single repo-relative POSIX path against the non-domain
 * patterns. O(P) per call where P = pattern count. Use makeTierClassifier
 * for repeated lookups.
 */
export function classifyTier(
  repoRelPath: string,
  nonDomainPatterns: string[],
): Tier {
  if (nonDomainPatterns.length === 0) return "domain";
  for (const pattern of nonDomainPatterns) {
    if (picomatch.isMatch(repoRelPath, pattern)) return "nonDomain";
  }
  return "domain";
}

/**
 * Compile the patterns once and return a memoised classifier. Use this
 * when classifying many files in a single scan.
 */
export function makeTierClassifier(
  nonDomainPatterns: string[],
): (repoRelPath: string) => Tier {
  if (nonDomainPatterns.length === 0) return () => "domain";
  const matchers = nonDomainPatterns.map((p) => picomatch(p));
  const cache = new Map<string, Tier>();
  return (path: string): Tier => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    const result: Tier = matchers.some((m) => m(path)) ? "nonDomain" : "domain";
    cache.set(path, result);
    return result;
  };
}
```

- [ ] **Step 5: Add `tier` to `Finding`**

In `packages/core/src/finding.ts`:

```typescript
export interface Finding {
  // ... existing fields ...
  /**
   * Scope tier of the finding's file, computed from
   * `config.scopeTiers.nonDomain`. Optional and additive — readers that
   * don't care can ignore it. Absent only on findings produced by tests
   * that bypass scan/context wiring.
   */
  tier?: Tier;
}
```

Add `export type { Tier } from "./scoring/tier.js";` if needed.

- [ ] **Step 6: Re-export from core index**

```typescript
export { classifyTier, makeTierClassifier } from "./scoring/tier.js";
export type { Tier } from "./scoring/tier.js";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test tier`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/scoring/tier.ts packages/core/src/scoring/tier.test.ts packages/core/src/finding.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): add Finding.tier and scope-tier classifier

Pure helper used by scan and context to mark each finding as 'domain'
or 'nonDomain' based on config.scopeTiers.nonDomain globs. Memoised
classifier returned by makeTierClassifier for repeated lookups. Field
on Finding is optional and additive — no schema_version bump.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none yet (field is unused). No version bump.

---

## Task 7: `FindingScores.recency` + populate in `finaliseFindingScores`

**Spec ref:** §5.3 (recency-on-Finding so reporter can compute rank_score), §11 (frozen contract: additive).

**Files:**
- Modify: `packages/core/src/finding.ts`
- Modify: `packages/core/src/scoring/build.ts`
- Modify: `packages/core/src/scoring/build.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/scoring/build.test.ts`:

```typescript
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
      blastRadius: { forFile: () => 0 },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test build`
Expected: FAIL.

- [ ] **Step 3: Add the field to FindingScores**

In `packages/core/src/finding.ts`:

```typescript
export interface FindingScores {
  // ... existing fields ...
  /**
   * Recency boost in [0,1] derived from file's most recent commit. 1.0 =
   * touched within the last 7 days; linear decay to 0 over 7→14 days; 0
   * thereafter or when git is unavailable. Used by the scan reporter to
   * compute file-level rank_score = agent_risk * (1 + recency * 0.5).
   */
  recency?: number;
}
```

- [ ] **Step 4: Populate in `finaliseFindingScores`**

In `packages/core/src/scoring/build.ts`, update the function:

```typescript
export function finaliseFindingScores(
  finding: Finding,
  scoring: ScoringContext | undefined,
): void {
  let churn = 0;
  let test_gap = 0;
  let blast_radius = 0;
  if (scoring) {
    churn = round(scoring.churn.forFile(finding.file));
    test_gap = round(scoring.testGap.forFile(finding.file));
    blast_radius = round(scoring.blastRadius.forFile(finding.file));
    const recency = round(scoring.recency.forFile(finding.file));
    finding.scores.churn = churn;
    finding.scores.test_gap = test_gap;
    finding.scores.blast_radius = blast_radius;
    finding.scores.recency = recency;
  }
  finding.scores.agent_risk = computeAgentRisk({
    severity: finding.severity,
    confidence: finding.scores.confidence,
    churn,
    test_gap,
    blast_radius,
  });
}
```

The `agent_risk` formula stays unchanged: recency is a *separate* multiplier applied at sort time, not folded into the unified score.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test build`
Expected: all PASS.

- [ ] **Step 6: Patch-bump and commit**

Recency appearing on every finding is a JSON shape change visible to consumers (additive).

```bash
sed -i '' 's/"version": "0.9.3"/"version": "0.9.4"/' packages/cli/package.json

git add packages/cli/package.json packages/core/src/finding.ts packages/core/src/scoring/build.ts packages/core/src/scoring/build.test.ts
git commit -m "$(cat <<'EOF'
feat(core): expose recency on FindingScores (0.9.3 → 0.9.4)

Additive field paralleling churn/test_gap/blast_radius. Reporter
consumes it in subsequent task to compute file-level rank_score
without re-running git log. agent_risk is unchanged — recency is a
separate multiplier applied at sort time, not folded into the
unified formula.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

pnpm run evals
git add evals/results/0.9.4
git commit -m "chore: refresh eval baseline for 0.9.4 (recency on scores)"
```

**Eval impact:** field appears on every finding. Patch-bump to `0.9.4`.

---

## Task 8: Tier-tag findings and sort by `rank_score` in `scan` / `context`

**Spec ref:** §5.2, §5.3, §5.5.

**Files:**
- Modify: `packages/core/src/scan.ts`
- Modify: `packages/core/src/context-helpers.ts` (the `sortFindings` helper lives here per earlier read)
- Modify: `packages/core/src/scan.test.ts`

**Background:** After every detector has run and `finaliseFindingScores` has populated scores, walk findings once to set `tier`. Then sort by `rank_score = agent_risk * (1 + (recency ?? 0) * 0.5)` desc. Both `scan` and `context` use the same sort, so the helper lives in `context-helpers.ts` next to today's `sortFindings`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/scan.test.ts`:

```typescript
describe("scan — tier tagging and rank_score order", () => {
  it("tags findings with tier based on scopeTiers and sorts by rank_score desc", async () => {
    const dir = await makeRepo({
      "src/hot.ts": longFunctionFixture("hotFn"),     // domain, high recency expected
      "scripts/probe.ts": longFunctionFixture("probeFn"),  // non-domain
      "src/cold.ts": longFunctionFixture("coldFn"),   // domain, low recency
      "crimes.config.json": JSON.stringify({
        scopeTiers: {
          nonDomain: ["scripts/**"],
        },
      }),
    });
    await initRepo(dir);
    // Touch hot.ts again with a fresh commit to bump its recency.
    await commitFile(dir, "src/hot.ts", longFunctionFixture("hotFn") + "\n// touch\n", "touch hot");

    const report = await scan({ root: dir, config: loadConfig(dir) });

    const hot = report.findings.find((f) => f.file === "src/hot.ts");
    const probe = report.findings.find((f) => f.file === "scripts/probe.ts");
    const cold = report.findings.find((f) => f.file === "src/cold.ts");

    expect(hot?.tier).toBe("domain");
    expect(probe?.tier).toBe("nonDomain");
    expect(cold?.tier).toBe("domain");

    // hot.ts has recency 1.0 → rank_score = agent_risk * 1.5
    // cold.ts has recency 0 → rank_score = agent_risk * 1.0
    // Hot must appear before cold even if their agent_risks were equal.
    const hotIdx = report.findings.findIndex((f) => f.file === "src/hot.ts");
    const coldIdx = report.findings.findIndex((f) => f.file === "src/cold.ts");
    expect(hotIdx).toBeLessThan(coldIdx);
  });
});

// Reuse or add a helper at the top of the test file:
function longFunctionFixture(name: string): string {
  return `export function ${name}() {\n${"  console.log('x');\n".repeat(80)}}\n`;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test scan`
Expected: FAIL: `tier` is undefined on findings.

- [ ] **Step 3: Add the helper and wire it in**

In `packages/core/src/context-helpers.ts`:

```typescript
import { makeTierClassifier } from "./scoring/tier.js";
import type { Finding } from "./finding.js";
import type { CrimesConfig } from "./config.js";

/**
 * Tag every finding with `tier` from config.scopeTiers.nonDomain and
 * sort by rank_score = agent_risk * (1 + (recency ?? 0) * 0.5) desc.
 * Stable on ties: falls back to (severity desc, file asc, lines start asc).
 */
export function tagTierAndSortByRankScore(
  findings: Finding[],
  config: CrimesConfig,
): void {
  const nonDomain = config.scopeTiers?.nonDomain ?? [];
  const classify = makeTierClassifier(nonDomain);
  for (const f of findings) {
    f.tier = classify(f.file);
  }
  findings.sort((a, b) => {
    const ra = rankScore(a);
    const rb = rankScore(b);
    if (rb !== ra) return rb - ra;
    // Tiebreakers: keep today's secondary sort behaviour.
    return existingSecondarySort(a, b);
  });
}

function rankScore(f: Finding): number {
  const ar = f.scores.agent_risk ?? 0;
  const rec = f.scores.recency ?? 0;
  return ar * (1 + rec * 0.5);
}
```

`existingSecondarySort` should reproduce whatever `sortFindings` does today (severity, file, lines). Refactor by extracting today's comparator into this helper and calling it from both old and new entry points.

In `packages/core/src/scan.ts`, replace the call to today's `sortFindings(findings)` with `tagTierAndSortByRankScore(findings, config)`.

In `packages/core/src/context.ts`, do the same.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test`
Expected: all PASS. Older tests that assert finding order may need snapshot updates: only update if the new order is *the* intended new order (per spec); never silence an ordering test by deleting it.

- [ ] **Step 5: Patch-bump and commit**

```bash
sed -i '' 's/"version": "0.9.4"/"version": "0.9.5"/' packages/cli/package.json

git add packages/cli/package.json packages/core/src/scan.ts packages/core/src/context.ts packages/core/src/context-helpers.ts packages/core/src/scan.test.ts
git commit -m "$(cat <<'EOF'
feat(core): tier-tag findings and sort by rank_score (0.9.4 → 0.9.5)

scan() and context() now tag every finding with tier (domain | nonDomain)
and sort by rank_score = agent_risk * (1 + recency * 0.5) desc instead
of by agent_risk alone. Existing secondary tiebreakers preserved. This
is the ordering surface that the new file-grouped scan layout consumes.

PRODUCT CHANGE — finding order shifts. agent_risk math is untouched
but recently-modified files float up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

pnpm run evals
git add evals/results/0.9.5
git commit -m "chore: refresh eval baseline for 0.9.5 (rank_score sort + tier)"
```

**Eval impact:** finding order shifts substantially. Patch-bump to `0.9.5`.

---

## Task 9: `clues` object on `ContextReport`

**Spec ref:** §5.7 (full shape + omission rules), §11 (frozen contract for Release B).

**Files:**
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/context.test.ts`
- Modify: `packages/core/src/suppressions.ts` (a new helper that returns the entries for a single file)

- [ ] **Step 1: Add the helper for per-file suppression listing**

In `packages/core/src/suppressions.ts`, add (signature only: the file is large; place near the existing `partitionFindings`):

```typescript
import type { SuppressionEntry } from "./suppressions.js";

export interface SuppressionForFile {
  fingerprint: string;
  detector: string;
  reason: string;
  pinned_version: string;
  matches_current_finding: boolean;
}

/**
 * Return every suppression entry whose `file` matches `repoRelPath` (or
 * whose `detector + file` would match a finding in the supplied list),
 * with a flag indicating whether at least one current finding matched.
 */
export function suppressionsForFile(
  entries: SuppressionEntry[],
  repoRelPath: string,
  currentFindings: Finding[],
): SuppressionForFile[] {
  // ... walk entries that scope to this file ...
  // ... cross-check fingerprints against currentFindings ...
}
```

Implementation specifics depend on the existing suppression entry shape: read `suppressions.ts` to mirror its existing matching predicate. Add a unit test in `suppressions.test.ts` covering: file-scoped match, fingerprint-scoped match, `matches_current_finding` flag.

- [ ] **Step 2: Write the failing context tests**

Append to `packages/core/src/context.test.ts`:

```typescript
describe("context — clues", () => {
  it("populates clues.churn from the scoring context when git is available", async () => {
    const dir = await makeRepoWithGitHistory(/* fixtures */);
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues?.churn).toBeDefined();
    expect(result.clues!.churn!.commits_90d).toBeGreaterThan(0);
    expect(result.clues!.churn!.last_commit_at).toMatch(/^\d{4}-/);
    expect(result.clues!.churn!.unique_authors_90d).toBeGreaterThan(0);
  });

  it("omits clues.churn when git is unavailable", async () => {
    const dir = await makeRepo({ "src/a.ts": "x" });
    // Deliberately no git init
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues?.churn).toBeUndefined();
  });

  it("emits clues.test_gap with raw + percentile + label on a repo of ≥4 files", async () => {
    const dir = await makeRepo({ /* 4+ files */ });
    await initRepo(dir);
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues?.test_gap).toBeDefined();
    expect(result.clues!.test_gap!.raw).toBeGreaterThanOrEqual(0);
    expect(result.clues!.test_gap!.percentile).toBeGreaterThanOrEqual(0);
    expect(["top-quartile", "median", "bottom-quartile", "unknown"]).toContain(result.clues!.test_gap!.label);
  });

  it("emits label='unknown' and omits percentile when fewer than 4 files are scanned", async () => {
    const dir = await makeRepo({ "src/a.ts": "x", "src/b.ts": "x" });
    await initRepo(dir);
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues!.test_gap!.label).toBe("unknown");
    expect(result.clues!.test_gap!.percentile).toBeUndefined();
  });

  it("includes related_signals as an empty array (reserved for Release B)", async () => {
    const dir = await makeRepo({ "src/a.ts": "x" });
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues?.related_signals).toEqual([]);
  });

  it("omits clues entirely when every nested key would be empty", async () => {
    // No git, no suppressions, fewer than 4 files: nothing to report.
    const dir = await makeRepo({ "src/a.ts": "x" });
    const result = await context({ root: dir, file: "src/a.ts" });
    // churn omitted, suppressions absent → check we don't emit clues with only related_signals.
    if (result.clues) {
      // The spec says omit clues entirely if all three would be empty;
      // related_signals doesn't count toward "non-empty" by itself.
      expect(result.clues.churn).toBeUndefined();
      expect(result.clues.suppressions).toBeUndefined();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @crimes/core test context`
Expected: FAIL: `clues` not on the report shape.

- [ ] **Step 4: Add the `clues` shape and populate it**

In `packages/core/src/context.ts`:

```typescript
export interface ContextClues {
  churn?: {
    commits_90d: number;
    last_commit_at: string;
    unique_authors_90d: number;
  };
  suppressions?: SuppressionForFile[];
  test_gap?: {
    raw: number;
    percentile?: number;
    label: "top-quartile" | "median" | "bottom-quartile" | "unknown";
  };
  related_signals: unknown[];  // always present, always [] in Release A
}

export interface ContextReport {
  // ... existing fields ...
  clues?: ContextClues;
}
```

In the `context()` function body (right before the `return report` block), build the clues object:

```typescript
  const clues: ContextClues = { related_signals: [] };

  // churn — present only when git data is available for this file
  const churnEntry = churnResultByFile.get(fileRel);  // expose churnResult from scoring step
  if (churnEntry) {
    clues.churn = {
      commits_90d: churnEntry.changeCount,
      last_commit_at: churnEntry.latestChange,
      unique_authors_90d: churnEntry.uniqueAuthors,
    };
  }

  // suppressions for this file (regardless of whether any matched today)
  const supps = suppressionsForFile(suppressions.entries, fileRel, findings);
  if (supps.length > 0) {
    clues.suppressions = supps;
  }

  // test_gap with raw, percentile, label
  const raw = scoring.testGap.rawForFile(fileRel);
  const score = scoring.testGap.forFile(fileRel);
  const eligible = allFiles.length >= 4;
  clues.test_gap = eligible
    ? {
        raw,
        percentile: score,
        label: score >= 0.75 ? "top-quartile" : score <= 0.25 ? "bottom-quartile" : "median",
      }
    : { raw, label: "unknown" };

  // Omit clues entirely if all three substantive blocks would be empty.
  // related_signals alone doesn't count.
  if (clues.churn || clues.suppressions || clues.test_gap) {
    report.clues = clues;
  }
```

Note: `churnResultByFile` and `suppressions.entries` need to be propagated from earlier in the function: adjust the existing scoring setup so the raw `CollectChurnResult` is reachable (today only `ChurnIndex.forFile` is exposed; we need the full list to grab `latestChange` and `uniqueAuthors` for the inspected file).

Wire `suppressions` loading: `context()` doesn't currently load suppressions itself: that's done by the CLI command. Move the load into core (with the `config.suppressions.path` honoured) so the JSON report is self-sufficient. Alternative: accept `suppressionsEntries: SuppressionEntry[]` as a new `ContextOptions` field and have the CLI pass it. Pick whichever fits better; the test calls `context()` directly without suppressions, so the CLI-passing approach keeps tests narrow.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @crimes/core test context`
Expected: all PASS.

- [ ] **Step 6: Re-export types and commit**

```typescript
// packages/core/src/index.ts
export type { ContextClues, ContextOptions, ContextReport, ContextRisk } from "./context.js";
```

```bash
git add packages/core/src/context.ts packages/core/src/context.test.ts packages/core/src/suppressions.ts packages/core/src/suppressions.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): add clues block to ContextReport

Frozen contract for Release B: clues.churn (commits_90d, last_commit_at,
unique_authors_90d), clues.suppressions (per-file inventory regardless
of current matches), clues.test_gap (raw, percentile, label), and
clues.related_signals reserved as []. Omission rules per spec §5.7:
churn absent when git unavailable, suppressions absent when empty,
clues itself absent when no substantive block would render.

Additive — no schema_version bump. JSON consumers see new optional
field; existing fields unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** context shape change. Evals primarily exercise `scan`, but verify the eval runner doesn't break. If it does, patch-bump and refresh.

---

<span id="task-10-reporter--quartile-label-for-test_gap-in-humansharedts"></span>

## Task 10: Reporter: quartile label for `test_gap` in `human/shared.ts`

**Spec ref:** §5.4 (human display switches phrasing).

**Files:**
- Modify: `packages/reporter/src/human/shared.ts`
- Modify: `packages/reporter/src/reporter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/reporter/src/reporter.test.ts` (it already covers `renderFinding`):

```typescript
describe("renderRiskProfileLine — test_gap quartile label", () => {
  it("renders 'top-quartile' for scores >= 0.75", () => {
    const f = stubFinding({ test_gap: 0.75 });
    const line = renderRiskProfileLine(f, pc, { alwaysShowRiskProfile: true });
    expect(line).toContain("test gap top-quartile");
    expect(line).not.toContain("0.75");
  });

  it("renders 'bottom-quartile' for scores <= 0.25", () => {
    const f = stubFinding({ test_gap: 0.25 });
    const line = renderRiskProfileLine(f, pc, { alwaysShowRiskProfile: true });
    expect(line).toContain("test gap bottom-quartile");
  });

  it("renders '~median' for scores in (0.25, 0.75)", () => {
    const f = stubFinding({ test_gap: 0.5 });
    const line = renderRiskProfileLine(f, pc, { alwaysShowRiskProfile: true });
    expect(line).toContain("test gap ~median");
  });
});

function stubFinding(scores: Partial<FindingScores>): Finding {
  return {
    id: "x", type: "t", charge: "C", severity: "low",
    confidence: 0.5, file: "a.ts", summary: "", evidence: [],
    scores: { severity: 0.5, confidence: 0.5, ...scores },
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/reporter test`
Expected: FAIL: still shows `0.75` etc.

- [ ] **Step 3: Update `renderRiskProfileLine`**

In `packages/reporter/src/human/shared.ts`, replace the test_gap segment:

```typescript
export function renderRiskProfileLine(
  finding: Finding,
  colour: ColourFns,
  options: { alwaysShowRiskProfile?: boolean },
): string | undefined {
  const { churn, test_gap, blast_radius } = finding.scores;
  if (churn === undefined && test_gap === undefined && blast_radius === undefined) {
    return undefined;
  }
  const notable =
    (churn ?? 0) > 0.5 ||
    (test_gap ?? 0) >= 0.75 ||
    (blast_radius ?? 0) > 0.5;
  if (!notable && !options.alwaysShowRiskProfile) return undefined;
  const parts = [
    `churn ${(churn ?? 0).toFixed(2)}`,
    `test gap ${testGapLabel(test_gap)}`,
    `blast radius ${(blast_radius ?? 0).toFixed(2)}`,
  ];
  return `     ${colour.bold("Risk profile:")} ${colour.dim(parts.join(" · "))}`;
}

function testGapLabel(score: number | undefined): string {
  if (score === undefined) return "unknown";
  if (score >= 0.75) return "top-quartile";
  if (score <= 0.25) return "bottom-quartile";
  return "~median";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crimes/reporter test`
Expected: all PASS. Update any reporter snapshots that include "test gap 1.00" → regenerate intentionally.

- [ ] **Step 5: Commit**

```bash
git add packages/reporter/src/human/shared.ts packages/reporter/src/reporter.test.ts
git commit -m "$(cat <<'EOF'
feat(reporter): show quartile label for test_gap instead of raw 0.xx

Numeric test_gap was reading 1.00 on virtually every finding because the
underlying primitive returns {0, 0.5, 1}. After the Task 3 quartile pass,
the score is meaningfully distributed but still numeric — the human
report swaps it for top-quartile / ~median / bottom-quartile phrasing.
JSON output is unaffected (it carries the numeric percentile inside
clues.test_gap).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none (human reporter only). No version bump.

---

<span id="task-11-reporter--new-file-grouped-scan-layout"></span>

## Task 11: Reporter: new file-grouped scan layout

**Spec ref:** §5.1 (layout), §5.2 (per-file ordering), §5.5 ("Also flagged elsewhere"), §5.6 (action-close), §8 (`--flat` parity, all-non-domain edge case).

**Files:**
- Modify: `packages/reporter/src/human/scan.ts`
- Modify: `packages/reporter/src/reporter.test.ts`

**Background:** This is the largest single piece of work in the release. Today `formatHumanReport` groups by severity. The new layout groups by file, shows top-N (default 5), renders the "Also flagged elsewhere" footer for non-domain findings, and ends with an action-close line. `--flat` falls back to today's exact behaviour; `--all` shows every finding, ordered, both tiers flattened.

Substeps:

- [ ] **Step 1: Add the new options to `HumanReportOptions`**

```typescript
export interface HumanReportOptions {
  showAll?: boolean;
  /** Default cap for the new layout; ignored when showAll or flat. */
  topFiles?: number;
  noColor?: boolean;
  /** When true, revert to today's flat-by-severity layout. */
  flat?: boolean;
  feedbackHints?: FeedbackHintOptions;
}

const DEFAULT_TOP_FILES = 5;
```

- [ ] **Step 2: Write snapshot test scaffolding**

Reporter tests likely already use snapshots. Add new snapshot test fixtures:

```typescript
describe("formatHumanReport — file-grouped layout", () => {
  it("groups by file, caps at topFiles, renders Also-flagged footer + action-close", () => {
    const report: ScanReport = stubReport({
      findings: [
        domainFinding({ file: "src/a.ts", agent_risk: 0.9, recency: 1, severity: "high" }),
        domainFinding({ file: "src/a.ts", agent_risk: 0.8, recency: 1, severity: "medium" }),
        domainFinding({ file: "src/b.ts", agent_risk: 0.7, recency: 0, severity: "high" }),
        nonDomainFinding({ file: "scripts/x.ts", agent_risk: 0.6, severity: "medium" }),
        nonDomainFinding({ file: "tests/y.test.ts", agent_risk: 0.5, severity: "low" }),
      ],
    });
    expect(formatHumanReport(report, { noColor: true })).toMatchInlineSnapshot(`
      CRIME SCENE REPORT
      repo: x  ·  5 findings across 4 files

      Top files by risk

      🚨 src/a.ts                      2 findings · 1 high
         1. ...
         2. ...
         Risk: ...

      🚨 src/b.ts                      1 finding · 1 high
         1. ...

      Also flagged elsewhere
        scripts/  1 finding    tests/  1 finding
        Run with --all to see them.

      → Start with \`crimes context src/a.ts\` — it concentrates the most risk in this scan.
    `);
  });

  it("--flat reverts to today's severity-grouped layout", () => {
    const report = stubReport({ /* same findings */ });
    const out = formatHumanReport(report, { flat: true, noColor: true });
    expect(out).toContain("HIGH severity");  // today's heading format
    expect(out).not.toContain("Top files by risk");
  });

  it("--all flattens both tiers", () => {
    const report = stubReport({ /* same findings */ });
    const out = formatHumanReport(report, { showAll: true, noColor: true });
    // No "Also flagged elsewhere" section; every finding listed.
    expect(out).not.toContain("Also flagged elsewhere");
    expect(out).toContain("scripts/x.ts");
  });

  it("falls back to top non-domain file when no domain findings exist", () => {
    const report = stubReport({
      findings: [nonDomainFinding({ file: "scripts/x.ts", agent_risk: 0.6 })],
    });
    const out = formatHumanReport(report, { noColor: true });
    expect(out).toContain("every finding is in non-domain folders");
    expect(out).toContain("crimes context scripts/x.ts");
  });
});
```

Helpers `stubReport`, `domainFinding`, `nonDomainFinding` build minimal `ScanReport` and `Finding` objects with explicit `tier`, `scores.agent_risk`, `scores.recency`, and `severity`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @crimes/reporter test`
Expected: FAIL: old layout still emitted.

- [ ] **Step 4: Implement the new layout**

Pseudocode for `formatHumanReport` after refactor:

```typescript
export function formatHumanReport(report, options = {}) {
  if (options.flat) return formatHumanReportFlat(report, options);  // legacy path

  const colour = options.noColor ? plainColour() : pc;
  const showAll = options.showAll === true;
  const topFiles = options.topFiles ?? DEFAULT_TOP_FILES;

  const lines: string[] = [];
  lines.push(colour.bold("CRIME SCENE REPORT"));
  const fileCount = new Set(report.findings.map((f) => f.file)).size;
  lines.push(colour.dim(`repo: ${report.repo.name}  ·  ${report.findings.length} findings across ${fileCount} files`));

  if (report.findings.length === 0) {
    lines.push("");
    lines.push(colour.green(`✨ No crimes detected. Suspiciously clean.`));
    return lines.join("\n");
  }

  const domain = report.findings.filter((f) => f.tier !== "nonDomain");
  const nonDomain = report.findings.filter((f) => f.tier === "nonDomain");

  if (showAll) {
    // Flat list of all findings in rank order, no tier section.
    lines.push("");
    report.findings.forEach((f, i) => lines.push(...renderFindingCompact(f, i + 1, colour, options)));
  } else if (domain.length === 0) {
    // All-non-domain edge case.
    lines.push("");
    lines.push(colour.bold("All findings are in non-domain folders"));
    const topNon = groupByFile(nonDomain).slice(0, topFiles);
    renderFileGroups(lines, topNon, colour, options);
    lines.push("");
    lines.push(`→ Start with \`crimes context ${topNon[0]!.file}\` — every finding is in non-domain folders; review your scopeTiers config if that surprises you.`);
  } else {
    const groupedDomain = groupByFile(domain);
    const shown = groupedDomain.slice(0, topFiles);
    lines.push("");
    lines.push(colour.bold("Top files by risk"));
    renderFileGroups(lines, shown, colour, options);

    if (groupedDomain.length > shown.length) {
      const hidden = groupedDomain.length - shown.length;
      lines.push("");
      lines.push(colour.dim(`Showing ${shown.length} of ${groupedDomain.length} files. Run with --all for every finding.`));
    }

    if (nonDomain.length > 0) {
      lines.push("");
      lines.push(colour.bold("Also flagged elsewhere"));
      lines.push(colour.dim(`  ${nonDomainCountsLine(nonDomain)}`));
      lines.push(colour.dim(`  Run with --all to see them.`));
    }

    lines.push("");
    lines.push(`→ Start with \`crimes context ${shown[0]!.file}\` — it concentrates the most risk in this scan.`);
  }

  if (report.suppressed_count && report.suppressed_count > 0) {
    lines.push("");
    lines.push(colour.dim(`${report.suppressed_count} finding${report.suppressed_count === 1 ? "" : "s"} suppressed; run with --show-suppressed to see.`));
  }

  return lines.join("\n");
}
```

Helpers:

- `groupByFile(findings)` returns an array of `{ file, findings: Finding[], totalRankScore: number, severityCounts: { high, medium, low } }`, ordered by `totalRankScore` desc.
- `renderFileGroups(lines, groups, colour, opts)` per file:
  - Header: `severityGlyph(maxSeverity) + file + tally`
  - For each finding: a single compact line: `   N. {charge} · {symbol|""}   {key evidence joined by ", "}`
  - One `Risk:` summary line per file (max churn, dominant test_gap label, max blast radius)
  - `id=` range line if multiple findings
- `nonDomainCountsLine(findings)`: `scripts/  6 findings    examples/  3 findings    tests/  12 findings`. Determine prefix via `file.split("/")[0]` for `scripts/`/`examples/`/`fixtures/`/`public/`; group test files under `tests/`.
- `renderFindingCompact(f, n, colour, opts)`: for `--all` mode; one block per finding, using today's `renderFinding` shape but without the per-file header.
- `formatHumanReportFlat`: extracted today's exact rendering: verbatim move into a sibling function called only when `options.flat === true`.

"Key evidence" extraction for the compact line: take up to 2 evidence strings, joined by `, `. If none, just the charge.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @crimes/reporter test`
Expected: all PASS. Update inline snapshots to the new output (`pnpm --filter @crimes/reporter test -- -u`).

- [ ] **Step 6: Patch-bump and commit**

Human reporter changes don't affect JSON-based evals, but the layout is the headline UX change. Bump anyway so the release notes capture the moment.

```bash
sed -i '' 's/"version": "0.9.5"/"version": "0.9.6"/' packages/cli/package.json

git add packages/cli/package.json packages/reporter/src/human/scan.ts packages/reporter/src/reporter.test.ts
git commit -m "$(cat <<'EOF'
feat(reporter): file-grouped scan layout with action-close (0.9.5 → 0.9.6)

Default `crimes scan` now groups findings by file (top 5 by rank_score),
collapses each finding to a one-line compact form, summarises file-level
risk in a single line, segments non-domain findings into an "Also flagged
elsewhere" footer, and ends with a single imperative action-close line
pointing at the highest-risk file.

--all flattens both tiers (today's --all semantics, refined ordering).
--flat preserves today's severity-grouped layout exactly.
Empty repos keep the existing green sparkle line.

PRODUCT CHANGE — first-run UX changes substantially. No JSON contract
change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** evals score on JSON, not human output → no eval refresh strictly required. Verify a single eval run still passes; patch-bump captures the release-note milestone.

---

<span id="task-12-reporter--render-clues-in-context-human-output"></span>

## Task 12: Reporter: render `clues` in context human output

**Spec ref:** §5.7 (renders between Likely tests and Findings blocks).

**Files:**
- Modify: `packages/reporter/src/human/context.ts`
- Modify: `packages/reporter/src/reporter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe("formatContextHumanReport — clues block", () => {
  it("renders a Clues section with churn / suppressions / test_gap when present", () => {
    const report: ContextReport = stubContextReport({
      clues: {
        churn: { commits_90d: 14, last_commit_at: "2026-05-18T12:30:00Z", unique_authors_90d: 3 },
        suppressions: [
          { fingerprint: "abc", detector: "large_function", reason: "legacy", pinned_version: "0.9.x", matches_current_finding: false },
        ],
        test_gap: { raw: 1, percentile: 0.85, label: "top-quartile" },
        related_signals: [],
      },
    });
    const out = formatContextHumanReport(report, { noColor: true });
    expect(out).toContain("Clues");
    expect(out).toContain("churn: 14 commits / 3 authors (last 2026-05-18)");
    expect(out).toContain("test gap: top-quartile");
    expect(out).toContain("known suppressions: 1");
  });

  it("omits the Clues section when report.clues is absent", () => {
    const report = stubContextReport({});
    const out = formatContextHumanReport(report, { noColor: true });
    expect(out).not.toContain("Clues");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/reporter test`
Expected: FAIL.

- [ ] **Step 3: Render the block**

In `packages/reporter/src/human/context.ts`, insert after the "Likely tests" block and before "Findings":

```typescript
  // Clues — context-only signals beyond the per-file findings list.
  if (report.clues && (report.clues.churn || report.clues.suppressions || report.clues.test_gap)) {
    lines.push("");
    lines.push(colour.bold("Clues"));
    if (report.clues.churn) {
      const { commits_90d, last_commit_at, unique_authors_90d } = report.clues.churn;
      const dateOnly = last_commit_at.slice(0, 10);
      lines.push(`  · churn: ${commits_90d} commits / ${unique_authors_90d} author${unique_authors_90d === 1 ? "" : "s"} (last ${dateOnly})`);
    }
    if (report.clues.test_gap) {
      lines.push(`  · test gap: ${report.clues.test_gap.label}`);
    }
    if (report.clues.suppressions && report.clues.suppressions.length > 0) {
      const n = report.clues.suppressions.length;
      lines.push(`  · known suppressions: ${n} (review with crimes audit-suppressions)`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crimes/reporter test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/reporter/src/human/context.ts packages/reporter/src/reporter.test.ts
git commit -m "$(cat <<'EOF'
feat(reporter): render Clues block on crimes context human output

Surfaces churn / suppressions / test_gap label between the existing
Likely tests and Findings sections. Omitted when the JSON clues block
is absent. JSON contract unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none. No version bump.

---

<span id="task-13-cli-scan-flags----top---flat---no-recency"></span>

## Task 13: CLI scan flags: `--top`, `--flat`, `--no-recency`

**Spec ref:** §5.1, §5.3, §8 (`--flat` parity).

**Files:**
- Modify: `packages/cli/src/commands/scan.ts`
- Modify: `packages/cli/src/commands/scan.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/cli/src/commands/scan.test.ts`:

```typescript
import { Command } from "commander";
import { registerScanCommand } from "./scan.js";

describe("crimes scan — new flags", () => {
  it("declares --top, --flat, --no-recency", () => {
    const program = new Command();
    registerScanCommand(program);
    const scan = program.commands.find((c) => c.name() === "scan");
    expect(scan).toBeDefined();
    const opts = scan!.options.map((o) => o.long);
    expect(opts).toContain("--top");
    expect(opts).toContain("--flat");
    expect(opts).toContain("--no-recency");
  });
});
```

End-to-end flag behaviour is covered by the reporter tests (`--flat`) and the core sort test (`--no-recency` collapses recency to 0). This unit test just confirms registration.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter crimes test scan`
Expected: FAIL.

- [ ] **Step 3: Add the flags + forward them**

In `packages/cli/src/commands/scan.ts`:

```typescript
interface ScanCommandOptions {
  // ... existing fields ...
  top?: number;
  flat: boolean;
  recency: boolean;  // Commander gives this as `true` by default with --no-recency
}
```

In `registerScanCommand`:

```typescript
    .option("--top <n>", "show only the top N files (default 5)", (v) => Number.parseInt(v, 10))
    .option("--flat", "use the legacy flat-by-severity layout", false)
    .option("--no-recency", "disable the recency multiplier on rank_score", true)
```

Forward to the formatter and core:

```typescript
process.stdout.write(
  formatHumanReport(gatedReport, {
    showAll: options.all,
    topFiles: options.top,
    flat: options.flat,
    noColor: effectiveNoColor,
    feedbackHints: { /* ... */ },
  }) + "\n",
);
```

For `--no-recency` to actually disable the multiplier, the sort step in `tagTierAndSortByRankScore` needs a `recencyEnabled: boolean` argument. Plumb it: add `RecencyOptions` to `scan()` options, default true, pass through from CLI.

Add a thin core test verifying `recencyEnabled: false` produces the same order as today's pre-recency sort on a small fixture.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter crimes test scan && pnpm --filter @crimes/core test scan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/scan.ts packages/cli/src/commands/scan.test.ts packages/core/src/scan.ts packages/core/src/context-helpers.ts
git commit -m "$(cat <<'EOF'
feat(cli): add --top, --flat, --no-recency to crimes scan

--top N overrides the default 5-file cap per invocation.
--flat reverts to the legacy severity-grouped layout exactly.
--no-recency disables the recency multiplier, falling back to
agent_risk-only sort.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none. No version bump.

---

## Task 14: `init-detect` module + refactor `init.ts` to use it

**Spec ref:** §5.8 (medium detection: monorepo / Next.js / TS-only / scopeTiers).

**Files:**
- Create: `packages/cli/src/init-detect.ts`
- Create: `packages/cli/src/init-detect.test.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/init.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/init-detect.test.ts`:

```typescript
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRepoShape, generateConfig } from "./init-detect.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-init-detect-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

describe("detectRepoShape", () => {
  it("detects pnpm workspaces", async () => {
    const dir = await makeRepo({ "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" });
    const shape = await detectRepoShape(dir);
    expect(shape.isMonorepo).toBe(true);
  });

  it("detects Next.js", async () => {
    const dir = await makeRepo({ "next.config.js": "module.exports = {};" });
    const shape = await detectRepoShape(dir);
    expect(shape.isNextJs).toBe(true);
  });

  it("detects Vite", async () => {
    const dir = await makeRepo({ "vite.config.ts": "" });
    const shape = await detectRepoShape(dir);
    expect(shape.isVite).toBe(true);
  });

  it("detects TS-only when no JS-family files exist", async () => {
    const dir = await makeRepo({ "src/a.ts": "export {}", "src/b.tsx": "" });
    const shape = await detectRepoShape(dir);
    expect(shape.isTsOnly).toBe(true);
  });

  it("returns isTsOnly=false when even one .js / .mjs / .cjs / .jsx file exists", async () => {
    const dir = await makeRepo({ "src/a.ts": "", "scripts/legacy.js": "" });
    const shape = await detectRepoShape(dir);
    expect(shape.isTsOnly).toBe(false);
  });

  it("picks scopeTier patterns whose target exists", async () => {
    const dir = await makeRepo({
      "scripts/x.ts": "",
      "examples/y.ts": "",
    });
    const shape = await detectRepoShape(dir);
    expect(shape.scopeTiers).toContain("scripts/**");
    expect(shape.scopeTiers).toContain("examples/**");
    expect(shape.scopeTiers).not.toContain("fixtures/**");
    // Test globs are always appended:
    expect(shape.scopeTiers).toContain("**/*.test.{ts,tsx,js,jsx}");
  });
});

describe("generateConfig", () => {
  it("emits the static template when detect=false", async () => {
    const out = await generateConfig({ root: ".", detect: false });
    expect(out).toMatch(/"\$schema": "https:\/\/crimes\.sh\/schema/);
    expect(out).toMatch(/"include": \["\*\*\/\*\.\{ts/);
  });

  it("tightens include to ts-only when no JS files are present", async () => {
    const dir = await makeRepo({ "src/a.ts": "" });
    const out = await generateConfig({ root: dir, detect: true });
    expect(out).toContain('"include": ["**/*.{ts,tsx}"]');
  });

  it("adds .next/.vercel excludes when next.config.* exists", async () => {
    const dir = await makeRepo({ "next.config.js": "", "src/a.ts": "" });
    const out = await generateConfig({ root: dir, detect: true });
    expect(out).toContain('"**/.next/**"');
    expect(out).toContain('"**/.vercel/**"');
  });

  it("populates scopeTiers.nonDomain with only existing patterns + test globs", async () => {
    const dir = await makeRepo({ "scripts/x.ts": "" });
    const out = await generateConfig({ root: dir, detect: true });
    const parsed = JSON.parse(out);
    expect(parsed.scopeTiers.nonDomain).toContain("scripts/**");
    expect(parsed.scopeTiers.nonDomain).not.toContain("examples/**");
    expect(parsed.scopeTiers.nonDomain).toContain("**/*.test.{ts,tsx,js,jsx}");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter crimes test init-detect`
Expected: ERROR (module not found).

- [ ] **Step 3: Implement `init-detect.ts`**

```typescript
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface RepoShape {
  isMonorepo: boolean;
  isNextJs: boolean;
  isVite: boolean;
  isTsOnly: boolean;
  scopeTiers: string[];
}

const DIR_PATTERNS: Array<[string, string]> = [
  ["scripts", "scripts/**"],
  ["examples", "examples/**"],
  ["fixtures", "fixtures/**"],
  ["public", "public/**"],
  ["__tests__", "**/__tests__/**"],
];

const STATIC_TEST_GLOBS = [
  "**/*.test.{ts,tsx,js,jsx}",
  "**/*.spec.{ts,tsx,js,jsx}",
];

export async function detectRepoShape(root: string): Promise<RepoShape> {
  const exists = (path: string) => existsSync(join(root, path));

  const isMonorepo =
    exists("pnpm-workspace.yaml") ||
    exists("turbo.json") ||
    exists("lerna.json");

  const isNextJs =
    exists("next.config.js") ||
    exists("next.config.mjs") ||
    exists("next.config.cjs") ||
    exists("next.config.ts");

  const isVite =
    exists("vite.config.js") ||
    exists("vite.config.mjs") ||
    exists("vite.config.ts");

  const isTsOnly = await scanForJsFamilyAbsence(root);

  const scopeTiers: string[] = [];
  for (const [dir, pattern] of DIR_PATTERNS) {
    if (exists(dir)) scopeTiers.push(pattern);
  }
  scopeTiers.push(...STATIC_TEST_GLOBS);

  return { isMonorepo, isNextJs, isVite, isTsOnly, scopeTiers };
}

async function scanForJsFamilyAbsence(root: string): Promise<boolean> {
  // Walk a bounded depth; stop on first .js/.jsx/.mjs/.cjs hit.
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 1000) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(path);
        continue;
      }
      visited += 1;
      if (/\.(jsx?|mjs|cjs)$/.test(e.name)) return false;
    }
  }
  return true;
}

export interface GenerateConfigOptions {
  root: string;
  detect: boolean;
}

export async function generateConfig(options: GenerateConfigOptions): Promise<string> {
  const include = ["**/*.{ts,tsx,js,jsx,mjs,cjs}"];
  const exclude = [
    "**/node_modules/**", "**/dist/**", "**/build/**",
    "**/.next/**", "**/out/**", "**/coverage/**",
    "**/*.min.js", "**/*.generated.*", "**/.crimes/**",
  ];
  let scopeTiers = [
    "scripts/**", "examples/**", "fixtures/**", "public/**",
    "**/__tests__/**", ...STATIC_TEST_GLOBS,
  ];

  if (options.detect) {
    const shape = await detectRepoShape(options.root);
    if (shape.isTsOnly) include[0] = "**/*.{ts,tsx}";
    if (shape.isNextJs) exclude.push("**/.next/**", "**/.vercel/**");
    if (shape.isVite) exclude.push("**/dist/**");
    scopeTiers = shape.scopeTiers;
  }

  const config = {
    $schema: "https://crimes.sh/schema/0.1.0/config.json",
    include,
    exclude: dedupe(exclude),
    thresholds: { largeFileLines: 300, largeFunctionLines: 60, todoDensityPerKLoc: 10 },
    scopeTiers: { nonDomain: scopeTiers },
    scan: { topFiles: 5 },
    detectors: { enable: [], disable: [] },
    ia: { aliasGroups: [] },
    suppressions: { path: ".crimes/suppressions.json" },
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
```

- [ ] **Step 4: Refactor `init.ts` to use the generator**

In `packages/cli/src/commands/init.ts`:

```typescript
import { generateConfig } from "../init-detect.js";

// Replace the hardcoded STARTER_CONFIG with a call to generateConfig.
// Add `--no-detect` option to bypass detection (writes the static template).
//
// .action(async (options) => {
//   const path = resolve(process.cwd(), CONFIG_FILENAME);
//   ...existing exists checks...
//   const config = await generateConfig({ root: process.cwd(), detect: !options.noDetect });
//   writeFileSync(path, config, "utf8");
//   ...
// });
```

Update `init.test.ts`: existing tests that compare against `STARTER_CONFIG_TEXT` should switch to comparing against `generateConfig({ detect: false })`. The exported `STARTER_CONFIG_TEXT` constant can be removed or replaced with `generateConfig({ root: ".", detect: false })`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter crimes test init`
Expected: PASS (after snapshot updates for the new generator output).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init-detect.ts packages/cli/src/init-detect.test.ts packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): replace STARTER_CONFIG with detection-aware generator

init now emits a config tuned to the repo: tightens include to ts-only
when no JS files exist, adds .next/.vercel excludes for Next.js repos,
adds dist exclude for Vite repos, and populates scopeTiers.nonDomain
with only the patterns whose target directory exists (test globs are
always appended). --no-detect bypasses detection and writes the static
template — matches today's behaviour exactly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none. No version bump.

---

## Task 15: Auto-init module + Commander pre-action hook

**Spec ref:** §5.8 (trigger / detection / flow / SIGINT).

**Files:**
- Create: `packages/cli/src/auto-init.ts`
- Create: `packages/cli/src/auto-init.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/commands/init.ts` (add `--init` re-entry support: though the trigger lives globally)

**Background:** The auto-init module exports `maybeRunAutoInit(command, options)`. The CLI entry hooks it as a Commander `preAction` on the program. The hook:

1. Checks the `--no-init` / `--init` flags.
2. Checks suppression conditions: CI, non-TTY, marker file, config exists (unless `--init`).
3. If conditions allow: detects the agent, prompts twice, writes files, prints continuations.

Prompt uses Node's `readline` (zero new dependencies). SIGINT during the prompt: catch with `rl.on("close")` → exit 130.

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/auto-init.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectAgent,
  shouldPromptAutoInit,
} from "./auto-init.js";

describe("detectAgent", () => {
  it("prefers CLAUDECODE env var over directories", () => {
    expect(detectAgent({
      env: { CLAUDECODE: "1" },
      cwd: "/tmp",
      exists: () => true,
    })).toBe("claude");
  });

  it("returns 'codex' for OPENAI_CODEX", () => {
    expect(detectAgent({
      env: { OPENAI_CODEX: "1" },
      cwd: "/tmp",
      exists: () => false,
    })).toBe("codex");
  });

  it("falls back to .claude/ when no env var is set", () => {
    expect(detectAgent({
      env: {},
      cwd: "/tmp",
      exists: (p) => p.endsWith(".claude"),
    })).toBe("claude");
  });

  it("returns 'none' when neither env nor directory signals exist", () => {
    expect(detectAgent({
      env: {},
      cwd: "/tmp",
      exists: () => false,
    })).toBe("none");
  });
});

describe("shouldPromptAutoInit", () => {
  it("returns false when CI is set", () => {
    expect(shouldPromptAutoInit({
      env: { CI: "true" }, isTTY: true,
      configExists: false, markerExists: false,
      flags: { noInit: false, init: false },
    })).toBe(false);
  });

  it("returns false when stdout is not a TTY", () => {
    expect(shouldPromptAutoInit({
      env: {}, isTTY: false,
      configExists: false, markerExists: false,
      flags: { noInit: false, init: false },
    })).toBe(false);
  });

  it("returns false when --no-init is set", () => {
    expect(shouldPromptAutoInit({
      env: {}, isTTY: true,
      configExists: false, markerExists: false,
      flags: { noInit: true, init: false },
    })).toBe(false);
  });

  it("returns false when config already exists (unless --init)", () => {
    expect(shouldPromptAutoInit({
      env: {}, isTTY: true,
      configExists: true, markerExists: false,
      flags: { noInit: false, init: false },
    })).toBe(false);
  });

  it("returns true when --init forces re-entry even with config present", () => {
    expect(shouldPromptAutoInit({
      env: {}, isTTY: true,
      configExists: true, markerExists: false,
      flags: { noInit: false, init: true },
    })).toBe(true);
  });

  it("returns false when marker file exists", () => {
    expect(shouldPromptAutoInit({
      env: {}, isTTY: true,
      configExists: false, markerExists: true,
      flags: { noInit: false, init: false },
    })).toBe(false);
  });

  it("returns true on a clean first-run path", () => {
    expect(shouldPromptAutoInit({
      env: {}, isTTY: true,
      configExists: false, markerExists: false,
      flags: { noInit: false, init: false },
    })).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter crimes test auto-init`
Expected: ERROR.

- [ ] **Step 3: Implement the module**

`packages/cli/src/auto-init.ts`:

```typescript
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { generateConfig } from "./init-detect.js";

export type Agent = "claude" | "codex" | "none";

export interface DetectAgentInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  exists: (path: string) => boolean;
}

export function detectAgent(input: DetectAgentInput): Agent {
  if (input.env.CLAUDECODE || input.env.CLAUDE_CODE) return "claude";
  if (input.env.OPENAI_CODEX || input.env.CODEX_AGENT) return "codex";
  if (input.exists(join(input.cwd, ".claude"))) return "claude";
  if (input.exists(join(input.cwd, ".agents"))) return "codex";
  return "none";
}

export interface ShouldPromptInput {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  configExists: boolean;
  markerExists: boolean;
  flags: { noInit: boolean; init: boolean };
}

export function shouldPromptAutoInit(input: ShouldPromptInput): boolean {
  if (input.flags.noInit) return false;
  if (input.env.CI) return false;
  if (!input.isTTY) return false;
  if (input.markerExists) return false;
  if (input.configExists && !input.flags.init) return false;
  return true;
}

const MARKER_PATH = ".crimes/.skip-init";
const CONFIG_FILENAME = "crimes.config.json";

interface AutoInitOptions {
  cwd: string;
  flags: { noInit: boolean; init: boolean };
}

const COMMANDS_THAT_SKIP_PROMPT = new Set([
  "init", "feedback", "ignore", "unignore", "baseline",
]);

export async function maybeRunAutoInit(
  command: string,
  options: AutoInitOptions,
): Promise<void> {
  if (COMMANDS_THAT_SKIP_PROMPT.has(command)) return;

  const cwd = options.cwd;
  const configPath = join(cwd, CONFIG_FILENAME);
  const markerPath = join(cwd, MARKER_PATH);

  const should = shouldPromptAutoInit({
    env: process.env,
    isTTY: process.stdout.isTTY === true,
    configExists: existsSync(configPath),
    markerExists: existsSync(markerPath),
    flags: options.flags,
  });
  if (!should) return;

  const agent = detectAgent({ env: process.env, cwd, exists: existsSync });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.on("SIGINT", () => {
    rl.close();
    process.stdout.write("\n");
    process.exit(130);
  });

  try {
    let wroteAny = false;
    let declinedAny = false;

    if (!existsSync(configPath) || options.flags.init) {
      const ans = (await rl.question(
        `No crimes.config.json found. Generate one for this repo? [Y/n] `,
      )).trim().toLowerCase();
      if (ans === "" || ans === "y" || ans === "yes") {
        const body = await generateConfig({ root: cwd, detect: true });
        writeFileSync(configPath, body, "utf8");
        process.stdout.write(`  Wrote ${CONFIG_FILENAME}.\n`);
        wroteAny = true;
      } else {
        declinedAny = true;
      }
    }

    if (agent !== "none") {
      const skillPath = agent === "claude"
        ? join(cwd, ".claude/skills/crimes/SKILL.md")
        : join(cwd, ".agents/skills/crimes/SKILL.md");
      if (!existsSync(skillPath)) {
        const label = agent === "claude" ? "Claude Code" : "Codex";
        const rel = agent === "claude"
          ? ".claude/skills/crimes/SKILL.md"
          : ".agents/skills/crimes/SKILL.md";
        const ans = (await rl.question(
          `Write ${rel} so ${label} discovers crimes for future sessions? [Y/n] `,
        )).trim().toLowerCase();
        if (ans === "" || ans === "y" || ans === "yes") {
          mkdirSync(dirname(skillPath), { recursive: true });
          writeFileSync(skillPath, AGENT_SKILL_TEXT, "utf8");
          process.stdout.write(`  Wrote ${rel}.\n`);
          wroteAny = true;
        } else {
          declinedAny = true;
        }
      }
    }

    if (declinedAny && !wroteAny) {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, "", "utf8");
    }
    if (wroteAny || declinedAny) {
      process.stdout.write(`Continuing with \`${command}\` …\n\n`);
    }
  } finally {
    rl.close();
  }
}

// Reuse AGENT_SKILL from the existing init.ts; export it for shared use.
import { AGENT_SKILL_TEXT } from "./commands/init.js";
```

- [ ] **Step 4: Wire into the global program**

In `packages/cli/src/index.ts`:

```typescript
import { maybeRunAutoInit } from "./auto-init.js";

program
  .option("--no-init", "suppress the first-run auto-init prompt")
  .option("--init", "force the first-run auto-init prompt even if config exists")
  .hook("preAction", async (_thisCommand, actionCommand) => {
    const name = actionCommand.name();
    const opts = program.opts<{ init?: boolean; noInit?: boolean }>();
    await maybeRunAutoInit(name, {
      cwd: process.cwd(),
      flags: { init: opts.init === true, noInit: opts.noInit === true },
    });
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter crimes test auto-init && pnpm --filter crimes test`
Expected: PASS. The smoke test (`pnpm --filter crimes smoke`) runs non-interactively, so `shouldPromptAutoInit` returns `false` and nothing fires.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/auto-init.ts packages/cli/src/auto-init.test.ts packages/cli/src/index.ts packages/cli/src/commands/init.ts
git commit -m "$(cat <<'EOF'
feat(cli): auto-init on first run with agent detection

Two-prompt flow: generate crimes.config.json + (when detected) write the
single agent-specific skill file. Trigger conditions: TTY present, CI
unset, --no-init absent, marker file absent, config missing OR --init
flag forces re-entry. Detection priority: env var > directory presence,
claude > codex on ties. Skip on init/feedback/ignore/unignore/baseline
subcommands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none. No version bump.

---

## Task 16: CLI welcome banner + `--help` reorder

**Spec ref:** §5.9.

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
// existing welcomeBanner export (or test the action handler's stdout)
import { welcomeBanner } from "./index.js";

describe("welcomeBanner", () => {
  it("lists `crimes context` as the headline command", () => {
    const out = welcomeBanner();
    const contextIdx = out.indexOf("crimes context");
    const scanIdx = out.indexOf("crimes scan");
    expect(contextIdx).toBeGreaterThan(-1);
    expect(scanIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(scanIdx);
  });
});
```

(If `welcomeBanner` is currently a private helper, export it for testing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter crimes test index`
Expected: FAIL.

- [ ] **Step 3: Update the banner and addHelpText**

```typescript
export function welcomeBanner(): string {
  return [
    `crimes ${__CRIMES_VERSION__}`,
    "",
    "A crime scene investigator for your codebase. Built for agents, readable by humans.",
    "",
    "Pick one to get started:",
    "  crimes context <file>  pre-edit briefing for a single file",
    "  crimes scan            risk overview for the whole repo",
    "  crimes init --agents   set up config + a skill for your coding agent",
    "  crimes --help          list all commands",
    "",
    "Docs: https://crimes.sh",
    "",
  ].join("\n");
}
```

And the `addHelpText("after", ...)`:

```typescript
.addHelpText(
  "after",
  "\nTip: run `crimes context <file>` before editing — it concentrates findings + likely tests + agent notes for one file.",
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter crimes test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): lead with `crimes context` in welcome banner and --help

context is the standout command per two independent agent-user reviews;
it should be the first thing a fresh terminal user sees. Scan and init
remain available; nothing is removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Eval impact:** none. No version bump.

---

## Task 17: Docs reorder + Changeset (release wrap)

**Spec ref:** §5.9 (docs), §10 (versioning policy).

**Files:**
- Modify: `README.md`
- Modify: `docs/agent-usage.md`
- Create: `.changeset/release-a-front-door.md`
- Create: `docs/releases/v0.10.0.md`
- Modify: `packages/cli/package.json` (final bump to `0.10.0`)

- [ ] **Step 1: Reorder the README quick-start**

In `README.md`, the "Quick start" code block (today's order: scan first, then context):

```bash
# Pre-edit briefing for one file (findings + likely tests + agent notes)
crimes context src/billing/tax.ts --format json

# Scan the current directory (file-grouped, top 5 files)
crimes scan .

# Stable JSON output — the product contract
crimes scan . --format json

# Show every finding, not just the top files
crimes scan . --all

# Scan only files changed in the working tree (post-edit gate)
crimes scan --changed --format json
crimes scan --changed --base main --format json

# Rank files by Git churn × current findings
crimes hotspots --since 90d --format json
```

Update the Status section to describe Release A: file-grouped scan, clues on context, auto-init, scope tiers, test_gap quartile, recency-weighted ranking.

- [ ] **Step 2: Reorder `docs/agent-usage.md`**

Restructure top-level sections in this order:

1. **Pre-edit briefing** (`crimes context <file>`): what to read first
2. **Scan and post-edit gates** (`crimes scan`, `crimes scan --changed`)
3. **Verdict** (`crimes verdict`)
4. **Hotspots / diff / ask**: supporting commands

Lift agent-context language already present in the doc; only reorder and tighten transitions.

- [ ] **Step 3: Write release notes**

Create `docs/releases/v0.10.0.md` capturing every change in the release with links to the spec doc and to the affected commits. Use existing release notes under `docs/releases/` as the template. Be explicit about the two visible-behaviour shifts:

- **scan default layout** is file-grouped, not severity-grouped. `--flat` reverts.
- **`Finding.scores.test_gap`** now repo-relative quartile-ranked instead of `{0, 0.5, 1.0}`. Range and field name unchanged; distribution shifts. Agents that compared exact values (e.g. `if test_gap === 1`) need to switch to `>= 0.75`.

- [ ] **Step 4: Write the Changeset**

Create `.changeset/release-a-front-door.md`:

```markdown
---
"crimes": minor
---

Front-door redesign (Release A): file-grouped `scan` layout with action-close, repo-relative `test_gap` quartile, recency-weighted ranking, `scopeTiers` non-domain partition, `clues` block on `context --json`, two-prompt auto-init with agent detection, docs/banner lead with `context`. Detector taxonomy unchanged; `schema_version` unchanged (`clues`, `tier`, and `recency` are additive optional fields). `--flat` reverts the scan layout; `--no-recency` disables the recency multiplier.
```

- [ ] **Step 5: Final version bump and commit**

```bash
# Bump from the last patch (e.g. 0.9.6) to 0.10.0
sed -i '' 's/"version": "0.9.6"/"version": "0.10.0"/' packages/cli/package.json

git add README.md docs/agent-usage.md docs/releases/v0.10.0.md .changeset/release-a-front-door.md packages/cli/package.json
git commit -m "$(cat <<'EOF'
chore: cut crimes@0.10.0 — front-door redesign (Release A)

Rolls up the accumulated 0.9.3 → 0.9.6 patch series into a single minor
release. README + docs/agent-usage.md reordered to lead with `context`.
Changeset and release notes attached.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Final validation**

```bash
pnpm ci                                # full workspace build + typecheck + test
pnpm --filter crimes smoke             # pack tarball + exercise commands from clean install
pnpm run evals                         # final eval baseline at 0.10.0
git add evals/results/0.10.0
git commit -m "chore: eval baseline for 0.10.0 release"
```

If `pnpm ci` or smoke fails: diagnose, fix on a follow-up commit, re-run. Do not push if either is red.

**Eval impact:** final baseline directory at `0.10.0`. No further patch bumps.

---

## Self-review (after writing the plan)

Spec coverage check: every spec section maps to at least one task:

- §5.1 layout → Task 11
- §5.2 ranking → Tasks 6 (tier), 8 (sort), 11 (display)
- §5.3 recency → Tasks 5 (index), 7 (on Finding), 8 (sort), 13 (--no-recency)
- §5.4 test_gap quartile → Tasks 2 (utility), 3 (pass), 10 (label)
- §5.5 scope tiers → Tasks 1 (config), 6 (helper), 8 (tag), 11 (footer)
- §5.6 action-close → Task 11
- §5.7 clues → Tasks 4 (churn ext), 9 (build), 12 (render)
- §5.8 auto-init → Tasks 14 (generator), 15 (module + hook)
- §5.9 docs → Tasks 16 (banner), 17 (docs + release)
- §11 frozen contracts → Tasks 1 (scopeTiers config), 9 (clues shape)

Placeholder scan: no "TBD", "TODO", "fill in", "similar to". Step 1 of Task 11 has a step labelled "Substeps:" with multiple bullets: those are explicit substeps within one Task step, not placeholders.

Type/signature consistency:
- `Tier` type defined in `scoring/tier.ts` (Task 6) is referenced in `Finding` (Task 6) and in the tagger (Task 8): consistent.
- `RecencyIndex` (Task 5), `recency` on `FindingScores` (Task 7), and `rank_score` formula in `tagTierAndSortByRankScore` (Task 8) all line up: `agent_risk * (1 + (recency ?? 0) * 0.5)`.
- `ContextClues.test_gap.label` enum `"top-quartile" | "median" | "bottom-quartile" | "unknown"` (Task 9) matches the renderer's `testGapLabel` (Task 10): note: spec uses `"~median"` for the human label but the JSON enum stays plain `"median"`. Confirmed in spec §5.7 (JSON) vs §5.4 (human display).
- `MARKER_PATH = ".crimes/.skip-init"` (Task 15) matches spec §5.8.

No spec requirement is uncovered. No types are introduced without definition.
