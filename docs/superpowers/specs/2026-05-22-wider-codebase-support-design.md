# Wider codebase support — three-release design

> **Renumbering note (added 2026-07-31).** This document was written
> before the ranking work claimed `0.13.0`. The version numbers below
> are the *original* slots and are now off by one from what shipped:
> the universal pack was `0.12.0` as planned, but the **Python pack
> shipped as `0.14.0`** and **polyglot IA is `0.15.0`**.
> [`docs/roadmap.md`](../../roadmap.md) carries the accurate numbering.
> The spec is left otherwise unedited as the historical design record —
> see [`docs/releases/v0.14.0.md`](../../releases/v0.14.0.md) for what
> the Python pack actually shipped, including two scoring fixes and a
> parser-packaging decision this document did not anticipate.

**Status:** Draft, brainstormed 2026-05-22.
**Slots:** `crimes@0.12.0`, `crimes@0.13.0`, `crimes@0.14.0`.
**Schema bump:** `0.2.0` → `0.3.0` (lands once, in 0.12.0).
**Wedge unchanged:** local, open-source, agent-native codebase risk and
context. Deterministic before magical. Evidence before judgement.

## Problem

`crimes` only sees TypeScript and JavaScript today. The shipped
detectors live in `packages/core/src/detectors/` but most of them
depend on `ParsedFile` from `packages/language-js/`, so even
file-level detectors that are conceptually language-agnostic
(`large_file`, asset detectors, `hardcoded_localhost`) only fire on
files the JS pack claims. Running `crimes scan .` on a Python, Go,
or Rust repo today returns nothing useful — which reads as "the tool
is broken" rather than "no language pack installed."

The architecture was designed for multiple language packs from day
one (`PRD.md` §26 lists Python as deferred-not-rejected). The
detector boundaries are already roughly correct. What's missing is a
**pack** model that lets us ship "works on every codebase, honestly
calibrated to what we can see" without first writing a parser for
every language.

## Approach (three releases)

A three-release arc, scoped so each release is independently
shippable and the schema bump only happens once:

1. **0.12.0 — universal pack.** Extract a universal-pack detector
   pass that runs without parsing. Refactor `DetectorContext` into a
   discriminated union. Move file discovery to `core`. Bump schema
   `0.2.0` → `0.3.0` to add `Finding.pack` + `ScanReport.coverage`.
2. **0.13.0 — Python language pack.** First non-JS pack via
   tree-sitter-python. Port eight detectors. Proves the
   language-pack interface is real and reusable.
3. **0.14.0 — polyglot IA + monorepo coverage.** Three new
   cross-language detectors (`cross_language_concept_alias_drift`,
   `cross_language_route_drift`, `cross_language_type_drift`).
   Coverage block goes per-package in monorepos. This is the
   differentiator that no single-language tool can match.

**Naming.** This document uses **"pack"** for the universal /
language-js / language-py / cross-language axis. The existing
`Finding.tier` field already carries scope tier (`domain` /
`nonDomain`) from `scopeTiers.nonDomain` config, so the new axis
lives on a new field — `Finding.pack` — to avoid collision. The TS
type for the new field is `Pack`, defined alongside the existing
`Tier` type but distinct from it.

## Architecture

### Pack model

Each detector belongs to exactly one pack, declared at registration:

- **Universal pack.** Evidence is filename + bytes + git + IA
  index. No AST. Runs on every discovered file in every repo.
  Examples: `large_file`, `oversized_raster`,
  `finder_duplicate_filename`, `hardcoded_localhost`,
  `docs_code_drift`, `missing_agent_context`,
  `todo_density` (regex), `commented_out_code` (regex variant; the
  AST variant stays in the language-js pack).
- **Language packs** (`language-js`, `language-py`, …). Evidence
  requires AST parsing by a specific pack. Detector declares its
  required pack(s). Examples: `large_function`,
  `circular_dependency`, all date/time detectors, `sync_io_in_hotpath`.
  A Python `large_function` is a *different detector* from a JS
  `large_function` — same abstract `type`, but different parsers,
  fixtures, and detector ids (`large_function.js` vs `large_function.py`).
- **Cross-language pack** (lands in 0.14.0). Evidence requires
  aligning artifacts from two or more language packs. Examples:
  `cross_language_concept_alias_drift`,
  `cross_language_route_drift`, `cross_language_type_drift`.

**Packs describe capability, not quality.** A universal-pack
`large_file` finding has the same confidence as it would if a parser
were available. What you give up by going universal-only is *missing
detectors* (no AST → no `large_function`), not less-trustworthy
detectors.

### DetectorContext discriminated union

Today's `DetectorContext` carries `ParsedFile[]` from `language-js`.
Replace with a tagged union; the registry only feeds each detector
the matching kind:

```ts
type DetectorContext =
  | { kind: "universal";
      files: UniversalFile[]; git: GitContext; ia: IaIndex; config: CrimesConfig }
  | { kind: "language-js";
      files: ParsedFile[]; git: GitContext; ia: IaIndex; config: CrimesConfig; imports: ImportGraph }
  | { kind: "language-py";          // 0.13.0
      files: ParsedPyFile[]; git: GitContext; ia: IaIndex; config: CrimesConfig; imports: PyImportGraph }
  | { kind: "cross-language";       // 0.14.0
      packs: Record<PackId, LanguageContext>;
      git: GitContext; ia: IaIndex; config: CrimesConfig };
```

Asset detectors fold into the universal pack — the existing
`AssetDetectorContext` becomes a specialised `UniversalFile` whose
`read()` is lazy and per-file cached, preserving the 0.8.0 asset
pipeline behaviour.

### File discovery moves to `core`

`packages/language-js/src/file-discovery.ts` is universal logic that
happens to live in the JS pack for historical reasons. Move it to
`packages/core/src/discovery/`. Language packs *register* extensions
they claim:

- JS pack: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.cts`, `.mts`
- Python pack (0.13.0): `.py`, `.pyi`

The universal pack runs on every discovered file; language packs only
run on their claimed subset. Discovery respects `.gitignore`, project
`exclude` patterns, and universal-pack asset patterns
(`**/*.{png,jpg,...}`) as today.

### Python pack uses tree-sitter-python

Decision: `tree-sitter` + `tree-sitter-python` as npm deps.
Rationale:

- **No Python runtime required at install/scan time.** Subprocess to
  system `python -m ast` would push the adoption barrier onto every
  user, including ones whose only Python is a venv they don't want
  `crimes` to see.
- **Single build artifact.** tree-sitter-python ships prebuilt
  native bindings for Linux/macOS/Windows; the WASM build is a
  fallback. CI matrix coverage is straightforward.
- **Byte-position-stable.** Fingerprints in tree-sitter are derived
  from start/end byte ranges that survive whitespace re-rendering as
  cleanly as the JS pack's TypeScript-ESTree positions do.

Rejected alternatives: Pyodide (way too heavy for a CLI dep);
custom hand-rolled Python parser (decade-long maintenance trap).

## Release breakdown

### `crimes@0.12.0` — universal pack

**Goal:** "Works on any repo, honest about what's covered."

**Changes:**

- **Pack model lands.** `DetectorContext` becomes the discriminated
  union above. Detector registry routes by `pack` + `context_kind`.
- **File discovery moves to `core`.** Language packs register
  claimed extensions. No behaviour change for JS users — the same
  files get parsed and the same detectors fire.
- **Detector inventory split.** No detectors are removed or
  re-implemented; only re-categorised:
  - **Promoted to universal:** `large_file`, `oversized_raster`,
    `raster_should_be_vector`, `svg_with_embedded_raster`,
    `finder_duplicate_filename`, `hardcoded_local_path`,
    `hardcoded_localhost`, `docs_code_drift`,
    `missing_agent_context`, `todo_density`,
    `commented_out_code` (regex variant for non-JS files; the
    existing AST variant stays in `language-js`).
  - **Universal repo signals:** `crimes hotspots` works on any
    repo. Churn-based ranking has no AST dependency.
  - **Stay in `language-js`:** every other detector, unchanged.
- **Schema bump `0.2.0` → `0.3.0`.** See "Schema changes" below.
- **Coverage banner in human output** when >50% of discovered files
  are universal-only (no language pack claimed them). Single line
  above the file-grouped scan output, e.g.:
  ```
  coverage: 412 files, 18% covered by language packs (js).
            Run with --explain-coverage for the breakdown.
  ```
  JSON output is silent — the `coverage` block in `ScanReport`
  carries the same data.
- **`crimes context <file>` accepts any extension.** Returns
  universal-pack findings + git/IA context, even when no language
  pack claims the file. When no findings apply, `agent_guidance`
  surfaces a one-liner explaining the coverage gap rather than
  going blank.
- **`crimes scan --explain-coverage`** prints the per-language file
  breakdown + which extensions belong to which pack + which packs
  are loaded.
- **`crimes init` adds a `coverage` callout** in the generated
  config and `AGENTS.md` so agents know to weight universal-pack
  findings appropriately on unsupported-language files.
- **Docs.** New `docs/packs.md`; every page under
  `docs/finding-types/` annotated with the detector's pack; landing
  page gets a "Works on every codebase" panel calibrated to honest
  universal-pack claims (no "47 detectors!" copy on a Rust-only
  repo).

**One-time on-disk migration:** the detector-id rename
(`large_function` → `large_function.js`) must not invalidate
existing baselines, suppressions, triage entries, or feedback
records. Mitigation: the canonical **fingerprint** formula stays
`<type>::<file>::<symbol>` and continues to use the **abstract**
`type`, not the qualified `detector_id`. Existing fingerprints are
untouched. The 0.12.0 first-run logs a one-line note when it
detects pre-0.12 on-disk artefacts that lack the new fields — but
they continue to work as-is.

### `crimes@0.13.0` — Python language pack

**Goal:** Prove the language-pack interface is real and reusable.

**Changes:**

- **New package** `packages/language-py/` mirroring `language-js`:
  `parse/`, file-discovery extension claim, `index.ts` exporting
  `ParsedPyFile` + a pack-registration function. Uses
  `tree-sitter` + `tree-sitter-python`.
- **Initial Python detector slate (8):**
  1. `large_function.py` — function-level line/branch thresholds
     mirroring the JS shape policy (test fixtures, FastAPI route
     handlers, Django views, CLI Click/Typer commands have
     per-shape thresholds).
  2. `direct_date.py` — `datetime.datetime.now()` /
     `datetime.now()` without `tz=` argument; analogous to the JS
     `direct_date` charge.
  3. `sync_io_in_hotpath.py` — `open()`, `requests.get`,
     `urllib.request.urlopen`, `subprocess.run` inside FastAPI
     route handlers, Django views, Flask routes, or domain
     functions.
  4. `circular_dependency.py` — Python module import graph.
  5. `deep_import.py` — `from a.b.c.d import …` past a configurable
     depth.
  6. `weak_test_signal.py` — `pytest` / `unittest` test files with
     too few assertions, single-test files for large modules.
  7. `mixed_utc_local_methods.py` — `.utcnow()` and `.now()` used
     on the same module's surface, mirroring the JS family.
  8. `boolean_naming_drift.py` — Python booleans whose names lack
     the `is_`/`has_`/`should_` prefix convention, with an
     allowlist mirroring the JS-side React-state allowlist for
     idiomatic Python state names.
  Goal is eight detectors that **prove the seam**, not catalogue
  parity. Future Python detectors can land additively across
  patch releases without their own minor bump.
- **Per-language detector ids.** `Finding.type` carries the
  abstract id (`large_function`); `Finding.detector_id` carries
  the qualified form (`large_function.js`, `large_function.py`).
  Cross-language grouping uses `type`.
- **Eval harness:** 6 new Python scenarios across all five scenario
  kinds (refactor / bugfix / review / context / plan). 2 new Python
  fixtures under `evals/fixtures/`.
- **Coverage block becomes meaningful:** a mixed-language repo now
  shows `files_by_language: { js: 412, py: 138 }`.
- **`crimes init --agents`** updated to mention Python coverage in
  the generated agent skills.
- **Schema unchanged** — `pack` and `coverage` were already shipped
  in 0.12.0. New `Finding.pack: "language-py"` values land
  additively.

### `crimes@0.14.0` — polyglot IA + monorepo coverage

**Goal:** Cross-language findings that no single-language tool can
produce. This is the differentiator.

**Changes:**

- **Three cross-language detectors:**
  - **`cross_language_concept_alias_drift`** — extends 0.3.0's
    `concept_alias_drift` to consider Python symbol names +
    docstrings alongside JS identifiers. Same evidence model
    (≥3 disagreeing sources, ≥2 distinct directories), broader
    source pool. Fires when `team` / `workspace` / `organisation`
    appear inconsistently across `users.py`, `team_service.py`,
    `WorkspaceProvider.tsx`, etc.
  - **`cross_language_route_drift`** — FastAPI / Django / Flask
    route declarations on the Python side, matched against TS
    fetch sites + nav labels on the JS side. Fires when
    `@app.get("/api/users")` in `routes/users.py` is labelled
    `team` in the frontend nav array. Evidence cap 8.
  - **`cross_language_type_drift`** — Python `Plan` enum or
    Pydantic class referenced as a closed set of string literals
    on the TS side, where the string set diverges from the
    canonical type's members. Symmetric: same detector fires on
    TS-defined types referenced as strings in Python.
- **Monorepo-aware coverage.** When `packages/*/package.json` or
  `packages/*/pyproject.toml` are present, `ScanReport.coverage`
  gains an optional `by_package` array:
  ```ts
  coverage: {
    files_total, files_by_language, files_universal_only,
    files_skipped, packs_loaded,
    by_package?: Array<{
      path: string;                              // "packages/api-py"
      files_total: number;
      files_by_language: Record<string, number>;
      dominant_language: string | null;
    }>;
  }
  ```
  Scan output groups findings by package, then by file (matches the
  0.10.0 file-grouped layout).
- **Cross-language context kind.** `DetectorContext` gains
  `{ kind: "cross-language"; packs: Record<PackId, LanguageContext>; ... }`.
  Cross-language detectors run after per-language passes complete;
  they receive every loaded pack's parsed output.
- **`crimes ignore` works on cross-language fingerprints.** Already
  fingerprint-based, so this is verification-only. The fingerprint
  for a cross-language finding uses
  `<type>::<canonical-source-file>::<symbol>`; `related_files`
  carries the cross-language evidence.
- **Eval harness:** 4 polyglot scenarios across at least 3 scenario
  kinds. New polyglot fixture under `evals/fixtures/`.
- **Schema additions (all additive):** `Finding.pack: "cross-language"`,
  `ScanReport.coverage.by_package`. No `schema_version` bump.

## Schema changes (land once, in 0.12.0)

Bump `schema_version: "0.2.0"` → `"0.3.0"`.

```ts
type Pack = "universal" | "language-js" | "language-py" | "cross-language";

type Finding = {
  // ...existing fields unchanged, including `tier?: Tier` (scope tier)
  pack: Pack;                   // NEW, required
  detector_id: string;          // NEW, required. e.g. "large_function.js"
  type: string;                 // unchanged. Abstract, e.g. "large_function"
};

type ScanReport = {
  // ...existing fields unchanged
  coverage?: {                  // NEW, optional
    files_total: number;
    files_by_language: Record<string, number>;
    files_universal_only: number;
    // `files_skipped` was specified here but cut before 0.12.0 shipped:
    // computing it faithfully ("files excluded by config or default
    // rules") means globbing without the ignore list, i.e. walking
    // node_modules on every scan. It was never implemented — the field
    // was hardcoded to 0. Do not reintroduce it without a cheap source.
    packs_loaded: string[];     // always led by "universal"
    by_package?: Array<{        // 0.14.0
      path: string;
      files_total: number;
      files_by_language: Record<string, number>;
      dominant_language: string | null;
    }>;
  };
};
```

`Finding.type` semantics are unchanged. Consumers that grouped by
`type` continue to work — the qualified form lives in the new
`detector_id` field and is purely informational for users that need
to disambiguate "JS large_function" from "Python large_function".
`Finding.tier` (existing scope-tier field) is untouched.

Consumers that hard-pinned `schema_version === "0.2.0"` must accept
`"0.3.0"`. The schema bump is documented in `docs/json-schema.md`
and the 0.12.0 release notes.

## UX details

- **Coverage banner** triggers when >50% of discovered files have
  no pack claim. One line, above the file-grouped scan output.
  Suppressed in JSON output and when `--no-color` is set.
- **`crimes scan --explain-coverage`** new flag — prints
  per-language breakdown, extension-to-pack map, loaded packs.
- **`crimes context <unsupported.rs>`** — universal-pack findings +
  git/IA context, with `agent_guidance_reason: "no language pack
  claims .rs files; install or wait for one."` No error, no
  exit-2.
- **`crimes scan` on a Rust-only repo** — prints universal-pack
  findings + banner. Does **not** print "no crimes detected" (which
  today reads as a clean bill of health on what is in fact an
  unparsed repo).
- **`crimes init`** — generated `crimes.config.json` gains a
  commented `coverage` section explaining pack semantics. The
  generated `AGENTS.md` mentions that universal-pack findings on
  unsupported-language files have full confidence on the things
  they can see and are silent on the things they can't.

## Risks & mitigations

- **Fingerprint stability across the schema bump.** The detector-id
  rename must not invalidate `.crimes/baseline.json`,
  `.crimes/suppressions.json`, `.crimes/triage.json`, or feedback
  records. **Mitigation:** the canonical fingerprint formula stays
  `<type>::<file>::<symbol>` and continues to use the abstract
  `type`. Existing fingerprints are untouched. First-run logs a
  one-line note when pre-0.12 artefacts are detected; they continue
  to work without migration.
- **Naming overlap with the existing `Finding.tier` field.** The
  existing `tier?: Tier` is scope tier (`domain` / `nonDomain`); the
  new pack axis lives on `Finding.pack`. **Mitigation:** the new
  TypeScript type is named `Pack`, the field is named `pack`, and
  no `Tier`/`tier` symbol is touched. Documented in the schema
  section.
- **tree-sitter native binary install on CI.** **Mitigation:**
  pin `tree-sitter` + `tree-sitter-python` versions; CI matrix
  covers Linux/macOS/Windows in 0.13.0; WASM fallback documented in
  `docs/troubleshooting.md`.
- **"Universal-only" findings feel thin and damage the brand.**
  Real risk. **Mitigation:** the coverage banner names exactly
  what's missing ("install a Python pack for full coverage") so
  thinness is legible and provisional, not a verdict on the tool.
  Landing-page copy explicitly says "works on every codebase" only
  in the context of the coverage model — never as an unqualified
  claim.
- **Cross-language IA false-positive blast radius.**
  Cross-language detectors have 2× the source surface for false
  matches. **Mitigation:** 0.14.0 detectors require ≥3 disagreeing
  sources just like the 0.3.0 IA family. Polyglot eval scenarios
  land before the release.
- **Eval baseline noise.** Adding Python scenarios moves the
  structural pass rate. **Mitigation:** follow the existing eval
  baseline policy (patch bumps for calibration changes, fresh
  baseline directory per minor). 0.13.0 and 0.14.0 each get
  `evals/results/0.13.0/` and `evals/results/0.14.0/`.
- **Three-release scope discipline.** It will be tempting to slip
  Go or Rust into this arc. **Mitigation:** explicit "out of
  scope" list below; new packs after Python land as their own
  minor releases on the same template.

## Explicitly out of scope

- **Other language packs in this arc.** No Go, Rust, Java, Ruby,
  PHP, C#, Elixir, etc. Each is its own future minor release,
  modelled on the 0.13.0 Python pack.
- **Cross-language *import graph*.** Detecting that a TS
  `fetch("/api/users")` lines up with a FastAPI
  `@app.get("/api/users")` route requires real cross-language
  symbol resolution and is its own subtree — deferred to 0.15.0+.
- **LLM-assisted modes.** `PRD.md` §26 `crimes ask` stays
  deferred. Nothing in this arc requires an LLM.
- **`crimes` becoming a multi-language linter.** The wedge stays
  change-risk + agent-risk. We do **not** add `unused_import.py`,
  PEP-8 rules, or anything that overlaps Ruff / Pylint / mypy on
  the Python side, or any equivalent on future packs.
- **Homebrew tap and standalone binaries (M6).** Independent track,
  unaffected by this arc.

## Success criteria

- **0.12.0:** `crimes scan` on `examples/messy-ts-app` produces
  byte-identical output to 0.11.1 modulo the new `pack` and
  `coverage` fields. `crimes scan` on any Python-only, Rust-only,
  or Go-only fixture produces at least the `large_file` +
  git-derived hotspot signals plus a coverage banner. Self-scan
  stays clean. Smoke test passes on every workspace package.
- **0.13.0:** Each of the 8 Python detectors fires on a
  hand-written fixture under `evals/fixtures/`. Eval suite passes
  on at least one Python scenario per scenario kind. `crimes
  hotspots`, `crimes diff`, `crimes verdict`, `crimes baseline
  check` all work on a Python-only repo.
- **0.14.0:** Each of the 3 cross-language detectors fires on a
  hand-written polyglot fixture under `evals/fixtures/`. Coverage
  block's `by_package` populates correctly on the
  crimes monorepo. Polyglot scenarios pass on at least claude in
  the eval harness.

## Next steps

After this design is approved, hand off to `writing-plans` to
produce implementation plans for **0.12.0 first** (universal pack).
0.13.0 and 0.14.0 get their own plans after 0.12.0 ships — the
language-pack interface details depend on what falls out of the
0.12.0 refactor.
