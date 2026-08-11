# 16-recency

**The only fixture with synthetic git history**, and the only one where
`recency` is a live term.

## Why it exists

`rank_score = agent_risk * (1 + recency * 0.5)` applies a multiplier
larger than any single `agent_risk` input. Measured at `0.25.10`, it
reorders 99.9% of a real repository's report and fills the top-20
entirely with recently-committed files — and **no eval fixture could see
it at all**. The four deep fixtures are months old, so `recency` is 0 on
every one of their findings and `rank_score` reduces to `agent_risk`.

A term that big cannot be validated, changed, or removed while the
metric is blind to it. This fixture makes it visible.

## Why this is a template

`pnpm run evals:setup` copies this directory to `16-recency/` and builds
the git history there. The two are separate because **a directory
holding a `.git` cannot be tracked by the outer repository** — git
records it as a gitlink and silently commits none of the files, which is
what happened the first time this landed. The template is committed; the
working fixture is generated and gitignored, the same split the OSS
fixtures use.

## How the history is made

Setup commits the tree in four
tranches, dated relative to `RANKING_REFERENCE_DATE` (the constant
`evals/runner/src/scan-helpers.ts` pins every fixture scan to):

| directory | age at the reference date | `recency` |
|---|---|---|
| `src/legacy/` | 90 days | 0 |
| `src/core/` | 20 days | 0 |
| `src/checkout/` | 3 days | 1.0 |
| `test/` | 9 days | ~0.71 |

The `.git` directory is gitignored and rebuilt by setup, so the dates
move with the reference constant instead of with the wall clock. Nothing
here depends on when you run it.

## What this fixture can and cannot settle

It **can** exercise the term: with history in place, `crimes scan
--no-recency` and the default sort disagree, so `evals:ranking` can
finally see a change to `recency`.

It **cannot** tell you on its own whether boosting recent files is
right, because that depends on a premise about real repositories — is
the finding you need to act on more likely to sit in code somebody
touched last week? A fixture cannot answer that; it can only be built to
assume it, which would be rigging the experiment.

So the scenarios deliberately test the premise **from both sides**:

- `plan-16-checkout-rollout` asks about the feature under active
  development. Its answer lives in `src/checkout/`, the recent tranche —
  the case recency is presumably *for*.
- `review-16-whole-repo-audit` asks for the riskiest thing in the
  repository regardless of activity. Its answer lives in `src/legacy/`,
  the oldest tranche — the case recency works *against*.

Running the A/B across both is what turns "should the top of the report
be the riskiest, or the riskiest among what you are currently touching?"
into a measured trade rather than an unexamined default.
