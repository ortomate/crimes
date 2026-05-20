# Roadmap status

Snapshot of the repo against the PRD milestones (`PRD.md` §22). Updated as
work lands. Authoritative spec stays in `PRD.md` — this file is a status
mirror, not a planning doc.

- **Last published version:** `crimes@0.11.0` (npm) ✅ shipped —
  _triage as the front door_ (Release B). New `crimes triage` command,
  triage- + baseline-aware resurfacing, PreToolUse hook in
  `init --agents`, human-readable secondary scores in the renderer,
  schema bump `0.1.0` → `0.2.0` adding required `effort` + `fix_shape`.
  `packages/cli/package.json` tracks the latest shipped version. Release
  notes: [`docs/releases/v0.11.0.md`](./docs/releases/v0.11.0.md).
- **Previously shipped milestones:** `crimes@0.10.0` — _front-door
  redesign_ (Release A): file-grouped `scan` layout, repo-relative
  `test_gap` quartile, recency-weighted ranking, `scopeTiers.nonDomain`,
  `clues` block on `context --json`, two-prompt auto-init —
  `crimes@0.9.2` — _emoji severity glyphs + ortomate move_ —
  `crimes@0.9.1` — _visible
  welcome banner on bare `crimes`_ — `crimes@0.9.0` — _Codex agent
  discovery + Finder-duplicate petty crime_ — `crimes@0.8.1` —
  _calibration patch on 0.8.0_ — `crimes@0.8.0` — _extended lens:
  date, naming, hot-path, and asset crimes_ — `crimes@0.7.5` —
  _eval-harness graduation and detector trim_ — `crimes@0.7.0` —
  _calibration and
  the evidence loop_ — `crimes@0.6.0` — _detector and scoring
  completion_ — `crimes@0.5.0` — _suppressions, config, and
  explainability_ — `crimes@0.4.0` — _agent context quality and
  signal-to-noise_ — `crimes@0.3.0` — _information architecture
  crimes_ — and `crimes@0.2.0` — _branch and PR safety for humans and
  coding agents_. All live on npm and exercised by the publish-tarball
  smoke test in CI on every commit.
- **Published package:** [`crimes`](https://www.npmjs.com/package/crimes)
  on npm — `npm install -g crimes` and `npx crimes scan .` both work today.
- **Website:** [crimes.sh](https://crimes.sh) — live, deployed from this
  monorepo via Vercel (auto-deploys on push to `main`).
- **Repository:** [`ortomate/crimes`](https://github.com/ortomate/crimes).

| Milestone                     | Status                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| M0 — Repo foundation          | ✅ done (shipped in 0.1.0)                                                              |
| M1 — First working CLI        | ✅ done (shipped in 0.1.0)                                                              |
| M2 — Risk model               | ✅ completed in `0.6.0` — per-finding `scores.churn` / `test_gap` / `blast_radius` now populated by every scan from the import graph + git history + test-file index. Unified `agent_risk` formula. `crimes hotspots` (0.1.0) + shallow-clone awareness (0.4.0) remain alongside. |
| M3 — Agent context            | 🟢 expanded again in `0.5.0` — adds `crimes explain <id-or-fingerprint>` for the rung between "I see the charge" and "I commit to fix or suppress". Built on `crimes context` (0.1.0), cross-file `related_files` (0.3.0), and shape-aware `large_function` (0.4.0 + `cli_command_registrar` in 0.6.0). |
| M4 — Diff and CI              | 🟢 completed in `0.5.0` — every gating mode now lands: `scan --changed --fail-on` (0.2.0), `baseline check --fail-on` (0.2.0), `verdict --fail-on` (0.2.0), and finally `diff --fail-on new-high \| new-medium` (0.5.0). Suppressions apply before every gate; per-finding `crimes ignore` is shipped. |
| M5 — Public launch            | ✅ completed in `0.6.0` — full `/docs` site at [`crimes.sh/docs/`](https://crimes.sh/docs/) via Astro + Starlight; landing page unchanged. |
| M6 — Homebrew / binaries      | 🚧 not started                                                                            |

---

## ✅ Shipped in `crimes@0.11.0`

> **Theme: Triage as the front door** (Release B). Minor release.
> Schema bump (`0.1.0` → `0.2.0`) adding required `effort` +
> `fix_shape`. No new detectors.
>
> Release notes: [`docs/releases/v0.11.0.md`](./docs/releases/v0.11.0.md).
> Design rationale:
> [`docs/superpowers/specs/2026-05-20-release-b-triage-design.md`](./superpowers/specs/2026-05-20-release-b-triage-design.md).

- **`crimes triage` command.** Top-of-rank-first interactive walk over
  findings with five dispositions (`fix-now`, `fix-this-PR`,
  `needs-design`, `wont-fix`, `scaffolding`). Each disposition writes
  to `.crimes/triage.json` immediately (incremental persistence). The
  on-disk schema enforces `reason`, `owner`, and `date` per entry.
  Subcommands: `--apply <file>` (non-interactive), `--list`,
  `--clear <fingerprint>`, `--retriage <target>`, `--owner <handle>`,
  `--all`.
- **Triage- and baseline-aware resurfacing.** Silenced triage entries
  and baseline entries automatically resurface in `crimes scan` when
  their file is in the branch diff against
  `config.triage.resurfaceBase` (default `"main"`). Resurfaced
  findings carry `previously_triaged` / `previous_triage` (or
  `previously_baselined` / `previous_baseline`) annotations and render
  with a `▼` glyph in the human report. The re-detect pass drops
  resurfaced entries silently when the underlying finding is already
  fixed.
- **`effort` + `fix_shape` on every `Finding`.** Schema bump
  `schema_version: "0.1.0"` → `"0.2.0"`. Detector-supplied with
  defaults in `packages/core/src/detector-defaults.ts`; generic
  fallback is `medium` + a one-line "refactor … add a test" string.
  No existing field changed shape, name, or semantics.
- **New `crimes scan` flags.** `--show-triaged` reveals silenced
  triage dispositions in the output. `--gate-needs-design` opts in to
  counting `needs-design` findings toward `--fail-on`.
  `--gate-resurfaced` opts in to gating on resurfaced findings on
  touched files. All three default off.
- **PreToolUse hook in `init --agents`.** `crimes init --agents` now
  merge-writes a Claude Code `PreToolUse` Edit hook into
  `.claude/settings.local.json` and a forward-looking stub into
  `.agents/settings.local.json`. Matcher is `Edit|Write|NotebookEdit`;
  command runs `crimes context --format json` on the file being
  edited. `--no-hooks` opts out; `--force` overwrites the crimes hook
  entry only.
- **Human-readable secondary scores.** Scan + context renderers now
  print `blast top-quartile (11 importers)` / `churn 24 commits over
  90d · last touched 2 days ago` instead of bare decimals.
  `FindingScores` numerics in JSON are **unchanged** — renderer-only
  change.
- **New config key.** `triage.resurfaceBase` (string, default
  `"main"`) — empty string disables resurfacing entirely. See
  [`docs/configuration.md`](./configuration.md).

Schema bumps from `"0.1.0"` to `"0.2.0"`. Consumers that hard-checked
`schema_version === "0.1.0"` must accept the new string.

---

## ✅ Shipped in `crimes@0.10.0`

> **Theme: front-door redesign** (Release A). Minor release.
> Default `crimes scan` becomes file-grouped; `crimes context` leads
> in every entry-point. Detector taxonomy frozen; schema unchanged.
>
> Release notes: [`docs/releases/v0.10.0.md`](./docs/releases/v0.10.0.md).

- **File-grouped `crimes scan` layout.** Default human output groups
  findings by file, sorted by aggregate risk (churn × test-gap
  quartile × blast radius × recency). Top 5 files shown by default;
  `--top N` overrides, `--all` shows every finding, `--flat` reverts
  to the legacy severity-grouped list.
- **Repo-relative `test_gap` quartile.** `Finding.scores.test_gap` is
  now a quartile-ranked value (`0 / 0.25 / 0.5 / 0.75 / 1.0`)
  computed against the distribution of test-file proximity across the
  repo, not the prior fixed `{0, 0.5, 1.0}` mapping.
- **Recency-weighted ranking.** New optional `Finding.scores.recency`
  (0–1 decay over a 7- to 14-day window). The default rank score
  multiplies recency in; `--no-recency` collapses the multiplier.
- **`Finding.tier` + `scopeTiers.nonDomain` config.** Each finding is
  tagged `tier: "domain" | "nonDomain"`; non-domain findings appear
  in a separate "Also flagged elsewhere" footer. Defaults cover
  `scripts/**`, `examples/**`, `fixtures/**`, `public/**`, and the
  standard test globs.
- **`clues` object on `crimes context --json`.** Frozen contract for
  PreToolUse consumers: `clues.churn` (`commits_90d`,
  `last_commit_at`, `unique_authors_90d`), `clues.suppressions`
  (per-file inventory), `clues.test_gap` (`raw`, `percentile`,
  `label`), and `clues.related_signals` (reserved).
- **Two-prompt auto-init with agent detection.** On any subcommand
  other than `init` / `feedback` / `ignore` / `unignore` / `baseline`,
  if `crimes.config.json` is missing and stdout is a TTY (CI / piped
  invocations skipped), `crimes` prompts to generate the config and
  (when an agent is detected) the agent skill.
- **`context`-first messaging.** Welcome banner, `--help`, README,
  agent docs all lead with `crimes context <file>`.

Schema unchanged. `schema_version` stays at `"0.1.0"` for 0.10.0.

---

## ✅ Shipped in `crimes@0.9.2`

> **Theme: emoji severity glyphs + ortomate move.** UX-only patch.
> No schema change, no new detectors.
>
> Release notes: [`docs/releases/v0.9.2.md`](./docs/releases/v0.9.2.md).

- **Severity glyphs in the human report.** 🚨 high · ⚠️ medium · 🔎 low
  prefix every finding's title line and the severity heading. ✅ / ❌
  on the `--fail-on` gate line; ✨ on the "no crimes detected" empty
  state. Suppressed when stdout isn't a TTY, when `NO_COLOR` is set,
  or when `--no-color` is passed — JSON output, CI logs, and piped
  invocations stay emoji-free.
- **Repository moved to `ortomate/crimes`.** `repository.url` and
  `bugs.url` in the published package now point at the new GitHub
  org; every documentation deep link follows. npm Trusted Publisher
  config moved to the new org in the same cut-over — this release is
  the OIDC handoff verification.
- **Release checklist gap closed.** `docs/releasing.md` Step 2 now
  explicitly requires both READMEs, the roadmap, the release-notes
  file, and both landing-page surfaces (`llms.txt` + `index.html`)
  to reflect the new version before the GitHub Release is cut. The
  drift that left the root README pinned at `0.8.1` through `0.9.0`
  and `0.9.1` should not recur.

Schema unchanged. `schema_version` stays at `"0.1.0"`.

---

## ✅ Shipped in `crimes@0.9.1`

> **Theme: visible welcome on bare `crimes`.** UX-only patch.
> No schema change, no new detectors.
>
> Release notes: [`docs/releases/v0.9.1.md`](./docs/releases/v0.9.1.md).

- **Bare `crimes` prints a welcome banner.** Running `crimes` with no
  arguments now shows version, three first-step commands
  (`crimes init --agents`, `crimes init`, `crimes --help`), and a
  docs link — instead of Commander's long help dump. `crimes --help`
  still renders the full usage output.
- **Post-install message expanded.** Includes the version and the
  same three commands. The script still runs, but npm 7+ swallows
  post-install stdout / stderr by default, so the bare-`crimes`
  banner is the reliable surface.

Schema unchanged. `schema_version` stays at `"0.1.0"`.

---

## ✅ Shipped in `crimes@0.9.0`

> **Theme: Codex agent discovery + one new petty crime.** Minor bump
> for the new detector and the expanded agent surface.
>
> Release notes: [`docs/releases/v0.9.0.md`](./docs/releases/v0.9.0.md).

- **Codex agent discovery is first-class.** `crimes init --agents`
  now writes both `.claude/skills/crimes/SKILL.md` and
  `.agents/skills/crimes/SKILL.md`; a new `--codex-skill` flag writes
  only the Codex skill. The `missing_agent_context` detector treats
  `.agents/skills/*/SKILL.md` as a satisfying signal.
- **New detector: `finder_duplicate_filename`** (petty). Flags
  macOS Finder / iCloud conflict-copy filenames like `Button 2.tsx`
  that slip into repos as accidental duplicates. Medium severity,
  0.90 confidence.
- **`crimes explain` rewrite.** Output broken into named section
  helpers; new "Likely remedies" block synthesised from the finding's
  `suggested_actions` plus generic next-steps. The `ExplainReport`
  JSON gains a new `likely_remedies: string[]` field. `Finding` wire
  format unchanged.
- **Post-install nudge.** `npm install -g crimes` now prints a
  one-line reminder to run `crimes init --agents` (suppressed in CI
  and behind `CRIMES_DISABLE_POSTINSTALL=1`).
- **Landing-page broken link fix.** "Live status" and `llms.txt`
  roadmap pointer now resolve to `docs/roadmap.md`.

Schema unchanged. `schema_version` stays at `"0.1.0"`.

---

## ✅ Shipped in `crimes@0.8.1`

> **Theme: calibration patch on 0.8.0.** Three changes, no new
> detectors and no schema change.
>
> Release notes: [`docs/releases/v0.8.1.md`](./docs/releases/v0.8.1.md).

- **`boolean_naming_drift` allowlist expanded.** Eight idiomatic
  state names (`loaded`, `found`, `settled`, `overflow`,
  `typeonly`, `interpolated`, `limited`, `existed`) added to the
  built-in React-state allowlist. Pure default-tuning; project
  configs are unaffected (set-membership lookup, duplicates
  harmless).
- **Self-scan signal cleanup.** The crimes monorepo's own
  `crimes.config.json` now excludes `evals/fixtures/**` and
  `examples/messy-ts-app/**` from the asset pass, so the dogfood
  scan no longer surfaces the intentional-bad demo assets at the
  top of the report. Downstream users' configs are unaffected.
- **`scan-assets.ts` refactored.** The 80-line
  `runAssetDetectorsForRoot` body split into four named helpers
  (`discoverAssetFiles`, `groupDetectorsByExtension`,
  `runDetectorsForAssetFile`, `buildAssetContext`). Same
  behaviour, individually testable.

Schema unchanged. `schema_version` stays at `"0.1.0"`.

---

## ✅ Shipped in `crimes@0.1.0` (2026-05-15)

Every command below is verified by the publish-smoke test in CI on every
commit (`pnpm --filter crimes smoke`). Each command also accepts
`--format json`; the JSON output is the stable contract (see
[`docs/json-schema.md`](./docs/json-schema.md)).

### Commands

- `crimes --help` / `crimes --version`
- `crimes scan [path]` — directory scan, default top-10, `--all` for full list
- `crimes scan [path] --format json`
- `crimes scan --changed` — restrict to files changed in the working tree
- `crimes scan --changed --base <ref>` — also include commits unique to `<ref>...HEAD`
- `crimes context <file>` — per-file findings + likely tests + agent guidance
- `crimes context <file> --format json`
- `crimes hotspots [path]` — Git churn × findings, ranked by aggregate risk
- `crimes hotspots [path] --since <window>` — `90d`, `2w`, `6m`, `1y`, or anything `git log --since` understands
- `crimes hotspots [path] --format json`

### Detectors

- `large_file` — God File
- `large_function` — God Function
- `todo_density` — Unfinished Business
- `direct_date` — Temporal Recklessness (`Date.now()` / `new Date()`)

### Agent integrations

- [`AGENTS.md`](./AGENTS.md) — read by Codex CLI, Cursor, Aider, Continue,
  Copilot Workspace, etc.
- [`.claude/skills/crimes/SKILL.md`](./.claude/skills/crimes/SKILL.md) —
  Claude Code skill (loads on demand)
- [`docs/agent-usage.md`](./docs/agent-usage.md) — long-form pre/post-edit
  workflow
- [`docs/skills.md`](./docs/skills.md) — catalogue of bundled agent assets
- [`docs/json-schema.md`](./docs/json-schema.md) — stable wire format

### Release automation

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — install, build,
  typecheck, test, scan smoke, publish-tarball smoke on every push / PR.
- [`.github/workflows/release.yml`](./.github/workflows/release.yml) —
  publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
  when a GitHub Release is published. No `NPM_TOKEN` required.
- [`docs/releasing.md`](./docs/releasing.md) — step-by-step release recipe
  and the one-time npmjs.com Trusted Publisher setup.

---

## ✅ Shipped in `crimes@0.2.0`

**Theme: branch and PR safety for humans and coding agents.**

`0.1.0` gave humans and agents a per-file / per-directory snapshot of
codebase risk. `0.2.0` extends that to **change sets** — what a branch or
PR introduces vs. what was already there — so the same workflow can run
inside CI and an agent loop on every commit, not just on demand.

The wedge is unchanged: deterministic, local, JSON-first. No LLM in the
core path. The only new artefacts on disk are `.crimes/baseline.json` and
the `diff` / `verdict` / `baseline_check` JSON shapes — all versioned by
the same `schema_version` as `crimes scan`.

### ✅ Completed in `0.2.0`

- **`crimes diff <base...head>`** — report **new**, **fixed**, and
  **unchanged** crimes between two Git refs. Working-tree-safe: each ref
  is exported via `git archive` into a temp directory and scanned there,
  so no checkout / stash / temporary commit ever touches the user's tree.
  Findings are matched by stable fingerprint
  `<type>::<file>::<symbol-or-empty>` so small line shifts from unrelated
  edits don't register as fix + new. JSON shape documented in
  [`docs/json-schema.md`](./docs/json-schema.md#diffreport-output-of-crimes-diff-basehead).
- **`crimes baseline save` / `crimes baseline check`** — snapshot the
  current findings to `.crimes/baseline.json` (intended to be committed)
  and gate future scans against that baseline. The same fingerprint
  identity as `crimes diff` does the matching, and `--fail-on
  low|medium|high` (default `medium`) controls the severity threshold
  that flips `failed: true` (exit `1`). Exit `2` is reserved for missing
  / malformed baselines and bad flags. Schemas (`Baseline`,
  `BaselineCheckReport`) documented in
  [`docs/json-schema.md`](./docs/json-schema.md#baseline-on-disk-shape-of-crimesbaselinejson).
- **`crimes verdict`** — branch-level "did this branch make the repo
  cleaner, worse, unchanged, or mixed?" summary. Built on top of
  `crimes diff` (same archive-into-temp machinery, same fingerprint
  matching). Default base picks `origin/main` first, then `main`;
  exits `2` if neither resolves and no `--base` is passed. Advisory
  by default (always exits `0`); opt into a CI gate with `--fail-on
  worse | new-high | new-medium`. Severity weights are `high = 3`,
  `medium = 2`, `low = 1`. Schema (`VerdictReport`) documented in
  [`docs/json-schema.md`](./docs/json-schema.md#verdictreport-output-of-crimes-verdict).
- **`crimes scan --changed --fail-on low|medium|high`** — the
  changed-files-only CI gate. Only valid in combination with
  `--changed`; passing it on a plain `crimes scan` exits `2`. When set,
  the JSON output gains two optional top-level fields (`fail_on`,
  `failed`) — both absent on the default advisory `scan` path so the
  existing contract is unchanged. Exit `1` when at least one finding
  in the changed set meets the threshold; exit `0` otherwise. Schema
  delta documented in
  [`docs/json-schema.md`](./docs/json-schema.md#scan---changed---fail-on-gate-fields).
- **CI integration docs** — [`docs/ci.md`](./docs/ci.md) covers the
  three recommended gating modes (changed-files, baseline, branch
  verdict) and the shared exit-code contract.
  [`examples/github-actions/crimes.yml`](./examples/github-actions/crimes.yml)
  is the copy-paste workflow that ships with the repo.
- **Schema / report consistency pass** — every report now carries a
  `report_type` discriminator (`"scan"`, `"context"`, `"hotspots"`,
  `"diff"`, `"baseline"`, `"baseline_check"`, `"verdict"`) under the
  same `schema_version`. Consumers can route on a single field.

### Deferred from `0.2.0` (and still deferred after `0.3.0`)

The following are explicitly **not in `0.2.0` or `0.3.0`** and remain
tracked for later versions. Don't document them as shipped.

- **`crimes diff --fail-on new-high`** — exit non-zero when the head
  ref introduces any new `severity: "high"` finding. Until it lands,
  gate on JSON (`jq -e '.summary.new == 0'`) or use
  `crimes verdict --fail-on new-high` / `crimes scan --changed
  --fail-on high` / `crimes baseline check`.
- **`crimes ignore <id>`** + `.crimes/suppressions.json` per-finding
  suppressions. The baseline workflow covers the "don't fail on legacy
  debt" use case in the meantime.
- **`crimes explain <id>`** — long-form per-finding rationale.
- **`crimes init` + config plumbing** — bootstrap a
  `crimes.config.json` with sensible architecture rules.
- **`crimes ask` / LLM-assisted modes** — `v1+`.
- **Dependency-graph detectors** — circular dependencies, deep imports,
  layer violations driven by `architecture.layers` config. `0.4.0+`.
- **Duplication detectors** — exact and near-duplicate blocks, repeated
  string literals, duplicated role / status / plan checks. `0.4.0+`.
- **Homebrew tap + standalone macOS / Linux / Windows binaries** —
  deferred until the CLI surface stabilises.

---

## ✅ Shipped in `crimes@0.3.0`

**Theme: information architecture crimes.**

> **Implementation plan: [`.planning/archive/0.3.0-ia-crimes.md`](../.planning/archive/0.3.0-ia-crimes.md).**
> Detector taxonomy, scope recommendation, IA-index architecture,
> extraction strategy, fixture plan, sequencing, and success criteria
> for `0.3.0` live there. This section is the status mirror.

`0.2.0` made `crimes` useful for branches, PRs, CI, and agent loops —
the change-set surface is now covered. `0.3.0` makes `crimes` better
at detecting **repo structure drift that confuses humans, coding
agents, teams, and customers**.

Information architecture crimes expose the places where a repo gives
multiple competing answers to the same structural question — what a
concept is called, where it lives, which implementation owns it, how
users move through the product, who is allowed to do what. They are
the most distinctive form of agent-risk `crimes` can ship: deterministic
evidence of source-of-truth ambiguity that linters and security scanners
do not look for, and that AI coding agents repeatedly trip over when
they pick the wrong vocabulary, the wrong route, or the wrong copy of a
shared piece of nav.

### ✅ Completed in `0.3.0`

- **IA concept index foundation** —
  [`packages/core/src/ia/`](./packages/core/src/ia/) builds a
  deterministic per-scan `IaIndex` (route signals, nav sources, label
  signals, alias seeds, agent-context discovery, markdown link graph)
  consumed by every IA detector through `DetectorContext.ia`. The
  index is computed once in the same pass as file discovery and AST
  parsing; no detector reaches into the language pack directly.
- **`missing_agent_context`** — flags repos that declare a `bin` in
  `package.json` but ship no `AGENTS.md`, `CLAUDE.md`, or
  `.claude/skills/*/SKILL.md` / `.agents/skills/*/SKILL.md`. Medium
  severity, 0.90 confidence.
- **`route_metadata_drift`** — flags routes whose path, file location,
  default-export component, `<title>` / `metadata.title`, and
  nav-source labels appear to describe the destination with competing
  concept tokens. Requires ≥3 disagreeing sources; layouts and generic
  root routes are excluded. Medium severity, 0.60–0.80 confidence.
- **`duplicated_navigation_source`** — flags single internal
  destinations that appear in two or more nav-like sources with
  different non-empty labels. Medium severity, 0.70–0.85 confidence.
- **`concept_alias_drift`** — flags alias groups (`team` / `workspace`
  / `organisation`; `plan` / `tier` / `subscription`; etc.) where ≥3
  aliases each appear in ≥2 distinct directories with at least one
  product-surface hit. Capped at the three strongest groups per scan.
  Low–medium severity, 0.60–0.75 confidence.
- **`docs_code_drift`** — flags broken local links in `docs/**/*.md`
  and root-level `*.md` / `*.mdx`. Low severity, 0.90 confidence.
- **Cross-file `related_files`** — populated by the IA detectors and
  rendered as an "Also touches:" block (capped at 5, with overflow
  noted) in the human reporter. JSON output is unchanged.
- **Petty crimes detector family** — `commented_out_code`,
  `logic_in_comments`, `name_behavior_mismatch`,
  `magic_domain_literal_scatter`, `weak_test_signal`,
  `option_bag_junk_drawer`, `return_shape_roulette`, and
  `negative_flag_maze` ship as evidence-backed maintainability findings.
  They stay under the existing `Finding` shape and do not add a new
  severity level. See
  [`docs/finding-types/petty.md`](./docs/finding-types/petty.md).
- **Route Metadata Drift evidence cap raised from 6 → 8** so both nav
  labels in a multi-source drift fit alongside the route path / file /
  component / title evidence without losing data to truncation.
- **Public fixture demonstrates all five IA finding types.** The
  bundled [`examples/messy-ts-app`](./examples/messy-ts-app) fixture
  emits at least one finding from each of the five IA detectors. The
  pinned sample output at
  [`docs/fixtures/messy-ts-app.json`](./docs/fixtures/messy-ts-app.json)
  is regenerated from a real scan — not hand-edited.
- **Long-form IA reference docs.**
  [`docs/finding-types/ia.md`](./docs/finding-types/ia.md) covers each
  shipped detector: what it reads, example evidence, why it matters,
  suggested fixes, and a "false positives" section. Wired into
  [`docs/agent-usage.md`](./docs/agent-usage.md) and
  [`docs/json-schema.md`](./docs/json-schema.md).

The new `Finding.type` values land additively under the same
`schema_version: "0.1.0"`. No schema bump. The CLI surface
(`scan` / `context` / `hotspots` / `diff` / `baseline` / `verdict`) is
unchanged — IA findings ride the existing report shapes.

### Self-scan note

Running `crimes scan .` on the crimes monorepo from the repo root
will surface findings from the bundled fixture
([`examples/messy-ts-app`](./examples/messy-ts-app)) — by design,
since the fixture is intentionally crime-ridden. The default
`exclude` list does **not** ignore `examples/`, so a full repo
self-audit may include 1–2 IA findings inherited from the fixture
(typically a `missing_agent_context` charge against the inner
`messy-ts-app` workspace because it ships a `bin` without an
`AGENTS.md`). Recommended workflows for a clean self-audit:

- Scan only first-party code: `crimes scan packages docs`.
- Or exclude the fixture in a `crimes.config.json`:
  `{ "exclude": ["examples/**"] }`. Config plumbing is deferred to
  `0.3.x` / `0.4.0`, but `fast-glob`'s `exclude` already honours the
  pattern.
- Or pass `--all` to see every finding and visually filter the
  fixture-induced ones.

The "low-noise on the crimes repo itself" success criterion in
[`.planning/archive/0.3.0-ia-crimes.md`](../.planning/archive/0.3.0-ia-crimes.md) §13 is evaluated against
the first-party tree, not the whole repo.

### Deferred from `0.3.0`

Tracked for later versions. **Do not** document them as shipped.

IA detectors still on the long-term roadmap:

- **`orphaned_destination`** — page / route / screen files
  unreachable from primary navigation, route registries, or internal
  links. Needs route discovery to mature.
- **`parallel_destination`** — multiple pages or flows that appear to
  serve the same user intent (`/billing` vs `/settings/billing`
  vs `/account/subscription`; `InviteUserModal` vs
  `AddTeamMemberDialog`). Needs near-duplicate scoring to avoid noisy
  guesses.
- **`permission_ia_drift`** — nav, route guards, docs, and policy
  code describe access using different roles. Requires policy /
  route-guard discovery.
- **`action_label_drift`** — semantic drift in action and object
  labels ("Delete" / "Remove" / "Archive"; "User" / "Member" /
  "Seat").
- **Command-drift variant of `docs_code_drift`** — docs that
  reference a CLI command the published `bin` no longer implements.
  Needs deterministic command-registration scanning.

Supporting work also deferred (tracked for `0.3.x` / `0.4.0+`):

- **Richer per-finding scores (M2):** `scores.churn`,
  `scores.test_gap`, and `scores.blast_radius` on every finding.
- **`crimes explain <id>`** — long-form per-finding rationale (M3).
- **`crimes ignore <id>`** + `.crimes/suppressions.json` per-finding
  suppressions.
- **`crimes diff --fail-on new-high`** — finish the M4 CI-gate trio.
- **`crimes init` + config plumbing** — bootstrap
  `crimes.config.json` with sensible defaults.

---

## ✅ Shipped in `crimes@0.4.0`

**Theme: agent context quality and signal-to-noise.**

> **Implementation plan:
> [`.planning/archive/0.4.0-agent-context-quality.md`](../.planning/archive/0.4.0-agent-context-quality.md).**
> Scope, root-detection fix, neighbourhood discovery, shape-aware
> `large_function`, schema additions, and prompt sequence for `0.4.0`
> live there. This section is the status mirror.

Real-repo trials of `0.3.0` with Claude Code and Codex CLI surfaced
two coupled gaps: (1) `crimes context` did not tell agents what _else_
to read before editing the target file, and (2) several existing
detectors were noisy enough on production repos (React pages, route
handlers, test callbacks, GitHub-relative README links, shallow git
clones, nested-package roots) that agents started to discount the
report. `0.4.0` raises the context floor and lowers the noise ceiling
_before_ adding more detectors — no new detectors ship in this
release.

### ✅ Completed in `0.4.0`

- **Monorepo / nested-package root detection for `crimes context`** —
  `findNearestPackageRoot` walks up from the target file to the nearest
  enclosing `package.json` and uses that as the scan root. Explicit
  `--root` still wins. Output paths are normalised against the chosen
  root so `crimes context examples/messy-ts-app/src/foo.ts` from the
  monorepo root and `crimes context src/foo.ts` from inside the
  package produce equivalent reports.
- **Deterministic neighbourhood `related_files` on `ContextReport`** —
  new
  [`packages/core/src/context-related-files.ts`](./packages/core/src/context-related-files.ts)
  ranks up to 10 files an agent should read before editing the target,
  using four heuristics: IA finding passthrough (`related to <charge>`),
  shared IA path tokens, domain-prefix filename matches, and same-
  directory siblings. Each entry carries a `reason` string and an
  ordinal `score`. Files already in `likely_tests` are excluded.
- **Shape-aware `large_function`** — `ParsedFunction` carries a new
  `shape: FunctionShape` (`domain | test_callback | react_component |
  page_export | route_handler | unknown`) computed during AST parsing.
  Per-shape thresholds (60/200@low/200/200/100/80) replace the single
  60-line cut-off. Test callbacks no longer dominate scans; React pages
  and route handlers get appropriate budgets; `generateInvoice`'s
  fixture finding still flags at high.
- **`_test.ts` / `_spec.ts` likely-test discovery** — Go-style suffix
  conventions (`foo_test.ts`, `foo_spec.ts`) join the existing
  `.test.ts` / `.spec.ts` / `__tests__/` rules.
- **`docs_code_drift` GitHub-relative link allowlist** — `../../issues`,
  `../../pull/N`, `../../wiki/Home`, `../../blob/main/PRD.md`, and
  the rest of the GitHub-rewritten path set are no longer flagged as
  broken local links. Real `../../docs/foo.md` paths still resolve.
- **`ScanReport.changed_files`** — `crimes scan --changed --format json`
  now emits a top-level array listing every file the resolver returned,
  sorted and deduplicated, **including** files with zero findings
  (touched markdown, lockfiles, etc.). Plain `crimes scan` omits the
  field.
- **`HotspotsReport.history_limited` + `history_limited_reason`** —
  detected via `git rev-parse --is-shallow-repository`. The human
  reporter prints `(history limited: …)` on the same line as the
  existing not-a-git-repo notice. Agents should downweight rankings
  when the flag is set.
- **Top-level `agent_guidance` ordering in `ContextReport`** —
  serialised JSON now places `agent_guidance` ahead of `findings` so
  agents read the actionable summary first. Same wording as 0.3.0.
- **Neighbourhood guidance line** — when a target file has no findings
  but does have related files, `agent_guidance` gains a single line
  pointing the agent at the neighbourhood instead of being empty.
- **Empty-field self-explanation** — `agent_guidance_reason`,
  `related_files_reason`, and `likely_tests_reason` are each set
  **only when** the matching array is empty. Distinguishes "we
  searched and found nothing" from "we didn't search".

All additions land additively under the same
`schema_version: "0.1.0"`. **No schema bump.** No CLI behaviour
regressions. JSON consumers that read by key name (the recommended
pattern) are unaffected by the `agent_guidance` reordering.

### Deferred from `0.4.0`

Tracked for `0.5.0` or later. **Do not** document them as shipped.

- **`crimes init` + `crimes.config.json` plumbing** — moves to
  `0.5.0` alongside suppressions.
- **`crimes ignore <id>` + `.crimes/suppressions.json`** — moves to
  `0.5.0`. The noise-reduction work in `0.4.0` removed most of the
  underlying demand.
- **More IA detectors** — `orphaned_destination`,
  `parallel_destination`, `permission_ia_drift`, `action_label_drift`,
  command-drift variant of `docs_code_drift`. Pre-empted by the "no
  more detectors before fixing noise" feedback.
- **Per-finding `scores.churn` / `scores.test_gap` / `scores.blast_radius`** —
  M2 work; large surface area, deferred again.
- **`crimes diff --fail-on new-high`** — finish the M4 CI-gate trio.
- **`crimes explain <id>`** — long-form per-finding rationale.
- **`crimes ask` / LLM-assisted modes** — `v1+`.
- **Homebrew tap + standalone binaries** — deferred until the CLI
  surface stabilises further.
- **Importer / importee detection in `related_files`** — would require
  walking every file's imports. Deferred; the four shipped heuristics
  cover the common cases.
- **CLI breadcrumb when the auto-detected package root differs from
  cwd** — the auto-detection works silently. A one-line stderr note
  was suggested in the plan; deferred.
- **`pnpm-workspace.yaml` / `turbo.json` as additional monorepo
  markers** — `package.json` alone covers >95% of cases.

---

## ✅ Shipped in `crimes@0.5.0`

> **Theme: suppressions, config, and explainability — the three levers
> teams need to adopt `crimes` without fighting legitimate exceptions.**
>
> Release notes: [`docs/releases/v0.5.0.md`](./docs/releases/v0.5.0.md).
> Implementation plan:
> [`.planning/archive/0.5.0-suppressions-config-explain.md`](../.planning/archive/0.5.0-suppressions-config-explain.md).

### Config + bootstrap

- **`crimes init [--force]`** writes a starter `crimes.config.json`
  with sensible defaults and inline pointers at the new knobs.
- **`zod`-validated `CrimesConfig`** carrying optional, back-compat
  fields: per-shape `largeFunction` overrides
  (`thresholds.largeFunction.<shape>`), `ia.aliasGroups` (additive to
  `DEFAULT_ALIAS_GROUPS`), `detectors.enable` / `detectors.disable`
  (errors on unknown ids), `suppressions.path` override, and a
  reserved `architecture.layers` placeholder mirroring `PRD.md` §18.
- **`ConfigParseError`** maps to CLI exit `2` with a single-line
  message naming the malformed key.

### Suppressions

- **`.crimes/suppressions.json`** — fingerprint-keyed, `reason`
  required, intended to be committed. Pretty-printed with 2-space
  indent + trailing newline for review-friendly diffs.
- **`crimes ignore <id-or-fingerprint> --reason "…"`** — id resolves
  to a fingerprint via a fresh scan, then persists by fingerprint
  (ids reassign every scan and are useless on disk). Re-suppressing
  the same fingerprint updates `reason` instead of duplicating.
  `--file`, `--dry-run`, and `--no-verify` available.
- **Suppression application across `scan`, `context`, `baseline
  check`, `diff`, `verdict`** — default-hide with `suppressed_count`;
  `--show-suppressed` re-surfaces them annotated; the gate
  (`--fail-on`) always ignores suppressed entries regardless of
  display.
- **`crimes unignore <fingerprint>`** — symmetric removal by stable
  fingerprint. Supports `--file <path>` and `--dry-run`. Empty
  `suppressions: []` is left in place rather than deleting the file,
  so the frame stays visible in `git diff`.
- **`crimes audit-suppressions [--format human|json]`** — list every
  entry sorted oldest first, with `age_days` and per-entry concerns
  (`stale` > 180 days, `short_reason` < 16 chars, `vague_reason` for
  deferral keywords like `tmp` / `todo` / `wip` / `too noisy`).
  Emits `report_type: "audit_suppressions"`. Closes the workflow:
  add (`ignore`) → list (`audit-suppressions`) → remove
  (`unignore`).

### Explainability

- **`crimes explain <id-or-fingerprint> [--from <scan.json>]`**
  resolves either form and emits a deterministic long-form rationale
  (`detector.description` + `whyItMatters` per detector + the
  finding's evidence + the verbatim `crimes ignore` command line). No
  LLM, no network — same wedge.
- **`Detector.whyItMatters`** populated on every shipped detector
  (17 in total).

### CI gate completion

- **`crimes diff --fail-on new-high | new-medium`** finally lands,
  completing the M4 trio (`scan --changed`, `baseline check`,
  `verdict`, `diff`). Suppressed entries never trip the gate.

### Schema additions (all optional / additive)

- `Finding.suppressed?: true` + `Finding.suppression_reason?: string`
- `*Report.suppressed_count?: number` on `ScanReport`, `ContextReport`,
  `BaselineCheckReport`, `DiffReport`, `VerdictReport`.
- `DiffReport.fail_on?` + `DiffReport.failed?`.
- New report types: `ExplainReport` (`report_type: "explain"`) and on-disk
  `Suppressions` (`report_type: "suppressions"`).
- **No `schema_version` bump.** `crimes@0.4.0` consumers continue to read
  every report without modification.

Per-finding `scores.churn` / `scores.test_gap` / `scores.blast_radius`
remain **deferred** — M2 work touches every detector and deserves its
own release rather than a wedge into the suppressions theme. Tracked
for `0.6.0`.

The wedge stays the same: deterministic, local, JSON-first, no LLM.

---

## ✅ Shipped in `crimes@0.7.0`

> **Theme: calibration and the evidence loop — zero new detectors,
> one new command (`crimes feedback`), plus the `evals/` agentic
> harness so we can measure detector behaviour over time.**
>
> Release notes: [`docs/releases/v0.7.0.md`](./docs/releases/v0.7.0.md).
> Implementation plan:
> [`.planning/archive/0.7.0-calibration-evidence-loop.md`](../.planning/archive/0.7.0-calibration-evidence-loop.md).

### Track A — the dogfood feedback loop

- **`crimes feedback <fingerprint> --verdict {tp|fp|known} --note`** —
  capture per-finding verdicts. `fp` writes a feedback-sourced
  suppression pinned to the current minor; the suppression
  auto-resurfaces on the next minor for re-confirmation.
- **`crimes feedback list / summary / export / recheck`** — read
  paths plus the per-release review surface.
- **Inline `Give feedback: …` hints** under every finding in
  human-format output (suppressed on piped output / `--no-color` /
  when 5+ entries already exist for the detector).
- **Cross-project rollup** at `~/.crimes/feedback-rollup.jsonl` via
  `crimes feedback export --append-global` (dedupes by
  `(repo, timestamp, fingerprint)`).
- **Per-detector release-notes map** powers
  `crimes feedback recheck`'s "In 0.X: <hint>" copy.

### Track B — the eval harness (`evals/`)

- **10 fixtures × 12 scenarios** across 5 scenario kinds
  (refactor / bugfix / review / context / plan).
- **Runner** invokes locally-installed `claude` + `codex` CLIs in
  non-interactive mode against the user's existing subscriptions —
  no API keys, no per-call billing.
- **Structural rubric** scores responses against `expected_artifacts`
  (referenced findings, files, forbidden actions, priority);
  **opt-in `--judge` pass** adds open-ended judging via the same
  `claude` CLI in an evaluator role.
- **`pnpm run evals:replay` + `evals:diff`** + GitHub Actions
  `evals-pr.yml` workflow — replays cached agent outputs against
  the PR's crimes build, posts a markdown diff comment with
  per-agent pass-rate moves (±10% tolerance band).

### Housekeeping (closing §20 dogfood items)

- **`direct_date` skips test files** — closed the §20 false
  positive. Shared `isTestFile()` helper consolidates 8 copies of
  the regex.
- **`reporter/src/human.ts` split** into 10 files under `human/`;
  every file under 200 lines; byte-identical output.
- **`language-js/src/parse.ts` split** into 12 files under `parse/`;
  every file under 250 lines; byte-identical JSON output.

Schema: `schema_version` stays at `"0.1.0"`. New fields are
optional and additive:

- `Finding.previously_suppressed?: true` +
  `Finding.previous_suppression?: { pinned_version, reason }`.
- `SuppressionEntry.source?: "manual" | "feedback"` +
  `SuppressionEntry.crimes_version_pinned?: string`.
- New `FeedbackReport` / `FeedbackRecheckReport` types.

---

## ✅ Shipped in `crimes@0.8.0`

> **Theme: extended lens — four families of "common-sense" crimes
> linters don't catch.** One config feature plus thirteen detectors
> spanning date / time, naming-tier, hot-path / portability, and
> asset crimes. Detector count rises from 34 → 47. Schema unchanged.
>
> Release notes: [`docs/releases/v0.8.0.md`](./docs/releases/v0.8.0.md).

### Per-detector exemption config

- **`detectors.options.<id>`** — per-detector exemption values, sitting
  between `detectors.disable` (kills the detector everywhere) and
  `crimes ignore` (suppresses one specific finding). Each detector
  registers its own zod schema; typos surface at config-load time,
  not scan time. Consumed by every 0.8.0 detector with built-in
  exemption surface (allowlists, threshold tuning).

### Date / time family (5 detectors)

- **`timezone_unsafe_parse`** — flags `new Date("…")` whose string
  literal has no `Z` or `±HH:MM` offset. The runtime applies its
  own timezone, which is rarely the one the literal author had in
  mind. Severity medium-high, confidence 0.90.
- **`mixed_utc_local_methods`** — flags Date instances whose
  `get*UTC*` and `get*` methods are read on the same receiver in
  the same file. Silent bug class: tests pass in UTC, production
  drifts by the host's offset. Severity high.
- **`locale_drift`** — flags `.toLocaleDateString()` / `.toLocaleString()`
  / `.toLocaleTimeString()` invoked without a locale argument. Output
  depends on the host's default locale; user-facing renderers need
  an explicit pick.
- **`dst_naive_arithmetic`** — flags `+ 86400000` / `+ 604800000`
  and folded equivalents (`24 * 60 * 60 * 1000`). Day-level
  millisecond arithmetic silently misfires on DST transitions.
- **`date_string_concat`** — flags `"…" + d.getUTCMonth()` and the
  reverse — hand-rolled date string assembly. Smell rather than
  guaranteed bug, but a tell that the project should reach for
  `Intl.DateTimeFormat` or `toISOString()`.

### Naming-tier family (2 detectors)

- **`boolean_naming_drift`** — flags boolean-typed declarations
  whose name lacks the `is`/`has`/`should`/`can` prefix
  convention. Ships with a built-in React-state allowlist
  (`loading`, `ready`, `active`, `disabled`, …) plus user
  extensions via `detectors.options.boolean_naming_drift.allowedNames`.
- **`singular_plural_type_mismatch`** — flags declarations where
  the name's plural shape disagrees with the type's array shape
  (`users: User`, `invoice: Invoice[]`). v1 fires on bare
  identifier / simple-array annotations only — aliased and generic
  types deferred to 0.9.0 type-info work. Hand-rolled
  pluraliser plus uncountable-noun allowlist.

### Hot-path / portability family (3 detectors)

- **`sync_io_in_hotpath`** — `readFileSync` / `writeFileSync` /
  `execSync` etc. inside route handlers, page exports, React
  components, or domain functions. Consumes a new
  `syncIoCalls` parser surface that captures the chain of
  enclosing function-like ancestors; test-callback and
  CLI-registrar ancestors anywhere in the chain suppress the
  finding.
- **`hardcoded_local_path`** — `/Users/<name>/…`, `/home/<name>/…`,
  Windows `C:\Users\<name>\…` baked into source. Skips test /
  scripts / examples / fixtures dirs. Per-project allowlists.
- **`hardcoded_localhost`** — `localhost:NNNN`, `127.0.0.1:NNNN`,
  `0.0.0.0:NNNN`, `[::1]:NNNN` outside config-style basenames
  (`.env*`, `*.config.*`, `docker-compose*`, `Dockerfile*`,
  README, CHANGELOG) and outside `scripts/` / `examples/` / `docs/`
  / `fixtures/` / `test/` / `tests/`. Per-project allowlists.

### Asset family (3 detectors) — first non-source pass

- **Second-pass asset pipeline.** Source detectors stay on the
  parsed-AST contract; asset detectors run a separate walk over
  `**/*.{png,jpg,jpeg,gif,webp,avif,svg}`. New
  `AssetDetectorContext` carries `{ file, absolutePath, extension,
  byteSize, read(), config }`; the `read()` is lazy and per-file
  cached. The two pools share one `detectors.options.<id>`
  namespace and one `detectors.enable` / `disable` list.
- **`oversized_raster`** — file size against
  `thresholds.assetWeight.{low,medium,high}Kb` (defaults 200 / 500
  / 1000 KB, mirroring Core Web Vitals guidance). Pure-stat
  detector: flagging a 5 MB hero is one syscall.
- **`raster_should_be_vector`** — PNG / JPEG / GIF whose width
  AND height both fit ≤ 64 px. Header-only dimension parse via a
  ~80-line in-tree reader (no `image-size` dependency added; WebP
  / AVIF skipped in v1).
- **`svg_with_embedded_raster`** — SVG containing
  `<image href="data:image/*;base64,…">`. Severity medium for one
  embed, high for two-plus.

### Eval harness expansion

- **Eight new scenarios** across all five scenario kinds — one per
  detector family lands as a `bugfix` / `plan` / `review` /
  `context` / `refactor` exemplar:
  - `refactor-01-plural-mismatch`,
    `context-01-boolean-naming` (naming-tier)
  - `bugfix-01-sync-io-hotpath`,
    `plan-01-hardcoded-local-path`,
    `review-01-hardcoded-localhost` (hot-path / portability)
  - `context-01-raster-icon`,
    `refactor-01-svg-embedded-raster`,
    `review-01-oversized-raster` (assets)
- Total scenarios per agent: **30 → 38**. `verify-scenarios`
  green on all 38.
- **Scorer extended** for the asset pass: `DETECTOR_IDS` now
  unions `builtInDetectors` and `builtInAssetDetectors`, and the
  file-path regex covers asset extensions (`png` / `jpg` / `jpeg`
  / `gif` / `webp` / `avif` / `svg`). Two real measurement bugs
  surfaced during the consolidated re-run; the 0.7.15 baseline is
  the corrected reference.
- **Eval baseline at 0.7.15:** claude 85% structural pass rate
  (essentially flat vs 0.7.8's 84%); codex 74% (down 4pp,
  reflecting the harder new scenarios — codex is genuinely weaker
  on the new bugfix / review scenarios). Captured at
  [`evals/results/0.7.15/`](./evals/results/0.7.15/).

### Parser surfaces added

Additive `ParsedFile` fields — no schema bump, no existing
detector touched:

- **`dateMethodCalls`** (phase 2a) — every `Date.prototype` method
  call with receiver / family (UTC vs local) / line / arg count.
- **`dateArithmetic`** (phase 2a) — every `+` / `-` whose numeric
  operand matches a day / week / month / year millisecond
  constant, including folded `24 * 60 * 60 * 1000`.
- **`dateStringConcats`** (phase 2a) — `"…" + d.dateMethod()` and
  the reverse.
- **`typedDeclarations`** (phase 3a) — every named declaration
  (const / let / var / param / property) with optional type
  annotation text and `InitializerKind`.
- **`syncIoCalls`** (phase 4a) — every node:fs `*Sync` call site
  with the full chain of enclosing function-like ancestors
  (innermost first), letting detectors apply their own shape
  policy without re-walking the AST.

### Crimes-on-crimes self-scan

Self-scan stays clean: zero medium-or-higher findings from any
0.8.0 detector. 18 low-severity `sync_io_in_hotpath` findings
on internal CLI machinery (config loaders, git helpers, scan
orchestration) are intentional surface — visible under `--all`,
hidden from default output. Asset detectors fire zero findings
once `**/fixtures/**` is in the default asset exclude.

Schema unchanged. `schema_version` stays at `"0.1.0"`.

---

## ✅ Shipped in `crimes@0.7.5`

> **Theme: eval-harness graduation and detector trim.** Five
> accumulated calibration patches (0.7.1 → 0.7.5) roll up into a
> single release. The 0.7.0 first-cut eval harness becomes
> production-grade tooling, scenario coverage of the detector
> catalogue rises from 12 / 35 to 33 / 34, and one 0.6.0 detector
> retires because its trigger turned out to be a poor proxy.
>
> Release notes: [`docs/releases/v0.7.5.md`](./docs/releases/v0.7.5.md).

### Eval harness graduation

- **Hardened scorer.** `referenced_findings` now matches by detector
  type AND finding id AND human charge name, not just slug. Cluster-C
  reconciliation completed (~74% of "agent failures" at 0.7.0 were
  rubric vs fixture mismatches, not real misses).
- **Parallelised runs.** Default concurrency = 4; a 50-run matrix
  finishes in ~8 minutes on a single laptop.
- **Scenario↔fixture coverage verifier.** `pnpm --filter evals-runner
  evals:verify-scenarios` enforces that every `referenced_findings`
  entry produces an actual finding on the fixture's scan output.
  Wired into [`.github/workflows/evals-pr.yml`](./.github/workflows/evals-pr.yml).
- **Variance sampling.** `evals:variance` ranks per-scenario mean ±
  stddev across repeat samples (`--label r2`, `--label r3`, etc.).
  Separates agent inconsistency from real detector regressions.
- **Opt-in judge-model pass.** `pnpm run evals -- --judge` adds
  qualitative per-question scoring; complements the structural rubric.
- **End-to-end duration printed on completion.**
- **`--label` flag.** Repeat-run variance sampling no longer burns
  a patch version per sample.
- **Continuous-improvement baseline policy.** Patch bumps for any
  calibration or product change that moves the baseline, no
  Changesets / no tags. Accumulated patches roll into the next real
  release.

### Detector coverage in scenarios (12 / 35 → 33 / 34)

- **13 new scenarios** across all 5 scenario kinds covering 22 of 23
  previously-uncovered detectors. See
  [`evals/scenarios/`](./evals/scenarios/).
- **Fixture 05 extensions** so five previously-silent IA detectors
  now fire: three drifting JSX components (`UserList.tsx`,
  `TeamList.tsx`, `SeatList.tsx`) for action_label_drift /
  copy_ia_drift; admin route + role-mismatched nav + manager-mention
  docs for permission_ia_drift; parallel `admin/billing-plans.ts` for
  parallel_destination; Commander bin + unadvertised doc references
  for command_drift_docs_code_drift.

### Detector trim

- **`visual_regression_review_hint` removed.** Its trigger — file
  churn ≥ 0.7 on a UI `.tsx` file with weak test proximity — was a
  poor proxy: active development trips it as cleanly as regression
  does. Detector count goes from 35 → 34.

### Detector calibration fixes

- **`large_function` priority window** calibrated.
- **`cli_command_registrar` registrar regex** tightened.
- **Inline feedback-hint copy** made version-agnostic.
- **Import resolver** fixed for NodeNext `.js`→`.ts` specifiers —
  several cross-file detectors were silently undercounting because
  the graph was missing edges.

### Crimes-on-crimes (zero remaining structural highs)

- **`packages/cli/src/commands/feedback.ts` split** into write + four
  read subcommands under `feedback/`.
- **`packages/cli/src/commands/context.ts` split** into 4 modules.
- **`classifyShape` refactored** into a chain of `try*` helpers.
- **`analyseRoute` refactored** with extracted source / evidence /
  related helpers.

Scan JSON output byte-identical to pre-split.

Schema unchanged. `schema_version` stays at `"0.1.0"`.

---

## ✅ Shipped in `crimes@0.6.0`

> **Theme: detector and scoring completion — closing M2 (per-finding
> risk model) and M5 (full `/docs` site) plus the long tail of named
> detectors from `PRD.md` §8.**
>
> Release notes: [`docs/releases/v0.6.0.md`](./docs/releases/v0.6.0.md).
> Implementation plan:
> [`.planning/archive/0.6.0-detector-scoring-completion.md`](../.planning/archive/0.6.0-detector-scoring-completion.md).

### Per-finding scores (M2 completion)

- **`scores.blast_radius`** — normalised transitive-importer count,
  derived from the new import graph.
- **`scores.churn`** — normalised commits-in-window count, same
  saturation curve as `crimes hotspots`.
- **`scores.test_gap`** — three-tier signal from filesystem layout
  plus import-graph test discovery.
- **Unified `agent_risk` formula** — replaces hand-rolled per-detector
  weighting. Documented in [`docs/scoring.md`](./docs/scoring.md).

### Shared infrastructure

- **Import graph** under `packages/core/src/imports/` — language-pack
  agnostic, built once per scan, consumed by dependency-graph
  detectors and `scores.blast_radius`. Carries `imports_limited` on
  the `ScanReport` when the graph hit its performance budget.
- **JSX inspection layer** under `packages/core/src/jsx/` — shared by
  every frontend detector.
- **AST hashing** under `packages/core/src/ast-hash/` — backs
  `exact_duplicate_block`, `near_duplicate_block`,
  `duplicate_component_shape`.
- **Scoring data sources** under `packages/core/src/scoring/` —
  finalises every finding's score in one place; degrades gracefully
  when git or the import graph are unavailable.

### New detectors (18 total)

- **Architecture / dependency graph** (4): `layer_violation`,
  `circular_dependency`, `deep_import`, `high_fan_in_fan_out`.
  `layer_violation` consumes `architecture.layers` +
  `architecture.rules` (graduated from "reserved" in 0.5.0).
- **IA completion** (5): `orphaned_destination`,
  `parallel_destination`, `permission_ia_drift`,
  `action_label_drift`, `command_drift_docs_code_drift`.
- **Frontend / UI agent-risk** (5): `design_token_escape`,
  `accessible_interaction_risk`, `duplicate_component_shape`,
  `responsive_fragility`, `copy_ia_drift`. (Originally shipped six —
  `visual_regression_review_hint` removed in 0.7.5; its churn-based
  trigger was a poor proxy for "needs visual review".)
- **Duplication** (3): `exact_duplicate_block`,
  `near_duplicate_block`, `duplicated_role_status_plan_check`.

### Shape-aware `cli_command_registrar`

A new `large_function` shape recognises Commander-style
`register*Command(program)` wrappers and their `.action(...)`
callbacks. Threshold 200, severity caps at `low` / `medium` — fixes
the dominant false-positive cluster from the 0.5.0 dogfood signal.

### `crimes hotspots <subdir>` enclosing-repo lookup

Running `crimes hotspots packages` from a monorepo root now walks
upward to find the enclosing git repo, runs `git log` with a
pathspec scoped to the passed directory, and re-roots emitted paths
relative to the scan root. Subdirs of a git repo no longer collapse
to severity-only ranking.

### M5 — full `/docs` site

[`crimes.sh/docs/`](https://crimes.sh/docs/) — Astro + Starlight
mounted at `/docs/`, every existing markdown page in
[`docs/`](./docs/) routed under the new tree. The landing page at
`crimes.sh/` is unchanged — `apps/website/landing/` holds the
static files, `apps/website/src/content/docs/` is generated from the
repo's `docs/` tree at build time.

### Polish

- **`detectors.disable` breadcrumb** — `crimes scan` / `context` /
  `diff` emit a one-line stderr notice when `crimes.config.json`
  disables ≥ 3 detectors. Suppressed when stdout is piped or
  `--no-color` is set.

### Schema additions (all optional / additive)

- New `Finding.type` values for the 18 new detectors above.
- `Finding.scores.blast_radius` / `scores.churn` / `scores.test_gap`
  graduate from "reserved" to "populated by every scan".
- `ScanReport.imports_limited?: true` + `imports_limited_reason?:
  string` when the import graph hit its performance budget. Mirrors
  `HotspotsReport.history_limited` from 0.4.0.
- **No `schema_version` bump.** `crimes@0.5.0` consumers continue to
  read every report without modification.

The wedge stays the same: deterministic, local, JSON-first, no LLM.

---

## 🚧 Planned for later versions

### `0.4.0+` candidates

- **Dependency graph detectors:** circular dependencies, deep imports,
  layer violations driven by `architecture.layers` config.
- **Duplication detectors:** exact and near-duplicate blocks, repeated
  string literals, duplicated role / status / plan checks.
- **Test-proximity-as-risk** feeding into `hotspots` and per-finding
  `test_gap` scoring.
- **Frontend agent-risk detectors:** UI / UX findings that predict fragile
  edits, design-system drift, or user-facing regressions. This is not a
  taste engine or visual-design grader; findings must stay deterministic,
  evidence-backed, and tied to change risk.
- **Information architecture detectors:** product-structure findings that
  reveal concept drift, route / navigation drift, ambiguous sources of
  truth, orphaned destinations, or fragmented workflows. This extends the
  agent-risk thesis into product taxonomy: can a human or agent tell what a
  thing is called, where it belongs, and which implementation owns it?
- **Petty crimes follow-ups:** repeated domain literals, weak tests, option
  bag junk drawers, return-shape roulette, and negative flag mazes. See
  [`.planning/archive/0.3.0-petty-crimes.md`](../.planning/archive/0.3.0-petty-crimes.md). This track must stay
  out of style-lint territory: no tabs-vs-spaces, import-order, or generic
  formatting rules.
- **`crimes ask "..."`** — heuristic / LLM-assisted question answering (v1+).

### Frontend / UI risk candidates

These are worth exploring if they stay inside the core `crimes` thesis:
**where is future change likely to go wrong, and what should a human or
agent know before editing?** They should not become generic aesthetic lint
rules, and they should avoid duplicating tools like axe, Lighthouse,
Storybook, Chromatic, ESLint, or design-token linters.

- **Design Token Escape:** hard-coded colors, spacing, shadows, radii,
  z-indexes, or breakpoints in app components when local tokens or theme
  variables already exist. Agent value: discourages one-off UI patches that
  bypass the design system.
- **Duplicate Component Shape:** repeated JSX / template structures for
  buttons, cards, forms, modals, tables, empty states, and similar shared UI.
  Agent value: points agents toward existing primitives before they create
  another near-copy.
- **Accessible Interaction Risk:** clickable non-buttons, icon-only controls
  without accessible labels, custom controls without obvious keyboard
  affordances, or dialogs without focus-management signals. Agent value:
  flags UI surfaces that are easy to regress during small edits.
- **Responsive Fragility:** fixed widths, viewport-scaled typography,
  absolute-positioned copy over dynamic content, hard-coded grid columns
  without mobile alternatives, or tables/cards without an overflow strategy.
  Agent value: tells agents when a visual change needs mobile inspection.
- **Copy / IA Drift:** inconsistent labels for the same action or domain
  concept, duplicated empty-state copy, hard-coded plan / role / status text,
  or UI copy that appears to encode business rules. Agent value: surfaces
  ambiguous sources of truth before another label or rule is duplicated.

Initial frontend detector priority, if this track is promoted:

1. **Design Token Escape** — easiest to make deterministic and low-noise.
2. **Accessible Interaction Risk** — high practical value, but keep it to
   agent-risk signals rather than a full accessibility scanner.
3. **Duplicate Component Shape** — larger implementation surface, but likely
   strong differentiation once near-duplicate JSX detection is in place.

### Information architecture risk candidates

IA crimes are especially aligned with `crimes` because they expose product
structure drift before it turns into duplicated code, conflicting business
rules, or agent confusion. The detector should not judge whether the product
taxonomy is "good"; it should surface evidence that the repo contains
multiple competing answers to the same structural question.

- **Concept Alias Drift:** the same domain concept appears under multiple
  names across identifiers, routes, headings, translation keys, constants,
  docs, and tests. Examples: `organization` / `workspace` / `team` /
  `account`, or `plan` / `tier` / `subscription` / `package`. Agent value:
  prevents new edits from choosing the wrong vocabulary or duplicating a
  rule under another name.
- **Route Metadata Drift:** route paths, nav labels, page titles,
  breadcrumbs, component names, and file names disagree. Example:
  `/settings/billing` is labelled "Plans", headed "Subscription", and
  implemented by `PricingPage.tsx`. Agent value: tells an editor to inspect
  the whole destination before renaming, moving, or extending it.
- **Duplicated Navigation Source:** nav arrays, route registries,
  breadcrumbs, sitemap metadata, and sidebar definitions repeat the same
  destination data in multiple files. Agent value: identifies which source
  may be stale before an agent updates only one copy.
- **Orphaned Destination:** page, route, or screen files exist but are not
  reachable from primary navigation, route registries, sitemap metadata, or
  internal links. Agent value: warns that a file may be abandoned or
  non-canonical before treating it as the source of truth.
- **Parallel Destination:** multiple pages or flows appear to serve the same
  user intent. Examples: `/billing`, `/settings/billing`, and
  `/account/subscription`, or `InviteUserModal` and
  `AddTeamMemberDialog`. Agent value: forces a source-of-truth decision
  before another parallel implementation is extended.
- **Workflow Fragmentation:** one user journey is scattered across
  unrelated route branches or folders, such as onboarding logic split across
  `signup`, `settings`, `profile`, and `team`. Agent value: adds
  `related_files` context for changes that otherwise look local but are
  really journey-wide.
- **Action Label Drift:** the same action or object is labelled differently
  across UI copy and code, such as "Delete", "Remove", and "Archive" for
  the same operation, or "User", "Member", and "Seat" for the same actor.
  Agent value: catches semantic drift that often precedes duplicated
  conditional logic and inconsistent UX.
- **Permission IA Drift:** navigation, route guards, docs, and policy code
  describe access using different roles or concepts. Example: nav visible
  to `admin`, route guarded by `owner`, UI says "Team settings", and code
  checks `organization.manage`. Agent value: highlights auth vocabulary
  mismatches before a change leaks or hides product areas.

Initial IA detector priority, if this track is promoted:

1. **Concept Alias Drift** — highest differentiation and directly supports
   source-of-truth discovery.
2. **Route Metadata Drift** — concrete, evidence-backed, and easy to explain
   in PR comments.
3. **Duplicated Navigation Source** — likely low-noise in apps with route
   config or sidebar arrays.
4. **Orphaned Destination** — useful cleanup signal once route discovery is
   mature.
5. **Parallel Destination** — high value, but probably needs near-duplicate
   name / route / component-shape scoring to avoid noisy guesses.

### Distribution (later)

- Homebrew tap and standalone binaries (M6) — deferred until the CLI
  surface stabilises through `0.2.0` and `0.3.0`.

---

## Why this slice for 0.2.0

In rough leverage order — these unlock the most product value once
`crimes scan` is in users' hands:

1. **`crimes diff base...HEAD` + baseline (M4)** so CI can fail only on
   **new** high findings without drowning teams in legacy debt. This was
   the single highest-impact feature still missing from the PRD's M4
   bundle, and the one most CI integrations were waiting on.
2. **`crimes verdict`** because it turns the same diff signal into a
   one-line "did this branch help or hurt?" answer that fits a PR
   comment or an agent's end-of-task summary.
3. **`crimes scan --changed --fail-on`** — the cheapest CI gate, narrow
   by design, useful in repos that already have zero findings or in
   agent loops that want to fail fast on their own diff.
4. **CI docs** because shipping the gating commands without a copy-paste
   GitHub Actions recipe leaves users to guess at the integration.
5. **Schema / report consistency pass** so the new on-disk artefact
   (`.crimes/baseline.json`) and the new `VerdictReport` / `DiffReport`
   shapes carry the same `schema_version` and a `report_type`
   discriminator from day one — stable contract discipline.

After `0.2.0`, the next bottleneck shifts back to **detector signal**: the
richer per-finding scores and cross-file relationships that `0.3.0`
targets.
