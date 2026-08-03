# Pick up the `crimes` remediation queue after 0.18.0

You're continuing work on `crimes` (`/Users/andrew/dev/crimes`). Every
**blocker** from the 0.14→0.17 dogfooding round is closed. What's left is
the long tail: 4 items surfaced while closing them, 12 "real problems",
9 annoyances, and 5 standing decisions.

## Read these first, in this order

1. `CLAUDE.md` — the product's non-negotiables. The ones that bite:
   JSON output is the contract and a public API; deterministic before
   magical; **evidence before judgement — no verdicts without receipts**;
   signal over exhaustiveness. Biome's `lineWidth: 90` is a
   *measurement* setting, so reformatting changes what the scanner
   reports about itself.
2. `docs/dogfooding/2026-08-03-remediation.md` — the handoff. §4 is the
   queue and is the authority on what's left. §1–1c record what was
   fixed and what it measured. §2 lists what was deliberately left, with
   reasons.
3. `evals/README.md` § Versioning policy — including the
   identity-only carve-out and its `0.17.2`/`0.17.3` rows.

Current version is `0.18.0`, `schema_version` `0.5.0`. Around 2,011
tests. `pnpm verify` green, working tree clean.

---

## How this codebase is worked on

These aren't style preferences. Every commit in the last three passes
follows them and reviewers check.

**Test-driven, genuinely.** Write the failing test, *run it*, confirm it
fails for the right reason, then write the minimal fix. A test that
passes the moment you write it proves nothing. If you catch yourself
adding tests after the code, delete and restart.

**`pnpm verify` before every commit** — build + typecheck + test across
all packages. Run `pnpm run format` first if Biome complains.

**Measure on real repos, not fixtures.** The corpus is at
`~/crimes-dogfood/corpus/` (outside the tree, pinned SHAs in
`SHAS.txt`): `hono` ~8s, `pydantic` ~6s, `drf`, `zulip`, `airflow`,
`mlflow`, `cal.com`, `posthog`, `n8n` (~13 min, whole-repo). Report
before/after numbers. **A null result reported honestly is worth more
than a number massaged upward.**

**Version bumps and evals.** Anything that changes `findings[]` for the
same input gets a patch bump *in the same commit*, then `pnpm run
evals`. The one exception is a change whose entire effect is on finding
*identity* (fingerprints/discriminators) — see the carve-out. Say in the
commit message whether a delta is a **measurement correction** or a
**product delta**; don't let a scorer fix read as an agent improvement.

**Two properties you must not break.** Both are load-bearing and both
have standing tests:
- **Fingerprint uniqueness.** `scan.test.ts` has a mutation-checked
  gate. n8n's residual is 28 of 16,325, all content-identical pairs.
- **Byte-identical re-scans.** Two scans of an unchanged tree produce
  identical JSON (verified on hono, pydantic, n8n `packages/cli`).
  Anything touching scoring, discovery or sort order can break this —
  re-check it with `cmp`.

---

## Four lessons from the last three passes. Please actually apply them.

**1. A queue entry is a hypothesis, not a fact.** Three of the four
blocker entries contained a claim that didn't survive contact:
blocker 1's motivating example was already handled; blocker 2's
".gitignore" half was obsolete when written; blocker 4 credited
`explain` with being honest when it wasn't. Blocker 3's headline number
was mostly a measurement artifact — 202 was really 4. **Reproduce each
item before fixing it, and say so when the entry is wrong.** The
strikethroughs in §4 are the format.

**2. Scope changes what you can see.** `duplicated_policy` collided on
fingerprints at *package* scope and not at *repo* scope, because it
anchors on its group's lex-first file. A whole-repo measurement declared
the class closed while it wasn't. Measure at more than one scope before
claiming anything is finished.

**3. Watch out for stale measurements in the doc.** Several numbers were
taken before intervening fixes. If you're about to quote a figure from
§4, re-measure it or mark it unverified — don't propagate it.

**4. If you fan out to subagents:** check the worktree base is current
`main` before trusting their work (the last batch branched 31 commits
behind, which produced one false finding and one failing test built on a
behaviour that had already changed). Handle version bumps centrally —
parallel agents all editing `packages/cli/package.json` is a guaranteed
conflict.

---

## The work, in the order I'd do it

### Tier 1 — cheap, contained, in code just touched

- **§4b — nested `test_*` functions counted as tests.**
  `weak_test_signal` treats any `test_*`-named function as a test
  regardless of nesting, so a `def test_view(request)` declared *inside*
  a real test is reported as a silent test. **9 of 23** survivors in
  zulip's `test_message_delete.py`, **5 of 71** in `test_decorators.py`.
  Exclude a `test_*` whose span sits inside another test's.
- **§4c — `pytest.warns(...)` uncredited** though `pytest.raises` is;
  it fails when the warning isn't emitted, so it's the same thing.
  **36 occurrences** in pydantic. Same shape: `@pytest.mark.xfail`,
  where the expectation of failure *is* the assertion.
- **§17 — `--all` is a byte-for-byte no-op in `--format json`** while
  the human output advertises it.
- **§19 — `explain` exits 2 on `oversized_raster`**, a type the scanner
  emits; its copy-paste `crimes ignore` block isn't shell-safe.
- **§22 — no `fingerprint` field in the JSON**, though four commands
  require one. `fingerprintFinding` is already exported from core.
- **§20 — `verdict` fails on `master`-default repos** (tries only
  `origin/main`, `main`) and costs two full scans to say "unchanged".

### Tier 2 — detectors that are confidently wrong

Each of these produces high-volume or high-severity output that is
simply incorrect. **Reproduce on the named repo first.**

- **§7 — `commented_out_code` matches English prose.** 8,019 findings on
  airflow; **41.1% of the entire report is the Apache licence header**
  (7,320 at line range `(1,16)`/`(1,17)`). Every Apache-licensed repo
  hits this. Also flags Rust `///` doc comments.
- **§16 — `cross_language_route_drift` is confidently wrong.** On
  PostHog its 28 "backend routes" came entirely from two sidecar
  services and zero from PostHog's own Django/DRF API, because it
  matches decorator routing only. The `backend.length === 0` guard that
  would have suppressed it was defeated by those sidecars. Result: a
  high-severity finding comparing PostHog's test suite to a Stripe mock.
  (`cross_language_type_drift` is the 0.15 release's genuine success —
  keep it.)
- **§10 — `pass_through_abstraction` fabricates chains from method
  names.** Confidence *rises* with the number of unrelated files joined
  (0.92 across three repos on `delete`, 0.98 across four on `has`). The
  single-file arm is a different code path and looks sound.
- **§11 — `parallel_destination`: 2,819 findings from 134 files**, 53%
  of one n8n package, pairing Vue composables on the token `use`. Zero
  on every other repo. Strongest default-off candidate.
- **§12 — `boolean_naming_drift`** flags framework-owned names that
  cannot be renamed (Django `Migration.atomic`, `Meta.abstract`),
  Pydantic fields already annotated `: bool`, and names its own
  convention exempts. Proposes semver-major renames of public API
  options at `effort: "quick"`.
- **§15 — `mixed_utc_local_methods` cannot fire on modern Python.**
  Matches bare `datetime.utcnow()` but not a wrapper
  (`timezone.utcnow()`), which `dateCalls` never sees. Airflow has 775
  `utcnow()` sites and 21 files mixing both; the detector found zero.
  **Note:** `PyCall` (general call extraction) landed in 0.18.0 and may
  be exactly what this needs.
- **§9 — `sync_io_in_hotpath` has no working hotpath test.** Fires on
  `if __name__ == "__main__"` scripts, Django management commands and
  `@cache`-decorated functions. Also emits a file-level finding wearing
  one function's `symbol` and `lines` (a span covering 81% of a file),
  which corrupts any ±N-line excerpt built from it.
- **§13 — `scope-class` misses vendored trees**: drf's vendored
  google-code-prettify, `pydantic/v1/`, `_pb2.py`, a file whose first
  line is `# @generated by protoc`, and two airflow paths that *do*
  match `GENERATED_RE` and are `isNeverReportable` yet were reported.
- **§8 — tsconfig path aliases** in `dependency_provenance_gap`,
  resolved only from a *root* `tsconfig.json`, so cal.com (no root
  tsconfig — normal for Next.js) reported `@components/*`, `.` and `..`
  as undeclared packages.
- **§14 — `hotspots`** ranks manifest churn #1 (`package.json` at 72% on
  hono), operates over a different file universe than `scan`, and on a
  quiet repo degenerates to alphabetical order while still printing
  confident percentages.

### Tier 3 — the wedge. Ask before starting; these need a decision.

These are the two items the last handoff called out as *why the
differentiated 0.16 detectors stay buried*. They're scoring-model and
product-shape decisions, not defect fixes.

- **§5 — `agent_risk` is a length ranking.** Top 20 on ebg: 15
  `large_function`/`large_file`. On zulip: 18 of 20, and **zero Python**
  on a repo that is 71% Python. `CLAUDE.md` says it "must not be
  collapsed into severity". Changes ranking in every report.
- **§6 — repo-level findings are invisible in the default view.** `scan`
  groups by file, so cal.com's highest-severity finding (anchored on
  `package.json`) never appears, and seven of ten 0.16 detectors are
  absent from n8n's default view despite firing in the JSON.

### Tier 4 — standing decisions (§2). Don't take these unilaterally.

- **`blast_radius` score saturation** — pinned at 1.0 on 47% of zulip
  findings. 0.18.0 fixed what the number is *called*, not how it's
  scaled. Standing recommendation: quartile-rank within the scan the way
  `test_gap` already does, with the direct count as an in-quartile
  tiebreaker. Full eval re-baseline; record as a **calibration** change.
- **`transitiveImporterCount` counts a file as its own importer** on a
  cycle. Left deliberately — it's the number `blast_radius` has always
  normalised.
- **`large_file` counts blank lines.** Fixing it drops every number
  15–25% and retunes thresholds repo-wide. Calibration, not a bugfix.
- **No detector has been disabled or gated.** The sunset shortlist (see
  the round report §8) is a recommendation awaiting a decision.
  `parallel_destination` (§11) is the strongest candidate.
- **§4d — cross-file assertion helpers** need a Python symbol index that
  doesn't exist. Feature-sized. It's what airflow's 12% is waiting on,
  and would serve any Python detector that wants to follow a call.
- **§4e — JS syntax errors have no `coverage.warnings[]` signal.**
  `ts.createSourceFile` keeps `parseDiagnostics` off the public
  `SourceFile` type; reaching it means an internal-API dependency, which
  was judged not worth it *in a field whose whole value is being
  trustworthy*. Revisit only if a supported signal appears.

### Remaining annoyances (§18, 21, 23, 24, 25)

Default-view suppression is a *file* cap not a finding budget; `diff`
human output is three integers with no locations and runs two full
scans; `lines` absent on 12–16% of findings and `symbol` undefined on 20
of 34 types; `.json`/`.yaml`/`.txt`/`.rst`/`.adoc` missing from
`DEFAULT_SOURCE_INCLUDES` so the 0.17.0 data-format exclusion and 5 of 7
docs extensions are unreachable at default config; score derivation
mixed into `evidence` rather than a separate field.

---

## How to proceed

Work Tier 1 straight through — they're small, independent, and each
should be its own commit. Then Tier 2, reproducing on the named repo
before touching anything; several of those may turn out to be different
(or already fixed) from what the entry claims.

**Stop and ask before Tier 3 or Tier 4.** Those change ranking or the
default view across every report, and the right answer depends on where
the product is going, not on the code.

Batch the version bumps: one bump and one `pnpm run evals` per group of
findings-moving changes, not one per commit — the policy exists to give
each *measured baseline* its own results directory.

Update §4 of the remediation doc as you go: strike items through with a
one-line note on what was actually measured, and **record where the
entry was wrong**. That record is the most useful thing in the document.
