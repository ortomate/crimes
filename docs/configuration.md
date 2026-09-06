# `crimes.config.json` reference

Zero-config works for most repos. Use `crimes.config.json` only when the
defaults are wrong for your repo — tuning thresholds, disabling
detectors that don't apply, seeding product-specific concept aliases.

The config lives at the repo root as `crimes.config.json`. The
`.crimes/` directory next to it is a tooling output directory
(baseline, suppressions, cache); the config is hand-edited.

## Bootstrap

```bash
npx crimes init
```

Writes a starter `crimes.config.json` with sensible defaults and an
inline `$schema` URL for IDE validation. Refuses to overwrite an
existing file unless you pass `--force`.

To also make `crimes` discoverable to future Claude Code and Codex
sessions in the repo:

```bash
npx crimes init --agents
```

That writes `.claude/skills/crimes/SKILL.md` and
`.agents/skills/crimes/SKILL.md` alongside the config.

## Shape

```jsonc
{
  "$schema": "https://crimes.sh/schema/0.1.0/config.json",

  "include": ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
  "exclude": [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/out/**",
    "**/coverage/**",
    "**/*.min.js",
    "**/*.generated.*",
    "**/.crimes/**"
  ],

  "thresholds": {
    "largeFileLines": 300,
    "largeFunctionLines": 60,
    "todoDensityPerKLoc": 10,
    "largeFunction": {
      "domain": 60,
      "route_handler": 100,
      "react_component": 200,
      "page_export": 200,
      "test_callback": 200,
      "cli_command_registrar": 200,
      "unknown": 80
    },
    "largeFile": {
      "domain": 300,
      "test_file": 1500,
      "docs": 1000
    }
  },

  "detectors": {
    "enable": [],
    "disable": []
  },

  "scopeTiers": {
    "nonDomain": [
      "scripts/**",
      "examples/**",
      "fixtures/**",
      "public/**",
      "**/__tests__/**",
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}"
    ]
  },

  "scan": {
    "topFiles": 5
  },

  "triage": {
    "resurfaceBase": "main"
  },

  "ia": {
    "aliasGroups": []
  },

  "suppressions": {
    "path": ".crimes/suppressions.json"
  },

  "architecture": {
    "layers": [],
    "rules": []
  }
}
```

Every key is optional. Missing keys take the defaults documented in
`packages/core/src/config.ts`.

## Field reference

### `$schema`

Optional URL pointing at the JSON schema. Parsed but not consumed by
the CLI — there only for IDE validation.

### `include` / `exclude`

Glob patterns the file walker honours. The included paths must match
**and** the excluded patterns must not match. Identical defaults to
`crimes init`.

### `thresholds.largeFileLines` / `largeFunctionLines` / `todoDensityPerKLoc`

The original three knobs. `largeFunctionLines` is the **domain**
function threshold; it stays the back-compat alias for the per-shape
override below.

### `thresholds.largeFunction.<shape>`

Per-shape `large_function` overrides. Any subset is fine — unset shapes
use the built-in defaults:

| Shape                   | Default threshold |
| ----------------------- | ----------------- |
| `domain`                | 60                |
| `route_handler`         | 100               |
| `react_component`       | 200               |
| `page_export`           | 200               |
| `test_callback`         | 200               |
| `cli_command_registrar` | 200               |
| `unknown`               | 80                |

The `cli_command_registrar` shape (new in 0.6.0) covers Commander-
style `register*Command(program)` wrapper functions and their
anonymous `.action(...)` callbacks. The chain is declarative DSL,
not branching logic, so the threshold is generous and severity caps
at `low` / `medium`.

`thresholds.largeFunction.domain` wins over the legacy
`thresholds.largeFunctionLines` when both are set.

### `thresholds.largeFile.<shape>`

Per-shape `large_file` overrides (new in 0.6.0). Any subset is fine
— unset shapes use the built-in defaults:

| Shape       | Default threshold |
| ----------- | ----------------- |
| `domain`    | 300               |
| `test_file` | 1500              |
| `docs`      | 1000              |

The `test_file` shape matches `**/*.{test,spec}.[jt]sx?` and files
under `__tests__/`. Test suites legitimately grow large with many
small `it()` blocks, so the budget is much higher and severity caps
at `low` / `medium`.

The `docs` shape (new in 0.17.0) matches `.md`, `.mdx`, `.markdown`,
`.rst`, `.adoc`, `.asciidoc`, and `.txt`. Reference documentation is
supposed to be long, so measuring prose against the domain-code budget
produced findings nobody could act on. Severity caps at `low` /
`medium`, same as `test_file`. Data formats — `.json`, `.yaml`, `.csv`
— are deliberately *not* docs: a 3000-line config file is still a
finding worth having.

`thresholds.largeFile.domain` wins over the legacy
`thresholds.largeFileLines` when both are set.

### `thresholds.assetWeight`

Severity thresholds for `oversized_raster` (new in 0.8.0). Sizes
are in KB (1 KB = 1024 bytes); any subset is fine — unset levels
use the built-in defaults:

| Knob       | Default |
| ---------- | ------- |
| `lowKb`    | 200     |
| `mediumKb` | 500     |
| `highKb`   | 1000    |

The severity rule: bytes below `lowKb` produce no finding;
`[lowKb, mediumKb)` is `low`; `[mediumKb, highKb)` is `medium`;
≥ `highKb` is `high`. Defaults mirror Core Web Vitals "good /
needs improvement / poor" guidance for content images.

### `assets.include` / `assets.exclude`

Asset-file discovery overrides for the second-pass detectors
(`oversized_raster`, `raster_should_be_vector`,
`svg_with_embedded_raster`). Independent of the top-level
`include` / `exclude` so users can tune asset scope without
touching source scope. Defaults:

```jsonc
{
  "assets": {
    "include": ["**/*.{png,jpg,jpeg,gif,webp,avif,svg}"],
    "exclude": [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/out/**",
      "**/coverage/**",
      "**/.crimes/**",
      "**/public/vendor/**",
      "**/__snapshots__/**",
      "**/fixtures/**",
      "**/*.test.{png,jpg,jpeg,gif,webp,avif,svg}"
    ]
  }
}
```

Setting `assets.include` to an empty list disables the asset pass
entirely.

### `detectors.enable` / `detectors.disable`

- `enable` is an allowlist **over the detectors that run by default**.
  Empty or omitted means "run all of them". When it names one or more
  default-on detectors, only those run.
- `disable` is a blocklist that runs **after** `enable`.

#### Default-off detectors

A few detectors ship gated: they exist, they are supported, and they do
not run unless you ask for them by name. They are listed in JSON
`coverage.detectors_default_off` and human `--explain-coverage`, without a
repeated stderr notice. This is intentional scope, not incomplete analysis.

| id | why it is gated |
|---|---|
| `boolean_naming_drift`, `boolean_naming_drift.py` | Naming conventions belong in an explicit naming review. |
| `accessible_interaction_risk` | Useful in an accessibility review; outside default change-risk triage. |
| `design_token_escape` | Raw style concentration does not establish design-system drift; optional UI review. |
| `parallel_destination` | 2,819 findings from 134 files on n8n's `editor-ui` — 52.8% of that package's entire report — and zero findings on every other repo in the corpus. |

Naming a gated detector in `enable` is **additive**: it switches that
detector on and leaves everything else alone.

```jsonc
{
  // Everything that normally runs, plus parallel_destination.
  "detectors": { "enable": ["parallel_destination"] }
}
```

Mixing the two kinds does what it looks like — the default-on ids form
the allowlist, and the gated id is added to it:

```jsonc
{
  // Exactly two detectors run.
  "detectors": { "enable": ["large_function", "parallel_destination"] }
}
```

`disable` still wins over an explicit `enable`, so a gated detector
named in both does not run.

> This split exists because `enable` used to be a pure allowlist, which
> made the CLI's own advice destructive: following the `Enable with …`
> hint verbatim turned off all 68 other detectors and the asset pass,
> with no warning. On the `05-stress-ia-drift` fixture that took a scan
> from 13 findings to 1.
- An unknown detector id in either list raises a CLI error (exit `2`)
  — typos should not silently no-op. See the table in
  [generated reference](./reference.md#detectors) for the full list of ids.

#### Disabling one claim

Eleven detectors make more than one **claim** — statements with their
own truth values and their own fixes. `weak_test_signal` says both
"this test contains no expect/assert calls" and "this test only uses
weak assertion matchers". Both entries accept `<id>/<claim>` so you can
silence the one that is wrong for your repo without silencing the one
that is right:

```jsonc
{
  "detectors": {
    // Our tests assert through same-file helpers, which this claim
    // cannot follow. The weak-matcher claim is still worth hearing.
    "disable": ["weak_test_signal/no_assertions"]
  }
}
```

The detector still runs — only the named claim is dropped from the
findings. The bare id keeps its old meaning and disables the whole
detector.

A few detectors state a **conjunction** about one subject and carry a
composite claim like `type_disagreement+undocumented`. Selectors match
by atom, so `config_drift/client_exposed_secret` drops that finding too:
asking not to hear about client-exposed secrets means it whether or not
the variable has other problems as well.

A misspelled claim is rejected at config load, and the error names the
claims that detector declares. The full list is in
[`json-schema.md`](./json-schema.md#claim).

**Anti-pattern:** disabling a whole detector is a blunt tool, and
disabling a whole *multi-claim* detector is bluntest of all — it is how
one repo silenced 67 correct findings after checking three that were
not. Prefer a claim selector over an id, and a `crimes ignore` with a
reason over either. Reserve a bare `disable` for detectors that
fundamentally don't fit your repo (`todo_density` on a research
codebase where TODO is a tracking convention, not debt).

### `detectors.options`

Per-detector exemption values. Sits between `detectors.disable`
(kills the detector everywhere) and `crimes ignore` (kills one
specific finding) — `detectors.options.<id>` lets you say "this
value is fine for this detector across the whole codebase, but
keep firing on others."

```jsonc
{
  "detectors": {
    "options": {
      "boolean_naming_drift": {
        "allowedNames": ["loading", "ready"]
      },
      "magic_domain_literal_scatter": {
        "allowedLiterals": ["draft", "published"]
      }
    }
  }
}
```

Each detector that accepts options declares its own schema; the
config loader validates supplied options against the schema at
load time. Three failure modes — all CLI exit `2`
(`ConfigParseError`):

1. `detectors.options.<id>`: unknown detector id — the id doesn't
   match any built-in.
2. `detectors.options.<id>`: this detector accepts no options —
   the id is real but the detector has not registered any options
   schema.
3. `detectors.options.<id>`: ... — the value's shape doesn't
   match the detector's declared options.

The keys each detector understands are documented alongside that
detector under [`finding-types/`](./finding-types/). Detectors
that don't appear in those docs accept no options.

#### Options added in 0.16.0

Every detector in the 0.16.0 slate accepts options. Full descriptions
live in [`finding-types/authority.md`](./finding-types/authority.md),
[`finding-types/correctness.md`](./finding-types/correctness.md), and
[`finding-types/agent-hygiene.md`](./finding-types/agent-hygiene.md);
this is the index.

| detector                    | key                             | type       | default | what it does |
| --------------------------- | ------------------------------- | ---------- | ------- | ------------ |
| `duplicated_policy`         | `minFiles`                      | int ≥2     | `2`     | Distinct production files a clone must span |
|                             | `minTokens`                     | int ≥3     | `3`     | Normalised-token floor; raise to report only compound rules |
|                             | `reportNearClones`              | boolean    | `true`  | Report families of one-value rule variants |
|                             | `ignorePaths`                   | string[]   | `[]`    | Property-path tails to skip entirely |
| `contract_drift`            | `minOverlap`                    | 0.3-1      | `0.6`   | Field-set overlap required before two declarations pair |
|                             | `minDisagreements`              | int ≥1     | `1`     | Disagreements required before reporting |
|                             | `ignoreNames`                   | string[]   | `[]`    | Contract names to exclude (case-insensitive, exact) |
|                             | `reportRequiredness`            | boolean    | `true`  | Report optional-vs-required differences |
| `config_drift`              | `reportUndocumented`            | boolean    | `true`  | Report variables absent from `.env.example` |
|                             | `reportUnused`                  | boolean    | `false` | Report documented-but-unread variables |
|                             | `reportBoundaryBypass`          | boolean    | `true`  | Report direct reads past a central config module |
|                             | `ignoreNames`                   | string[]   | `[]`    | Variable names to ignore entirely |
|                             | `publicPrefixes`                | string[]   | `[]`    | Extra client-exposing prefixes beyond the built-ins |
| `pass_through_abstraction`  | `minChainLength`                | int 2-20   | `3`     | Wrappers in a chain before it is reported |
|                             | `minChainFiles`                 | int 1-20   | `2`     | Distinct files a chain must span |
|                             | `minClusterSize`                | int 3-50   | `4`     | Wrappers sharing one receiver before a cluster is reported |
|                             | `boundaryPaths`                 | string[]   | `[]`    | Extra path fragments marking a deliberate boundary |
| `swallowed_error`           | `reportLogWithoutError`         | boolean    | `true`  | Report handlers that log without passing the error |
|                             | `reportFallbackReturns`         | boolean    | `true`  | Report handlers returning a bland fallback |
|                             | `treatCommentAsIntent`          | boolean    | `false` | Treat a comment-only handler as deliberate and skip it |
|                             | `allowedFunctions`              | string[]   | `[]`    | Enclosing function names to exempt |
| `unsafe_retry`              | `transactionCountsAsIdempotent` | boolean    | `false` | Accept a visible transaction as sufficient on its own |
|                             | `reportDelete`                  | boolean    | `true`  | Report retried HTTP `DELETE` |
|                             | `mutatingCalls`                 | string[]   | `[]`    | Extra callee names to treat as writes |
|                             | `idempotentCalls`               | string[]   | `[]`    | Callee names known safe to replay |
| `unbounded_async_fanout`    | `staticallySmall`               | int 1-100  | `8`     | Array-literal size treated as bounded by construction |
|                             | `reportUnclassifiedWork`        | boolean    | `false` | Report fan-outs whose callback work could not be classified |
|                             | `boundedHelpers`                | string[]   | `[]`    | Project helpers that bound concurrency |
| `mock_saturation`           | `minMockedRatio`                | 0.1-1      | `0.8`   | Fraction of collaborators mocked before saturation is considered |
|                             | `minMockedCollaborators`        | int 1-50   | `2`     | Distinct collaborators that must be mocked |
|                             | `reportInteractionOnlyTests`    | boolean    | `false` | Report interaction-only assertions below the ratio threshold |
|                             | `alwaysAllowedMocks`            | string[]   | `[]`    | Specifiers whose mocking never counts toward saturation |
| `dependency_provenance_gap` | `reportUndeclaredImports`       | boolean    | `true`  | Report imports with no declaring manifest |
|                             | `reportMissingFromLock`         | boolean    | `true`  | Report declared dependencies absent from the lockfile |
|                             | `reportUnpinnedSpecifiers`      | boolean    | `true`  | Report mutable git / URL / wildcard specifiers |
|                             | `allowedPackages`               | string[]   | `[]`    | Packages to treat as always available |
| `agent_permission_sprawl`   | `reportPermissions`             | boolean    | `true`  | Report broad permission grants |
|                             | `reportHooks`                   | boolean    | `true`  | Report hook and MCP execution hazards |
|                             | `reportInstructionProse`        | boolean    | `true`  | Report advisory prose directives |
|                             | `allowedRules`                  | string[]   | `[]`    | Permission rules to accept verbatim |

All values are validated at config load. An out-of-range number, a
wrong type, or an unrecognised key exits `2` with a message naming the
detector and the offending path.

**Two limits are not configurable**, deliberately:

- The cross-file risk index truncates at **5000 source files** and
  reports itself `limited` rather than spending unbounded time.
- Bucketed matching caps at **400 comparisons per bucket**. Both are
  regression guards against pathological repos, not tuning knobs.

### `scopeTiers.nonDomain` (since 0.10.0)

Glob patterns whose findings are classified as `tier: "nonDomain"`.
Non-domain findings appear in a separate "Also flagged elsewhere"
footer in the default `crimes scan` human report, don't compete with
domain findings for the default top-N file slots, and **are not counted
in the report's headline** (the header states them separately as
`+N in non-domain paths`).

**This is the scaffolding knob.** One-off diagnostics, backfill scripts
and sample code are quick and dirty by design, and a scan that leads
with them buries the findings you can act on. `scripts/**` is in the
default list for exactly that reason. Setting `scopeTiers.nonDomain`
**replaces** the defaults wholesale, so re-list any of them you still
want.

```jsonc
{
  "scopeTiers": {
    "nonDomain": [
      "scripts/**",
      "examples/**",
      "fixtures/**",
      "public/**",
      "**/__tests__/**",
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}"
    ]
  }
}
```

If `scopeTiers` is omitted from the config, the seven-pattern default
above is applied at scan time. Set `"nonDomain": []` to opt out
entirely (every finding becomes `"domain"`).

### `scan.topFiles` (since 0.10.0)

Default number of files shown in the file-grouped `crimes scan` human
output. Override per-invocation with `--top N`; pass `--all` to see
every finding (both tiers, no cap); pass `--flat` to revert to the
legacy severity-grouped layout.

```jsonc
{
  "scan": {
    "topFiles": 10
  }
}
```

Defaults to `5`. JSON output is unaffected — the `topFiles` knob only
shapes the human renderer.

### `triage.resurfaceBase` (since 0.11.0)

Git ref used to detect "touched files" for the resurfacing pipeline.
On every `crimes scan` invocation, files in the diff against
`<resurfaceBase>...HEAD` (plus working-tree changes) are checked
against `.crimes/triage.json` and `.crimes/baseline.json`; any
silenced or baselined finding whose file is in that set resurfaces
with `previously_triaged` / `previous_triage` (or
`previously_baselined` / `previous_baseline`) annotations.

| Key                     | Type   | Default  | Description                                                                                          |
| ----------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `triage.resurfaceBase`  | string | `"main"` | Git ref used to detect "touched files" for resurfacing. Empty string disables resurfacing entirely.  |

```jsonc
{
  "triage": {
    "resurfaceBase": "develop"
  }
}
```

Resurfacing is skipped silently when:

- `triage.resurfaceBase` is `""`.
- The directory is not a git repository.
- `HEAD` resolves to the same ref as `<resurfaceBase>` — you're on the
  base, there's no diff to compute.

**Interaction with `scopeTiers.nonDomain`.** Resurfacing crosses
tiers — a triaged finding in a non-domain file (e.g. under
`scripts/**` or `**/__tests__/**`) **still resurfaces** when that file
is in the branch diff. The non-domain footer is a *display* tier, not
a "we don't care about it" tier; once you've explicitly triaged the
finding the resurface contract honours that decision regardless of
where the file lives.

The default `crimes triage` interactive walk visits domain-tier
findings only. Pass `crimes triage --all` to include non-domain
findings in the walk.

### `ia.aliasGroups`

Seed entries for `concept_alias_drift`. Each group is `{ id,
aliases[], preferred? }` with lowercase, singular tokens. Always
**additive** to the built-in `DEFAULT_ALIAS_GROUPS`.

```jsonc
{
  "ia": {
    "aliasGroups": [
      { "id": "dataset", "aliases": ["dataset", "corpus", "collection"] }
    ]
  }
}
```

### `suppressions.path`

Override the on-disk suppressions file path. Defaults to
`.crimes/suppressions.json`. Relative paths resolve against the repo
root; absolute paths win unchanged. See
[`suppressions.md`](./suppressions.md).

### `architecture` (consumed by `layer_violation` since 0.6.0)

Defines named layers by file glob and explicit
`from → cannotImport` rules. The `layer_violation` detector consumes
both fields and emits one finding per imported file that crosses a
forbidden boundary.

```jsonc
{
  "architecture": {
    "layers": [
      { "name": "ui",     "pattern": "src/components/**" },
      { "name": "domain", "pattern": "src/domain/**" },
      { "name": "db",     "pattern": "src/db/**" }
    ],
    "rules": [
      { "from": "ui",     "cannotImport": ["db", "domain"] },
      { "from": "domain", "cannotImport": ["ui"] }
    ]
  }
}
```

`pattern` is a glob matched against repo-relative POSIX paths.
`from` and `cannotImport[]` reference layers by `name`. Layers that
don't appear in any rule are still useful as documentation; the
detector only emits findings when a `cannotImport` is violated.

See [`docs/finding-types/dependency.md`](./finding-types/dependency.md)
for the full detector contract and `PRD.md` §18 for the design intent.

## Worked examples

### Add a product-specific alias group

```jsonc
{
  "ia": {
    "aliasGroups": [
      { "id": "tenant", "aliases": ["tenant", "company", "org", "organization"] }
    ]
  }
}
```

### Tune `large_function` for a route-heavy app

```jsonc
{
  "thresholds": {
    "largeFunction": {
      "route_handler": 150
    }
  }
}
```

### Disable a detector that doesn't apply

```jsonc
{
  "detectors": {
    "disable": ["todo_density"]
  }
}
```

### Move the suppressions file out of `.crimes/`

```jsonc
{
  "suppressions": {
    "path": "config/crimes-suppressions.json"
  }
}
```

## Validation errors

The CLI validates the file with `zod`. A malformed value prints the
exact key path that failed and exits `2`:

```
crimes: crimes.config.json at .../crimes.config.json is invalid:
thresholds.largeFileLines: Expected number, received string
```

Unknown top-level keys are preserved silently — `crimes` may extend
the schema in future releases without breaking older config files.
