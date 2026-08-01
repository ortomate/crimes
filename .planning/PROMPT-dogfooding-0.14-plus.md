# Dogfood `crimes` 0.14 → 0.16 against real codebases

Paste this into a fresh Claude Code session at the repo root. It is
self-contained: it assumes no memory of the sessions that built or
shipped these releases.

---

## What this is

Three releases have shipped detector surface that has **never been run
against a real codebase outside its own fixtures**:

| release | surface |
| --- | --- |
| `0.14.0` | Python language pack — `.py` / `.pyi` parsing plus 8 Python detectors |
| `0.15.0` | cross-language pack — 3 detectors that only fire when two languages disagree, plus `coverage.by_package` |
| `0.16.0` | 10 detectors across correctness, cross-file authority, and agent hygiene |

Every one of them was tuned against fixtures in `evals/fixtures/` and
`examples/`, and validated by a self-scan of this repo. Both of those
are systematically biased:

- **Fixtures are built to make detectors fire.** They tell you the
  detector *can* fire. They tell you nothing about how often it fires
  when it shouldn't.
- **This repo cannot exercise 0.14 or 0.15 at all.** It is
  TypeScript-only. The Python pack has no Python to parse here, and the
  three cross-language detectors return early unless two languages are
  present. Their entire real-world track record is one hand-built
  polyglot fixture.
- **This repo's own findings are already dispositioned.** See
  `.crimes/suppressions.json` and `.crimes/triage.json`. Re-scanning it
  measures nothing new.

So: **you are collecting calibration evidence from real code, not
changing the product.** The deliverable is data plus a written
assessment. Detector changes come after, as a separate decision, for
reasons in "Boundaries" below.

## Read these first, in this order

1. **`CLAUDE.md`** — product constraints. Especially "What this product
   is (and isn't)" and the eval-baseline versioning policy.
2. **`docs/calibration-followups.md`** — **the most important one.**
   Records calibration questions already examined and the decisions
   taken, including detector-widening options deliberately *rejected*
   and why. A "no change" entry there is a decision, not an oversight.
   Do not re-discover these as findings.
3. **`docs/feedback.md`** — the `crimes feedback` loop, which is the
   mechanism this exercise runs on.
4. **`docs/finding-types/correctness.md`**, **`authority.md`**,
   **`agent-hygiene.md`** — what the 0.16 detectors claim to find, so
   you can judge whether a finding is true *on its own terms* rather
   than on yours.
5. **`docs/packs.md`** — how the language packs and `packs_loaded` work.

## The surface under test

**0.14 — Python pack.** `boolean_naming_drift`, `circular_dependency`,
`deep_import`, `direct_date`, `large_function`, `sync_io_in_hotpath`,
`mixed_utc_local_methods`, plus Python-aware test pairing and project-root
detection. Parser is a vendored tree-sitter WASM grammar in
`packages/language-py/vendor/`.

**0.15 — cross-language.** `cross_language_route_drift`,
`cross_language_type_drift`, `cross_language_concept_alias_drift`, and
`coverage.by_package`.

**0.16 — correctness / authority / agent hygiene.** `swallowed_error`,
`unsafe_retry`, `unbounded_async_fanout`, `mock_saturation`,
`duplicated_policy`, `contract_drift`, `config_drift`,
`pass_through_abstraction`, `dependency_provenance_gap`,
`agent_permission_sprawl`.

## Build a corpus

Clone real repositories into a scratch directory **outside this repo**
(`~/crimes-dogfood/` or similar — never inside the working tree, or you
will scan your own corpus). Pin each to a SHA and record it; a finding
you cannot re-derive is not evidence.

Aim for roughly 8–12 repos with deliberate spread:

- **3–4 substantial Python** — a web service (Django/FastAPI/Flask), a
  library, and something data/ML-shaped. These are the *only* way to
  test 0.14. Pick projects with real history, not toys.
- **2–3 genuine polyglot monorepos** — a Python or Go backend beside a
  TS frontend, ideally one where the frontend calls the backend's HTTP
  API. This is the *only* way to test 0.15's three detectors, and the
  route-drift one in particular needs a real client/server pair.
- **2–3 substantial TypeScript services** — where the 0.16 correctness
  detectors have something to chew on: retries, `Promise.all`, env
  handling, error handling at boundaries.
- **At least one control** — a small, well-maintained, heavily-reviewed
  repo where **few findings is the correct answer**. If it lights up,
  that is the single most valuable result of the exercise.

Prefer repos you can actually reason about. A finding you cannot judge
is not evidence either — "I don't know if this is real" is a legitimate
recording, but a corpus made entirely of those is a wasted round.

## Method, per repo

```bash
crimes scan <repo> --all --format json > <repo>.json
crimes scan <repo>                       # the human view, which is what a user sees
```

Then, for each finding you judge, record a verdict through the
product's own loop:

```bash
crimes feedback <fingerprint> --verdict tp --note "…"
crimes feedback <fingerprint> --verdict fp --note "why this is wrong here"
crimes feedback <fingerprint> --verdict known --note "…"   # record only, no suppression
```

`fp` also writes a suppression whose reason is your note, so the note
has to stand on its own to a stranger. Roll the results up with:

```bash
crimes feedback summary --format json
crimes feedback export --append-global    # ~/.crimes/feedback-rollup.jsonl
```

You do not need to judge all findings in a large repo. Judge a
**bounded, honestly-chosen sample** and say what the rule was — e.g.
"every finding from the 0.14+ detectors, plus the top 20 by
`agent_risk`". State the rule, then follow it. Silently skipping the
awkward ones is how a dogfooding round produces a flattering number
instead of a useful one.

## What to measure

**1. Precision, per detector.** tp / (tp + fp) for each of the 0.14+
detector types, with the sample size. A detector with 3 findings across
the corpus has no precision number worth quoting — say so rather than
reporting 100%.

**2. Actionability, separately from correctness.** A finding can be
*true* and still useless. `contract_drift` on a TS interface beside its
Zod schema is technically two declarations that disagree, and no
maintainer would act on it. Record these as `known` and call them out —
this is the axis the eval harness cannot see.

**3. The zero case.** Do the three cross-language detectors correctly
stay **silent** on every single-language repo? Does the Python pack stay
silent on repos with no Python? A false positive here is worse than a
missed finding, because it undermines `packs_loaded`.

**4. Robustness.** Real Python is messier than fixtures. Watch for:
parse failures on modern syntax (3.11/3.12 generics, `match`,
walrus), generated code (protobuf `_pb2.py`), notebooks, vendored
dependencies, namespace packages. Note that
`packages/core/src/indexes.ts` swallows index-build failures by design,
so **a silently-degraded scan looks like a clean one** — check
`packs_loaded` and `coverage` in the JSON, don't just count findings.

**5. Performance and scale.** Time each scan and record repo size. Two
known issues make large repos the interesting case, both recorded in
`docs/calibration-followups.md`: `buildFunctionHashIndex` and
`buildJsxShapeIndex` each `Promise.all` a `readFile` per candidate file
with **no bound**, so a large enough repo may exhaust file descriptors.
If you can trigger that, it is a concrete bug report with a
reproduction — worth more than another precision data point.

**6. The human report.** Read the non-JSON output as a user would. With
10 new detector types, does the default view still lead with the thing
that matters, or has 0.16 crowded the front door? "Signal over
exhaustiveness" is a stated product constraint; check it held.

## Boundaries

**Do not change detector behaviour during the round.** Collect first,
decide after. Tuning mid-corpus means the repos scanned before and after
were measured with different instruments and the round is worthless.
If something is obviously, badly wrong, record it and keep going.

**Any detector change afterwards is a product change** — patch bump in
the same commit, plus `pnpm run evals` re-run, per the policy in
`CLAUDE.md` and `evals/README.md`. That is deliberately expensive, which
is why the decision comes after the evidence, not during.

**Do not commit corpus code into this repo.** Record SHAs and paths.
If a repo turns out to be an excellent source of a shape we have no
fixture for, propose it as an `evals/fixtures/` entry following the
existing OSS-clone convention (committed meta, gitignored body) — as a
proposal, not a fait accompli.

**Known-open issues — do not re-report as discoveries** (all in
`docs/calibration-followups.md`): `exact_duplicate_block` is not
run-to-run deterministic in its evidence strings; `fingerprintFinding`
collides when one file yields several findings of a type with no symbol,
which means `crimes ignore` on one can silently suppress another;
`magic_domain_literal_scatter` is formatting-sensitive by construction.
Do report if you find these are **worse in the wild** than recorded here.

**`pnpm verify` must stay green** if you touch anything in this repo,
and the working tree must be clean of corpus artefacts before you stop.

## Deliverable

Write `docs/dogfooding/2026-08-<dd>-0.14-to-0.16.md` containing:

1. **The corpus** — repo, pinned SHA, language mix, rough size, scan
   duration. A table.
2. **Per-detector verdict table** — tp / fp / known counts, sample size,
   and a one-line judgement. Include the detectors that produced
   **zero** findings across the whole corpus; a detector that never
   fires in the wild is a finding about the detector.
3. **The false positives, in full** — each with the repo, the code, and
   why the detector was wrong. This is the part that changes the
   product, so it earns the most space.
4. **Actionability assessment** — separately from precision, per the
   axis above.
5. **Robustness and performance** — parse failures, degraded scans,
   timings, anything that broke.
6. **A ranked list of recommended changes**, each labelled with what it
   would cost: config default / detector tuning (patch bump + eval
   re-run) / schema change (minor + migration).
7. **What you deliberately did not judge**, and why.

Commit the report and the `.crimes/feedback.jsonl` it produced. Do not
apply the recommendations in the same pass — bring them back as a
decision.

---

**One framing note.** The instinct in an exercise like this is to
report that things went well. The useful outcome is the opposite: the
false positives, the detector that never fired, the Python file that
failed to parse, the report that buried the one finding that mattered.
Ten detectors shipped in a single release two days ago. It would be
surprising if all ten were correctly calibrated against code nobody
tuned them on, and a round that concludes they are is more likely to
have been run gently than to be true.
