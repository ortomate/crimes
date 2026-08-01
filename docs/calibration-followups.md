# Calibration follow-ups

Open calibration questions, the decision taken, and the evidence behind
it. This file exists so a decision to *not* change a detector is as
recorded as a decision to change one.

Each entry states the disposition. `Decided: no change` means the
behaviour was examined and judged correct — not that it was
unexamined.

---

## `swallowed_error` volume on the self-scan

**Status:** Decided — no detector change. Handled by triage.
**Raised:** 0.16.x cleanup, after `swallowed_error` returned 59 findings
on a self-scan of 406.

### What the numbers actually are

The initial read was "58 hits, mostly the `safelyBuildX` helpers in
`packages/core/src/indexes.ts`". Measured, it is more diffuse and more
interesting:

| | count |
|---|---|
| total | 59 |
| `severity: low` | 54 |
| `severity: medium` | 5 |
| in `indexes.ts` | 8 |
| distinct files | 32 |

Of the 5 `medium`, **4 are in `examples/risky-service/`** — the fixture
built to trigger this detector. Those firing at `medium` is the
detector working. Exactly one non-fixture `medium` exists:
`probeShallow` in `packages/core/src/git/churn.ts`.

Grouped by enclosing function, the 54 `low` findings are five families:

- `safelyBuild*` (8) — `indexes.ts`
- `read*` (~14) — `readManifest`, `readLockfile`, `readCreatedAt`, …
- `parse*` (~10) — `parse`, `parseFile`, `parsePyFile`, `parseTriage`
- probe predicates (~7) — `exists`, `isFile`, `isGitRepo`, `refExists`
- `load*` (~6) — `loadConfig`, `loadScenarios`, `loadBinSurface`

### Why the `safelyBuild*` family is already handled

`BEST_EFFORT_FUNCTION_RE` matches `^safely[A-Z]`, so `looksDeliberate`
already returns true for all 8 and the confidence ladder applies its
`-0.2` "suppression appears deliberate" delta. That is *why* they are
`low` rather than `medium`. The mechanism the follow-up proposed
widening is already doing its job.

### The three options, and why the first two are wrong

**Widen `BEST_EFFORT_FUNCTION_RE` — rejected.** To silence the
remaining families the regex would have to absorb `read*`, `parse*`,
`load*`, `exists*`. Those prefixes do not announce failure tolerance.
`readUser()` that swallows its error is a genuine bug in most
codebases, and this regex ships to every user of the tool. Trading
product-wide precision to quiet one repo's self-scan is the exact move
the "never weaken a check" rule exists to stop.

**`allowedFunctions` — rejected.** Repo-local, so it does not damage
other users, which makes it strictly better than the regex. But it
would need roughly 30 entries, and the names it would have to carry
(`readFile`, `parse`, `loadConfig`) are generic enough that adding them
would also blind this repo to *future* real swallows in functions that
happen to share a name. It hides findings rather than dispositioning
them.

**Triage — taken.** Because the detector is not wrong. A reader cannot
tell from the name `readManifest` that a failure is tolerated and
returns `undefined`; the finding is a fair observation that the
tolerance is undocumented. The problem is volume, not correctness, and
volume is what `.crimes/triage.json` is for. Triage keeps each finding
visible, attributed, and re-surfaceable rather than deleted.

The one genuine item — `probeShallow` returning `false` when
`git rev-parse --is-shallow-repository` fails, so a failed probe is
indistinguishable from "history is complete" and `historyLimited` is
never set — is triaged separately as real work rather than accepted.

---

## Self-scan triage policy (0.16.x)

**Status:** Applied. `.crimes/suppressions.json` and `.crimes/triage.json`
are committed and meant to be argued with.

The self-scan went 410 findings / 30 high to **250 / 0 high** in the
default view. Nothing was deleted — with `--show-triaged
--show-suppressed` the scan still reports 388 / 26 high. The reduction
is four levers, in descending order of how much they should be trusted:

**1. Config excludes (410 → 388).** Two of these are plain bugs rather
than judgement calls:

- `examples/risky-service/**` was never added to `crimes.config.json`
  when the fixture landed in 0.16.0, even though `examples/messy-ts-app/**`
  has always been there. Its 9 findings are the crimes the fixture was
  *built* to contain. Scanning your own fixture and reporting its
  deliberate crimes as your own is a measurement error.
- `docs/superpowers/**` — archived plan and spec documents from a
  one-time workflow, never edited after their milestone. Same class as
  `.planning/`.

**2. `scopeTiers.nonDomain` (partition, not removal).** Adds `docs/**`,
root `*.md`, and `.planning/**` to the non-domain tier, which moves 36
findings out of the primary walk without hiding them. Note this key
*replaces* `DEFAULT_NON_DOMAIN_PATTERNS` rather than extending it, so
the defaults are re-listed in the config.

**3. Suppressions (21).** Only categorical false positives, each with a
mechanism a reviewer can check:

- `hardcoded_local_path` on `docs/**` (2) — the docs that *document*
  the detector contain example bad paths to show the reader what it
  catches. Self-referential.
- `large_file` on `**/*.md` (19) — `large_file` has two policy shapes,
  `domain` and `test_file`, so prose is scored against the domain-code
  line budget. Reference documentation is supposed to be long. The real
  fix is a `docs` shape in the detector; until then this is a
  suppression, not an acceptance.

**4. Triage (117).** Recorded decisions on findings that are *correct*:

| disposition | n | what it covers |
|---|---|---|
| `wont-fix` | 98 | 55 `swallowed_error` (see above), 43 `high_fan_in_fan_out` |
| `needs-design` | 19 | every remaining `high` |

`high_fan_in_fan_out` is `wont-fix` because `packages/core` is a hub by
design — the finding schema and scoring are meant to be depended on
widely. `layer_violation` is the detector that would catch a genuinely
wrong edge, and it reports nothing.

The 19 `needs-design` highs are real size debt: detector `run` bodies
and parser surfaces that grew with the 0.16.0 slate. They are not
fixed here because splitting a detector changes its output, which needs
its own change and an eval re-run rather than a drive-by extraction
during a tooling pass.

### What is deliberately still visible

250 findings remain untriaged and unsuppressed, led by 101
`large_function`, 33 `large_file`, 30 `boolean_naming_drift`, and 25
`sync_io_in_hotpath`. That is the honest backlog. It was left alone
rather than blanket-triaged, because a triage entry that says nothing
more than "acknowledged" is worse than an open finding — it converts a
visible number into a silent one.

---

## `fingerprintFinding` collisions

**Status:** Decided — no change now. Recommended for the next minor
that already bumps `schema_version`.
**Raised:** documented in `fingerprint.ts` as a known limitation,
pre-dating 0.16.0.

### It is not one detector

The follow-up named `magic_domain_literal_scatter`. Measured against a
self-scan, the collision is a property of `fingerprintFinding` itself
and hits every detector that emits more than one file-level finding
without a `symbol`:

```
x2  magic_domain_literal_scatter :: detectors/unbounded-async-fanout.ts
      "subprocess" appears in 5 production files
      "property"   appears in 4 production files
x2  exact_duplicate_block :: cli/src/commands/feedback.test.ts
x3  exact_duplicate_block :: cli/src/commands/audit-suppressions.test.ts

3 colliding fingerprints covering 7 findings, of 402 distinct.
```

`exact_duplicate_block` collides worse than the detector that was
reported. A fix that gives only `magic_domain_literal_scatter` a
disambiguator would repair one case of three.

### Why this matters more than "diff shows them as one"

The documented consequence is that `crimes diff` conflates them. The
sharper one is suppression targeting: `crimes ignore <fingerprint>` on
the `"property"` finding **also silently suppresses `"subprocess"`**,
because they are the same fingerprint. A user suppressing one thing
gets a second thing suppressed without being told. That is a safety
property, not a cosmetic one.

### Decision

Do not patch it in a cleanup pass, for three reasons.

1. **The obvious fix abuses a field.** Setting `symbol` to the literal
   value would work mechanically, but `fingerprint.ts` documents
   `symbol` as naming *a specific declaration*. A string literal is not
   a declaration. That silently changes what the field means for every
   consumer reading it.
2. **A per-detector fix is the wrong shape.** The bug is in the
   fingerprint function's inputs, so it wants one general answer — an
   explicit optional `discriminator` on `Finding` that a detector
   populates when `(type, file, symbol)` is not unique, folded into the
   fingerprint when present. Each colliding detector already has a
   natural value: the literal for scatter, the body hash for the
   duplicate-block family (already in its evidence string).
3. **The cost should be paid once.** Any change to fingerprint
   composition invalidates `.crimes/baseline.json` and
   `.crimes/suppressions.json` in the wild — pinned entries stop
   matching, old findings read as "fixed", new ones as "new". The repo
   already has a designed channel for this (suppressions resurface on a
   minor for re-confirmation, per `docs/feedback.md`), so the right
   moment is a minor that is already bumping `schema_version` and
   migrating those files, not a standalone break.

**Recommendation:** add `discriminator?: string` to `Finding` and
include it in `fingerprintFinding` in the next `schema_version` bump.
Populate it in `magic_domain_literal_scatter` (the literal) and the
duplicate-block detectors (the hash) in the same change, and note the
baseline/suppression migration in the release notes.

### Adjacent, found while measuring

`exact_duplicate_block` is **not deterministic** across runs on an
unchanged tree. Three consecutive scans of the same commit produced
identical finding *identity* and severity counts, but 3 findings
differed in content — the same anchor file reported
`hash 3dbfcb76d2cc… across 6 file(s)` on one run and
`hash 3d33dfe315b3… across 9 file(s)` on another. A function belonging
to more than one duplicate group appears to pick its group by map
iteration order.

Identity is stable, so baselines and `diff` are not affected, but the
evidence string a user reads is not reproducible. Worth fixing on its
own; not attempted here because it changes findings and so needs a
patch bump and an eval re-run.
