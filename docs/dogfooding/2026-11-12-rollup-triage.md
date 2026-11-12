# Rollup triage: 2026-11-12

**Triages:** [the 2026-09-22 import](./2026-09-22-rollup-import.md), 54 `fp`
verdicts recorded against crimes 0.26.0.
**Build under test:** 0.31.0, then 0.31.1 with the fixes below.

## Method

Each repo was exported with `git archive` at the first commit after the
verdict's timestamp and scanned with 0.31.0, so a finding that vanished
because the code changed is not mistaken for a detector fix. Fingerprints
were compared with the claim suffix stripped (`direct_date/clock_read`
→ `direct_date`), since claims were added to fingerprints after 0.26.0.
The repos' current `HEAD` was scanned as well.

| At the snapshot | Entries |
| --- | --- |
| still fires on 0.31.0 | 39 |
| no longer fires | 6 |
| verdict given on uncommitted code; no snapshot | 9 |

The six that stopped firing are three `direct_date` entries on
`new Date(value)` (fixed in 0.29.1: a parse is not a clock read),
`option_bag_junk_drawer`, `weak_test_signal` and `near_duplicate_block`.

## Fixed in 0.31.1

- `config_drift`: `client_exposed_secret` on `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  / `_PUBLISHABLE_KEY`. Both are browser keys by design, so a name ending in
  `PUBLISHABLE_KEY`, `ANON_KEY` or `PUBLIC_KEY` no longer counts as
  secret-shaped on `KEY` alone. One verdict reported it; the rescan found
  the same **high** finding in four of the five repos.
- `config_drift`: `NODE_ENV` undocumented. The runtime and every bundler
  set it. Five repos.
- `name_behavior_mismatch`: `ts.createSourceFile(…)` bound then
  dereferenced, and `createHash(…).update(…)` chained, are construction.
  `.then`/`.catch`/`.finally` chains still count as effects.
- `orphaned_destination`: `app/**/route.test.ts` was read as a route. Test
  and story files are no longer routes.

## Still open, by pattern

- **Findings on files a branch did not touch** (8 `high_fan_in_fan_out`,
  2 `duplicated_role_status_plan_check`, all on 0.31.0). The percentile
  cutoff moves when a file is added elsewhere, and `diff`/`verdict` then
  report the untouched file as new. This is a `diff` contract question
  (mark new findings on unchanged files) rather than a detector fix.
- **`direct_date` at a request boundary** (8 still fire, all `low`). One
  clock read captured at the route or action and injected inward is the
  pattern the detector recommends. Recognising it needs a single read
  passed as an argument, which the parser does not track yet.
- **`swallowed_error` fail-closed on untrusted input** (7 still fire).
  `JSON.parse` or `decodeURIComponent` of attacker-controlled input
  returning `null` is called a `bland_fallback`. Best-effort telemetry
  catches make up the rest.
- **Shared literal, unrelated state machines** (`magic_domain_literal_scatter`
  ×2, `duplicated_policy` ×1, `duplicated_role_status_plan_check` on
  `Promise.allSettled` `status === "rejected"`).
- Single reports, not yet a pattern: `return_shape_roulette` with an
  explicit discriminated-union return type, `hardcoded_localhost` behind a
  production throw.
