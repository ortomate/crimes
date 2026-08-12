# Sprint 0.27 — the first product release in five

Sprint plan for the release after `0.26.0`. Deliberately **not** another
correctness sprint, and §2 says why in terms of what the last two
actually produced.

---

## 1. Where the backlog stands

`0.26.0` closed all five debts `0.25.0` left. The correctness backlog
that has driven the last four releases is now nearly exhausted:

| | status |
|---|---|
| P0.1 self-scan artifact | ✅ |
| P0.2 user `exclude` falls behind defaults | ✅ `excludeDefaults`, `0.25.0` |
| P1.1 honour tooling excludes | ✅ Python; JS **closed by measurement**; `linguist-generated` shipped |
| P1.2 `sync_io_in_hotpath` by reachability | ✅ incl. the test-only bucket |
| P1.3 unify `commented_out_code` | ✅ discriminator + intrinsic |
| P2.3 cross-pack disagreement (7 of 8) | ✅ except `weak_test_signal`, which is not a constant gap |
| P3.2 deep fixtures miss the differentiated detectors | ✅ fixtures 15 and 16 |
| D1–D5 | ✅ |

**What is left is not more of the same.** It is one user-facing feature,
two product decisions, and a short tail of scoring-model debt that no
measurement is currently blocked on.

---

## 2. The thesis, and the evidence for choosing it

**A fifth correctness sprint would be planning against a dry well.**

`0.26.0`'s own plan predicted that closing D1 would produce the first
real deep-mean movement since `0.24.0`. D1 landed in full, cleanly, in
four attributable bumps — and moved `mean_ndcg_deep` by **+0.0000**.
Every result that mattered came from something the plan did not contain:

| finding | was it planned? | effect |
|---|---|---|
| churn lost through a symlinked scan root | no | **the only real deep-mean movement**, +0.0019 |
| `evals:ranking` was a function of wall-clock time | no | falsified the metric's headline claim |
| `commented_out_code`'s published anchor unreachable | no | every peer calibrated against a number no report contained |
| the recency multiplier is a large unlabelled bet | no | reorders 99.9% of a real report |
| D1, all four parts | **yes** | +0.0000 |

That is not an argument that planning failed — the streams were worth
doing and the debts are genuinely closed. It is an argument that **the
planned correctness surface is exhausted while the unplanned one is
not**, and that the next release should spend its budget somewhere the
plan can be wrong in a *useful* direction.

So: **`0.27.0` is a product release.** M6 is the headline, and the two
decisions `0.26.0` surfaced get settled rather than carried.

---

## 3. Streams

### S1 — settle the recency default — **do this first, and alone**

**Blocks:** M6, deliberately. See §4.

`0.26.0` measured the recency multiplier properly for the first time and
the result is a genuine trade, not a defect:

```
plan-16-checkout-rollout    "what ships with the feature we're building?"
   recency on  0.844 (rank 1)   off 0.425 (rank 15)   +0.418
review-16-whole-repo-audit  "what's most dangerous here, regardless?"
   recency on  0.327 (rank 12)  off 0.456 (rank 5)    -0.129
```

On posthog it reorders **99.9% of 14,181 findings**, median displacement
534 places, and makes the top-20 **100% recency-boosted** at a cost of
0.028 mean `agent_risk`.

**The decision is not "keep or remove".** It is what the default sort
means, and there are three defensible answers:

1. **Keep it.** The bet pays ~3× more when right than it costs when
   wrong, and "what you are touching" is the agent-native reading.
2. **Keep it but make it visible.** `--no-recency` exists and nobody
   knew to reach for it; the report never says the top was chosen partly
   by commit date.
3. **Reduce the weight.** 0.5 was never argued. Nothing measures whether
   0.5 beats 0.2.

**Do:** pick one, with the fixture-16 A/B as the instrument. If the
answer is (3), the A/B extends to a weight sweep at no extra cost —
`--no-recency` is already a toggle, a weight flag is a small addition.

**Reproduce first:** `PRD.md` §10 does not mention `recency` at all and
the field's doc comment gives mechanics without rationale. **Find out
whether the omission is an oversight or a deliberate silence** before
choosing — if somebody argued for it once, that argument should win or
be explicitly overruled.

**Own bump.** Whatever is chosen, it moves scores on every repo with git
history, so it cannot share a baseline with anything else.

---

### S2 — M6: Homebrew tap + standalone binaries

The only user-facing feature on the table, deferred four times. Its
stated precondition — *"deferred until the CLI surface stabilises"* — is
now **met, and this was checked rather than assumed**: 20 commands, and
the last one added was `feedback-summary` on 2026-05-18, nearly three
months ago.

**The technical risk is asset resolution, not packaging.** Measured:

```
packages/cli/dist/index.js         1.96 MB
tree-sitter-python.wasm             458 KB
web-tree-sitter.wasm                  — vendored alongside
runtime dependency                  typescript ^5.6.3   (NOT bundled)
```

`language-py/src/parse/grammar.ts` locates both WASM blobs by **walking
up from `import.meta.url`** — a deliberate design, documented there,
chosen because the bundle moves away from its own `node_modules`. Every
single-binary approach (Node SEA, `bun build --compile`, `pkg`) changes
what `import.meta.url` means, so **the walk is the thing most likely to
break, and it will break by falling back to "Python pack unavailable"
rather than by crashing.** That is a silent degradation of exactly the
kind this project keeps finding.

**Do, in order:**

1. **Prove the WASM path first, on one platform, before choosing a
   packaging tool.** Build a binary, scan `evals/fixtures/11-py-service`,
   and assert the Python findings are present — not merely that the
   binary runs. `CRIMES_PY_GRAMMAR_WASM` already exists as an escape
   hatch; if it becomes *required*, the binary is not standalone and
   that should be said out loud rather than shipped.
2. Then decide the tool, on evidence from step 1.
3. Then the tap.

**Reproduce first:** does `typescript` need to be in the binary at all?
It is the sole runtime dependency and it is large. If the TS AST work
can be reached without shipping the whole compiler, the binary halves;
if it cannot, say so and size the result honestly.

**Done when:** a binary on one platform produces byte-identical scan
JSON to `npx crimes` on the same fixture — including the Python findings.

---

### S3 — `weak_test_signal`'s granularity

The last entry in `KNOWN_DISAGREEMENTS`, and `0.26.0` established it is
not a constant gap: universal emits **one finding per hollow test**,
Python **one per file** — 3.19 findings per affected file against
exactly 1.00.

Choosing a granularity changes finding **counts**, not scores, which
makes it the one remaining scoring item that is a product decision
rather than a calibration.

**Do it only if S1 and S2 land with room.** It is the least
user-visible item here and it has waited nine releases; it can wait one
more.

---

## 4. Sequencing, and the one constraint that matters

```
S1  recency default (own bump, moves every repo with git history)
     └─► S2  M6 binaries
S3  weak_test_signal — last, and only with room
```

**S1 before S2, and not for convenience.** The recency default changes
the first screen of every report. Changing it *after* a Homebrew release
widens the install base means changing it under more users, on a
distribution channel with no `npx` equivalent of "just use the old
version". Get the default right while the audience is still
`npm install`-shaped.

**M6 has zero eval interaction** — it changes packaging, not findings —
so it needs no baseline bump and cannot make anything unattributable.
That is what makes it safe to pair with a scoring change in one release.

---

## 5. Explicitly deferred, with reasons

- **P2.1 the level `0.3`.** Still needs an instrument that does not
  exist. Fixture 16 was that argument's shape for `recency`; nobody has
  built the equivalent for `STRUCTURAL_CEILING`.
- **P2.2 the class table.** `standard` still has zero members across 70
  detectors. Real, and still no user-facing number.
- **P2.4 inline intrinsic literals.** ~24 detectors still express
  ladders inline against 28 declared defaults. `0.25.9` showed why this
  matters — an inline ladder hid an unreachable base for nine releases —
  but the remaining ones are visible to the parity gate now.
- **P3.3 the stale `evals/README.md` § "Fix this regardless".** The
  version comparator it describes was fixed; the section still reads as
  live. Two-minute docs fix, genuinely trivial.
- **P3.4 build ordering.** Did not reproduce over 8 runs. **Propose
  closing it** rather than carrying it a fifth time.
- **PRD §26 / `crimes ask`.** Still deferred; confirm that is still the
  intent before anyone starts.

---

## 6. Definition of done

- [ ] `pnpm verify`, smoke, `verify-build`, fingerprint-uniqueness,
      byte-identical re-scan, the intrinsic gate and the parity gate all
      green.
- [ ] Every stream re-derived its own before-state rather than quoting
      this document.
- [ ] The recency decision is written down **as a decision** — what the
      default sort means — not just as a constant that changed.
- [ ] A standalone binary produced byte-identical scan JSON to `npx
      crimes` on a Python fixture, or the reason it cannot is recorded.
- [ ] Any deep-population change is reported via `delta_on_stable_set`.
- [ ] Every place an entry in this plan turned out to be wrong is
      recorded in it. `0.25.0` corrected four; `0.26.0` corrected 26.
      **Assume this one is wrong somewhere too — and note that both
      previous plans were most wrong about where the value would come
      from, not about the individual entries.**

---

## 7. What would falsify this plan

`0.26.0`'s retrospective is that both prior plans predicted the source of
their own value incorrectly. So, stated up front and checkable:

**This plan predicts** that M6 is mostly packaging work whose risk is
concentrated in WASM asset resolution, and that the recency decision is
a half-day once the instrument exists.

**It would be falsified if** — and each of these should be treated as
the real result, not a detour:

- the WASM walk survives packaging untouched and the actual difficulty
  is somewhere unglamorous (code signing, notarisation, the tap's CI);
- `typescript` turns out to be unshippable in a binary, making M6 a
  dependency-architecture problem rather than a packaging one;
- settling recency exposes a second unvalidated term in `rank_score` —
  the same way chasing one zero in `0.26.0` produced four findings.
