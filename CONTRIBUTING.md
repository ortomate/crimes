# Contributing to crimes

Thanks for considering a contribution! `crimes` is intentionally small at the moment, so the bar for "useful contribution" is low.

## The most useful contribution isn't code

Detector thresholds are calibrated against real repos, and the project
has far more detectors than it has evidence about how they behave
outside this one. **Reporting a false positive is worth more than a PR.**

`crimes` already records these locally:

```bash
crimes feedback <fingerprint> --verdict fp --note "why this isn't real"
crimes feedback export --format md      # paste into an issue
```

The `fp` verdict also silences the finding locally and resurfaces it for
re-confirmation on the next minor bump, so you get the fix immediately
whether or not anyone acts on the issue. See
[`docs/feedback.md`](./docs/feedback.md).

There are issue templates for [false
positives](https://github.com/ortomate/crimes/issues/new?template=false-positive.yml)
and [missed
findings](https://github.com/ortomate/crimes/issues/new?template=missed-finding.yml).

## Quick setup

Use the Node version in `.nvmrc`, pnpm 10.14.0 and Python 3.10+. Python runs
the behavioral evaluation oracles and harness-method tests during workspace
verification; the published CLI itself needs only Node >=18.

```bash
git clone https://github.com/ortomate/crimes.git
cd crimes
pnpm install
pnpm build
pnpm test
```

If `pnpm scan:example` produces a "CRIME SCENE REPORT" with a handful of findings, you have a working dev environment.

## Project shape

This is a **pnpm workspace monorepo**:

| Package                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `packages/cli`         | The `crimes` binary (Commander)                                 |
| `packages/core`        | Detector contract, finding schema, scan orchestration           |
| `packages/language-js` | TS/JS file discovery and AST parsing                            |
| `packages/reporter`    | Human-readable and JSON output formatters                       |
| `apps/website`         | `crimes.sh` — Astro + Starlight, auto-deploys from `main`        |
| `examples/messy-ts-app`| Intentionally crime-ridden fixture used by smoke tests          |
| `evals/`               | Fixture × scenario × agent harness; see `evals/README.md`        |

## Adding a new detector

1. Create `packages/core/src/detectors/your-detector.ts`. Export a `Detector`:

   ```ts
   import type { Detector } from "../detector.js";
   import type { PreFinding } from "../finding.js";

   export const yourDetector: Detector = {
     id: "your_detector",
     name: "Your Detector",
     description: "What it finds, in one sentence.",
     // Required. "universal" runs on every file and gets source text
     // plus line counts; "language-js" additionally gets a parsed AST.
     pack: "language-js",
     run(ctx) {
       const findings: PreFinding[] = [];
       // inspect ctx.source / ctx.parsed / ctx.config
       return findings;
     },
   };
   ```

   `Detector` is a discriminated union on `pack`, so declaring
   `pack: "universal"` and then reaching for `ctx.parsed` is a type
   error rather than a runtime surprise. Detectors return `PreFinding[]`;
   ids, scores, and the qualified `detector_id` are filled in during
   finalisation.

2. Export it from `packages/core/src/index.ts` **and** add it to `builtInDetectors` in `packages/core/src/scan.ts`.

3. Add a Vitest unit test next to your detector file (`your-detector.test.ts`).

4. If the example fixture doesn't already trigger your detector, add a small file under `examples/messy-ts-app/src/` that does.

Detector design rules:

- Findings must include concrete **evidence** strings — facts a reader can verify.
- `confidence` is honest: don't claim 1.0 unless you literally cannot be wrong.
- No I/O. Detectors run against `ctx.source` and `ctx.parsed`.
- Keep heuristics conservative. A noisy detector is a disabled detector.

## Adding a new language

The registry exists as of 0.12.0 — you don't wire packs into `scan.ts`
by hand any more. `packages/language-py` (0.14.0) is the worked example
to copy; read it alongside this section.

1. **Create `packages/language-<lang>`** alongside `language-js`. It
   exports a `<LANG>_EXTENSIONS` constant, a `parse<Lang>File` function,
   and the parsed-file type its detectors read. It must not depend on
   `@crimes/core` — core depends on it.

2. **Register the claim.** `packages/core/src/discovery/language-pack-router.ts`
   seeds the router from each pack's own exported extension list:

   ```ts
   packExtensions.set("language-py", new Set<string>(PY_EXTENSIONS));
   ```

   The list lives in the pack, so there is still one source of truth per
   language; core only does the seeding, because `registerPackExtensions`
   lives in core and a pack calling it would be a dependency cycle.
   `LanguagePackRouter` then routes files to the claiming pack and
   `ScanReport.coverage` picks it up automatically — no second list.

   Keep the import cheap. Core loads every pack's module eagerly just to
   read its extensions, so anything expensive (a WASM runtime, a parser
   binary) belongs behind a lazy/dynamic import. Otherwise a repo with
   none of that language pays for the pack existing.

3. **Add a context variant.** `LanguagePyDetectorContext` in
   `packages/core/src/detector.ts`, a branch on the `Detector` union, a
   `grouped["language-<lang>"]` bucket in `groupDetectorsByPack`, and a
   routing block in `scan-detect.ts`.

   Only carry indexes the language actually has. The Python context
   deliberately omits `jsxShapeIndex` and `functionHashIndex` — adding
   fields "for symmetry" is how a pack seam quietly becomes
   JS-shaped.

4. **Qualify your detector ids** (`large_function.py`) while emitting
   the abstract `Finding.type` (`large_function`). The qualified id
   keeps the detector separately addressable in `detectors.enable` /
   `disable` and avoids a registry collision with the JS detector of
   the same name; the abstract type keeps cross-language grouping,
   fingerprints, baselines and suppressions working. See
   [`docs/packs.md`](./docs/packs.md#detector-ids-vs-finding-types).

5. **Set `scores.agent_risk` on every finding**, scaled to the evidence
   found. Since 0.13.0 it is 0.40 of the unified formula, and detectors
   that omit it fall back to a deliberately-compressed severity-derived
   default. A detector without an opinion ranks below one with an
   opinion — which is the intended behaviour, so don't be the former.

6. **Check `test_gap` understands the language's test convention.**
   `testBaseCovers` in `packages/core/src/scoring/build.ts` pairs a
   test file to the file it covers. Python needed a *prefix* rule
   (`test_billing.py`) where every other supported language uses a
   suffix; getting this wrong scores every file in the language at
   `test_gap: 1.0` and silently over-ranks the whole pack.

7. **Check whether the import graph needs the language.**
   `blast_radius` is derived purely from it, and it is 0.20 of
   `agent_risk`. `packages/core/src/imports/python.ts` shows the shape:
   resolution logic lives in the pack, and core merges the resulting
   edges into the one shared `ImportGraph`.

File discovery itself is universal-pack infrastructure and lives in
`packages/core/src/discovery/`; language packs supply parsing, not
walking.

## Running checks locally

```bash
pnpm format      # biome format --write .  (rewrites files)
pnpm format:check # biome format .         (read-only, what CI runs)
pnpm lint        # biome lint .
pnpm lint:fix    # biome lint --write .
pnpm check       # format + lint + assists in one pass
pnpm check:fix   # ...and apply what it can

pnpm typecheck   # tsc --noEmit everywhere
pnpm test        # Vitest + Python outcome oracle and method checks
pnpm build       # tsup everywhere

pnpm verify      # read-only format/lint, build, docs drift, types and tests
```

Note it is `pnpm verify`, not `pnpm ci`: pnpm reserves `ci` as a
built-in, so that form fails before reaching the workspace script.

CI uses the Node version in `.nvmrc`, matching release development. It also
builds/verifies the documentation site and tests a freshly packed npm
artifact. Live agent trials are explicit opt-in and never run in CI.

## Formatting and linting

**Biome is the only formatter and the only linter.** Do not add ESLint,
Prettier, or a second formatter alongside it. Config lives in
[`biome.jsonc`](./biome.jsonc), which is commented throughout.

Two things about it are worth knowing before you change it.

**Fixtures are never formatted.** `examples/`, `evals/fixtures/`,
`docs/fixtures/`, and `evals/results/` are excluded in
`files.includes`. Those directories are *scanner input* — their
formatting is the test data. Reformatting them would silently change
what the detectors report and invalidate the pinned expected outputs.

**`lineWidth` is a measurement decision, not a taste one.** It is 90,
matching how the tree was already hand-wrapped (p98 line length 86).
`large_function` and `large_file` are line-count thresholds and
duplicate detection gates on an 8-line span, so re-wrapping the repo
changes what `crimes` reports about itself. Dropping to Biome's default
80 moves the self-scan by +18 findings and +5 high. If you change this
number, re-run the self-scan and say what moved.

Three rules are turned off, each with the reasoning recorded inline in
`biome.jsonc`: `style/noNonNullAssertion` (the codebase runs
`noUncheckedIndexedAccess`, which makes `arr[0]!` the compiler-mandated
idiom, 1033 times), `style/useTemplate` (fires almost entirely on
`expr + "\n"`, where the autofix is worse than the input), and the
linter as a whole on `apps/website/landing/index.html` (90 real a11y
findings deferred pending a markup + CSS change — see below).

Prefer a targeted `// biome-ignore lint/<rule>: <reason>` over widening
a config disable. The directive must be on the line *immediately* above
the offending line, and the whole reason must fit on that one line — a
wrapped `//` block silently stops suppressing, though Biome will tell
you via `suppressions/unused`.

### Before you tune a detector because it looks noisy

Read [`docs/calibration-followups.md`](./docs/calibration-followups.md)
first. It records the calibration questions that have already been
examined and the reasoning behind every entry in
`.crimes/suppressions.json` and `.crimes/triage.json` — including which
detector-widening changes were deliberately *rejected*, and why. A
"no change" decision there is a decision, not an oversight.

### Known lint debt

`apps/website/landing/index.html` builds two comparison tables from
`<div role="table">` / `<span role="cell">`. `a11y/useSemanticElements`
and `a11y/useFocusableInteractive` are right to flag them. The fix is
real `<table>` markup, which is not a lint fix: `.detector-table` is
`display: grid` with `grid-template-columns` on `.row`, and a real
table gets an auto-inserted `<tbody>` between the grid container and
its rows. It needs CSS work and a browser check. The override in
`biome.jsonc` is scoped to that single file; delete it with the fix.

## Commit style

Prefix commits with the affected area when it's obvious:

```
core: add deep-nesting detector
cli: add --no-color flag
language-js: improve arrow-function name inference
```

Not required, just helpful.

## License

By contributing, you agree your contribution is released under the [MIT License](./LICENSE).
