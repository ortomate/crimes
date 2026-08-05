---
"crimes": minor
---

**0.19.0 — the backlog release.** 50 commits, ~30 defect fixes, four
features, two `schema_version` bumps (`0.4.0` → `0.6.0`). Versions
`0.18.0`–`0.18.4` were internal eval-baseline markers and were never
published, so everything they carried lands here.

Minor rather than patch, and the reason is concrete: the wire format
changed twice, and pinned suppression / baseline entries for twelve more
detectors stop matching. `RELEASE_NOTES` in `packages/core/src/feedback/`
is keyed by minor, and the per-detector migration hints for this span sit
under `"0.17"` and `"0.18"` — a patch number would leave the current minor
at `"0.18"` and tell users nothing had changed.

- **Install is clean again.** The postinstall script is removed. npm ≥
  11.18 blocks install scripts by default, so the only crimes-specific
  output on a fresh install was an `allow-scripts` approval prompt — spent
  on a seven-line banner npm swallowed anyway.
- **Schema `0.5.0`:** `scores.blast_radius_importers` →
  `blast_radius_transitive_importers`, plus a new
  `blast_radius_direct_importers`. The old name promised "N files import
  this" and delivered the transitive closure.
- **Schema `0.6.0`:** every finding carries a required `fingerprint`, plus
  an optional `score_rationale`.
- **Detector precision, measured on real repos:** airflow
  `commented_out_code` 8,019 → 45, n8n editor-ui `parallel_destination`
  2,819 → 0 (first detector shipped gated off), `pass_through_abstraction`
  fabricated chains 7 → 0, airflow claimed-silent Python tests −27.1%.
- **`agent_risk` stops being a length ranking**, `blast_radius` moves to a
  log scale, and repo-level findings get their own section in the human
  report.
- **`detectors.enable` naming a gated detector is now additive.** It was a
  pure allowlist, so following the tool's own remediation hint verbatim
  turned off the other 68 detectors and the entire asset pass, with no
  warning.
