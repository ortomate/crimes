---
"crimes": minor
---

Six changes to what the scanner reads, what it skips, and how it reports
the difference.

- A user `exclude` is now additive to the defaults rather than replacing
  them, and `crimes init` derives its list instead of hand-copying 9 of
  20 patterns. New `excludeDefaults` opt-out; `assets.exclude` fixed the
  same way.
- crimes honours a repository's own tooling exclusions when two or more
  independent tools name a path — pydantic 487 → 402 findings (−17.5%)
  — and reports every skipped file under `coverage.warnings[]` with the
  config keys that authorised it. New `honourToolingExcludes` opt-out.
  Build-backend tables are never read.
- `sync_io_in_hotpath` no longer charges one-shot scripts: airflow
  811 → 680 (−16% of the detector), mlflow 402 → 347, pydantic 17 → 11.
  The known production counter-example is still reported.
- `commented_out_code`'s two variants now identify a block the same way.
  Fingerprints move for single-block non-JS files.
- One shared intrinsic ladder across both language packs, plus a test
  that fails on undocumented cross-pack disagreement. Findings-neutral.
- `DEPTH_FLOOR` re-centred 40 → 28 in the eval harness; the deep
  population, the mean and all stored baselines are unchanged.

`schema_version` stays `0.7.0`; all schema changes are additive.
