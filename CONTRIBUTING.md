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
by hand any more.

Create `packages/language-<lang>` alongside `language-js`, then call
`registerPackExtensions("language-<lang>", [".ext", ...])` at module
load. `LanguagePackRouter` routes files to the claiming pack, and
`ScanReport.coverage` picks the pack up automatically — there is no
second list to update.

File discovery itself is universal-pack infrastructure and lives in
`packages/core/src/discovery/`; language packs supply parsing, not
walking.

## Running checks locally

```bash
pnpm typecheck   # tsc --noEmit everywhere
pnpm test        # vitest run everywhere
pnpm build       # tsup everywhere

pnpm verify      # all three, sequentially — the gate CI enforces
```

Note it is `pnpm verify`, not `pnpm ci`: pnpm reserves `ci` as a
built-in, so that form fails before reaching the workspace script.

CI runs the same on Node 20 and Node 22.

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
