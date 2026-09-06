# 0.29 follow-ups: latency and completed edits

Accepted by Andrew on 7 September 2026 after the 0.28.2 readiness review.
Implementation branch: `perf/context-and-outcomes`. Baseline: `v0.28.2`.

## Acceptance and sequence

1. Reproducible end-to-end scan/context/hook timing, first and repeated
   processes, memory, stage timings, fixed source/configuration and report
   equivalence. Include small/medium JS, Python, mixed and the crimes source.
2. Profile before optimizing. Reuse reads/parses where measured; preserve
   findings, scores, fingerprints, order and coverage. Test freshness after
   source/configuration/root changes. Persistent caching is conditional on
   evidence and a bounded invalidation design, not a predetermined feature.
3. Twelve behavioral edit tasks, two hosts, three conditions (without,
   supplied briefing, installed workflow), three repetitions: 216 runs.
   Pin model/settings, balance order, keep acceptance outside agent inputs,
   retain failures and usage/time. Pilot before the full matrix. Reserve
   tasks from tuning and distinguish synthetic evidence from outside use.
4. Inspect failures/distraction, add reproductions and calibrate only when
   evidence supports a scoped change. A tie is an outcome, not an improvement.
5. Fault-injection/recovery tests for pin migration; a self-serve external
   trial covering install, a real edit, and a reviewed feedback export.

Completed logical changes are committed after appropriate checks. Final
validation includes `pnpm verify`, package smoke, same-corpus ranking and
pre/post self-scan comparison. No new release publication was requested in
this follow-up; record results and release readiness without claiming npm
has changed. External recruitment is not authorized; prepare the trial.

## Outcome

- Complete: bounded per-analysis source/parse reuse and batched coverage
  matching. Eight corpora, three command paths, first plus ten repeated
  fresh processes per binary. Both the initial sequential batch and the
  alternating confirmation remain committed. The largest context case
  improves from 6270 to 2969ms median, with +15 MiB peak memory; small cases
  do not demonstrate a material gain. No persistent cache was warranted.
- Complete: exact optimization report parity and separately declared advice
  changes, with full findings/scores/identity/order/coverage comparison.
  Ranking is unchanged on the same corpus and clock.
- Complete: 216 assigned trials across 12 tasks and two hosts, with six
  tasks reserved from tuning. All primary acceptance checks passed in every
  condition; the resulting tie does not establish better edits. Installed
  workflows took longer on these small tasks.
- Complete: all 31 primary scope flags reviewed. Five briefing runs expanded
  a small policy edit; one changed an unspecified fallback edge. Narrowed
  literal-scatter guidance and retained the reproduction. An 18-run separate
  check retained a further failure: an agent removed persistent integration
  assertions after a low fan-out finding. Connectivity advice and the skill
  now preserve useful regression coverage.
- Complete: audited command recognition uniformly from raw logs. Six valid
  pre/post pairs were missed when global flags preceded the subcommand;
  help/error calls also inflated context counts. Original metrics and audit
  hashes remain recorded. Two genuine executable-selection deviations are
  retained in the assigned condition. A separate 12-run check of explicit
  local paths passed, including all four installed pre/post pairs.
- Complete: staged pin migration, original-byte/permission journal, explicit
  recovery, refusal of later conflicting edits, fault injection and real
  SIGKILL recovery/retry tests. Multi-file visibility and power-loss limits
  are documented.
- Complete: self-serve external trial, human/agent documentation, package
  upgrade smoke including published 0.28.2, and Node 18 tarball verification.
  No external recruitment or independently reported result is claimed.

Complete: the final 18 test-preservation trials passed acceptance. All six
installed runs took a skill action, and five had matching final pre/post
scans. One retained useful integration checks after a low connectivity finding
but ran a broader final scan after another test edit; the workflow miss stays
recorded. Full results and review ledgers distinguish this from the original
216-run comparison. Local verification is recorded with the candidate; CI
runs on the exact final PR commit. The plan remains here until publication, as required
by `.planning/README.md`. Preparing 0.29.0 does not claim it is on npm.

## Evidence corrections and limits

Pilot refund wording conflicted with its acceptance expectation; it was made
explicit and re-piloted before the main study. Batch concurrency wording,
condition order and file-set-aware hashes were fixed before the main matrix.
These are measurement corrections, not scanner improvements. The primary
artifact stayed frozen; scoped follow-ups use separately identified packages.

The initial TSX timing regression is retained even though it did not repeat.
No universal speedup or representative agent-benefit claim is supported.
Further generalization needs larger real tasks and independently reported
outcomes, not more selective reruns of this ceiling-limited suite.
