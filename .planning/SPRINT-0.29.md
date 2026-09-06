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

## Progress

- Retained the 0.28.2 bundle and pre-edit context/core scans outside source.
- Created an immutable baseline source worktree for performance comparison.
- Implementation and measurements in progress.
