# Release B — Triage as the Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `crimes@0.11.0` with a new `crimes triage` command, triage-and-baseline-aware resurfacing, `effort` + `fix_shape` schema additions (single `schema_version` bump to `"0.2.0"`), a PreToolUse Edit hook written by `init --agents`, human-readable secondary scores in the renderer, and full doc + website updates covering both Release A and Release B.

**Architecture:** Two new core modules (`triage.ts` for storage, `resurface.ts` for the diff-driven re-detect pipeline), a new `detector-defaults.ts` populating `effort` + `fix_shape` per detector type, a new `commands/triage.ts` CLI command, a new `hook-templates.ts` for the init-time hook write, a new reporter `human/score-format.ts` interpreting raw scores, plus surgical edits to `finding.ts`, `scoring/build.ts`, `scan.ts`, `config.ts`, `commands/init.ts`, `commands/scan.ts`, `human/scan.ts`, and `human/context.ts`. Triage filters apply alongside (not merged with) suppressions in the scan pipeline. Resurfacing re-runs the relevant detector on each touched-and-triaged file to produce a live `Finding` with current evidence.

**Tech Stack:** TypeScript on Node.js · pnpm workspaces · tsup · Vitest · Commander.js · zod · simple-git · fast-glob · `@typescript-eslint/typescript-estree`. `crimes` is published as the unscoped `crimes` package; the workspace packages are `@crimes/core`, `@crimes/language-js`, `@crimes/reporter`, and the `crimes` (cli) package.

---

## Reference index for the engineer

The engineer implementing this plan should keep these files open:

- `docs/superpowers/specs/2026-05-20-release-b-triage-design.md` — design spec this plan implements. When in doubt, the spec wins.
- `packages/core/src/finding.ts` — public schema; `SCHEMA_VERSION` lives here.
- `packages/core/src/baseline.ts` — load/save/validate pattern to mirror for triage.
- `packages/core/src/suppressions.ts` — zod schema + load helpers; structural reference for triage.
- `packages/core/src/fingerprint.ts` — `<type>::<file>::<symbol-or-empty>` identity used by baseline/suppressions/triage.
- `packages/core/src/scan.ts` — main scan pipeline; new triage + resurface stages slot in here.
- `packages/core/src/scoring/build.ts` — `finaliseFindingScores` lives here; new `applyDetectorDefaults` runs alongside it.
- `packages/cli/src/commands/init.ts` and `packages/cli/src/auto-init.ts` — existing patterns for writing files into `.claude/` / `.agents/`.
- `packages/reporter/src/human/scan.ts` and `packages/reporter/src/human/context.ts` — render-side files modified for resurface block, fix-shape rendering, and secondary-score reformatting.

The repo follows TDD. Every task that touches code starts with a failing test.

**Eval baseline policy** (per `evals/README.md` § Versioning policy):

- Tasks that change findings, scoring, or filter behaviour patch-bump `packages/cli/package.json` and re-run `pnpm run evals` in the same commit. The new `evals/results/<version>/` directory ships alongside the code change.
- Renderer-only and docs-only tasks do **not** patch-bump.
- One Changeset at the **end** of the release rolls accumulated patches into the minor `0.10.x → 0.11.0` bump.

**Branch hygiene:** all tasks land on `main` (no PR gating between them — this is solo work; commits stack).

---

## Phase 1 — Schema additions (`effort`, `fix_shape`, schema_version bump)

### Task 1: Add `Effort` type and the `fix_shape` field to the public schema

**Files:**
- Modify: `packages/core/src/finding.ts`

- [ ] **Step 1: Open `packages/core/src/finding.ts` and locate the `Finding` interface**

The current file declares `export const SCHEMA_VERSION = "0.1.0" as const;` at line 6 and the `Finding` interface at line 57. Both lines will change in this task.

- [ ] **Step 2: Add the `Effort` type alias and update `Finding`**

Replace the top of the file (lines 1–10) with this header:

```typescript
/**
 * Public finding schema. This is part of the product API contract.
 *
 * Bumping `schema_version` is a breaking change.
 */
export const SCHEMA_VERSION = "0.2.0" as const;

import type { Tier } from "./scoring/tier.js";

export type Severity = "low" | "medium" | "high";

/**
 * Estimated effort to address a finding. Detector-supplied; defaults from
 * `core/src/detector-defaults.ts` when a detector omits it.
 *
 * - `quick`  — ≤1-line change
 * - `small`  — under 1 hour
 * - `medium` — fits within one PR
 * - `large`  — needs design
 */
export type Effort = "quick" | "small" | "medium" | "large";
```

Then, in the `Finding` interface (currently lines 57–112), add these two fields **immediately after the `evidence: string[]` line and before `scores: FindingScores;`**:

```typescript
  /**
   * Estimated effort to address. Detector-supplied; `core` fills the
   * default from `detector-defaults.ts` if the detector omits it.
   */
  effort: Effort;
  /**
   * One-line description of the *shape* of the fix, not the fix itself.
   * Detector-supplied; ≤120 chars, single line. Defaults vary per
   * detector type — see `core/src/detector-defaults.ts`.
   */
  fix_shape: string;
```

These fields are **required** on output. Consumers reading the old `0.1.0` shape ignore unknown fields — strict-additive.

- [ ] **Step 3: Run the existing test suite to see all the failures the schema change creates**

Run: `pnpm --filter @crimes/core test --run 2>&1 | tail -40`
Expected: ~60–120 TypeScript errors in detector and scan test files about missing `effort` / `fix_shape` properties on the constructed `Finding` literals.

This is the desired failure — every place that constructs a `Finding` is now flagged by the typechecker. We will fix them in Task 2 by populating defaults in finalisation, so test stubs and detector outputs don't have to manually add the fields.

- [ ] **Step 4: Do not commit yet — Task 2 lands the defaults that make these errors go away**

Task 1 alone leaves the build broken. Continue to Task 2 in the same working session.

---

### Task 2: `detector-defaults.ts` — populate `effort` + `fix_shape` per detector type

**Files:**
- Create: `packages/core/src/detector-defaults.ts`
- Create: `packages/core/src/detector-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/detector-defaults.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { DETECTOR_DEFAULTS, GENERIC_DEFAULT, getDefaultsFor } from "./detector-defaults.js";
import { builtInDetectors, builtInAssetDetectors } from "./detector-registry.js";

describe("detector-defaults", () => {
  it("exposes a GENERIC_DEFAULT fallback for unknown detector types", () => {
    expect(GENERIC_DEFAULT.effort).toBe("medium");
    expect(GENERIC_DEFAULT.fix_shape).toMatch(/refactor/);
    expect(GENERIC_DEFAULT.fix_shape.length).toBeLessThanOrEqual(120);
    expect(GENERIC_DEFAULT.fix_shape).not.toContain("\n");
  });

  it("has a one-line fix_shape (no newlines, <=120 chars) for every detector type", () => {
    for (const [type, defaults] of Object.entries(DETECTOR_DEFAULTS)) {
      expect(defaults.fix_shape.length, `${type} fix_shape too long`).toBeLessThanOrEqual(120);
      expect(defaults.fix_shape, `${type} fix_shape has newline`).not.toContain("\n");
      expect(defaults.fix_shape.trim(), `${type} fix_shape empty`).not.toBe("");
      expect(["quick", "small", "medium", "large"]).toContain(defaults.effort);
    }
  });

  it("covers every registered detector id (source + asset)", () => {
    const ids = new Set<string>([
      ...builtInDetectors.map((d) => d.id),
      ...builtInAssetDetectors.map((d) => d.id),
    ]);
    for (const id of ids) {
      expect(
        DETECTOR_DEFAULTS[id],
        `missing default for detector ${id} — add it to detector-defaults.ts`,
      ).toBeDefined();
    }
  });

  it("returns GENERIC_DEFAULT for an unknown detector type", () => {
    expect(getDefaultsFor("not_a_real_detector_id")).toEqual(GENERIC_DEFAULT);
  });

  it("returns the bespoke default for a known type", () => {
    expect(getDefaultsFor("large_function").effort).toBe("small");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test -- detector-defaults --run`
Expected: FAIL with "Cannot find module './detector-defaults.js'".

- [ ] **Step 3: Create `packages/core/src/detector-defaults.ts`**

Populate one row per registered detector. The list of detector ids is in the spec (§5.6) and verifiable by running `grep -h 'id: "' packages/core/src/detectors/*.ts | sed 's/.*id: "//; s/",.*//' | sort -u`. There are 48 source detectors plus a handful of asset detectors (`oversized_raster`, `raster_should_be_vector`, `svg_with_embedded_raster`).

```typescript
import type { Effort } from "./finding.js";

export interface DetectorDefaults {
  effort: Effort;
  fix_shape: string;
}

export const GENERIC_DEFAULT: DetectorDefaults = {
  effort: "medium",
  fix_shape: "refactor to remove this signal; add a test that pins the fix",
};

/**
 * Per-detector defaults applied during finalisation when a detector emits
 * a finding without setting `effort` or `fix_shape`. Detectors that want
 * per-finding overrides can set the fields directly on the emitted
 * `Finding` object — same as `severity`.
 */
export const DETECTOR_DEFAULTS: Record<string, DetectorDefaults> = {
  // Structural — keep these aligned with the detector source order.
  large_function: { effort: "small", fix_shape: "extract pure helpers; keep the orchestrator thin" },
  large_file: { effort: "medium", fix_shape: "split by responsibility; one concern per module" },
  todo_density: { effort: "small", fix_shape: "convert TODOs to tickets or delete; comments are not tracking" },
  commented_out_code: { effort: "quick", fix_shape: "delete; git history preserves it" },
  option_bag_junk_drawer: { effort: "small", fix_shape: "split the options bag into named, narrowly-typed records" },
  negative_flag_maze: { effort: "small", fix_shape: "invert flags to read positively; consolidate combined states" },
  return_shape_roulette: { effort: "small", fix_shape: "pick one return shape; use a discriminated union if you need both" },

  // Dependency / structure
  circular_dependency: { effort: "medium", fix_shape: "extract shared types to a leaf module" },
  deep_import: { effort: "quick", fix_shape: "import from the package boundary, not the internals" },
  layer_violation: { effort: "medium", fix_shape: "route through the layer boundary or relocate the consumer" },
  high_fan_in_fan_out: { effort: "medium", fix_shape: "split or invert: too many consumers means too much coupling" },

  // Duplication
  exact_duplicate_block: { effort: "small", fix_shape: "extract the duplicated block into a shared helper" },
  near_duplicate_block: { effort: "small", fix_shape: "consolidate into one helper; pass the differing values as args" },
  duplicate_component_shape: { effort: "small", fix_shape: "extract the shared component; parameterise the differing props" },
  duplicated_role_status_plan_check: { effort: "medium", fix_shape: "centralise the policy check; everyone calls the one helper" },
  duplicated_navigation_source: { effort: "small", fix_shape: "single source of truth for nav; routes derive from it" },
  magic_domain_literal_scatter: { effort: "small", fix_shape: "promote the literal to a named constant in one module" },
  finder_duplicate_filename: { effort: "quick", fix_shape: "delete the duplicate; the canonical file already exists" },

  // Testability
  direct_date: { effort: "small", fix_shape: "inject a clock; pass through the domain boundary" },
  hardcoded_localhost: { effort: "quick", fix_shape: "lift the host to config or env; default for dev only" },
  hardcoded_local_path: { effort: "quick", fix_shape: "use a portable path or resolve from a configured root" },
  sync_io_in_hotpath: { effort: "small", fix_shape: "switch to async I/O; await at the call site" },
  weak_test_signal: { effort: "small", fix_shape: "assert behaviour, not implementation; remove no-op assertions" },

  // Information architecture (IA)
  copy_ia_drift: { effort: "small", fix_shape: "pick the canonical label; redirect copies to it" },
  concept_alias_drift: { effort: "small", fix_shape: "rename the alias to match the canonical term; one term per concept" },
  command_drift_docs_code_drift: { effort: "small", fix_shape: "regenerate command docs from code or codify them in CI" },
  docs_code_drift: { effort: "small", fix_shape: "sync the doc to the code, or move the assertion into a test" },
  action_label_drift: { effort: "small", fix_shape: "pick one verb per action; update labels uniformly" },
  permission_ia_drift: { effort: "small", fix_shape: "centralise the permission check; every caller goes through it" },
  route_metadata_drift: { effort: "small", fix_shape: "derive route metadata from one source; remove the divergent copies" },
  parallel_destination: { effort: "small", fix_shape: "fold the parallel destinations into one; route via a switch if necessary" },
  orphaned_destination: { effort: "quick", fix_shape: "delete the orphan destination or wire it up" },
  missing_agent_context: { effort: "small", fix_shape: "write a SKILL.md so agents discover the entry points" },

  // Naming
  boolean_naming_drift: { effort: "quick", fix_shape: "rename to `isX`/`hasX`/`shouldX`; consistent across the module" },
  name_behavior_mismatch: { effort: "small", fix_shape: "rename to match behaviour, or change the body to match the name" },
  singular_plural_type_mismatch: { effort: "quick", fix_shape: "make the name agree with the type — `users` for array, `user` for scalar" },
  logic_in_comments: { effort: "small", fix_shape: "lift the prose rule to an assert / type / test / config check" },

  // Time / locale
  mixed_utc_local_methods: { effort: "medium", fix_shape: "pick one time domain; convert at the boundary" },
  timezone_unsafe_parse: { effort: "small", fix_shape: "parse with explicit timezone; reject ambiguous inputs" },
  dst_naive_arithmetic: { effort: "medium", fix_shape: "use a DST-aware library; never add seconds to a wall-clock date" },
  date_string_concat: { effort: "small", fix_shape: "format dates via a single helper; never concatenate fragments" },
  locale_drift: { effort: "small", fix_shape: "centralise locale; one provider for all formatters" },

  // UI / interaction
  accessible_interaction_risk: { effort: "small", fix_shape: "use semantic elements; add ARIA only when semantics don't fit" },
  design_token_escape: { effort: "quick", fix_shape: "replace raw values with the design token" },
  responsive_fragility: { effort: "small", fix_shape: "drive layout from container queries or a fluid scale, not pixel media queries" },

  // Asset detectors
  oversized_raster: { effort: "quick", fix_shape: "downscale or convert to WebP/AVIF; budget the size" },
  raster_should_be_vector: { effort: "quick", fix_shape: "ship the SVG source; rasters lose at any scale" },
  svg_with_embedded_raster: { effort: "small", fix_shape: "externalise the embedded raster or replace it with vector geometry" },
};

export function getDefaultsFor(detectorType: string): DetectorDefaults {
  return DETECTOR_DEFAULTS[detectorType] ?? GENERIC_DEFAULT;
}
```

- [ ] **Step 4: Run the test to verify all assertions pass**

Run: `pnpm --filter @crimes/core test -- detector-defaults --run`
Expected: PASS.

If the "covers every registered detector id" assertion fails, the diff tells you which id is missing. Add it to `DETECTOR_DEFAULTS` with a one-line `fix_shape` matching the detector's domain.

- [ ] **Step 5: Do not commit yet — Task 3 wires this into finalisation**

Continue to Task 3.

---

### Task 3: Apply detector defaults in finalisation

**Files:**
- Modify: `packages/core/src/scoring/build.ts:329-353`
- Modify: `packages/core/src/scoring/build.test.ts` (or whatever the existing test file is named — the directory has a test file for the scoring module already)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/scoring/build.test.ts` (create the file if it doesn't exist, but it should — `ls packages/core/src/scoring/` to confirm):

```typescript
import { describe, expect, it } from "vitest";
import { finaliseFindingScores } from "./build.js";
import type { Finding } from "../finding.js";

function stubFinding(overrides: Partial<Finding> = {}): Finding {
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
  } as Finding;
}

describe("finaliseFindingScores — applies detector defaults", () => {
  it("fills effort and fix_shape from DETECTOR_DEFAULTS when detector omits them", () => {
    const finding = stubFinding({ effort: undefined as never, fix_shape: undefined as never });
    finaliseFindingScores(finding, undefined);
    expect(finding.effort).toBe("small"); // large_function default
    expect(finding.fix_shape).toBe("extract pure helpers; keep the orchestrator thin");
  });

  it("keeps detector-supplied effort and fix_shape when set", () => {
    const finding = stubFinding({
      effort: "large",
      fix_shape: "bespoke override",
    });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test -- scoring/build --run`
Expected: FAIL — "expected 'placeholder…' to be 'extract pure helpers…'" or similar.

- [ ] **Step 3: Implement the defaults pass in `finaliseFindingScores`**

In `packages/core/src/scoring/build.ts`, add an import at the top of the file (after the existing imports):

```typescript
import { getDefaultsFor } from "../detector-defaults.js";
```

Modify `finaliseFindingScores` (lines 329–353) to apply detector defaults **before** the existing scoring math. The new top of the function looks like:

```typescript
export function finaliseFindingScores(
  finding: Finding,
  scoring: ScoringContext | undefined,
): void {
  // Backfill detector-supplied effort + fix_shape from the per-type
  // defaults map. Detectors that set their own values keep them; only
  // missing or invalid values are replaced.
  const defaults = getDefaultsFor(finding.type);
  const currentEffort = (finding as Partial<Finding>).effort;
  if (
    currentEffort !== "quick" &&
    currentEffort !== "small" &&
    currentEffort !== "medium" &&
    currentEffort !== "large"
  ) {
    finding.effort = defaults.effort;
  }
  const currentShape = (finding as Partial<Finding>).fix_shape;
  if (
    typeof currentShape !== "string" ||
    currentShape.trim() === "" ||
    currentShape.includes("\n") ||
    currentShape.length > 120
  ) {
    finding.fix_shape = defaults.fix_shape;
  }

  // ...existing churn / test_gap / blast_radius / recency math unchanged...
```

Leave the rest of the function (lines 333–353) exactly as-is.

- [ ] **Step 4: Run scoring tests**

Run: `pnpm --filter @crimes/core test -- scoring/build --run`
Expected: PASS (all three new tests plus existing ones).

- [ ] **Step 5: Run the full core test suite to see how many other tests still fail**

Run: `pnpm --filter @crimes/core test --run 2>&1 | tail -20`

The detector-output tests will still fail wherever they assert exact `Finding` shape against fixtures or snapshots — they need to expect `effort` and `fix_shape` now. We'll patch them in the next step.

- [ ] **Step 6: Update detector test fixtures + snapshots**

The detector tests construct expected findings as object literals. Every one that asserts equality against a full `Finding` object needs `effort` and `fix_shape` added.

For tests that do a partial-shape assertion (`expect(finding).toMatchObject({ type, severity })`), nothing changes — those still pass.

For tests that compare against snapshots (e.g. `expect(findings).toMatchInlineSnapshot()`), re-run with `--update-snapshots` to regenerate.

Practical workflow:

```bash
# Re-run, update snapshots, then sanity-check the diff before committing
pnpm --filter @crimes/core test --run -u
git diff packages/core/src/ | head -200
```

Inspect each updated snapshot. Every diff should show two added lines per finding:

```diff
+    "effort": "small",
+    "fix_shape": "extract pure helpers; keep the orchestrator thin",
```

Reject any diff that's not those two additions (or `severity`/`charge` changes — the snapshot may have other drift; if so, stop and investigate before continuing).

For non-snapshot tests that build a `Finding` literal and now fail with TypeScript errors (`Property 'effort' is missing`), the fix is the same two lines, picked from `DETECTOR_DEFAULTS[type]`.

Run repeatedly until clean:

```bash
pnpm --filter @crimes/core test --run 2>&1 | grep -E "FAIL|Error" | head -20
```

Expected after all fixes: PASS across `@crimes/core`.

- [ ] **Step 7: Repeat for `@crimes/reporter` and the CLI**

Run: `pnpm --filter @crimes/reporter test --run -u`
Then: `pnpm --filter crimes test --run -u`

Same diff inspection — only `effort` / `fix_shape` additions.

- [ ] **Step 8: Patch-bump `packages/cli/package.json`**

This commit changes finding shape, so the eval baseline directory shifts.

In `packages/cli/package.json`, change `"version": "0.10.0"` to `"version": "0.10.1"`.

- [ ] **Step 9: Re-run evals against the new baseline**

Run: `pnpm run evals`
Expected: completes, writes a new `evals/results/0.10.1/` directory.

- [ ] **Step 10: Inspect the eval diff**

Run: `git status evals/results/ && git diff --stat evals/results/`

Expect: a new `evals/results/0.10.1/` directory with results identical in structure to `evals/results/0.10.0/` except every finding now carries `effort` and `fix_shape`. No quality movement — this is a measurement-shape correction (the schema gained two fields).

- [ ] **Step 11: Commit Tasks 1, 2, and 3 together**

```bash
git add packages/core/src/finding.ts \
        packages/core/src/detector-defaults.ts \
        packages/core/src/detector-defaults.test.ts \
        packages/core/src/scoring/build.ts \
        packages/core/src/scoring/build.test.ts \
        packages/core/src/detectors/*.test.ts \
        packages/core/src/scan.test.ts \
        packages/core/src/context.test.ts \
        packages/reporter/src/reporter.test.ts \
        packages/cli/src/commands/scan.test.ts \
        packages/cli/package.json \
        evals/results/0.10.1/
git commit -m "feat(core): add effort + fix_shape schema fields (schema_version 0.2.0)

Adds two new required fields to every Finding: \`effort\` (enum) and
\`fix_shape\` (one-line string). Both are populated by detectors when
they have specific values; finalisation backfills from per-type
defaults in detector-defaults.ts when omitted. Lifts SCHEMA_VERSION
to 0.2.0.

Measurement-shape correction, not a quality change: eval outputs
gain two keys per finding; rankings unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Note: the test files modified may include far more than the list above — adjust the `git add` to match what `git status` shows after Step 7.

---

## Phase 2 — Triage core (storage + scan integration)

### Task 4: `triage.ts` — load, validate, save `.crimes/triage.json`

**Files:**
- Create: `packages/core/src/triage.ts`
- Create: `packages/core/src/triage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/triage.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTriage,
  resolveTriagePath,
  saveTriage,
  upsertTriageEntry,
  MalformedTriageError,
  type Triage,
  type TriageEntry,
} from "./triage.js";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "crimes-triage-test-"));
}

function sampleEntry(overrides: Partial<TriageEntry> = {}): TriageEntry {
  return {
    fingerprint: "large_function::src/foo.ts::doStuff",
    type: "large_function",
    file: "src/foo.ts",
    symbol: "doStuff",
    disposition: "wont-fix",
    reason: "legacy code, planned rewrite",
    owner: "@amayfield",
    date: "2026-05-20",
    ...overrides,
  };
}

describe("triage", () => {
  it("returns an empty entries list when the file does not exist", async () => {
    const root = makeTempRoot();
    const result = await loadTriage(resolveTriagePath(root));
    expect(result.entries).toEqual([]);
    expect(result.loaded).toBe(false);
    expect(result.path.endsWith(".crimes/triage.json")).toBe(true);
  });

  it("round-trips a single entry through save then load", async () => {
    const root = makeTempRoot();
    const path = resolveTriagePath(root);
    const triage: Triage = {
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [sampleEntry()],
    };
    await saveTriage(path, triage);
    const loaded = await loadTriage(path);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toMatchObject({
      fingerprint: "large_function::src/foo.ts::doStuff",
      disposition: "wont-fix",
      owner: "@amayfield",
    });
  });

  it("rejects malformed JSON with MalformedTriageError", async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, ".crimes"), { recursive: true });
    const path = join(root, ".crimes", "triage.json");
    writeFileSync(path, "{ not json");
    await expect(loadTriage(path)).rejects.toBeInstanceOf(MalformedTriageError);
  });

  it("rejects an entry missing the reason field", async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, ".crimes"), { recursive: true });
    const path = join(root, ".crimes", "triage.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: "x::a::b",
            type: "x",
            file: "a",
            disposition: "wont-fix",
            // reason missing
            owner: "@a",
            date: "2026-05-20",
          },
        ],
      }),
    );
    await expect(loadTriage(path)).rejects.toBeInstanceOf(MalformedTriageError);
  });

  it("upsertTriageEntry adds a new entry", () => {
    const triage: Triage = {
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [],
    };
    const next = upsertTriageEntry(triage, sampleEntry(), { now: () => new Date("2026-05-21T00:00:00Z") });
    expect(next.entries).toHaveLength(1);
    expect(next.updated_at).toBe("2026-05-21T00:00:00.000Z");
  });

  it("upsertTriageEntry overwrites by fingerprint", () => {
    const triage: Triage = {
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [sampleEntry({ disposition: "needs-design", reason: "old" })],
    };
    const next = upsertTriageEntry(
      triage,
      sampleEntry({ disposition: "wont-fix", reason: "new" }),
      { now: () => new Date("2026-05-21T00:00:00Z") },
    );
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0].disposition).toBe("wont-fix");
    expect(next.entries[0].reason).toBe("new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test -- triage --run`
Expected: FAIL with "Cannot find module './triage.js'".

- [ ] **Step 3: Implement `packages/core/src/triage.ts`**

Mirror the suppressions module shape. Key differences: `disposition` enum and `reason` / `owner` / `date` are all required at the zod level.

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { systemClock } from "./clock.js";
import { SCHEMA_VERSION } from "./finding.js";

export const TRIAGE_RELATIVE_PATH = ".crimes/triage.json";

export type TriageDisposition =
  | "fix-now"
  | "fix-this-PR"
  | "needs-design"
  | "wont-fix"
  | "scaffolding";

export interface TriageEntry {
  fingerprint: string;
  type: string;
  file: string;
  symbol?: string;
  disposition: TriageDisposition;
  /** Required at the schema level — non-empty. */
  reason: string;
  /** Required field; may be the empty string when the user declined to set one. */
  owner: string;
  /** YYYY-MM-DD. */
  date: string;
}

export interface Triage {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "triage";
  created_at: string;
  updated_at: string;
  crimes_version?: string;
  entries: TriageEntry[];
}

export const TriageEntrySchema = z
  .object({
    fingerprint: z.string().min(1),
    type: z.string().min(1),
    file: z.string().min(1),
    symbol: z.string().min(1).optional(),
    disposition: z.enum([
      "fix-now",
      "fix-this-PR",
      "needs-design",
      "wont-fix",
      "scaffolding",
    ]),
    reason: z.string().min(1),
    owner: z.string(), // empty string allowed
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  })
  .strict();

export const TriageSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    report_type: z.literal("triage"),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    crimes_version: z.string().min(1).optional(),
    entries: z.array(TriageEntrySchema),
  })
  .strict();

export class MalformedTriageError extends Error {
  path: string;
  constructor(path: string, reason: string) {
    super(`triage file at ${path} is malformed: ${reason}`);
    this.name = "MalformedTriageError";
    this.path = path;
  }
}

export interface LoadTriageResult {
  entries: TriageEntry[];
  /** Resolved absolute path (read or not). */
  path: string;
  /** True when the file existed and was read. */
  loaded: boolean;
  /** Present only when `loaded === true`. */
  document?: Triage;
}

export function resolveTriagePath(root: string, override?: string): string {
  if (override === undefined) {
    return resolve(root, TRIAGE_RELATIVE_PATH);
  }
  return isAbsolute(override) ? override : resolve(root, override);
}

export async function loadTriage(path: string): Promise<LoadTriageResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return { entries: [], path, loaded: false };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MalformedTriageError(path, `invalid JSON — ${message}`);
  }

  const result = TriageSchema.safeParse(parsed);
  if (!result.success) {
    throw new MalformedTriageError(path, result.error.message);
  }
  return {
    entries: result.data.entries,
    path,
    loaded: true,
    document: result.data,
  };
}

export interface SaveTriageOptions {
  now?: () => Date;
  crimesVersion?: string;
}

export async function saveTriage(
  path: string,
  triage: Triage,
  options: SaveTriageOptions = {},
): Promise<void> {
  const now = (options.now ?? systemClock)();
  const out: Triage = {
    ...triage,
    updated_at: now.toISOString(),
  };
  if (options.crimesVersion) out.crimes_version = options.crimesVersion;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(out, null, 2) + "\n", "utf8");
}

export function upsertTriageEntry(
  triage: Triage,
  entry: TriageEntry,
  options: { now?: () => Date } = {},
): Triage {
  const now = (options.now ?? systemClock)();
  const filtered = triage.entries.filter(
    (e) => e.fingerprint !== entry.fingerprint,
  );
  filtered.push(entry);
  return {
    ...triage,
    updated_at: now.toISOString(),
    entries: filtered,
  };
}

export function emptyTriage(options: { now?: () => Date; crimesVersion?: string } = {}): Triage {
  const now = (options.now ?? systemClock)().toISOString();
  const doc: Triage = {
    schema_version: SCHEMA_VERSION,
    report_type: "triage",
    created_at: now,
    updated_at: now,
    entries: [],
  };
  if (options.crimesVersion) doc.crimes_version = options.crimesVersion;
  return doc;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as { code?: unknown }).code === "string";
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @crimes/core test -- triage --run`
Expected: PASS (all six assertions).

- [ ] **Step 5: Export `triage` symbols from the package index**

Open `packages/core/src/index.ts` (lines 1–end) and add a new export block. The file already has `export *` blocks per module — add one:

```typescript
export {
  emptyTriage,
  loadTriage,
  MalformedTriageError,
  resolveTriagePath,
  saveTriage,
  upsertTriageEntry,
  TRIAGE_RELATIVE_PATH,
} from "./triage.js";
export type {
  Triage,
  TriageEntry,
  TriageDisposition,
  LoadTriageResult,
} from "./triage.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/triage.ts packages/core/src/triage.test.ts packages/core/src/index.ts
git commit -m "feat(core): add .crimes/triage.json data layer

Mirrors the suppressions module shape: zod-validated, MalformedTriageError
on invalid JSON or wrong shape, upsert-by-fingerprint. No scan-pipeline
wiring yet — that lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add `config.triage.resurfaceBase` config key

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config.test.ts`

- [ ] **Step 1: Locate the config zod schema**

Open `packages/core/src/config.ts`. Find the existing config schema (search for the shape that includes `scan: { topFiles: ... }`). Note the indentation and import style.

- [ ] **Step 2: Write the failing test**

Append to `packages/core/src/config.test.ts`:

```typescript
describe("loadConfig — triage.resurfaceBase", () => {
  it("defaults to 'main'", () => {
    const root = makeTempConfigRoot({});
    const config = loadConfig(root);
    expect(config.triage?.resurfaceBase).toBe("main");
  });

  it("honours an explicit resurfaceBase", () => {
    const root = makeTempConfigRoot({ triage: { resurfaceBase: "develop" } });
    const config = loadConfig(root);
    expect(config.triage?.resurfaceBase).toBe("develop");
  });

  it("accepts empty string as 'resurfacing disabled'", () => {
    const root = makeTempConfigRoot({ triage: { resurfaceBase: "" } });
    const config = loadConfig(root);
    expect(config.triage?.resurfaceBase).toBe("");
  });

  it("rejects non-string resurfaceBase", () => {
    const root = makeTempConfigRoot({ triage: { resurfaceBase: 42 } });
    expect(() => loadConfig(root)).toThrow();
  });
});
```

Use the existing `makeTempConfigRoot` helper if `config.test.ts` already has one; otherwise look at the existing test patterns and follow the same approach.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @crimes/core test -- config --run`
Expected: FAIL — `triage` not defined on `CrimesConfig`.

- [ ] **Step 4: Implement the config key**

In `packages/core/src/config.ts`:

1. Add to the zod schema:

```typescript
const TriageConfigSchema = z
  .object({
    resurfaceBase: z.string().default("main"),
  })
  .strict()
  .default({ resurfaceBase: "main" });
```

2. Add it to the top-level config object schema (the existing `CrimesConfigSchema`) as a new optional field with the same default:

```typescript
triage: TriageConfigSchema.optional(),
```

3. Add the same to the type-only `CrimesConfig` interface (or auto-derived type — follow the existing pattern). If the type is `z.infer<typeof CrimesConfigSchema>`, the field appears automatically.

4. In whatever defaulting code already runs at config-load time, ensure `config.triage` is always a populated object with `resurfaceBase: "main"` (even when the user didn't supply one). The existing pattern almost certainly applies `z.parse(rawConfig).` and uses the schema defaults — verify by reading the actual loader.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @crimes/core test -- config --run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "feat(core): add triage.resurfaceBase config key

Defaults to 'main'. Empty string disables resurfacing. Drives the
diff-driven re-detect pipeline introduced in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire triage filter into the scan pipeline

**Files:**
- Create: `packages/core/src/triage-filter.ts`
- Create: `packages/core/src/triage-filter.test.ts`
- Modify: `packages/core/src/scan.ts` (apply filter; pass triage entries through)
- Modify: `packages/core/src/finding.ts` (add `triaged?: { disposition; reason; owner; date }` annotation on Finding for `fix-now` / `fix-this-PR`)

- [ ] **Step 1: Extend `Finding` with the `triaged` annotation**

In `packages/core/src/finding.ts`, add inside the `Finding` interface (right before `tier?: Tier;`):

```typescript
  /**
   * Set when this finding matches an entry in `.crimes/triage.json` with a
   * non-silencing disposition (`fix-now` or `fix-this-PR`). Silencing
   * dispositions (`needs-design`, `wont-fix`, `scaffolding`) hide the
   * finding by default and surface only via resurfacing or
   * `--show-triaged` — see `previous_triage` on resurfaced findings.
   */
  triaged?: {
    disposition: "fix-now" | "fix-this-PR";
    reason: string;
    owner: string;
    date: string;
  };
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/triage-filter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Finding } from "./finding.js";
import { applyTriageFilter } from "./triage-filter.js";
import type { TriageEntry } from "./triage.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "crime_00001",
    type: "large_function",
    charge: "God Function",
    severity: "medium",
    confidence: 0.8,
    file: "src/foo.ts",
    symbol: "doStuff",
    summary: "stub",
    evidence: [],
    scores: { severity: 0.5, confidence: 0.8 },
    effort: "medium",
    fix_shape: "stub",
    ...overrides,
  } as Finding;
}

function makeEntry(overrides: Partial<TriageEntry> = {}): TriageEntry {
  return {
    fingerprint: "large_function::src/foo.ts::doStuff",
    type: "large_function",
    file: "src/foo.ts",
    symbol: "doStuff",
    disposition: "wont-fix",
    reason: "legacy",
    owner: "@a",
    date: "2026-05-20",
    ...overrides,
  };
}

describe("applyTriageFilter", () => {
  it("hides findings with silencing dispositions by default", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(findings, [makeEntry()], { showTriaged: false });
    expect(result.findings).toHaveLength(0);
    expect(result.hiddenCount).toBe(1);
  });

  it("annotates visible findings with fix-now disposition", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(
      findings,
      [makeEntry({ disposition: "fix-now" })],
      { showTriaged: false },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].triaged?.disposition).toBe("fix-now");
  });

  it("keeps silenced findings when showTriaged is true", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(findings, [makeEntry()], { showTriaged: true });
    expect(result.findings).toHaveLength(1);
    // Silenced findings under --show-triaged carry the full disposition metadata
    // (not just fix-now/fix-this-PR shape) — see scan rendering for how this is consumed.
    expect((result.findings[0] as Finding & { _hiddenTriage?: TriageEntry })._hiddenTriage?.disposition).toBe("wont-fix");
  });

  it("ignores triage entries whose fingerprint matches nothing", () => {
    const findings = [makeFinding()];
    const result = applyTriageFilter(
      findings,
      [makeEntry({ fingerprint: "ghost::x::y" })],
      { showTriaged: false },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].triaged).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test -- triage-filter --run`
Expected: FAIL — "Cannot find module './triage-filter.js'".

- [ ] **Step 4: Implement `packages/core/src/triage-filter.ts`**

```typescript
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import type { TriageDisposition, TriageEntry } from "./triage.js";

const SILENCED: ReadonlySet<TriageDisposition> = new Set([
  "needs-design",
  "wont-fix",
  "scaffolding",
]);

export interface ApplyTriageFilterOptions {
  /** When true, silenced findings stay visible carrying a `_hiddenTriage` marker. */
  showTriaged: boolean;
}

export interface TriageFilterResult {
  findings: Finding[];
  /** Number of findings hidden because of a silencing triage entry. */
  hiddenCount: number;
}

/**
 * Partition findings against `.crimes/triage.json` entries:
 *
 * - `fix-now` / `fix-this-PR` matches receive a `triaged` annotation and
 *   stay in the visible findings list.
 * - `needs-design` / `wont-fix` / `scaffolding` matches are removed by
 *   default. With `showTriaged: true`, they stay in the list with a
 *   `_hiddenTriage` marker for downstream rendering.
 * - Unmatched findings pass through unchanged.
 */
export function applyTriageFilter(
  findings: Finding[],
  entries: TriageEntry[],
  options: ApplyTriageFilterOptions,
): TriageFilterResult {
  const byFingerprint = new Map<string, TriageEntry>();
  for (const entry of entries) {
    if (!byFingerprint.has(entry.fingerprint)) {
      byFingerprint.set(entry.fingerprint, entry);
    }
  }

  let hiddenCount = 0;
  const out: Finding[] = [];

  for (const finding of findings) {
    const entry = byFingerprint.get(fingerprintFinding(finding));
    if (!entry) {
      out.push(finding);
      continue;
    }

    if (SILENCED.has(entry.disposition)) {
      if (options.showTriaged) {
        const annotated = finding as Finding & { _hiddenTriage?: TriageEntry };
        annotated._hiddenTriage = entry;
        out.push(annotated);
      } else {
        hiddenCount += 1;
      }
      continue;
    }

    // fix-now or fix-this-PR — annotate and keep visible.
    out.push({
      ...finding,
      triaged: {
        disposition: entry.disposition,
        reason: entry.reason,
        owner: entry.owner,
        date: entry.date,
      },
    });
  }

  return { findings: out, hiddenCount };
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @crimes/core test -- triage-filter --run`
Expected: PASS.

- [ ] **Step 6: Wire `applyTriageFilter` into `scan.ts`**

In `packages/core/src/scan.ts`, after the existing suppressions partition and before the report is returned, add:

```typescript
// Read more carefully: locate the section of scan.ts where suppressions are
// applied (around the call to `partitionFindings`). The triage stage runs
// just before suppressions — silenced triage entries take precedence over
// suppressions so the renderer can distinguish "user triaged this" from
// "suppression hit". Add at the top of the function or near the existing
// imports:
import { loadTriage, resolveTriagePath } from "./triage.js";
import { applyTriageFilter } from "./triage-filter.js";

// Inside `scan(...)`, after `report = ...` is initially built and after
// suppressions are loaded but before they are applied, fetch + apply
// triage. The exact insertion point depends on the current code shape —
// when in doubt, follow how `partitionFindings` is wired:
const triagePath = resolveTriagePath(root);
const triage = await loadTriage(triagePath);
const triageFilterResult = applyTriageFilter(report.findings, triage.entries, {
  showTriaged: false, // CLI flag forwarded via a new ScanOptions field below
});
report.findings = triageFilterResult.findings;
```

Add a `showTriaged?: boolean` option to `ScanOptions` (the interface in this file), defaulting to false. Plumb it through so the new option drives `applyTriageFilter`.

Plumb a corresponding `--show-triaged` flag on the `scan` command (Task 11 covers all three new scan flags including this one; for now the option exists on `ScanOptions` but isn't yet wired from the CLI).

- [ ] **Step 7: Update `scan.test.ts` with a triage integration test**

Add a fresh test to `packages/core/src/scan.test.ts` that:
1. Writes a fixture with a known finding.
2. Writes `.crimes/triage.json` with a `wont-fix` entry matching that finding.
3. Calls `scan()` and asserts the finding is **not** in `report.findings`.
4. Calls `scan({ ..., showTriaged: true })` and asserts the finding is in `report.findings` with `_hiddenTriage` set.

Use the existing test patterns in `scan.test.ts` (look at how it currently writes a fixture root, runs `scan()`, and asserts on report shape).

- [ ] **Step 8: Run the full `@crimes/core` test suite**

Run: `pnpm --filter @crimes/core test --run`
Expected: PASS.

- [ ] **Step 9: Patch-bump + evals**

Triage filtering changes the default `findings[]` for any repo with a populated `.crimes/triage.json`. The eval fixtures don't have one, so the eval *output* should be unchanged — but the safe move is to patch-bump anyway because the code path that produces findings is different.

Set `packages/cli/package.json` `"version"` to `"0.10.2"`.

Run: `pnpm run evals`
Inspect: `git diff evals/results/`

Expected: identical content under `evals/results/0.10.2/` to `evals/results/0.10.1/`. If anything differs, investigate — the triage stage shouldn't move scores when no triage file exists.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/triage-filter.ts \
        packages/core/src/triage-filter.test.ts \
        packages/core/src/finding.ts \
        packages/core/src/scan.ts \
        packages/core/src/scan.test.ts \
        packages/cli/package.json \
        evals/results/0.10.2/
git commit -m "feat(core): apply .crimes/triage.json during scan

Silenced dispositions (needs-design/wont-fix/scaffolding) hide
findings by default; --show-triaged keeps them visible with a
_hiddenTriage marker for the renderer. fix-now / fix-this-PR
matches stay visible and gain a Finding.triaged annotation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Resurfacing pipeline

### Task 7: `previously_triaged` / `previously_baselined` annotations on `Finding`

**Files:**
- Modify: `packages/core/src/finding.ts`

- [ ] **Step 1: Add the annotation fields to `Finding`**

In `packages/core/src/finding.ts`, append inside the `Finding` interface (after `triaged?: …`):

```typescript
  /** True when this finding matches an entry in `.crimes/triage.json`. */
  previously_triaged?: true;
  previous_triage?: {
    disposition: "fix-now" | "fix-this-PR" | "needs-design" | "wont-fix" | "scaffolding";
    reason: string;
    owner: string;
    date: string;
  };

  /** True when this finding matches an entry in `.crimes/baseline.json`. */
  previously_baselined?: true;
  previous_baseline?: {
    /** ISO-8601 date the baseline was last written; best-effort. */
    date?: string;
    /** Baselines don't store per-entry reasons today; absent for now. */
    reason?: string;
  };
```

- [ ] **Step 2: TypeScript compiles, no test change needed yet**

Run: `pnpm --filter @crimes/core build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/finding.ts
git commit -m "feat(core): add previously_triaged and previously_baselined annotations

Optional fields populated by the resurface pipeline (next commit).
Schema-additive; no schema_version bump.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `resurface.ts` — diff-driven re-detect of triaged/baselined findings

**Files:**
- Create: `packages/core/src/resurface.ts`
- Create: `packages/core/src/resurface.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/resurface.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { collectResurfaced, type ResurfaceInput } from "./resurface.js";
import type { Finding } from "./finding.js";
import type { TriageEntry } from "./triage.js";
import type { BaselineEntry } from "./baseline.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "crime_00001",
    type: "large_function",
    charge: "God Function",
    severity: "medium",
    confidence: 0.8,
    file: "src/foo.ts",
    symbol: "doStuff",
    summary: "stub",
    evidence: [],
    scores: { severity: 0.5, confidence: 0.8 },
    effort: "medium",
    fix_shape: "stub",
    ...overrides,
  } as Finding;
}

function makeTriage(overrides: Partial<TriageEntry> = {}): TriageEntry {
  return {
    fingerprint: "large_function::src/foo.ts::doStuff",
    type: "large_function",
    file: "src/foo.ts",
    symbol: "doStuff",
    disposition: "wont-fix",
    reason: "legacy",
    owner: "@a",
    date: "2026-05-20",
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    fingerprint: "large_function::src/foo.ts::doStuff",
    type: "large_function",
    charge: "God Function",
    severity: "medium",
    file: "src/foo.ts",
    symbol: "doStuff",
    ...overrides,
  };
}

describe("collectResurfaced", () => {
  it("returns empty when diffFiles is empty", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(),
      triageEntries: [makeTriage()],
      baselineEntries: [makeBaseline()],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(0);
  });

  it("annotates a triaged finding from a touched file", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage()],
      baselineEntries: [],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(1);
    expect(result[0].previously_triaged).toBe(true);
    expect(result[0].previous_triage?.disposition).toBe("wont-fix");
  });

  it("drops resurfaced entries silently when re-detect finds no match", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage()],
      baselineEntries: [],
      reDetect: vi.fn().mockResolvedValue([]), // detector found nothing
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(0);
  });

  it("prefers triage over baseline when both match the same fingerprint", async () => {
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [makeTriage({ disposition: "needs-design" })],
      baselineEntries: [makeBaseline()],
      reDetect: vi.fn().mockResolvedValue([makeFinding()]),
    };
    const result = await collectResurfaced(input);
    expect(result).toHaveLength(1);
    expect(result[0].previously_triaged).toBe(true);
    expect(result[0].previously_baselined).toBeUndefined();
  });

  it("only invokes reDetect for files in diffFiles", async () => {
    const reDetect = vi.fn().mockResolvedValue([makeFinding()]);
    const input: ResurfaceInput = {
      diffFiles: new Set(["src/foo.ts"]),
      triageEntries: [
        makeTriage(),
        makeTriage({
          fingerprint: "x::src/other.ts::y",
          file: "src/other.ts",
        }),
      ],
      baselineEntries: [],
      reDetect,
    };
    await collectResurfaced(input);
    expect(reDetect).toHaveBeenCalledTimes(1);
    expect(reDetect).toHaveBeenCalledWith("src/foo.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test -- resurface --run`
Expected: FAIL — "Cannot find module './resurface.js'".

- [ ] **Step 3: Implement `packages/core/src/resurface.ts`**

```typescript
import type { BaselineEntry } from "./baseline.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding } from "./finding.js";
import type { TriageEntry } from "./triage.js";

export interface ResurfaceInput {
  /** Repo-relative POSIX paths of files touched in the working tree + branch diff. */
  diffFiles: Set<string>;
  triageEntries: TriageEntry[];
  baselineEntries: BaselineEntry[];
  /**
   * Re-runs the relevant detector(s) on a single file and returns the
   * resulting findings. The scan pipeline supplies an implementation that
   * routes by detector type; tests pass a vitest mock.
   */
  reDetect: (file: string) => Promise<Finding[]>;
}

/**
 * Build the resurfaced findings list: for every triage or baseline entry
 * whose `file` is in `diffFiles`, re-run its detector and emit any
 * matching finding annotated with the prior disposition.
 *
 * Triage entries win over baseline entries when both match the same
 * fingerprint.
 *
 * Resurfaced findings whose re-detect yields no match for the stored
 * fingerprint are silently dropped — they're already fixed.
 */
export async function collectResurfaced(
  input: ResurfaceInput,
): Promise<Finding[]> {
  if (input.diffFiles.size === 0) return [];

  // Group prior entries by file, with triage taking precedence over baseline
  // on a per-fingerprint basis.
  const triageByPrint = new Map<string, TriageEntry>();
  for (const e of input.triageEntries) {
    if (!triageByPrint.has(e.fingerprint)) triageByPrint.set(e.fingerprint, e);
  }
  const baselineByPrint = new Map<string, BaselineEntry>();
  for (const e of input.baselineEntries) {
    if (!baselineByPrint.has(e.fingerprint)) baselineByPrint.set(e.fingerprint, e);
  }

  const filesToReDetect = new Set<string>();
  for (const e of input.triageEntries) {
    if (input.diffFiles.has(e.file)) filesToReDetect.add(e.file);
  }
  for (const e of input.baselineEntries) {
    if (input.diffFiles.has(e.file)) filesToReDetect.add(e.file);
  }

  const resurfaced: Finding[] = [];

  for (const file of filesToReDetect) {
    const detected = await input.reDetect(file);
    for (const finding of detected) {
      const print = fingerprintFinding(finding);
      const triage = triageByPrint.get(print);
      const baseline = baselineByPrint.get(print);
      if (!triage && !baseline) continue;

      if (triage) {
        resurfaced.push({
          ...finding,
          previously_triaged: true,
          previous_triage: {
            disposition: triage.disposition,
            reason: triage.reason,
            owner: triage.owner,
            date: triage.date,
          },
        });
      } else if (baseline) {
        resurfaced.push({
          ...finding,
          previously_baselined: true,
          previous_baseline: {},
        });
      }
    }
  }

  return resurfaced;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @crimes/core test -- resurface --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/resurface.ts packages/core/src/resurface.test.ts
git commit -m "feat(core): collectResurfaced — diff-driven re-detect of triaged/baselined findings

Pure module that takes the diff'd file set, the prior triage and baseline
entries, and a re-detect function; emits Finding objects annotated with
previously_triaged or previously_baselined. Scan-pipeline wiring lands
next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wire resurface into `scan.ts`

**Files:**
- Modify: `packages/core/src/scan.ts`
- Modify: `packages/core/src/scan.test.ts`

- [ ] **Step 1: Locate scan's git plumbing**

Open `packages/core/src/scan.ts` and find `getChangedFiles` (it's imported from `./git/changed-files.js` at line 20). The existing `--changed` path uses it. Find where the existing branch-detection happens (likely in `git/` — look for files that return a ref name).

Run: `ls packages/core/src/git/` and read the most relevant file (probably `head-ref.ts` or similar — if not present, the resurface stage will fall back to running `git rev-parse --abbrev-ref HEAD` via simple-git directly).

- [ ] **Step 2: Write the failing test**

Append to `packages/core/src/scan.test.ts`:

```typescript
describe("scan — resurfacing", () => {
  it("emits previously_triaged findings at the start of findings[]", async () => {
    // Setup a fixture root with one file that has a known finding,
    // .crimes/triage.json entry marking it wont-fix, and a fake git diff
    // that includes that file.
    //
    // Use the existing fixture-building helper in this test file.
    //
    // Assert: report.findings[0].previously_triaged === true
    //         report.findings[0].previous_triage.disposition === "wont-fix"
  });

  it("skips resurfacing when on the resurfaceBase branch", async () => {
    // Setup as above but stub HEAD to be "main"; assert no
    // previously_triaged findings.
  });

  it("silently skips resurfacing when not in a git repo", async () => {
    // Setup a fixture root with NO .git directory.
  });

  it("drops resurfaced entries whose re-detect produces no match", async () => {
    // Fixture: .crimes/triage.json points at a non-existent symbol;
    // re-detect on the file produces a finding with a different
    // fingerprint; resurfaced array is empty.
  });
});
```

Fill in the test bodies using the existing fixture helpers. If `scan.test.ts` already imports `makeFixture` or similar, use it; otherwise extract a small helper.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @crimes/core test -- scan --run -t resurfacing`
Expected: FAIL — assertions fail because resurface isn't wired into `scan` yet.

- [ ] **Step 4: Implement resurface wiring in `scan.ts`**

At the top of `scan.ts` add imports:

```typescript
import { collectResurfaced } from "./resurface.js";
import { loadBaseline, BASELINE_RELATIVE_PATH, BaselineNotFoundError } from "./baseline.js";
```

Inside `scan()`, after the existing finding pipeline produces `report.findings`, add a resurface stage. The relevant config (default `"main"`, empty disables) is on `config.triage.resurfaceBase`.

```typescript
// Resurfacing stage — runs after triage filter, before report is finalised.
const resurfaceBase = config.triage?.resurfaceBase ?? "main";
if (resurfaceBase !== "" && (await isGitRepo(root))) {
  const headRef = await getHeadRefName(root); // e.g. "feature/new-billing" or "main"
  if (headRef !== resurfaceBase) {
    const diffFiles = new Set<string>(
      await getChangedFiles({ root, base: resurfaceBase }),
    );

    // Build a re-detect function tied to the scan's detector registry. The
    // single-file re-detect path runs detector-registry's full pass
    // restricted to one file — slower than a per-detector hot path, but
    // bounded by branch size.
    const reDetect = async (file: string): Promise<Finding[]> => {
      const single = await scan({
        root,
        config,
        // Pass `changed: true` with no base + a stub set to limit scope
        // to just this file. Implement via a new `restrictTo: string[]`
        // option on ScanOptions, or by running detectors directly.
        // The exact shape depends on what's easiest in the codebase —
        // when reading scan.ts, look for the file-iteration loop and
        // factor it out so a single-file invocation reuses it.
      });
      return single.findings.filter((f) => f.file === file);
    };

    // Load triage + baseline. Both files are optional — empty when absent.
    const triagePath = resolveTriagePath(root);
    const triage = await loadTriage(triagePath);
    let baselineEntries: BaselineEntry[] = [];
    try {
      const baseline = await loadBaseline(resolve(root, BASELINE_RELATIVE_PATH));
      baselineEntries = baseline.findings;
    } catch (err) {
      // BaselineNotFoundError is fine — no baseline configured.
      if (!(err instanceof BaselineNotFoundError)) throw err;
    }

    const resurfaced = await collectResurfaced({
      diffFiles,
      triageEntries: triage.entries,
      baselineEntries,
      reDetect,
    });

    // Resurfaced findings go to the start of the array (renderer + JSON
    // consumers both filter by previously_* flags).
    report.findings = [...resurfaced, ...report.findings];
    // Update summary counts to include resurfaced entries (they're real
    // findings, not phantoms).
    report.summary = recomputeSummary(report.findings);
  }
}
```

Add helpers near the bottom of `scan.ts` if they don't already exist:

```typescript
async function isGitRepo(root: string): Promise<boolean> {
  // Use simple-git or fs.existsSync(join(root, ".git")) — copy the existing
  // pattern from getChangedFiles or hotspots.
}

async function getHeadRefName(root: string): Promise<string> {
  // simple-git: const git = simpleGit(root); return (await git.branch()).current;
}

function recomputeSummary(findings: Finding[]): ScanSummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    if (f.severity === "high") high += 1;
    else if (f.severity === "medium") medium += 1;
    else low += 1;
  }
  return { total: findings.length, high, medium, low };
}
```

When the codebase already exposes these helpers (look at `packages/core/src/git/` — `changed-files.ts` will reveal the simple-git pattern), reuse them. Don't introduce duplicate plumbing.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @crimes/core test -- scan --run`
Expected: PASS — including the four new resurfacing tests.

- [ ] **Step 6: Patch-bump + evals**

Resurfacing changes finding output in the presence of a triage or baseline file *and* a non-base branch. The eval fixtures don't have either; eval outputs should be unchanged. Still: patch-bump to be safe.

Set `packages/cli/package.json` `"version"` to `"0.10.3"`.
Run: `pnpm run evals`
Inspect: `git diff evals/results/` — should show only the directory rename.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/scan.ts \
        packages/core/src/scan.test.ts \
        packages/cli/package.json \
        evals/results/0.10.3/
git commit -m "feat(core): resurface triaged/baselined findings on touched files

Every \`crimes scan\` outside the resurface base branch runs a quick
diff against the base, re-detects findings for files in the diff, and
prepends matches to findings[] annotated with previously_triaged or
previously_baselined. Git unavailable / on-base / empty diff: silently
skipped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Triage CLI command

### Task 10: `commands/triage.ts` — interactive walk + `--apply` / `--list` / `--clear`

**Files:**
- Create: `packages/cli/src/commands/triage.ts`
- Create: `packages/cli/src/commands/triage.test.ts`
- Modify: `packages/cli/src/index.ts` (register the command)

- [ ] **Step 1: Open the existing `auto-init.test.ts` to copy the readline-mock pattern**

Read `packages/cli/src/auto-init.test.ts`. The pattern uses `vi.mock` on `node:readline/promises` or pipes a fake stdin. Replicate the same shape for the triage interactive test.

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/commands/triage.test.ts`. Cover at minimum:

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../test-helpers.js"; // existing helper — confirm location

describe("crimes triage", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "crimes-triage-cli-"));
  });

  it("refuses interactive mode in non-TTY environments", async () => {
    const result = await runCli(["triage"], { cwd: tmp, tty: false });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("non-TTY");
    expect(result.stderr).toContain("--apply");
  });

  it("applies a triage file non-interactively", async () => {
    const applyFile = join(tmp, "triage.json");
    writeFileSync(applyFile, JSON.stringify({
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [{
        fingerprint: "large_function::src/foo.ts::doStuff",
        type: "large_function",
        file: "src/foo.ts",
        symbol: "doStuff",
        disposition: "wont-fix",
        reason: "legacy",
        owner: "@a",
        date: "2026-05-20",
      }],
    }));
    const result = await runCli(["triage", "--apply", applyFile], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(
      readFileSync(join(tmp, ".crimes", "triage.json"), "utf8"),
    );
    expect(written.entries).toHaveLength(1);
  });

  it("lists current entries", async () => {
    mkdirSync(join(tmp, ".crimes"), { recursive: true });
    const triagePath = join(tmp, ".crimes", "triage.json");
    writeFileSync(triagePath, JSON.stringify({
      schema_version: "0.2.0",
      report_type: "triage",
      created_at: "2026-05-20T14:00:00Z",
      updated_at: "2026-05-20T14:00:00Z",
      entries: [{
        fingerprint: "large_function::src/foo.ts::doStuff",
        type: "large_function",
        file: "src/foo.ts",
        symbol: "doStuff",
        disposition: "wont-fix",
        reason: "legacy",
        owner: "@a",
        date: "2026-05-20",
      }],
    }));
    const result = await runCli(["triage", "--list"], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("large_function::src/foo.ts::doStuff");
    expect(result.stdout).toContain("wont-fix");
  });

  it("clears a single entry by fingerprint", async () => {
    // Pre-populate two entries; --clear one; assert the other remains.
    // (Same fixture pattern as --list above.)
  });

  it("merges --apply file into existing on-disk triage by fingerprint", async () => {
    // Pre-populate one entry; apply a file with the same fingerprint and a
    // different reason; assert the on-disk entry's reason is the new value.
  });

  it("walks findings interactively when run from a TTY (mocked stdin)", async () => {
    // Mock stdin to emit "w\nbecause reason\n@me\n" then "q\n" — assert
    // the first finding gets a wont-fix entry and the second is skipped.
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter crimes test -- commands/triage --run`
Expected: FAIL — the triage command isn't registered.

- [ ] **Step 4: Implement `commands/triage.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import {
  emptyTriage,
  fingerprintFinding,
  loadTriage,
  resolveTriagePath,
  saveTriage,
  scan,
  upsertTriageEntry,
  loadConfig,
  type Finding,
  type Triage,
  type TriageDisposition,
  type TriageEntry,
} from "@crimes/core";

declare const __CRIMES_VERSION__: string;

interface TriageOptions {
  apply?: string;
  list: boolean;
  clear?: string;
  retriage?: string;
  format: "human" | "json";
  owner?: string;
  noColor: boolean;
  all: boolean;
}

const DISPOSITION_BY_KEY: Record<string, TriageDisposition> = {
  f: "fix-now",
  p: "fix-this-PR",
  d: "needs-design",
  w: "wont-fix",
  s: "scaffolding",
};

export function registerTriageCommand(program: Command): void {
  program
    .command("triage")
    .description("Walk findings and assign per-finding dispositions (fix-now / fix-this-PR / needs-design / wont-fix / scaffolding).")
    .argument("[path]", "directory to scan (defaults to current directory)")
    .option("--apply <file>", "non-interactive: read triage entries from a JSON file")
    .option("--list", "show existing triage entries and exit", false)
    .option("--clear <fingerprint>", "remove one entry by fingerprint")
    .option("--retriage <target>", "re-prompt entries matching a fingerprint, file, or glob")
    .option("--format <format>", "summary output format: human | json", "human")
    .option("--owner <handle>", "default owner for new dispositions this run")
    .option("--no-color", "disable ANSI colour output")
    .option("--all", "include non-domain tier findings in the walk", false)
    .action(async (path: string | undefined, options: TriageOptions) => {
      const root = resolve(path ?? process.cwd());

      // --list short-circuits everything.
      if (options.list) {
        await runList(root, options);
        return;
      }

      if (options.clear !== undefined) {
        await runClear(root, options.clear);
        return;
      }

      if (options.apply !== undefined) {
        await runApply(root, options.apply, options);
        return;
      }

      // Interactive walk requires a TTY.
      if (!process.stdout.isTTY || process.env.CI) {
        process.stderr.write(
          "crimes: refusing to start interactive triage in a non-TTY/CI environment. " +
          "Use --apply <file>.\n",
        );
        process.exit(2);
        return;
      }

      await runInteractive(root, options);
    });
}

async function runList(root: string, options: TriageOptions): Promise<void> {
  const path = resolveTriagePath(root);
  const triage = await loadTriage(path);
  if (options.format === "json") {
    process.stdout.write(JSON.stringify({ entries: triage.entries }, null, 2) + "\n");
    return;
  }
  if (triage.entries.length === 0) {
    process.stdout.write("No triage entries.\n");
    return;
  }
  for (const e of triage.entries) {
    process.stdout.write(
      `${e.disposition.padEnd(13)}  ${e.fingerprint}\n` +
      `              ${e.reason}\n` +
      `              owner: ${e.owner || "(none)"} · date: ${e.date}\n\n`,
    );
  }
}

async function runClear(root: string, fingerprint: string): Promise<void> {
  const path = resolveTriagePath(root);
  const triage = await loadTriage(path);
  const before = triage.entries.length;
  const next: Triage = {
    schema_version: triage.document?.schema_version ?? "0.2.0",
    report_type: "triage",
    created_at: triage.document?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    entries: triage.entries.filter((e) => e.fingerprint !== fingerprint),
  };
  if (next.entries.length === before) {
    process.stderr.write(`crimes: no triage entry matched ${fingerprint}.\n`);
    process.exit(1);
    return;
  }
  await saveTriage(path, next, { crimesVersion: __CRIMES_VERSION__ });
  process.stdout.write(`Cleared ${fingerprint}.\n`);
}

async function runApply(root: string, applyPath: string, options: TriageOptions): Promise<void> {
  const absoluteApply = isAbsolute(applyPath) ? applyPath : resolve(process.cwd(), applyPath);
  if (!existsSync(absoluteApply)) {
    process.stderr.write(`crimes: --apply file not found: ${applyPath}\n`);
    process.exit(2);
    return;
  }

  const raw = readFileSync(absoluteApply, "utf8");
  try {
    JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`crimes: --apply file is not valid JSON: ${String(err)}\n`);
    process.exit(2);
    return;
  }
  // Reuse the triage zod schema by loading the file as if it were on disk.
  // The loader gives us proper MalformedTriageError on bad shape.
  mkdirSync(resolve(root, ".crimes"), { recursive: true });
  const tempPath = resolve(root, ".crimes", ".__apply_tmp.json");
  writeFileSync(tempPath, raw, "utf8");
  let appliedDoc;
  try {
    const loaded = await loadTriage(tempPath);
    appliedDoc = loaded.document!;
  } finally {
    unlinkSync(tempPath);
  }

  // Merge into existing triage on disk.
  const triagePath = resolveTriagePath(root);
  const existing = await loadTriage(triagePath);
  let doc: Triage = existing.document ?? emptyTriage({ crimesVersion: __CRIMES_VERSION__ });
  for (const entry of appliedDoc.entries) {
    doc = upsertTriageEntry(doc, entry);
  }
  await saveTriage(triagePath, doc, { crimesVersion: __CRIMES_VERSION__ });

  if (options.format === "json") {
    process.stdout.write(JSON.stringify({ applied: appliedDoc.entries.length }) + "\n");
  } else {
    process.stdout.write(`Applied ${appliedDoc.entries.length} entries to .crimes/triage.json.\n`);
  }
}

async function runInteractive(root: string, options: TriageOptions): Promise<void> {
  const config = loadConfig(root);
  const report = await scan({ root, config });

  // Filter to tier === "domain" unless --all.
  const findings = options.all
    ? report.findings
    : report.findings.filter((f) => f.tier !== "nonDomain");

  // Drop findings already in triage unless --retriage matches.
  const triagePath = resolveTriagePath(root);
  const existing = await loadTriage(triagePath);
  const existingPrints = new Set(existing.entries.map((e) => e.fingerprint));
  const retriageMatcher = buildRetriageMatcher(options.retriage, existing.entries);

  const queue = findings.filter((f) => {
    const print = fingerprintFinding(f);
    if (!existingPrints.has(print)) return true;
    const existingEntry = existing.entries.find((e) => e.fingerprint === print);
    return retriageMatcher(f, existingEntry);
  });

  if (queue.length === 0) {
    process.stdout.write(
      "No findings to triage. Run `crimes scan` to see what's left.\n",
    );
    return;
  }

  let doc: Triage = existing.document ?? emptyTriage({ crimesVersion: __CRIMES_VERSION__ });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let defaultOwner = options.owner ?? gitConfigEmail() ?? "";

  process.stdout.write(
    `Triaging ${queue.length} findings against ${triagePath}.\n` +
    "Keys: f fix-now · p fix-this-PR · d needs-design · w wont-fix · s scaffolding · k skip · q quit\n\n",
  );

  try {
    for (let i = 0; i < queue.length; i++) {
      const finding = queue[i];
      renderFindingHeader(finding, i + 1, queue.length);

      const key = (await rl.question("  Disposition? ")).trim().toLowerCase();
      if (key === "q") break;
      if (key === "k") {
        process.stdout.write("  · skipped\n\n");
        continue;
      }
      const disposition = DISPOSITION_BY_KEY[key];
      if (!disposition) {
        process.stdout.write(`  · unrecognised key '${key}' — skipping\n\n`);
        continue;
      }

      const reason = (await rl.question("  Reason (one line): ")).trim();
      if (reason === "") {
        process.stdout.write("  · empty reason — skipping (no entry written)\n\n");
        continue;
      }
      const ownerPrompt = defaultOwner ? `  Owner [${defaultOwner}]: ` : "  Owner (optional): ";
      const ownerInput = (await rl.question(ownerPrompt)).trim();
      const owner = ownerInput === "" ? defaultOwner : ownerInput;
      if (ownerInput !== "") defaultOwner = ownerInput;

      const entry: TriageEntry = {
        fingerprint: fingerprintFinding(finding),
        type: finding.type,
        file: finding.file,
        ...(finding.symbol ? { symbol: finding.symbol } : {}),
        disposition,
        reason,
        owner,
        date: todayYmd(),
      };
      doc = upsertTriageEntry(doc, entry);
      // Persist incrementally so SIGINT loses nothing.
      await saveTriage(triagePath, doc, { crimesVersion: __CRIMES_VERSION__ });
      process.stdout.write(`  ✓ ${disposition} · saved.\n\n`);
    }
  } finally {
    rl.close();
  }

  if (options.format === "json") {
    process.stdout.write(JSON.stringify({ entries: doc.entries.length }) + "\n");
  } else {
    process.stdout.write(`\nSaved ${doc.entries.length} total entries to .crimes/triage.json.\n`);
  }
}

// ---- helpers ----

function buildRetriageMatcher(
  target: string | undefined,
  entries: TriageEntry[],
): (f: Finding, e: TriageEntry | undefined) => boolean {
  if (!target) return () => false;
  // Match by exact fingerprint first.
  if (entries.some((e) => e.fingerprint === target)) {
    return (_f, e) => e?.fingerprint === target;
  }
  // Otherwise treat as file path or glob.
  // picomatch ships as a transitive dependency of fast-glob; if it's not
  // already a direct dep, add it to `crimes` package.json.
  const picomatch = require("picomatch");
  const isMatch = picomatch(target);
  return (f, _e) => f.file === target || isMatch(f.file);
}

function renderFindingHeader(f: Finding, index: number, total: number): void {
  const glyph = f.severity === "high" ? "🚨" : f.severity === "medium" ? "⚠️" : "🔎";
  process.stdout.write(
    `[${index}/${total}] ${glyph} ${f.file}\n` +
    `  ${f.charge}${f.symbol ? ` · ${f.symbol}()` : ""}\n` +
    `  ${f.evidence.slice(0, 2).join(" · ")}\n` +
    `  Fix shape: ${f.fix_shape}\n` +
    `  Effort: ${f.effort}\n`,
  );
}

function todayYmd(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function gitConfigEmail(): string | undefined {
  try {
    const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Register the command**

Open `packages/cli/src/index.ts` and add:

```typescript
import { registerTriageCommand } from "./commands/triage.js";
// ...elsewhere in the existing registration block:
registerTriageCommand(program);
```

Also update the existing `COMMANDS_THAT_SKIP_PROMPT` set in `auto-init.ts` to include `"triage"` — running triage should not trigger the auto-init flow:

```typescript
const COMMANDS_THAT_SKIP_PROMPT = new Set([
  "init",
  "feedback",
  "ignore",
  "unignore",
  "baseline",
  "triage",
]);
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter crimes test -- commands/triage --run`
Expected: PASS — all six scenarios.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/triage.ts \
        packages/cli/src/commands/triage.test.ts \
        packages/cli/src/index.ts \
        packages/cli/src/auto-init.ts
git commit -m "feat(cli): add \`crimes triage\` command

Interactive per-finding walk (one disposition at a time, top-of-rank
first, incremental persistence). Non-interactive --apply <file>,
--list, --clear, --retriage. Refuses to start interactively in
non-TTY/CI environments. Skipped by auto-init.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Scan flags + reporter for triage + resurface

### Task 11: Wire `--show-triaged`, `--gate-needs-design`, `--gate-resurfaced` on `crimes scan`

**Files:**
- Modify: `packages/cli/src/commands/scan.ts`
- Modify: `packages/cli/src/commands/scan.test.ts`
- Modify: `packages/core/src/scan.ts` (if `showTriaged` plumbing isn't already complete from Task 6)

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/commands/scan.test.ts`:

```typescript
it("--show-triaged surfaces silenced findings annotated with _hiddenTriage", async () => {
  // Fixture with one large_function finding + .crimes/triage.json wont-fix entry.
  // Run `crimes scan --show-triaged --format json`.
  // Assert: findings[].length === 1 and findings[0]._hiddenTriage exists.
});

it("--gate-needs-design + --fail-on medium fails when a needs-design finding is touched", async () => {
  // Fixture with a touched file containing a needs-design triage entry.
  // Run `crimes scan --changed --fail-on medium --gate-needs-design`.
  // Assert exit code 1.
});

it("--gate-resurfaced + --fail-on flags a resurfaced finding", async () => {
  // Fixture where the same file is in diff AND in baseline.json.
  // Run `crimes scan --changed --fail-on medium --gate-resurfaced`.
  // Assert exit code 1.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter crimes test -- commands/scan --run -t "show-triaged|gate-needs-design|gate-resurfaced"`
Expected: FAIL — flags not yet registered.

- [ ] **Step 3: Add the flags to scan**

In `packages/cli/src/commands/scan.ts` (the `program.command("scan")` block), add:

```typescript
.option("--show-triaged", "include silenced triage dispositions in output, annotated with disposition + reason + owner + date", false)
.option("--gate-needs-design", "when --fail-on is set, count needs-design dispositions toward the gate", false)
.option("--gate-resurfaced", "when --fail-on is set, count resurfaced findings toward the gate", false)
```

Update the `ScanCommandOptions` interface to include `showTriaged`, `gateNeedsDesign`, `gateResurfaced`.

In the `.action()` body, plumb them through:

```typescript
report = await scan({
  root,
  config,
  changed: options.changed,
  base: options.base,
  recencyEnabled: options.recency,
  showTriaged: options.showTriaged, // new
});
```

`--gate-needs-design` and `--gate-resurfaced` change which findings count toward `failed`. The existing gate logic lives in `applyScanFailOn` (imported from core). Either extend that helper or filter the findings before calling it:

```typescript
const gateFindings = (failOn === undefined
  ? []
  : gatedReport.findings.filter((f) => {
      if (f.previously_triaged && !options.gateResurfaced) return false;
      if (f.previously_baselined && !options.gateResurfaced) return false;
      if (f.previous_triage?.disposition === "needs-design" && !options.gateNeedsDesign) return false;
      // Silenced dispositions never reach the gate (already filtered out by triage stage).
      return true;
    }));
```

The cleanest approach is to thread `gateNeedsDesign` and `gateResurfaced` into `applyScanFailOn` directly; the diff against the existing helper signature is minimal.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter crimes test -- commands/scan --run`
Expected: PASS — all three new tests.

- [ ] **Step 5: Patch-bump + evals**

These flags change gate behaviour only when used; default eval output unchanged.
Set `packages/cli/package.json` `"version"` to `"0.10.4"`.
Run: `pnpm run evals` — verify only the directory rename in the diff.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/scan.ts \
        packages/cli/src/commands/scan.test.ts \
        packages/core/src/scan.ts \
        packages/cli/package.json \
        evals/results/0.10.4/
git commit -m "feat(cli): --show-triaged, --gate-needs-design, --gate-resurfaced on scan

--show-triaged: silenced dispositions visible in output (annotated).
--gate-needs-design: needs-design counts toward --fail-on.
--gate-resurfaced: resurfaced findings count toward --fail-on.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Reporter — resurface block in `human/scan.ts`

**Files:**
- Modify: `packages/reporter/src/human/scan.ts`
- Modify: `packages/reporter/src/reporter.test.ts`
- Create: `packages/reporter/src/human/triage.ts` (helpers for rendering triage annotations)

- [ ] **Step 1: Write the failing snapshot test**

In `packages/reporter/src/reporter.test.ts`, add a new test case that builds a report with one `previously_triaged` finding and one regular finding, then asserts the rendered output begins with the resurface header.

```typescript
it("renders the resurface block above the top-files section when any finding is previously_triaged", () => {
  const report: ScanReport = {
    schema_version: "0.2.0",
    report_type: "scan",
    repo: { name: "test", root: "/test" },
    summary: { total: 2, high: 0, medium: 1, low: 1 },
    findings: [
      // resurfaced finding (prepended in scan.ts; renderer trusts ordering or re-checks)
      makeFinding({
        previously_triaged: true,
        previous_triage: {
          disposition: "wont-fix",
          reason: "legacy billing, rewrite Q3",
          owner: "@amayfield",
          date: "2026-04-12",
        },
        severity: "high",
        file: "src/billing/invoice.ts",
      }),
      makeFinding({ severity: "medium", file: "src/api/users.ts" }),
    ],
  };
  const output = formatHumanReport(report, { showAll: false, topFiles: 5, flat: false });
  expect(output).toContain("You're editing files you previously triaged");
  expect(output).toContain("wont-fix");
  expect(output).toContain("legacy billing, rewrite Q3");
  expect(output).toContain("Touch this disposition: crimes triage --retriage src/billing/invoice.ts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/reporter test --run -t "resurface block"`
Expected: FAIL — the header isn't rendered.

- [ ] **Step 3: Implement the resurface section in `human/scan.ts`**

Add at the top of `formatHumanReport` (or wherever the human renderer's main loop lives), before the existing "Top files by risk" loop:

```typescript
const resurfaced = report.findings.filter(
  (f) => f.previously_triaged === true || f.previously_baselined === true,
);
const fresh = report.findings.filter(
  (f) => f.previously_triaged !== true && f.previously_baselined !== true,
);

if (resurfaced.length > 0) {
  // Render the "was this still intentional?" header + per-file rollup.
  out.push("You're editing files you previously triaged — was this still intentional?\n");
  // Group resurfaced by file, preserve order.
  const byFile = groupBy(resurfaced, (f) => f.file);
  for (const [file, findings] of byFile) {
    const high = findings.filter((f) => f.severity === "high").length;
    const glyph = high > 0 ? "🚨" : findings.some((f) => f.severity === "medium") ? "⚠️" : "🔎";
    out.push(
      `${glyph} ${file.padEnd(40)} ${findings.length} findings${high > 0 ? ` · ${high} high` : ""}`,
    );
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      const prev = f.previous_triage;
      if (prev) {
        out.push(
          `   ${i + 1}. ▼ ${f.charge}${f.symbol ? ` · ${f.symbol}()` : ""}    ${f.evidence[0] ?? ""}`,
        );
        out.push(
          `      ${prev.disposition} · "${prev.reason}"${prev.owner ? ` · ${prev.owner}` : ""} (${prev.date})`,
        );
      } else {
        out.push(
          `   ${i + 1}. ▼ ${f.charge}${f.symbol ? ` · ${f.symbol}()` : ""}    ${f.evidence[0] ?? ""}`,
        );
        out.push(`      previously baselined`);
      }
    }
    out.push(`   Touch this disposition: crimes triage --retriage ${file}\n`);
  }
  out.push(""); // blank line before Top files section
}

// Existing top-files rendering should now iterate over `fresh`, not `report.findings`.
```

Make sure to replace the existing iteration's source with `fresh` (NOT `report.findings`), so resurfaced findings appear only in the resurface block — not duplicated below.

Move shared helpers (`groupBy`, glyph selection) into `human/shared.ts` if they don't already live there.

- [ ] **Step 4: Run all reporter tests**

Run: `pnpm --filter @crimes/reporter test --run -u`
Expected: PASS. Inspect the snapshot diff before continuing — only resurface-related changes.

- [ ] **Step 5: Render fix-now / fix-this-PR annotations**

Within the existing per-finding rendering (each row in the top-files block), add a `▶ fix-now ·` or `▶ fix-this-PR ·` prefix when `f.triaged` is set:

```typescript
const triagedPrefix = f.triaged ? `▶ ${f.triaged.disposition} · ` : "";
out.push(`   ${i + 1}. ${triagedPrefix}${f.charge}${f.symbol ? ` · ${f.symbol}()` : ""}`);
```

Run again: `pnpm --filter @crimes/reporter test --run -u`. Inspect the diff.

- [ ] **Step 6: Commit**

```bash
git add packages/reporter/src/human/scan.ts \
        packages/reporter/src/reporter.test.ts \
        packages/reporter/src/human/triage.ts \
        packages/reporter/src/human/shared.ts
git commit -m "feat(reporter): render resurface block + fix-now annotations in scan human output

Resurfaced findings appear above 'Top files by risk' with disposition,
reason, owner, and date. Visible triage dispositions (fix-now,
fix-this-PR) get a row prefix in the regular file list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Human-readable secondary scores

### Task 13: `score-format.ts` — pure formatters for blast / churn / test_gap / fan-in

**Files:**
- Create: `packages/reporter/src/human/score-format.ts`
- Create: `packages/reporter/src/human/score-format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/reporter/src/human/score-format.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  formatBlastRadius,
  formatChurn,
  formatTestGap,
} from "./score-format.js";

describe("formatBlastRadius", () => {
  it("returns top-quartile + importer count when both present", () => {
    expect(formatBlastRadius(0.85, 11)).toBe("top-quartile (11 importers)");
  });
  it("falls back to quartile-only when importer count missing", () => {
    expect(formatBlastRadius(0.85)).toBe("top-quartile");
  });
  it("uses bottom-quartile for low scores", () => {
    expect(formatBlastRadius(0.15, 2)).toBe("bottom-quartile (2 importers)");
  });
  it("singular form for one importer", () => {
    expect(formatBlastRadius(0.85, 1)).toBe("top-quartile (1 importer)");
  });
});

describe("formatChurn", () => {
  it("renders commits + last touched when both present", () => {
    expect(formatChurn(0.6, 24, "2026-05-18T12:30:00Z")).toMatch(/24 commits/);
    expect(formatChurn(0.6, 24, "2026-05-18T12:30:00Z")).toMatch(/last touched/);
  });
  it("falls back to high/medium/low band when no commits supplied", () => {
    expect(formatChurn(0.8)).toBe("high");
    expect(formatChurn(0.5)).toBe("medium");
    expect(formatChurn(0.2)).toBe("low");
  });
});

describe("formatTestGap", () => {
  it("returns the quartile label when available", () => {
    expect(formatTestGap(1.0, "top-quartile")).toMatch(/top-quartile/);
  });
  it("returns the raw quartile label when no label provided", () => {
    expect(formatTestGap(0.5)).toMatch(/~median|median/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crimes/reporter test -- score-format --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `human/score-format.ts`**

```typescript
export type QuartileLabel = "top-quartile" | "median" | "bottom-quartile" | "unknown";

const QUARTILE_THRESHOLDS = [0.75, 0.5, 0.25] as const;

function quartileFromScore(score: number): QuartileLabel {
  if (score >= QUARTILE_THRESHOLDS[0]) return "top-quartile";
  if (score <= QUARTILE_THRESHOLDS[2]) return "bottom-quartile";
  return "median";
}

export function formatBlastRadius(score: number, importerCount?: number): string {
  const label = quartileFromScore(score);
  if (importerCount === undefined) return label;
  const noun = importerCount === 1 ? "importer" : "importers";
  return `${label} (${importerCount} ${noun})`;
}

export function formatChurn(
  score: number,
  commits90d?: number,
  lastCommitAt?: string,
): string {
  if (commits90d !== undefined) {
    let result = `${commits90d} commits over 90d`;
    if (lastCommitAt) {
      result += ` · last touched ${humanDateSince(lastCommitAt)}`;
    }
    return result;
  }
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

export function formatTestGap(score: number, label?: QuartileLabel): string {
  if (label && label !== "unknown") return `${label}`;
  return quartileFromScore(score);
}

function humanDateSince(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const days = Math.round(diffMs / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @crimes/reporter test -- score-format --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/reporter/src/human/score-format.ts \
        packages/reporter/src/human/score-format.test.ts
git commit -m "feat(reporter): score-format helpers — interpretive prose for raw scores

Pure helpers that turn blast_radius / churn / test_gap floats into
human-readable phrases. Falls back gracefully when supplementary data
(importer count, commit count) is unavailable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Use `score-format` in scan + context human renderers

**Files:**
- Modify: `packages/reporter/src/human/scan.ts`
- Modify: `packages/reporter/src/human/context.ts`
- Modify: `packages/reporter/src/reporter.test.ts`

- [ ] **Step 1: Locate the current numeric formatting calls**

Grep: `grep -n "toFixed(2)\|toFixed(1)" packages/reporter/src/human/*.ts`

Each match is a candidate for replacement. The `Risk:` line in `scan.ts` and the per-finding scores block in `context.ts` are the primary targets.

- [ ] **Step 2: Update `human/scan.ts` Risk lines**

Replace the current `blast ${score.toFixed(2)}` with `blast ${formatBlastRadius(score, importerCount)}`. The importer count comes from the scoring context (already populated in `ScoringContext.blastRadius` — wire it through the per-file aggregation function if not already exposed).

Replace `churn high` with `formatChurn(score, commits90d, lastCommitAt)` — these inputs flow through the file's primary finding's scoring or from a fresh helper that reads from the report's `clues` analogue (scan doesn't have `clues`, but the per-file summary already aggregates churn).

For `test gap top-quartile`, no change needed — the renderer already uses a quartile label.

- [ ] **Step 3: Update `human/context.ts` per-finding scores block**

In `context.ts`, where the per-finding scores currently render as a one-line `severity 0.86 · confidence 0.88 · blast 0.72 · churn 0.64 · test gap 1.00 · agent risk 0.91`, break it into the multi-line block from the spec:

```typescript
out.push(
  `scores: severity ${score.severity.toFixed(2)} · confidence ${score.confidence.toFixed(2)} · agent risk ${(score.agent_risk ?? 0).toFixed(2)}`,
);
out.push(
  `  blast    ${formatBlastRadius(score.blast_radius ?? 0, clues?.fan_in?.importer_count)}`,
);
out.push(
  `  churn    ${formatChurn(score.churn ?? 0, clues?.churn?.commits_90d, clues?.churn?.last_commit_at)}`,
);
out.push(
  `  test gap ${formatTestGap(score.test_gap ?? 0, clues?.test_gap?.label)}`,
);
```

The exact `clues` shape is frozen by Release A — see `docs/releases/v0.10.0.md` § `clues` block on `crimes context --json`.

- [ ] **Step 4: Update snapshot tests**

Run: `pnpm --filter @crimes/reporter test --run -u`

Inspect the diff — every snapshot of `scan` and `context` human output should show:
- `blast 0.72` → `blast top-quartile (11 importers)`
- `churn 0.41` → `churn 24 commits over 90d · last touched 2 days ago`
- `test gap 1.00` → `test gap top-quartile`

Reject anything else in the diff (e.g. if a test mistakenly captures both the old and new shapes).

- [ ] **Step 5: Sanity-check JSON output is unchanged**

Run: `pnpm --filter crimes smoke 2>&1 | grep -E 'blast|churn|test_gap'`
The JSON portion of the smoke should still emit raw numeric values.

- [ ] **Step 6: Commit (renderer-only — no patch bump)**

```bash
git add packages/reporter/src/human/scan.ts \
        packages/reporter/src/human/context.ts \
        packages/reporter/src/reporter.test.ts
git commit -m "feat(reporter): human-readable secondary scores in scan + context

blast/churn/test_gap raw floats now render as interpretive prose with
importer counts, commit counts, and quartile labels. JSON output is
untouched — schema is a public API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — PreToolUse hook in `init --agents`

### Task 15: `hook-templates.ts` + merge logic for `.claude/settings.local.json`

**Files:**
- Create: `packages/cli/src/hook-templates.ts`
- Create: `packages/cli/src/hook-templates.test.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/init.test.ts`

- [ ] **Step 1: Write the failing test for the template module**

Create `packages/cli/src/hook-templates.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_ENTRY,
  CODEX_HOOK_DOCUMENT,
  mergeClaudeHook,
} from "./hook-templates.js";

describe("hook-templates", () => {
  it("CLAUDE_HOOK_ENTRY is a single PreToolUse hook entry calling crimes context", () => {
    expect(CLAUDE_HOOK_ENTRY.matcher).toBe("Edit|Write|NotebookEdit");
    expect(CLAUDE_HOOK_ENTRY.hooks[0].command).toContain("crimes context");
  });

  it("CODEX_HOOK_DOCUMENT is valid JSON parseable as a settings document", () => {
    const parsed = JSON.parse(CODEX_HOOK_DOCUMENT);
    expect(parsed._note).toMatch(/Codex/);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Edit|Write|NotebookEdit");
  });

  it("mergeClaudeHook creates a new document when input is undefined", () => {
    const result = mergeClaudeHook(undefined);
    expect(result.action).toBe("created");
    expect(result.document.hooks?.PreToolUse).toHaveLength(1);
  });

  it("mergeClaudeHook skips when an existing crimes hook is present", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "npx crimes context $FILE" }],
          },
        ],
      },
    };
    const result = mergeClaudeHook(existing);
    expect(result.action).toBe("skipped");
  });

  it("mergeClaudeHook appends to existing non-crimes PreToolUse hooks", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo hello" }],
          },
        ],
      },
    };
    const result = mergeClaudeHook(existing);
    expect(result.action).toBe("merged");
    expect(result.document.hooks?.PreToolUse).toHaveLength(2);
  });

  it("mergeClaudeHook throws when the document shape is unexpected", () => {
    expect(() => mergeClaudeHook({ hooks: "not-an-object" } as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter crimes test -- hook-templates --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hook-templates.ts`**

```typescript
export interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const CLAUDE_HOOK_ENTRY: ClaudeHookEntry = {
  matcher: "Edit|Write|NotebookEdit",
  hooks: [
    {
      type: "command",
      command:
        'npx -y crimes context "$CLAUDE_TOOL_INPUT_file_path" --format json 2>/dev/null || true',
      timeout: 8000,
    },
  ],
};

export const CODEX_HOOK_DOCUMENT = JSON.stringify(
  {
    _note:
      "Forward-looking: Codex does not honour PreToolUse hooks as of crimes 0.11.0. The schema mirrors .claude/settings.local.json so this file is ready when the Codex hook surface lands. Safe to delete if your team doesn't want it.",
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|NotebookEdit",
          hooks: [
            {
              type: "command",
              command:
                'npx -y crimes context "$CODEX_TOOL_INPUT_file_path" --format json 2>/dev/null || true',
              timeout: 8000,
            },
          ],
        },
      ],
    },
  },
  null,
  2,
);

export type MergeAction = "created" | "merged" | "skipped";

export interface MergeResult {
  action: MergeAction;
  document: ClaudeSettings;
}

const CRIMES_MARKER = "crimes context";

function isCrimesEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some(
    (h) => typeof h.command === "string" && h.command.includes(CRIMES_MARKER),
  );
}

export function mergeClaudeHook(
  existing: ClaudeSettings | undefined,
): MergeResult {
  if (existing === undefined) {
    return {
      action: "created",
      document: {
        hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] },
      },
    };
  }
  if (typeof existing !== "object" || existing === null) {
    throw new Error("settings document is not an object");
  }
  const hooks = (existing.hooks ?? {}) as Record<string, unknown>;
  if (typeof hooks !== "object" || hooks === null) {
    throw new Error("settings.hooks is not an object");
  }
  const pre = (hooks.PreToolUse ?? []) as unknown;
  if (!Array.isArray(pre)) {
    throw new Error("settings.hooks.PreToolUse is not an array");
  }
  const entries = pre as ClaudeHookEntry[];
  if (entries.some(isCrimesEntry)) {
    return { action: "skipped", document: existing };
  }
  return {
    action: "merged",
    document: {
      ...existing,
      hooks: {
        ...((existing.hooks as Record<string, unknown>) ?? {}),
        PreToolUse: [...entries, CLAUDE_HOOK_ENTRY],
      },
    },
  };
}

export function serializeClaudeSettings(doc: ClaudeSettings): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter crimes test -- hook-templates --run`
Expected: PASS — all six assertions.

- [ ] **Step 5: Wire the hook write into `commands/init.ts`**

In `packages/cli/src/commands/init.ts`:

1. Add the `--no-hooks` flag:

```typescript
.option(
  "--no-hooks",
  "skip writing .claude/settings.local.json and .agents/settings.local.json with --agents",
)
```

Update `InitCommandOptions` to include `hooks: boolean` (Commander gives `true` by default with `--no-hooks`).

2. After the existing skill writes, add hook writes (gated by `writeAgentSkills && options.hooks`):

```typescript
import {
  CODEX_HOOK_DOCUMENT,
  mergeClaudeHook,
  serializeClaudeSettings,
  type ClaudeSettings,
} from "../hook-templates.js";

// ...within the action handler, after the SKILL.md writes:

if (writeAgentSkills && options.hooks !== false) {
  // Claude
  if (writeClaudeSkill) {
    const settingsPath = resolve(process.cwd(), ".claude/settings.local.json");
    let existing: ClaudeSettings | undefined;
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, "utf8"));
      } catch {
        if (!options.force) {
          process.stderr.write(
            `crimes: .claude/settings.local.json is malformed — refusing to modify. Pass --force to overwrite.\n`,
          );
          process.exit(2);
          return;
        }
        existing = undefined;
      }
    }
    const merge = mergeClaudeHook(existing);
    if (merge.action !== "skipped") {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, serializeClaudeSettings(merge.document), "utf8");
      written.push(".claude/settings.local.json");
    }
  }

  // Codex stub
  if (writeCodexSkill) {
    const codexSettingsPath = resolve(process.cwd(), ".agents/settings.local.json");
    if (!existsSync(codexSettingsPath) || options.force) {
      mkdirSync(dirname(codexSettingsPath), { recursive: true });
      writeFileSync(codexSettingsPath, CODEX_HOOK_DOCUMENT + "\n", "utf8");
      written.push(".agents/settings.local.json");
    }
  }
}
```

Add imports: `readFileSync` to the existing `node:fs` import line.

- [ ] **Step 6: Update `init.test.ts`**

Add five test cases (mirror the existing test style — fixture in tmpdir, runCli, assert filesystem):

```typescript
it("--agents writes .claude/settings.local.json with a crimes PreToolUse hook", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "crimes-init-hook-"));
  await runCli(["init", "--agents"], { cwd: tmp });
  const settings = JSON.parse(
    readFileSync(join(tmp, ".claude/settings.local.json"), "utf8"),
  );
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("crimes context");
});

it("--no-hooks skips the settings.local.json writes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "crimes-init-hook-"));
  await runCli(["init", "--agents", "--no-hooks"], { cwd: tmp });
  expect(existsSync(join(tmp, ".claude/settings.local.json"))).toBe(false);
});

it("merges into an existing .claude/settings.local.json without overwriting other hooks", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "crimes-init-hook-"));
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(
    join(tmp, ".claude/settings.local.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    }),
  );
  await runCli(["init", "--agents"], { cwd: tmp });
  const settings = JSON.parse(
    readFileSync(join(tmp, ".claude/settings.local.json"), "utf8"),
  );
  expect(settings.hooks.PreToolUse).toHaveLength(2);
  expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
  expect(settings.hooks.PreToolUse[1].matcher).toBe("Edit|Write|NotebookEdit");
});

it("refuses to modify a malformed .claude/settings.local.json without --force", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "crimes-init-hook-"));
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(join(tmp, ".claude/settings.local.json"), "{ not json");
  const result = await runCli(["init", "--agents"], { cwd: tmp });
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("malformed");
});

it("writes a Codex placeholder when --agents (or --codex-skill) is set", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "crimes-init-hook-"));
  await runCli(["init", "--agents"], { cwd: tmp });
  const settings = JSON.parse(
    readFileSync(join(tmp, ".agents/settings.local.json"), "utf8"),
  );
  expect(settings._note).toMatch(/Codex/);
});
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter crimes test -- init --run`
Expected: PASS.

- [ ] **Step 8: Commit (no patch bump — hooks don't affect findings)**

```bash
git add packages/cli/src/hook-templates.ts \
        packages/cli/src/hook-templates.test.ts \
        packages/cli/src/commands/init.ts \
        packages/cli/src/commands/init.test.ts
git commit -m "feat(cli): init --agents writes PreToolUse hook(s)

.claude/settings.local.json merge-write with a PreToolUse Edit hook
that calls 'crimes context --format json' on the file being edited.
Existing hooks preserved; malformed JSON refused without --force.
.agents/settings.local.json gets a forward-looking placeholder.
--no-hooks opts out of both.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 8 — In-repo docs

Each task in this phase is small (one or two file edits). Group as listed; commit each task on its own. **No patch bumps** — docs don't move eval baselines.

### Task 16: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README to identify the Quick Start triad and the version pin**

Run: `grep -n "crimes context\|crimes scan\|crimes verdict\|0.10\|0.11" README.md | head -30`

- [ ] **Step 2: Insert `crimes triage` into the Quick Start section**

Add a new bullet between the existing `crimes scan` and `crimes verdict` entries:

```markdown
- `crimes triage` — walk findings one at a time, mark each as fix-now /
  fix-this-PR / needs-design / wont-fix / scaffolding. Persists to
  `.crimes/triage.json` with reason + owner + date. Use this instead of
  `crimes baseline save` as your default "I'm done looking at this list"
  step.
```

- [ ] **Step 3: Add a "Triage workflow" section**

Insert after the Quick Start section (or in whichever place feels natural — follow the existing section organisation):

```markdown
## Triage workflow

When `crimes scan` returns more findings than you can act on right now,
walk the list with `crimes triage`. Each finding gets one of five
dispositions:

| Disposition    | Shown in scan? | Resurfaces on touched files? |
| -------------- | -------------- | ---------------------------- |
| `fix-now`      | yes (▶ prefix) | n/a                          |
| `fix-this-PR`  | yes (▶ prefix) | n/a                          |
| `needs-design` | hidden         | yes — "still intentional?"   |
| `wont-fix`     | hidden         | yes — "still intentional?"   |
| `scaffolding`  | hidden         | yes — "still intentional?"   |

Entries live in `.crimes/triage.json` alongside `baseline.json` and
`suppressions.json`. The file carries `fingerprint`, `disposition`,
`reason`, `owner`, and `date` for every entry — no bulk amnesia.

Resurfacing fires automatically when your current branch's diff (against
`config.triage.resurfaceBase`, defaults to `main`) touches a file with a
silenced disposition. The renderer prepends those findings to scan
output under "You're editing files you previously triaged — was this
still intentional?" Use `crimes triage --retriage <file-or-fingerprint>`
to re-open the disposition.

Non-interactive form: `crimes triage --apply <triage.json>` merges
entries from a JSON file into the on-disk triage.
```

- [ ] **Step 4: Update the version pin reference**

Find every `0.10.0` reference (likely in install commands or feature
gating). Update to `0.11.0`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document crimes triage workflow and .crimes/triage.json

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Update `docs/agent-usage.md`

**Files:**
- Modify: `docs/agent-usage.md`

- [ ] **Step 1: Insert triage between scan and verdict in the workflow flow**

Find the existing pre-edit / post-edit flow section. Add a step that mentions running `crimes triage` after a heavy scan and before relying on `--changed` gates.

- [ ] **Step 2: Document the PreToolUse hook contract**

Add a new subsection explaining that `crimes init --agents` writes a
`.claude/settings.local.json` PreToolUse hook that runs `crimes context
--format json` on every `Edit`/`Write`/`NotebookEdit`. Note the
`--no-hooks` opt-out and the Codex placeholder.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-usage.md
git commit -m "docs(agent-usage): triage step + PreToolUse hook contract

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Update `docs/json-schema.md`

**Files:**
- Modify: `docs/json-schema.md`

- [ ] **Step 1: Document the schema bump**

Add a top-of-file callout:

```markdown
## Migration note: schema_version 0.1.0 → 0.2.0

`crimes@0.11.0` bumps the finding schema. Every `Finding` now carries
two new required fields:

| Field      | Type                                        | Description                                |
| ---------- | ------------------------------------------- | ------------------------------------------ |
| `effort`   | `"quick" \| "small" \| "medium" \| "large"` | Estimated effort to address.               |
| `fix_shape`| `string` (≤120 chars, single line)          | The shape of the fix, not the fix itself.  |

Consumers that hard-checked `schema_version === "0.1.0"` must accept
`"0.2.0"` as well. No existing field changed shape, name, or semantics.
```

- [ ] **Step 2: Document the new optional annotations**

Add entries for `triaged`, `previously_triaged`, `previous_triage`,
`previously_baselined`, `previous_baseline` — mirror the spec
description in §5.5 of the design.

- [ ] **Step 3: Commit**

```bash
git add docs/json-schema.md
git commit -m "docs(json-schema): document schema 0.2.0 (effort, fix_shape) + triage annotations

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Update `docs/configuration.md`

**Files:**
- Modify: `docs/configuration.md`

- [ ] **Step 1: Add `triage.resurfaceBase` to the config-keys table**

```markdown
| `triage.resurfaceBase` | string | `"main"` | Git ref used to detect "touched files" for resurfacing. Empty string disables resurfacing entirely. |
```

- [ ] **Step 2: Explain the interaction with `scopeTiers.nonDomain`**

Add a paragraph noting that resurfacing **crosses tiers** — a triaged
finding in a non-domain file still resurfaces when that file is in the
branch diff. The default `crimes triage` walk visits domain-tier only;
use `crimes triage --all` to include non-domain.

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md
git commit -m "docs(configuration): add triage.resurfaceBase

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Update `docs/roadmap.md`

**Files:**
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Add a Release B mirror entry**

Following the existing milestone-mirror style, add a 0.11.0 row at the
top describing this release. Move the 0.10.0 entry into the
"shipped" section.

- [ ] **Step 2: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): mirror crimes@0.11.0 — triage as the front door

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Create `docs/releases/v0.11.0.md`

**Files:**
- Create: `docs/releases/v0.11.0.md`

- [ ] **Step 1: Draft the release notes**

Use `docs/releases/v0.10.0.md` as the structural template. Sections:

1. **TL;DR** — minor release, schema bump, new triage command,
   resurfacing, PreToolUse hook, secondary-score rendering.
2. **Things requiring agent attention** — `schema_version` `0.1.0` →
   `0.2.0`; new required fields on `Finding`.
3. **What shipped** — one subsection per item (triage command,
   resurfacing, schema additions, PreToolUse hook, secondary scores).
4. **What's not in 0.11.0** — same disclaimers as Release A
   (no new detectors, no `crimes ask`).
5. **Upgrading** — `npm install -g crimes@0.11.0` + the JSON consumer
   migration line.
6. **Notable links** — `docs/superpowers/specs/2026-05-20-release-b-triage-design.md`
   plus deep links into modified source files.

- [ ] **Step 2: Commit**

```bash
git add docs/releases/v0.11.0.md
git commit -m "docs(releases): draft v0.11.0 release notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: Update `PRD.md`

**Files:**
- Modify: `PRD.md`

- [ ] **Step 1: Refresh §9 finding-schema example**

Add `"effort": "medium"` and `"fix_shape": "extract orchestration; move pure helpers to a sibling module"` to the example finding (the current example sits around line 432).

- [ ] **Step 2: Add a `triage` block in §18 config section**

Update the config example to include `triage: { resurfaceBase: "main" }`.

- [ ] **Step 3: Update §22 milestone table**

If the table tracks 0.10.0 / 0.11.0, add a row for the latter.

- [ ] **Step 4: Commit**

```bash
git add PRD.md
git commit -m "docs(prd): finding-schema 0.2.0 example + triage config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 9 — Website

### Task 23: Update website homepage + nav

**Files:**
- Modify: `apps/website/src/pages/index.astro` (or wherever the homepage hero lives)
- Modify: the Starlight sidebar config (usually `astro.config.mjs` or `apps/website/src/content/config.ts`)

- [ ] **Step 1: Locate the homepage hero**

Run: `find apps/website/src -name "*.astro" -o -name "*.md" -o -name "*.mdx" | xargs grep -l "crimes context\|Quick start" 2>/dev/null | head -10`

- [ ] **Step 2: Update the hero to include triage**

Add `crimes triage` as the second front-door command after `crimes context`. The exact markup depends on the existing template — match the styling already used for `crimes context`.

- [ ] **Step 3: Update the sidebar/nav config**

Add a "Triage" entry under the docs section. Demote any prominent
mention of "baseline" to an "Escape hatch" subsection or footnote — the
brief is explicit that baseline is no longer the front door.

- [ ] **Step 4: Run the website locally and visually inspect**

Run: `pnpm --filter @crimes/website dev` (or whichever workspace command — check `apps/website/package.json` `scripts`).
Open: `http://localhost:4321` (Astro default).

Check that the hero renders, the nav reorders, and no broken links appear.

- [ ] **Step 5: Commit**

```bash
git add apps/website/src/pages/index.astro \
        apps/website/astro.config.mjs
git commit -m "site: homepage and nav reflect triage as the front door

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: Update website docs pages

**Files:**
- Modify: `apps/website/src/content/docs/getting-started.{md,mdx,astro}`
- Modify: `apps/website/src/content/docs/scan.{md,mdx,astro}`
- Modify: `apps/website/src/content/docs/configuration.{md,mdx,astro}`
- Modify: `apps/website/src/content/docs/agents.{md,mdx,astro}`
- Modify: `apps/website/src/content/docs/json-schema.{md,mdx,astro}`
- Create: `apps/website/src/content/docs/triage.{md,mdx,astro}` (new page)

The exact file extensions depend on the Starlight config. Use the
existing patterns.

- [ ] **Step 1: Triage page**

Create the new triage docs page mirroring the in-repo `README.md`
"Triage workflow" section but expanded with screenshots / output samples
showing the interactive walk and the resurface block.

- [ ] **Step 2: Update remaining docs pages**

Each page picks up the spec's website table (§5.9 in the design):

- Getting-started: new file-grouped scan output, `--top` / `--flat` /
  `--all`, **plus** the triage walkthrough.
- Scan: test_gap quartile change (from A), recency multiplier (from A),
  `scopeTiers.nonDomain` (from A), resurfacing pipeline (B),
  human-readable secondary scores (B).
- Configuration: `scopeTiers`, `scan.topFiles` (A), `triage.resurfaceBase`
  (B).
- Agents: two-prompt auto-init (A), `ContextReport.clues` (A),
  PreToolUse hook (B), `--no-hooks` (B).
- JSON schema: `tier` + `clues` (A); `schema_version: "0.2.0"`,
  migration note (B), new fields (B), JSON numerics unchanged callout
  (B).

- [ ] **Step 3: Build the site to verify nothing breaks**

Run: `pnpm --filter @crimes/website build`
Expected: succeeds, no broken-link warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/website/src/content/docs/
git commit -m "site: docs pages catch up on both Release A and Release B

- Adds triage page.
- Backfills Release A content (file-grouped scan, quartile test_gap,
  recency, scopeTiers, ContextReport.clues, auto-init).
- Adds Release B content (triage command, resurfacing, schema 0.2.0,
  PreToolUse hook, secondary-score rendering).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: Add v0.11.0 to the website releases index

**Files:**
- Modify: `apps/website/src/content/docs/releases.{md,mdx,astro}` (or whichever index lists released versions)

- [ ] **Step 1: Append a v0.11.0 entry linking to the new release-notes content**

Match the existing layout for v0.10.0 / v0.9.x entries.

- [ ] **Step 2: Build + commit**

Run: `pnpm --filter @crimes/website build`

```bash
git add apps/website/src/content/docs/releases.mdx
git commit -m "site(releases): add v0.11.0 entry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 10 — Release wrap-up

### Task 26: Smoke test the published surface

**Files:** none (test-only).

- [ ] **Step 1: Run the from-clean-install smoke**

Run: `pnpm --filter crimes smoke`
Expected: passes, including the three new assertions added in earlier tasks (triage --apply, resurface block, init --agents writes hooks).

- [ ] **Step 2: Run `pnpm ci`**

Run: `pnpm ci`
Expected: build + typecheck + test across every workspace package, all green.

- [ ] **Step 3: If anything's red, fix it before continuing**

Common failure modes:
- A detector test wasn't updated for the `effort` / `fix_shape` schema
  bump — search and apply the same two-line addition.
- A reporter snapshot in `human/context` wasn't regenerated.
- The website build fails on a markdown link to a path that didn't get
  created.

---

### Task 27: Write the Changeset and prepare the release

**Files:**
- Create: `.changeset/release-b-triage.md`

- [ ] **Step 1: Draft the Changeset**

Mirror the existing `.changeset/release-a-front-door.md` shape.

```markdown
---
"crimes": minor
"@crimes/core": minor
"@crimes/language-js": minor
"@crimes/reporter": minor
---

Release B — Triage as the front door

This minor release introduces `crimes triage`, the recommended way to
work through findings on a fresh install. Replaces the reflex
`crimes baseline save` step that prior versions implicitly funnelled
users toward.

**Breaking-ish: schema_version bumped 0.1.0 → 0.2.0**

Every `Finding` now carries two new **required** fields:

- `effort` — `"quick" | "small" | "medium" | "large"` (estimated effort)
- `fix_shape` — one-line description of the shape of the fix

Consumers that hard-checked `schema_version === "0.1.0"` must accept
`"0.2.0"` as well. No existing field changed shape, name, or semantics.

**New: `crimes triage`**

Interactive per-finding walk with five dispositions: `fix-now`,
`fix-this-PR`, `needs-design`, `wont-fix`, `scaffolding`. Persists to
`.crimes/triage.json`. Non-interactive `--apply <file>` for scripted
use.

**New: triage- and baseline-aware resurfacing**

Every `crimes scan` quietly checks whether the current branch's diff
touches a file with a silenced disposition (or a baselined finding) and
prepends matches to the report under "You're editing files you
previously triaged — was this still intentional?"

**New: PreToolUse hook in `init --agents`**

`crimes init --agents` now writes `.claude/settings.local.json` with a
PreToolUse Edit hook that runs `crimes context --format json` on the
file being edited. `.agents/settings.local.json` gets a forward-looking
stub. Opt out with `--no-hooks`.

**Renderer change: human-readable secondary scores**

The scan and context human renderers replace bare decimals (`blast
0.72`, `churn 0.41`) with interpretive prose (`blast top-quartile (11
importers)`, `churn 24 commits over 90d · last touched 2 days ago`).
JSON numerics are unchanged — the schema is a public API.

**Site catch-up**

crimes.sh now reflects both Release A (shipped 0.10.0) and Release B —
file-grouped scan output, `scopeTiers.nonDomain`, two-prompt auto-init,
`ContextReport.clues`, triage workflow, PreToolUse hook, secondary
scores.

Notable links:

- [Release B design spec](docs/superpowers/specs/2026-05-20-release-b-triage-design.md)
- [v0.11.0 release notes](docs/releases/v0.11.0.md)
```

- [ ] **Step 2: Commit and push**

```bash
git add .changeset/release-b-triage.md
git commit -m "chore: changeset for crimes@0.11.0 — triage as the front door

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Pushing to `main` and cutting the tag are out of scope for this plan — they're a separate release procedure tracked in `docs/releasing.md`.

---

## Plan-level self-check before handoff

Run these sanity checks as the engineer wraps up:

- [ ] `git log --oneline 0.10.0..HEAD` shows the commit sequence: schema bump → triage core → triage CLI → resurface → flags → reporter → hook → docs → website → changeset.
- [ ] `cat packages/cli/package.json | grep version` shows a patch version (e.g. `0.10.4`) — the Changeset bumps it to `0.11.0` at release time.
- [ ] `evals/results/` contains a directory for every patch-bump commit.
- [ ] `pnpm ci` passes from a clean checkout.
- [ ] `pnpm --filter crimes smoke` passes.
- [ ] Visual inspection of crimes.sh preview shows the triad (`context`, `triage`, `scan`) leading the homepage.

If any of those fails, do not cut the tag — fix the failure first.
