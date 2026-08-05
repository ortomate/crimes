---
"crimes": minor
---

**0.21.0 — precision, where the false positives were.** Four detectors
named in an outside field report, all re-verified against `main` first
and measured on real repositories before and after.

Minor rather than patch because detector *meanings* change — a
`baseline check` or `verdict` gate will see different severities — even
though `schema_version` stays at `0.7.0` and **no fingerprints move**.
Pinned baselines, suppressions and triage entries carry over untouched;
`crimes feedback recheck` carries a `0.21` note for each of the four.

- **`logic_in_comments`** matched domain vocabulary with
  `String.includes`, so `auth` matched "**Auth**ored" and `utc` matched
  "o**utc**ome". Now whole-word with a closed inflection set, and the
  vocabulary is spelled out per concept rather than relying on stems.
  choreograph 10 → 7.
- **`direct_date`** classifies each reading as deciding a branch vs
  being recorded or rendered, names both in the evidence, and caps a
  record-only file at `medium`. Nothing is filtered: the report's own
  example turned out to contain two real poll timeouts. choreograph
  `high` 4 → 1.
- **`high_fan_in_fan_out`** stops promoting fan-in when ≥80% of
  importers use `import type`. The count, the finding and the evidence
  are unchanged — only the severity moves.
- **`name_behavior_mismatch`** stops charging a `get*` function for a
  `create*` call whose result it binds and then reads through. A shape
  rule, not a `createClient` allowlist. choreograph 19 → 7.

**Nothing became a filter.** Every change is evidence or severity,
because a finding that is noise mid-task can be exactly what an audit
run wants.
