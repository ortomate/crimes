---
"crimes": minor
---

**The honest denominator.** Six streams on the boundary between what the
scanner looked at and what it skipped.

- A user `exclude` no longer replaces the defaults wholesale, and
  `crimes init` derives its list instead of hand-copying 9 of 20
  patterns. New `excludeDefaults` opt-out; `assets.exclude` fixed the
  same way.
- `crimes` now honours a repo's own tooling exclusions when **two
  independent tools agree** — pydantic 487 → 402 findings (−17.5%) —
  and reports every skipped path under `coverage.warnings[]` with the
  config keys that authorised it. New `honourToolingExcludes` opt-out.
  Build-backend tables are never honoured.
- `sync_io_in_hotpath` stops charging one-shot scripts: airflow
  811 → 680 (−16% of the detector), mlflow 402 → 347, pydantic 17 → 11,
  with the known production counter-example still reported.
- `commented_out_code`'s two variants now identify a block the same way.
  Fingerprints move for single-block non-JS files.
- One shared intrinsic ladder across both language packs, plus a
  standing gate on cross-pack disagreement. Findings-neutral.

`schema_version` stays `0.7.0`; all schema changes are additive.
