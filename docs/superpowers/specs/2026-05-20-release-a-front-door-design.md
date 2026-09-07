# Release A: Front-door redesign (design spec)

**Status:** approved design, pre-plan. Next step is the implementation plan
written by `superpowers:writing-plans`.

**Authors:** Andrew Mayfield + Claude (brainstorming session 2026-05-20).

**Companion docs**

- `PRD.md`: authoritative product spec; this design must not contradict it.
- `CLAUDE.md`: coding/governance constraints (signal over exhaustiveness,
  schema-as-contract, evidence-before-judgement, eval baseline policy).
- `evals/README.md` § Versioning policy: between-release patch bumps,
  Changeset cut at release time.
- Release B (parallel worktree): new `triage` command + finding-schema
  additions. This release freezes two contracts it depends on.

---

## 1. Background

Two unprompted agent users tested `crimes` on real repos and converged on
the same failure mode:

1. First `crimes scan` on a 200-finding repo prints a flat, severity-grouped
   list of 100–300 findings.
2. The user reflexively runs `crimes baseline save` to silence it.
3. The tool collapses into a diff-only gate and real debt freezes forever.

Triage of the user reports established that PRD §9 ("show top findings
only") is not the problem: `formatHumanReport` already caps at 10 and
renders a `Run with --all` hint
(`packages/reporter/src/human/scan.ts:16,37,56`). The complaint is
downstream of that cap: even ten findings, scattered across ten files,
grouped only by severity, with `scripts/_probe-*.ts` mixed in next to
domain code and `test gap 1.00` on every line, doesn't help anyone decide
what to do next.

## 2. Principle

> Help the user make a decision, don't hand them data.

## 3. Success criterion

A fresh user running `crimes scan` on a 200-finding repo either fixes
something concrete or reaches for `crimes context <file>`. They do **not**
feel the impulse to reach for `baseline` immediately.

## 4. Non-goals for this release

- New detectors. Detector taxonomy is frozen for Release A.
- Schema-breaking changes. `schema_version` stays at `0.1.0`; every new
  field is additive.
- Marketing-site copy. README + `--help` + `docs/agent-usage.md` are in
  scope; `apps/website/` is a separate pass after Release B lands.
- The `triage` command, finding-schema secondary scores, or anything else
  Release B is shipping. We freeze the two contracts they depend on
  (`context.clues` shape, `scopeTiers.nonDomain` config key) and stop
  there.

## 5. Decisions made

Each decision below was selected from concrete alternatives during the
brainstorming session. Rationale captured here so future maintainers can
re-litigate if needed.

<span id="51-new-scan-layout--file-grouped-compact-lines"></span>

### 5.1 New scan layout: file-grouped, compact lines

`crimes scan` defaults to a file-grouped layout. Per shown file: a header
line with severity glyph, repo-relative path, finding count, and
high/medium tally; then one compact line per finding (`charge · symbol
key-evidence`); then a single "Risk:" line summarising the file's churn
band, test-gap quartile, and blast radius; then ids. No per-finding
Charge/Summary/Evidence/Feedback blocks in the default view: those still
appear in `crimes scan --all` and `crimes context`.

A mock of the default view:

```
CRIME SCENE REPORT
repo: acme-app  ·  173 findings across 47 files

Top files by risk

🚨 src/billing/invoice.ts                       4 findings · 2 high
   1. God Function · generateInvoice()        214 lines, 6 awaits, 3 tables
   2. Duplicated Policy Logic · isOwner       role check in 4 sites
   3. Temporal Recklessness                   UTC + local mixed
   4. Direct Date.now() in domain             ln 187
   Risk: churn high · test gap top-quartile · blast 0.72
   id=crime_01982 … crime_01985

⚠️ src/api/users.ts                             3 findings · 1 high
   1. Duplicated Policy Logic · canEdit       role check in 11 handlers
   2. Large Function · postUser()             92 lines
   3. Hard-Coded Clock                        new Date() ln 41
   Risk: churn high · test gap top-quartile · blast 0.55

🔎 src/lib/date.ts                              2 findings · 0 high
   1. Mixed Temporal Module                   utc + local + offsets
   2. Repeated Magic Literal ('+08:00')       7 sites

(2 more file blocks elided in this mock — default top-N is 5)

Showing 5 of 47 files. Run with --all for every finding.

Also flagged elsewhere
  scripts/  6 findings    examples/  3 findings    tests/  12 findings
  Run with --all to see them.

→ Start with `crimes context src/billing/invoice.ts` — it concentrates the most risk.
```

Rationale: file-grouped is the smallest layout change that turns the
report from a finding catalogue into an editing plan. The compact line is
deliberately information-dense: agents already get the full Finding
shape from `--format json`; humans in the terminal want one row per crime
they can scan.

<span id="52-ranking--top-k-by-σ-rank_score-displayed-as-severity-counts"></span>

### 5.2 Ranking: top-K by Σ rank_score, displayed as severity counts

**Rank**: sort files by `Σ rank_score`, where `rank_score` is defined in
§5.3 as `agent_risk × (1 + recency × 0.5)`. When git is unavailable the
multiplier collapses to 1, so this reduces to `Σ agent_risk` exactly.
The agent_risk score itself already encodes severity + confidence +
churn + test_gap + blast_radius (see `scoring/build.ts` §4.4); recency
adds a "stop the bleeding" boost on top.

**Display**: per-file header line shows severity tally
(`4 findings · 2 high`), not the agent_risk number. Humans read severity
counts fluently; `0.71` requires a calibration in the reader's head.

**Top-N default**: 5 files. Override with `--top N` (CLI) or `scan.topFiles`
(config). `--all` shows every finding from every file as in
§5.5; `--flat` reverts to today's severity-grouped flat list.

<span id="53-recency-weighted-ranking--multiplicative-on-agent_risk"></span>

### 5.3 Recency-weighted ranking: multiplicative on agent_risk

`rank_score = agent_risk × (1 + recency × 0.5)`

where `recency ∈ [0,1]` is `1.0` for files with a commit ≤ 7 days ago,
linearly decaying to `0.0` at 14 days, and `0` thereafter. A cold
high-risk file (`agent_risk 0.80`) still ranks above a warm low-risk file
(`agent_risk 0.40` → `rank_score 0.60`); a warm high-risk file dominates.

When git is unavailable, `recency = 0` for every file (no-op): same
graceful degradation pattern `hotspots` already uses. `--no-recency`
disables the multiplier explicitly.

`rank_score` is **not** added to the `Finding.scores` JSON contract; it's
a render-time derived field. (Detectors don't compute it, and bumping the
schema for a sort key feels wrong.)

<span id="54-test-gap-signal--repo-relative-quartile-rank"></span>

### 5.4 Test-gap signal: repo-relative quartile rank

`scoring/build.ts` already computes a raw test-gap value per file
(`{0, 0.5, 1.0}`). Most repos have so few files at `0` that 80%+ of
findings emit `test gap 1.00`: meaningless noise.

**Fix**: a quartile-rank pass on the raw distribution after raw collection
but before `agent_risk` is computed:

```
raw = rawTestGap(file)        // {0, 0.5, 1}, as today
sorted = all_files.map(rawTestGap).sort()
percentile = rank(raw, sorted) / sorted.length
score = quartile(percentile)  // {0, 0.25, 0.5, 0.75, 1.0}
scores.test_gap = score
```

The field stays `[0,1]` so the `agent_risk` formula keeps the same
weights. Human display switches phrasing:

- `score ≥ 0.75` → `"top-quartile"` (worst-covered)
- `0.25 < score < 0.75` → `"~median"`
- `score ≤ 0.25` → `"bottom-quartile"` (well-covered)

**Behavioural change visible to JSON consumers.** Same field, same range,
different distribution. Flagged in release notes; not a `schema_version`
bump because `finding.ts:31` already labels these scores "ordinal: may
shift between minor releases" and we are within that contract.

**Small-repo fallback**: when fewer than 4 files are scanned, no quartile
is meaningful. `score` falls back to `raw`; `clues.test_gap.label` is
`"unknown"`; `clues.test_gap.percentile` is omitted from
`crimes context --json`.

**Tiebreak**: many files have identical raw test-gap (all `1.0`, all
`0.5`). The quartile pass uses a "midpoint of the tied range" rule:
all files tied at a raw value get the average percentile of the contiguous
block they occupy in the sorted array. This is deterministic, matches
the standard `rank-avg` behaviour, and avoids the alternative pathology
where 80% of files end up at `1.0 → quartile 1.0` because tied entries
were assigned the *highest* rank in the tie.

<span id="55-scope-aware-folder-tiers--domain-vs-non-domain"></span>

### 5.5 Scope-aware folder tiers: domain vs non-domain

New config key `scopeTiers.nonDomain: string[]` (globs). Findings whose
`file` matches any pattern are tagged `tier: "nonDomain"`; the rest are
`tier: "domain"`.

Defaults the generator emits when init runs (only patterns whose target
exists in the repo are included; the test-file globs are always
appended):

```json
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
```

Default `crimes scan`:

- Top-N files come from `tier === "domain"` only.
- If at least one non-domain finding exists, a single "Also flagged
  elsewhere" footer renders per-prefix counts (dimmed):
  `scripts/  6 findings    examples/  3 findings    tests/  12 findings`.
- The footer's first segment is always the count, not the names of the
  individual files: it's a pointer, not a section.

`crimes scan --all` flattens both tiers into a single ordered list
(today's `--all` semantics, just with the new ranking). There is **no**
separate `--include-non-domain` flag; `--all` covers it.

Backwards compat: when an existing `crimes.config.json` doesn't set
`scopeTiers.nonDomain`, the scanner applies a **static** default list at
runtime: all seven patterns shown above, unconditionally. (Repo
inspection only happens at *init* time, not on every scan.) Users opt
out by setting `scopeTiers.nonDomain: []` explicitly.

<span id="56-action-close--top-file-imperative-always"></span>

### 5.6 Action-close: top file imperative, always

If `findings.length > 0`, the report ends with:

```
→ Start with `crimes context <topFile>` — it concentrates the most risk in this scan.
```

where `<topFile>` is the #1 file by `rank_score` **among domain-tier
findings**. No percentage. No multi-file phrase. Empty report keeps the
existing `✨ No crimes detected. Suspiciously clean.` green line.

**All-non-domain edge case**: when every finding is in non-domain (e.g.
fixtures-only repo, or `scopeTiers` mis-configuration), the top-N file
list is empty. The action-close falls back to pointing at the
heaviest non-domain file, with phrasing adjusted: `→ Start with
\`crimes context <topFile>\`: every finding is in non-domain folders;
review your scopeTiers config if that surprises you.`

The full numeric summary (`Total 173 · high 23 medium 91 low 59`) moves
behind `--show-summary` (off by default) but remains in JSON output:
agents still get the structured count via `report.summary`.

<span id="57-context---json--add-clues-wrapper"></span>

### 5.7 `context --json`: add `clues` wrapper

`ContextReport` gains an optional `clues` object. Frozen shape (Release B's
PreToolUse hook will parse this):

```json
{
  "clues": {
    "churn": {
      "commits_90d": 14,
      "last_commit_at": "2026-05-18T12:30:00Z",
      "unique_authors_90d": 3
    },
    "suppressions": [
      {
        "fingerprint": "abc123…",
        "detector": "large_function",
        "reason": "Legacy billing module, rewrite planned in Q3.",
        "pinned_version": "0.9.x",
        "matches_current_finding": false
      }
    ],
    "test_gap": {
      "raw": 1.0,
      "percentile": 0.85,
      "label": "top-quartile"
    },
    "related_signals": []
  }
}
```

**Omission rules**:

- `clues.churn` omitted when git is unavailable.
- `clues.suppressions` omitted when the file has no suppression entries
  (regardless of whether they currently match a finding).
- `clues.test_gap.percentile` omitted in small-repo fallback (§5.4);
  `clues.test_gap.label` is `"unknown"` in that case.
- `clues.related_signals` is always present, always `[]` in Release A:
  reserved seam for Release B's triage workflow.
- `clues` itself omitted when all three of `churn`/`suppressions`/`test_gap`
  would be empty.

`crimes context` (human) renders `clues` between the existing "Likely
tests" block and "Findings" block. Per-file row in `Risk profile` swaps
the numeric `test gap 1.00` for the quartile label.

`schema_version` does not bump. `clues` is additive.

**Note for the implementer**: today's `collectChurn`
(`packages/core/src/git/churn.ts`) only returns `changeCount` per file.
Producing `last_commit_at` and `unique_authors_90d` requires extending
that collector (additional `--pretty=format` fields, or a follow-up
`git log` per file). The extension is part of this release's scope, not
out-of-band.

<span id="58-auto-init-on-first-run--two-prompts-agent-aware"></span>

### 5.8 Auto-init on first run: two prompts, agent-aware

**Trigger** (any subcommand except `init`, `feedback`, `ignore`,
`baseline`, and `unignore`):

```
trigger if all true:
  not exists(crimes.config.json)
  not exists(.crimes/.skip-init)
  process.stdout.isTTY
  process.env.CI is unset
  --no-init flag absent
```

**Agent detection** (in order, first match wins):

1. `process.env.CLAUDECODE` or `process.env.CLAUDE_CODE` set → `claude`
2. `process.env.OPENAI_CODEX` or `process.env.CODEX_AGENT` set → `codex`
3. `exists('.claude/')` → `claude`
4. `exists('.agents/')` → `codex`
5. otherwise → `none` (skip the skill prompt entirely)

**Prompt flow** (two independent prompts):

```
$ crimes scan
No crimes.config.json found. Generate one for this repo? [Y/n] y
  Wrote crimes.config.json (detected: monorepo, scripts/, examples/).

Write .claude/skills/crimes/SKILL.md so Claude Code discovers
crimes for future sessions? [Y/n] y
  Wrote .claude/skills/crimes/SKILL.md.

Continuing with `scan` …
CRIME SCENE REPORT
…
```

- Decline either prompt → write `.crimes/.skip-init`, future runs skip
  the prompt block. Skip-init covers both prompts; declining the config
  but accepting the skill (or vice versa) on first run is allowed in the
  same session.
- The second prompt only fires if agent detection returned something
  other than `none`. Each session writes at most one skill, for the
  detected agent. Never both. When both `.claude/` and `.agents/` exist
  but no env var is set, detection priority 3 wins (Claude) and Codex
  is *not* prompted in the same session: a user who wants both still
  runs `crimes init --agents` explicitly. Existing `crimes init
  --agents` retains its current behaviour (writes both): auto-init is
  the conservative path.
- `--init` global flag re-enters the prompt block even when
  `crimes.config.json` exists (useful when user declined and changed
  their mind, or added a new agent dir).
- `--no-init` global flag suppresses the whole block.
- CI (`process.env.CI`), non-TTY (`!process.stdout.isTTY`), or user abort
  (SIGINT during the prompt): no files written, no marker, exit code 130
  on SIGINT. The original command does **not** run after a SIGINT: we
  treat it as cancel-the-whole-invocation.

**Generated config (medium detection)**:

- Always emits the same overall shape as today's `STARTER_CONFIG`.
- Generated content driven by repo inspection:
  - **scopeTiers.nonDomain**: only patterns whose target exists in the
    repo, plus the standard `**/*.test.*` / `**/*.spec.*` globs.
  - **include**: stays `'**/*.{ts,tsx,js,jsx,mjs,cjs}'` unless **no**
    `.js`/`.jsx`/`.mjs`/`.cjs` file is discovered anywhere, in which
    case tightens to `'**/*.{ts,tsx}'`.
  - **exclude**: appends `'**/.next/**'` and `'**/.vercel/**'` if a
    `next.config.*` file exists; appends `'**/dist/**'` if a
    `vite.config.*` file exists (the default already excludes `dist/`
    but the comment-level marker helps).
  - **No threshold tuning, no detector toggles, no LOC-based logic.**
    Medium detection only changes globs.
- `--no-detect` flag (on `crimes init` only) bypasses detection and
  writes the pure static template; auto-init never sets this.

<span id="59-docs-reorder--context-first"></span>

### 5.9 Docs reorder: context-first

Scope:

- `README.md`: quick-start swaps order: `context` headline command,
  `scan` second, `verdict` third. "What it finds" section unchanged.
- `packages/cli/src/index.ts` `welcomeBanner()`: first listed command
  becomes `crimes context <file>`; `crimes init --agents` follows.
  `addHelpText("after", ...)` similarly reorders.
- `docs/agent-usage.md`: restructure to `context → scan → verdict` flow;
  body content reused, just reordered.

Not in scope: `apps/website/`, `docs/releases/`. Release B will add
`triage` to the front-door triad; the marketing site gets its own pass
afterwards.

## 6. Architecture summary

| Package | New file(s) | Modified file(s) |
|---|---|---|
| `@crimes/core` | n/a | `scoring/build.ts`, `scan.ts`, `context.ts`, `config.ts`, `finding.ts` (only doc comments) |
| `@crimes/language-js` | n/a | n/a |
| `@crimes/reporter` | n/a | `human/scan.ts`, `human/context.ts`, `human/shared.ts` |
| `@crimes/cli` | `commands/auto-init.ts` (or `auto-init.ts` at the top level), `commands/init-detect.ts` | `index.ts`, `commands/scan.ts`, `commands/context.ts`, `commands/init.ts` |
| Docs | n/a | `README.md`, `docs/agent-usage.md` |
| Tests | many `*.test.ts` siblings | snapshot updates throughout reporter |

## 7. Data flow

```
discoverFiles
  → buildScoringContext (now includes recency window + test_gap quartile pass)
  → run detectors (unchanged)
  → finaliseFindingScores (agent_risk recomputed with quartile test_gap)
  → tag each finding with tier from config.scopeTiers (new)
  → derive rank_score = agent_risk × (1 + recency × 0.5) (render-time only)
  → reporter:
      group findings by file (domain tier)
      sort files by Σ rank_score desc
      truncate to topFiles (default 5)
      render "Also flagged elsewhere" footer if any non-domain findings
      render action-close pointing at top file
```

JSON path is unchanged in shape for `scan` (already returns
ScanReport); `context` gains `clues`. Agents that previously
`cat | jq` against `findings[]` see no breakage; they may opt in to
`clues` when ready.

## 8. Error / edge handling

Cataloged in the decisions above; gathered here for the implementer:

| Scenario | Behaviour |
|---|---|
| Git unavailable | `recency = 0` (no multiplier); `clues.churn` omitted |
| Fewer than 4 files scanned | test_gap quartile not computed; `score = raw`; `label = "unknown"`; `percentile` omitted |
| No `scopeTiers` in existing config | Default pattern list applied; users opt out via `scopeTiers.nonDomain: []` |
| `crimes scan --flat` | Today's flat-by-severity behaviour exactly; no tier section; no file headers; no action close |
| Auto-init: CI / non-TTY / `--no-init` | Skip silently, run original command |
| Auto-init: SIGINT during prompt | No writes, no marker, exit 130, original command does NOT run |
| Auto-init: declined | Write `.crimes/.skip-init`, no further prompts in this repo unless user passes `--init` |
| `--all` with non-domain findings | All findings included, in `rank_score` order; tier section absent |
| No findings at all | Existing `✨ No crimes detected.` line; no action-close |
| `Finding.scores.test_gap` field consumers | Same field, same range, different distribution; release notes call this out |

## 9. Testing strategy

- **Unit (Vitest)**: new tests:
  - `scoring/build.test.ts`: quartile pass on synthetic distributions,
    N<4 fallback, recency window math, git-unavailable degradation.
  - `scan.test.ts`: tiering via globs, `topFiles` truncation, action
    close presence, `--flat` parity with pre-release output (snapshot).
  - `context.test.ts`: `clues` shape, omission rules
    (no-git / no-suppressions / small-repo), deterministic ordering.
  - `auto-init.test.ts`: detection priority, CI / non-TTY / `--no-init`
    suppression, marker file lifecycle, SIGINT abort cleanup, `--init`
    re-entry.
  - `init-detect.test.ts`: monorepo / Next.js / TS-only signals → expected
    include/exclude/scopeTiers output.
- **Reporter snapshots**: rewrite scan snapshots for the new layout;
  add context snapshots covering `clues` rendered and omitted; keep one
  snapshot of `--flat` to detect regression of the legacy path.
- **Smoke (`pnpm --filter crimes smoke`)**: assert (a) bare `crimes scan`
  produces a file-grouped report on the messy-ts-app fixture and ends
  with an action-close line; (b) `crimes context <file> --format json |
  jq .clues` returns a non-null object on a file with churn; (c) the
  smoke environment (non-interactive) does NOT trigger auto-init.
- **Evals**: every commit that changes finding ordering (ranking,
  recency, test_gap, tiering) or `agent_risk` math (test_gap quartile
  re-rank) patch-bumps `packages/cli/package.json` and re-runs
  `pnpm run evals`. New baseline directory under `evals/results/<v>/`
  committed alongside. Changeset only at the end of the release.

## 10. Versioning and release procedure

Per `evals/README.md` § Versioning policy:

- Each between-release commit that affects findings or scoring patches
  the CLI package version, no Changeset, no tag, eval baseline directory
  committed alongside.
- At the end of the release, one Changeset describes the bundle as a
  **minor** bump (`0.9.x → 0.10.0`). The accumulated patches roll into
  the minor.
- Commit messages: "calibration change" vs "product change" called out
  when relevant (per CLAUDE.md guidance).

## 11. Coordination with Release B (frozen contracts)

These two surfaces are frozen as of the spec being approved. Release B
should parse against them without further negotiation.

1. **`ContextReport.clues`**: shape in §5.7. Omission rules are part of
   the contract; Release B's PreToolUse hook must treat absent fields
   as "no signal", not as zero. Renames or restructures during Release
   A implementation require an explicit cross-thread sync.

2. **`scopeTiers.nonDomain`**: `string[]` of globs under
   `crimes.config.json`. Release B adds its own keys (`triage.*`)
   without touching this one.

Anything else in this design (the scan layout, action-close, auto-init
flow, recency formula, test_gap quartile semantics) is internal to
Release A and may evolve through implementation without breaking
Release B.

## 12. Open questions

None as of approval. The four open seams from brainstorming (auto-init
trigger scope, no `--include-non-domain` flag, no per-file finding cap,
test_gap semantic change without schema_version bump) are resolved in the
decisions above.

## 13. Definition of done (mirrors the release prompt)

- A fresh user running `crimes scan` on a 200-finding repo sees a focused,
  file-grouped output that ends with a concrete next command, with
  `scripts/`-style noise in a separate section.
- `crimes context <file> --json` returns a stable, documented `clues`
  structure that an agent can `cat | jq` into context with zero parsing.
- `--help` and the README lead with `context`.
- `crimes` on a fresh repo offers auto-init; `--no-init` and CI both
  skip cleanly.
- Test-gap is repo-relative and no longer reads `1.00` for everything.
- Eval suite passes; smoke passes; `pnpm ci` clean.
- One Changeset describing this as a minor release.
