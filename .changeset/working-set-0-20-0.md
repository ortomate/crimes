---
"crimes": minor
---

**0.20.0 — scope it to the work.** `crimes scan` gains a working set,
and the default report stops describing findings it declined to show.

Minor rather than patch: `schema_version` moves `0.6.0` → `0.7.0`
(additive — `ScanReport.working_set`, plus a
`working_set_path_unmatched` coverage-warning kind), and the CLI gains
three flags. **No fingerprints change**, so pinned baselines,
suppressions and triage entries carry over untouched — nothing to
re-record.

- **`scan --files a.ts,b.ts`** and **`scan --related-to <file>`** narrow
  a scan to a working set. `--related-to` walks the import graph both
  directions (what a file imports can break it; what imports it is what
  it can break); `--related-depth N` widens it. Selectors are mutually
  exclusive with each other and with `--changed`.
- **`--fail-on` accepts any working-set selector**, not only
  `--changed`.
- **The resolved set is reported** as `working_set.files`, and a path
  that matched nothing warns on stderr — a typo previously produced a
  report reading "No crimes detected. Suspiciously clean."
- **`--changed` is documented as the post-edit selector.** On a clean
  tree it correctly returns nothing, which is where most agent tasks
  start, and why the other two exist.
- **The headline counts what the report shows.** It announced 491
  findings above a body listing 339; the rest were already non-domain
  and collapsed into a footer. Stated now as `+152 in non-domain
  paths`. `summary.total` in the JSON is unchanged.
- **The totals repeat above the closing line** on a long report, so
  reading them no longer needs a second run at `--top 3`.
- **`crimes init --agents` leads the README's agent section**, and the
  `--help` tips block leads with scoping instead of never mentioning it.
