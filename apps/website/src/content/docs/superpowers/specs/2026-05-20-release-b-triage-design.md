---
title: "Release B — Triage as the front door (design spec)"
---

**Status:** approved design, pre-plan. Next step is the implementation plan
written by `superpowers:writing-plans`.

**Authors:** Andrew Mayfield + Claude (brainstorming session 2026-05-20).

**Companion docs**

- `PRD.md` — authoritative product spec; this design must not contradict it.
- `CLAUDE.md` — coding/governance constraints (signal over exhaustiveness,
  schema-as-contract, evidence-before-judgement, eval baseline policy).
- `evals/README.md` § Versioning policy — between-release patch bumps,
  Changeset cut at release time.
- `docs/superpowers/specs/2026-05-20-release-a-front-door-design.md` —
  Release A (front-door redesign), shipped at `crimes@0.10.0`. Release B
  consumes the contracts Release A froze (`context --json` `clues` block;
  `scopeTiers.nonDomain` config key).

---

## 1. Background

Two unprompted agent users converged on the same failure mode on `crimes`
0.9.x: first `crimes scan` on a 200-finding repo → reflex `crimes baseline
save` → the tool collapses into a diff-only gate and real debt freezes
forever. Release A reshaped the first screen so users reach for `crimes
context <file>` instead of `baseline`. Release B closes the loop on the
other half of the failure: when the user *does* want to set aside
findings in bulk, give them a structured triage path with per-finding
disposition + reason + owner + date — and make the choices stop being
permanent.

`crimes baseline save` stays in place; it's the escape hatch, not the
front door.

## 2. Principle

> Baseline is the escape hatch, not the front door. Make explicit triage
> the recommended path.

## 3. Success criterion

A fresh user who runs `crimes scan` and sees 150 findings reaches for
`crimes triage` rather than `crimes baseline`, and the result is per-finding
disposition with reason + owner + date — not bulk amnesia. When the user
later edits a file containing a `wont-fix` or `needs-design` entry, the
finding resurfaces with a "was this still intentional?" framing.

## 4. Non-goals for this release

- New detectors. Detector taxonomy stays frozen — Release B is workflow +
  schema fields + renderer, not new signal.
- `crimes baseline` deprecation. Baseline stays as the escape hatch; the
  brief is explicit that triage is the front door, not the replacement.
- `--quick-wins` and `--budget <minutes>` filter flags. `effort` is added
  to make these trivial in a follow-up, but they're explicitly out of
  scope for this release.
- LLM-assisted features. Still deferred per PRD §26.

## 5. Decisions made

### 5.1 `crimes triage` command — per-finding interactive walk

Top-of-rank-first interactive walk over findings, with five disposition
states. Each disposition writes to `.crimes/triage.json` immediately
(incremental persistence) so a SIGINT or terminal crash doesn't lose
progress. Non-interactive `--apply <file>` accepts the same JSON shape
for scripted use.

```
$ crimes triage
Triaging 47 findings against .crimes/triage.json.
Keys: f fix-now · p fix-this-PR · d needs-design · w wont-fix · s scaffolding · k skip · q quit

[1/47] 🚨 src/billing/invoice.ts
  God Function · generateInvoice() — 214 lines, 6 awaits, 3 tables
  Risk: churn high · test gap top-quartile · blast 0.72
  Fix shape: extract orchestration; move pure helpers to a sibling module
  Effort: medium
  Disposition? w
  Reason (one line): legacy billing, full rewrite Q3 — see ADR-014
  Owner [@amayfield]:
  ✓ wont-fix · saved.

[2/47] …
```

**Behaviours:**

- Walks `tier === "domain"` findings only by default, top-of-rank first
  (same ordering Release A uses). `crimes triage --all` includes
  non-domain.
- A finding already in `.crimes/triage.json` is **skipped** unless
  `--retriage` is passed. `--retriage <fingerprint-or-file>` re-opens
  the disposition prompt for matching entries.
- `k` (skip) leaves the finding un-triaged — no entry written.
  Re-running `crimes triage` re-prompts.
- `q` (quit) saves accumulated progress and exits 0.
- Owner prompt defaults to the last owner set in this session (so a
  reviewer walking a list doesn't re-type their handle). The first
  prompt's default comes from the `--owner` flag, then from
  `git config user.email`, then empty.
- Date is set from the system clock when the entry is written
  (YYYY-MM-DD).
- Non-TTY / `CI=1`: refuses to start the interactive flow with
  `crimes: refusing to start interactive triage in a non-TTY/CI
  environment. Use --apply <file>.` and exits 2.

**Subcommands:**

```
crimes triage                       # interactive walk over current scan
crimes triage --apply <file>        # non-interactive: read dispositions from JSON
crimes triage --list                # show current triage entries (no scan)
crimes triage --clear <fingerprint> # remove one entry
crimes triage --retriage <target>   # re-open dispositions for matching entries
```

**`--apply <file>` document shape**: the file accepts the same shape as
`.crimes/triage.json` (see §5.2) — top-level `schema_version`,
`report_type: "triage"`, and `entries[]`. Entries are merged into the
on-disk triage by fingerprint: an applied entry whose fingerprint
matches an existing one **overwrites** it (with the applied entry's
`reason` / `owner` / `date`); fingerprints not in the applied file are
left untouched. The applied file's `created_at` / `updated_at` are
ignored — `crimes triage --apply` sets `updated_at` to the system clock
at apply time.

**`--retriage <target>` target syntax**: accepts either a fingerprint
(exact match against `entries[].fingerprint`), a repo-relative file
path (matches all entries whose `file` equals it), or a glob (matches
all entries whose `file` matches via `picomatch`). Matching entries
are re-prompted in the interactive walk; non-matching entries are
left alone.

`--format human|json` controls the **summary line** the command emits on
exit (e.g. `Triaged 12 findings · 4 wont-fix · 3 needs-design · 5 fix-this-PR`).
The interactive prompt itself is human-only; `--apply` + `--format json`
gives the scripted equivalent.

`--owner <handle>` sets the default owner for every disposition this
run. `--no-color` disables ANSI.

### 5.2 Storage — separate `.crimes/triage.json`

Triage lives in its own file alongside `baseline.json` and
`suppressions.json`. Three reasons:

1. `fix-now` / `fix-this-PR` / `needs-design` / `scaffolding` carry
   semantic meaning beyond "silence me" — overloading `suppressions.json`
   would mix two distinct contracts.
2. Existing tooling (`crimes ignore`, `crimes feedback`, suppressions
   audit) keeps working unchanged.
3. The migration story is simple: existing `baseline.json` and
   `suppressions.json` are untouched; teams can adopt triage
   incrementally.

The scan pipeline reads all three files (baseline, suppressions, triage)
and applies them as parallel filter layers — no duplication of state,
no synthetic mirroring between files.

**Schema** (`packages/core/src/triage.ts`, validated with zod, mirroring
the `Suppressions` shape):

```jsonc
{
  "schema_version": "0.2.0",
  "report_type": "triage",
  "created_at": "2026-05-20T14:00:00Z",
  "updated_at": "2026-05-20T14:00:00Z",
  "crimes_version": "0.11.0",
  "entries": [
    {
      "fingerprint": "god_function::src/billing/invoice.ts::generateInvoice",
      "type": "god_function",
      "file": "src/billing/invoice.ts",
      "symbol": "generateInvoice",
      "disposition": "wont-fix",
      "reason": "legacy billing, full rewrite Q3 — see ADR-014",
      "owner": "@amayfield",
      "date": "2026-05-20"
    }
  ]
}
```

- `disposition` enum: `"fix-now" | "fix-this-PR" | "needs-design" |
  "wont-fix" | "scaffolding"`.
- `reason`, `owner`, `date` are **required at the zod level** so the
  file always carries the receipts the brief asks for. `owner` may be
  the empty string when the user declined to set one, but the field
  must be present. `reason` and `date` are non-empty.
- `fingerprint` follows the same `<type>::<file>::<symbol-or-empty>`
  scheme as `Baseline` and `Suppressions` (see
  `packages/core/src/fingerprint.ts`).
- Malformed files raise `MalformedTriageError`, mirroring
  `MalformedSuppressionsError`.

### 5.3 Filter semantics on `scan`

| Disposition | Default `crimes scan` | `--show-triaged` | Resurfaces on diff? |
|---|---|---|---|
| `fix-now` | shown with `▶ fix-now ·` annotation | shown | n/a (not silenced) |
| `fix-this-PR` | shown with `▶ fix-this-PR ·` annotation | shown | n/a (not silenced) |
| `needs-design` | hidden | shown | yes |
| `wont-fix` | hidden | shown | yes |
| `scaffolding` | hidden | shown | yes |

Rationale: `fix-now` / `fix-this-PR` stay visible because the *point*
of marking them is to keep them in your face until you do them. They
render with a distinct prefix in the file's finding list. The three
silenced dispositions resurface when the file is touched (see §5.4).

**New `crimes scan` flags introduced by this release:**

| Flag | Default | Effect |
|---|---|---|
| `--show-triaged` | off | Include silenced dispositions in output (annotated with their disposition + reason + owner + date) |
| `--gate-needs-design` | off | When `--fail-on` is set, count `needs-design` findings toward the gate |
| `--gate-resurfaced` | off | When `--fail-on` is set, count resurfaced findings on touched files toward the gate |

**Gate behaviour on `--changed --fail-on`:**

- `wont-fix` and `scaffolding` are excluded from the gate by default
  (matching today's suppression semantics).
- `needs-design` is excluded by default but a new `--gate-needs-design`
  flag opts in to treating it as gate-relevant (teams that consider
  "needs design" as "must resolve before merging").
- `fix-now` and `fix-this-PR` participate in the gate normally — they
  are visible findings.
- A new `--gate-resurfaced` flag (off by default) makes `--fail-on`
  count resurfaced findings on touched files. Off by default because
  the user already triaged them; we surface as a reminder, not a block.

### 5.4 Resurfacing pipeline — zero-effort, default on

**Trigger** (every `crimes scan` invocation):

```
on every `crimes scan`:
  if config.triage.resurfaceBase is empty string → skip resurfacing
  else if not in git repo → skip resurfacing
  else if HEAD ref name === <resurfaceBase> → skip resurfacing (we are on the base)
  else:
    diffFiles = git diff --name-only <resurfaceBase>...HEAD ∪ working-tree changes
    for each triage entry with disposition ∈ {needs-design, wont-fix, scaffolding}
      where entry.file ∈ diffFiles:
        re-run that finding's detector on entry.file (single-file scope)
        if a finding still matches the fingerprint → emit it with
          previously_triaged + previous_triage
    for each baseline entry where entry.file ∈ diffFiles:
        re-run that finding's detector → emit with
          previously_baselined + previous_baseline
```

**Why re-detect** rather than synthesise from stored metadata: the
user is editing the file. The finding might already be fixed
(renamed symbol, deleted block, extracted function). Re-running the
relevant detector on just the touched files is cheap (TS-only parses
a single file) and yields a real `Finding` with current evidence —
line numbers, current symbol position, current scoring. When the
re-detect produces zero matching findings for the stored fingerprint,
the resurfaced entry is silently dropped (we do not nag users about
something they already fixed).

**`config.triage.resurfaceBase`**: defaults to `"main"`. Override via
`crimes.config.json`:

```jsonc
{
  "triage": {
    "resurfaceBase": "develop"
  }
}
```

Set to `""` (empty string) to disable resurfacing entirely.

**Detector keying for single-file re-detect**: the existing
`detector-registry.ts` exposes detectors by type name. The resurface
path constructs a minimal scoring context (single file, no global
test-gap quartile pass) and invokes only the relevant detector. When
the detector requires repo-wide state (e.g. `circular_dep`), the
resurface path falls back to running a full scan filtered to the
diff'd file set — slower than ideal but bounded by the small number
of touched files in a typical branch.

### 5.5 Resurfacing — JSON & human shape

**JSON additions to `Finding`** (additive, lifted by the schema bump in
§5.6):

```typescript
export interface Finding {
  // ...existing fields...

  /** True when this finding matches an entry in .crimes/triage.json. */
  previously_triaged?: true;
  previous_triage?: {
    disposition: "fix-now" | "fix-this-PR" | "needs-design" | "wont-fix" | "scaffolding";
    reason: string;
    owner: string;
    date: string;            // YYYY-MM-DD
  };

  /** True when this finding matches an entry in .crimes/baseline.json. */
  previously_baselined?: true;
  previous_baseline?: {
    /** ISO-8601 date the baseline was last written; best-effort. */
    date?: string;
    /** Baselines don't store per-entry reasons today; absent for now. */
    reason?: string;
  };
}
```

`previously_triaged` and `previously_baselined` are mutually exclusive in
practice (a finding either has a triage entry, a baseline entry, or
neither; if both, triage wins because it's more specific). Both fields
are absent on findings that aren't resurfaced.

**Human renderer** — a new sub-section before the "Top files by risk"
header, only rendered when resurfaced findings exist:

```
You're editing files you previously triaged — was this still intentional?

🚨 src/billing/invoice.ts                       2 findings · 1 high
   1. ▼ God Function · generateInvoice()        214 lines, 6 awaits
      wont-fix · "legacy billing, rewrite Q3 — see ADR-014" · @amayfield (2026-05-20)
      Touch this disposition: crimes triage --retriage src/billing/invoice.ts
   2. ▼ Temporal Recklessness                   UTC + local mixed
      needs-design · "wait on payments redesign" · @bsmith (2026-04-12)

Top files by risk
…
```

`▼` glyph distinguishes resurfaced rows from `🚨`/`⚠️`/`🔎`. In
`--no-color` / non-TTY contexts it falls back to the prose
`"resurfaced — was previously triaged: wont-fix"`.

Baseline resurfacings get a separate sub-header
`"You're editing files captured in .crimes/baseline.json — was this still
intentional?"` when no triage resurfacings exist, or are folded into the
same block with a distinct marker when both exist.

### 5.6 `effort` + `fix_shape` finding-schema additions

Two new fields on every `Finding`. Bundled into a **single
`schema_version` bump** `"0.1.0"` → `"0.2.0"`.

```typescript
export type Effort = "quick" | "small" | "medium" | "large";
// quick   ≤1-line change
// small   <1 hr
// medium  fits within one PR
// large   needs design

export interface Finding {
  // ...existing fields...
  /** Estimated effort to address. Detector-supplied; defaults to "medium". */
  effort: Effort;
  /**
   * One-line description of the *shape* of the fix, not the fix itself.
   * Detector-supplied; ≤120 chars, single line. Defaults vary per detector
   * type — see packages/core/src/detector-defaults.ts.
   */
  fix_shape: string;
}
```

Both fields are **required on output** (always present, no `?`) so
agents can rely on them. Consumers of the old `0.1.0` shape simply
ignore unknown fields — strict-additive, no field changed shape, name,
or semantics.

**Detector-side wiring** (`packages/core/src/detector.ts`): the existing
`createFinding` helper grows two optional inputs:

```typescript
createFinding({
  type: "god_function",
  // ...
  effort: "medium",
  fix_shape: "extract orchestration; move pure helpers to a sibling module",
});
```

When a detector omits either, the finalisation pass fills it from
`packages/core/src/detector-defaults.ts`:

```typescript
export const DETECTOR_DEFAULTS: Record<string, { effort: Effort; fix_shape: string }> = {
  god_function:        { effort: "medium", fix_shape: "extract orchestration; move pure helpers to a sibling module" },
  large_function:      { effort: "small",  fix_shape: "extract pure helpers; keep the orchestrator thin" },
  large_file:          { effort: "medium", fix_shape: "split by responsibility; one concern per module" },
  logic_in_alibi:      { effort: "small",  fix_shape: "lift the prose rule to an assert / type / test / config check" },
  temporal_reckless:   { effort: "medium", fix_shape: "inject a clock; pass through the domain boundary" },
  direct_date:         { effort: "small",  fix_shape: "inject a clock; pass through the domain boundary" },
  circular_dep:        { effort: "medium", fix_shape: "extract shared types to a leaf module" },
  // ...one row per detector type (~48 detectors)
};

export const GENERIC_DEFAULT = {
  effort: "medium" as const,
  fix_shape: "refactor to remove this signal; add a test that pins the fix",
};
```

**Validation** at finalisation (zod):

- `fix_shape` ≤120 chars, no newlines, non-empty.
- `effort` in enum.
- In dev (`NODE_ENV !== "production"` or under Vitest): throws on
  violation.
- In prod: falls back to default with a single stderr warning per
  detector type per run.

**Where these flow** (no immediate use in this release beyond display
and JSON, but the brief calls these out as the linchpin for follow-up
`--quick-wins` and `--budget <minutes>` flags):

- `crimes scan --all` and `crimes explain <id>` show both fields in
  human output.
- `crimes context` per-finding block shows `fix_shape` under the
  finding header.
- `--apply` and `--list` for triage show `fix_shape` so the user has
  the shape on the page when deciding.
- The new triage interactive walk shows both fields (see §5.1
  rendering).

### 5.7 PreToolUse Edit hook in `init --agents`

Extend `init --agents` to write hook configuration alongside the
existing skill files:

| Path | Behaviour |
|---|---|
| `.claude/skills/crimes/SKILL.md` | unchanged (0.9.0+) |
| `.agents/skills/crimes/SKILL.md` | unchanged (0.9.0+) |
| `.claude/settings.local.json` | **NEW** — merge-write a PreToolUse Edit hook |
| `.agents/settings.local.json` | **NEW (placeholder)** — same JSON shape; Codex doesn't honour PreToolUse today but the file is documented as a forward-looking stub |

Asymmetric note: the user picked "Claude + Codex" in the brainstorming
session, against the recommendation to write Claude-only. The Codex
side is a stub today (Codex has no PreToolUse hook surface as of
crimes 0.11.0); we ship the file with a top-of-file comment explaining
it's forward-looking and safe to delete. The brief explicitly calls
this out so users know what they're getting.

**Claude hook contents** (merged into `.claude/settings.local.json`,
never overwritten wholesale):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y crimes context \"$CLAUDE_TOOL_INPUT_file_path\" --format json 2>/dev/null || true",
            "timeout": 8000
          }
        ]
      }
    ]
  }
}
```

**Merge semantics** (avoid clobbering an existing settings file):

1. If `.claude/settings.local.json` doesn't exist: create with just the
   hook.
2. If it exists and already contains a crimes hook (detected by
   `command` containing the substring `crimes context`): skip
   (already wired).
3. If it exists with other hooks: read, parse, append our entry to
   `hooks.PreToolUse[]`, write back preserving formatting (2-space
   indent, trailing newline).
4. If it exists with malformed JSON: write to stderr
   `crimes: .claude/settings.local.json is malformed — refusing to
   modify. Pass --force to overwrite.` and exit 2.

**`--force`** overwrites only the crimes hook entry; never touches
non-crimes entries.

**Stub `.agents/settings.local.json`** (valid JSON — no comments,
explanatory text carried as an underscore-prefixed key that most JSON
consumers ignore):

```json
{
  "_note": "Forward-looking: Codex does not honour PreToolUse hooks as of crimes 0.11.0. The schema mirrors .claude/settings.local.json so this file is ready when the Codex hook surface lands. Safe to delete if your team doesn't want it.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y crimes context \"$CODEX_TOOL_INPUT_file_path\" --format json 2>/dev/null || true",
            "timeout": 8000
          }
        ]
      }
    ]
  }
}
```

The `_note` key is the spec-level convention for "this is a placeholder"
documentation — implementers may instead drop a sibling `.agents/README`
or `.agents/settings.local.README.md` if a future Codex schema rejects
unknown top-level keys. At code time, pick whichever shape the current
Codex contract tolerates; the spec requires *only* that the placeholder
exists and that its purpose is discoverable to the reader.

**Flags:**

- `--no-hooks` opts out of writing either settings file (SKILL.md files
  still ship).
- `--force` overwrites the crimes hook entry but never non-crimes
  entries.

**`crimes init` (without `--agents`)** does not write hooks — the
existing config-only path stays unchanged.

### 5.8 Human-readable secondary scores in the human renderer

`scores.blast_radius: 0.72`, `scores.churn: 0.41`, `scores.test_gap:
1.0` are JSON values — kept untouched, schema is a public API. This is
a **renderer-only** change.

**Where it shows up** — scan per-file `Risk:` line and context
per-finding score block:

Before (scan default view, file header):

```
Risk: churn high · test gap top-quartile · blast 0.72
```

After:

```
Risk: churn high (24 commits in 90d) · test gap top-quartile · blast top-quartile (11 importers)
```

Before (`crimes context` per-finding):

```
scores: severity 0.86 · confidence 0.88 · blast 0.72 · churn 0.64 · test gap 1.00 · agent risk 0.91
```

After:

```
scores: severity 0.86 · confidence 0.88 · agent risk 0.91
  blast    top-quartile · imported by 11 files (top 5% of fan-in)
  churn    24 commits over 90d · last touched 2 days ago
  test gap top-quartile · no test file imports this module
```

**Implementation surface**: new `packages/reporter/src/human/score-format.ts`
with pure functions:

```typescript
formatBlastRadius(score: number, importerCount?: number, quartileLabel?: QuartileLabel): string
formatChurn(score: number, commits90d?: number, lastCommitAt?: string): string
formatTestGap(score: number, label?: TestGapLabel): string
formatFanIn(importerCount: number, percentile?: number): string
```

These take raw numeric inputs from `Finding.scores` and the
`ContextReport.clues` block (Release A froze these), return interpretive
prose. `human/scan.ts` and `human/context.ts` call them in place of
current `score.toFixed(2)` invocations.

**Fallback for missing inputs**: when `importerCount` / `commits90d` is
unavailable (git missing, scoring context not wired in a test stub),
the formatter falls back to the raw quartile label only (`blast
top-quartile`). Never shows a bare decimal in the new output.

**JSON callout for agent integrators** — release notes explicitly say
"numerics in JSON are unchanged; only the human renderer reformats."

### 5.9 Website + in-repo docs

Both Release A (shipped at 0.10.0, never reflected on crimes.sh) and
Release B (this release) need website + in-repo doc updates. Bundled
into this release; crimes.sh auto-deploys from `main` via Vercel so
the changes ship the moment they merge.

**In-repo (Markdown) updates:**

- `README.md` — add `crimes triage` to the Quick start triad; new
  "Triage workflow" section with the disposition table; document
  `.crimes/triage.json`; update version pin to `0.11.0`.
- `docs/agent-usage.md` — insert triage step between scan and verdict
  in the pre-edit / post-edit flow; document the PreToolUse hook
  contract; update the test-gap consumer-migration note from Release A.
- `docs/json-schema.md` — schema bump migration note; new fields
  (`effort`, `fix_shape`, `previously_triaged`, `previous_triage`,
  `previously_baselined`, `previous_baseline`).
- `docs/configuration.md` — `triage.resurfaceBase`; interaction with
  `scopeTiers.nonDomain` (resurfacing crosses tiers — a touched
  non-domain file's triaged finding still resurfaces).
- `docs/roadmap.md` — Release B mirror entry.
- `docs/releases/v0.11.0.md` — new release notes file with both
  releases' user-facing content described in the brief.
- `PRD.md` — §9 finding-schema example refreshed with `effort` +
  `fix_shape`; §18 config section adds `triage`; §22 milestone table
  updated.

**Website (`apps/website/`, Astro + Starlight):**

| Surface | From Release A (0.10.0) | From Release B (this release) |
|---|---|---|
| Homepage hero | Lead with `crimes context <file>` | Add `crimes triage` as second front-door command |
| Nav / sidebar | `context` first; rebuild scan demo to file-grouped layout | `triage` after `context`; `baseline` demoted to "Escape hatch" group |
| Getting-started | new file-grouped scan output, `--top`/`--flat`/`--all` | triage walkthrough; `.crimes/triage.json` lifecycle |
| Scan page | test_gap quartile change; recency multiplier; `scopeTiers.nonDomain` | resurfacing pipeline; human-readable secondary scores |
| Configuration page | `scopeTiers`, `scan.topFiles` | `triage.resurfaceBase` |
| Agents page | two-prompt auto-init; agent detection priority; `ContextReport.clues` frozen contract | PreToolUse hook + `settings.local.json` shape; `--no-hooks` opt-out |
| JSON schema page | call out optional `tier` + `clues` | `schema_version: "0.2.0"`; migration note; new fields; "JSON numerics unchanged in renderer revamp" callout |
| Releases index | link to v0.10.0 | link to v0.11.0 |

**Verification before merge**: workspace site build (`pnpm
--filter @crimes/website build` or whichever workspace command exists
— locate at planning time) must run clean; preview locally and check
the rendered triad.

## 6. Architecture summary

| Package | New file(s) | Modified file(s) |
|---|---|---|
| `@crimes/core` | `triage.ts`, `triage.test.ts`, `resurface.ts`, `resurface.test.ts`, `detector-defaults.ts`, `detector-defaults.test.ts` | `finding.ts` (`Effort`, `fix_shape`, `previously_triaged`, `previously_baselined`, `SCHEMA_VERSION` → `"0.2.0"`), `detector.ts` (`createFinding` accepts new fields), `scan.ts` (apply triage filter + resurface pipeline), `config.ts` (new `triage` config key), every detector source under `detectors/` (populate `effort` + `fix_shape`) |
| `@crimes/language-js` | — | — |
| `@crimes/reporter` | `human/score-format.ts`, `human/score-format.test.ts`, `human/triage.ts` | `human/scan.ts` (resurface block, score reformatting, `▶ fix-now` annotation), `human/context.ts` (score reformatting + `fix_shape` rendering), `human/shared.ts` (shared glyph helpers), `reporter.test.ts` (snapshot updates) |
| `@crimes/cli` | `commands/triage.ts`, `commands/triage.test.ts`, `hook-templates.ts` | `index.ts` (register `triage`), `commands/init.ts` (`.claude/settings.local.json` write + `.agents/settings.local.json` stub + `--no-hooks`), `commands/scan.ts` (no surface change; just calls new core path) |
| Docs | `docs/releases/v0.11.0.md`, `docs/superpowers/specs/2026-05-20-release-b-triage-design.md` (this file), website pages updated | `README.md`, `PRD.md`, `docs/agent-usage.md`, `docs/json-schema.md`, `docs/configuration.md`, `docs/roadmap.md` |

## 7. Data flow

```
discoverFiles
  → buildScoringContext (unchanged; quartile pass + recency window)
  → run detectors (each now supplies effort + fix_shape; finalisation fills defaults)
  → finaliseFindingScores (unchanged; computes agent_risk)
  → tag each finding with tier (unchanged; Release A)
  → load .crimes/triage.json
  → load .crimes/suppressions.json (unchanged path)
  → if config.triage.resurfaceBase set + in git repo + not on base:
      diffFiles = git diff --name-only <base>...HEAD ∪ working-tree
      resurfaced = re-detect on diffFiles for triage + baseline entries → annotate
  → apply triage filter (hide silenced dispositions; keep fix-now / fix-this-PR with annotation)
  → apply suppressions filter (unchanged)
  → reporter: render resurface block (if any), then file-grouped findings, then non-domain footer
```

JSON shape for `scan` gains `previously_triaged` / `previously_baselined`
on individual `Finding` entries. Resurfaced findings are emitted at the
**start** of `findings[]` (before non-resurfaced findings), in
`rank_score` order within the resurfaced subset. JSON consumers
distinguish them by checking `previously_triaged === true ||
previously_baselined === true`; no separate top-level field is added —
the existing `findings[]` array stays the single source of truth.

## 8. Error / edge handling

| Scenario | Behaviour |
|---|---|
| Git unavailable | Resurface skipped; baseline + triage filtering still applies |
| `config.triage.resurfaceBase = ""` | Resurface disabled even with git available |
| On base branch (HEAD ref name === resurfaceBase) | Resurface skipped silently |
| Triage entry's file no longer exists | Re-detect skipped; entry kept in `.crimes/triage.json` (might come back); not resurfaced |
| Re-detect finds no matching fingerprint | Resurface entry silently dropped (finding is fixed) |
| `crimes triage` in CI / non-TTY | Refuse with hint to use `--apply` |
| `crimes triage --apply` with malformed JSON | `MalformedTriageError`, exit 2 |
| `.claude/settings.local.json` malformed when init runs | Exit 2 with clear message; `--force` overwrites |
| `.claude/settings.local.json` already has a crimes hook | Skip (idempotent) |
| `effort`/`fix_shape` missing from a detector in dev | Throws — detector author sees the bug |
| `effort`/`fix_shape` missing from a detector in prod | Falls back to `DETECTOR_DEFAULTS[type]` → `GENERIC_DEFAULT`; single stderr warning per type per run |
| Both `previously_triaged` and `previously_baselined` would apply | `previously_triaged` wins (more specific) |
| Schema bump consumer that hard-checks `schema_version === "0.1.0"` | Breaks — explicitly documented in migration note |

## 9. Testing strategy

- **Unit (Vitest), TDD per `superpowers:test-driven-development`:**
  - `core/src/triage.test.ts` — schema load/save, fingerprint matching,
    disposition state transitions, `MalformedTriageError`, owner empty
    string allowed, date format validation.
  - `core/src/resurface.test.ts` — diff-driven file set, base-branch
    detection, on-base skip, git-unavailable degradation, re-detect
    drop-when-fixed, triage-wins-over-baseline merge.
  - `core/src/detector-defaults.test.ts` — every registered detector
    type has both fields; unknown type → `GENERIC_DEFAULT`.
  - `core/src/finding.test.ts` (extend) — `Effort` enum, `fix_shape`
    length cap, schema validation.
  - `cli/src/commands/triage.test.ts` — interactive readline flow with
    mocked stdin (mirror `auto-init.test.ts`), non-TTY refusal,
    `--apply` non-interactive, `--list`, `--clear`, `--retriage`,
    SIGINT mid-walk preserves progress.
  - `cli/src/commands/init.test.ts` (extend) —
    `.claude/settings.local.json` write, merge-into-existing,
    malformed-existing error path, `--no-hooks`, `--force`,
    `.agents/settings.local.json` stub content.
  - `reporter/src/human/score-format.test.ts` — interpretive prose for
    all input combos, fallback to quartile-only when raw numerics
    missing.
- **Reporter snapshot updates** (`reporter.test.ts`) — scan +
  context snapshots updated for the resurface block, secondary-score
  prose, and `▶ fix-now` annotation; one snapshot of the legacy
  `--flat` path preserved to detect regression.
- **Smoke (`pnpm --filter crimes smoke`)** — pack tarball, install in
  temp dir, run:
  1. `crimes triage --apply <fixture>.json` exits 0 and writes
     `.crimes/triage.json`.
  2. `crimes scan` on a fixture with a triaged finding shows the
     resurface block.
  3. `crimes init --agents` writes `.claude/settings.local.json` with
     a `PreToolUse` entry whose `command` contains `crimes context`.
  4. `crimes scan --format json | jq '.findings[0].effort'` returns a
     non-empty string.
- **Evals** — every commit that changes finding shape, scoring, or
  filtering re-runs `pnpm run evals` and commits
  `evals/results/<version>/`. The schema bump commit moves every
  fixture's output (new `effort` + `fix_shape` keys appear). Commit
  message annotates: measurement-shape correction, not a quality
  change.

## 10. Versioning and release procedure

Per `evals/README.md` § Versioning policy:

- **Patch bumps between releases** (no Changeset, no tag):
  - Patch when `crimes triage` + filter + resurface land in core.
  - Patch when detectors are wired with `effort` + `fix_shape`
    + `schema_version` bumps to `"0.2.0"`.
  - Patch when human renderer secondary-score reformatting lands.
  - Hook write logic in `init` typically lands without an eval shift
    (no finding output change), but if eval snapshots move (they
    shouldn't — init doesn't run during scan), patch-bump.
- **One Changeset at end of release** describing this as a **minor**
  bump (`0.10.x → 0.11.0`). Body explicitly calls out:
  - `schema_version` `"0.1.0"` → `"0.2.0"`.
  - JSON consumer migration: accept both old and new version strings;
    new fields are additive; existing fields unchanged.
  - New command: `crimes triage`.
  - New config key: `triage.resurfaceBase`.
  - New init behaviour: `.claude/settings.local.json` written by
    `--agents`; `--no-hooks` opts out.
  - Renderer numerics in human output are reformatted; JSON numerics
    are unchanged.

## 11. Coordination with Release A

Release A is **already merged at `crimes@0.10.0`**. The two contracts
Release B depends on are live:

- `ContextReport.clues` JSON shape (frozen contract, see
  `docs/releases/v0.10.0.md` §`clues` block on `crimes context --json`).
  Consumed by the PreToolUse hook (§5.7) and by the human renderer
  secondary-score formatter (§5.8).
- `scopeTiers.nonDomain` config key. Consumed by the triage interactive
  walk's default scope (domain-only) and by the resurface pipeline (a
  touched non-domain file's triaged finding still resurfaces — see §8).

No worktree coordination remaining; the parallel-development concern in
the brief was resolved when Release A landed.

## 12. Open questions

None at design time. Anything that emerges during planning gets
captured in the implementation plan and surfaced for review.
