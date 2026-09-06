---
stage: pre-PMF
posture: active
visibility: shared
last reviewed: 2026-09-06
promoted: 2026-09-04, from docs/strategy-drafts, on Andrew's word
---

# crimes strategy

The immediate product objective is to help a human or coding agent make
safer changes: identify relevant risks before editing and detect new risk
afterward, with evidence that can be checked locally. JSON is the contract;
the terminal view should make the next useful action easy to find.

The accepted September 2026 product review prioritizes reliable context,
less repetitive default reporting, explicit analysis limitations, recoverable
triage decisions and maintainable documentation. See
[0.28 release notes](./docs/releases/v0.28.0.md) for the implementation and
verification of that work.

## What success means

- A context briefing retains the applicable findings and scores of a full
  scan and names actual import neighbors and discoverable tests.
- The default report prioritizes consequential risks without rewarding
  repeated instances of one mild claim.
- Acceptance-tested paired edits measure whether crimes helps agents
  complete changes. The first three tasks tie at 3/3 per arm; they establish
  a harness, not a measured benefit. Broader, repeated tasks are needed.
- Users can preserve reasons and ownership through identity migrations,
  and distinguish an empty finding list from incomplete analysis.

The project remains pre-PMF; download counts alone do not establish use,
retention or customer value. A commercial objective and adoption target
remain open. The accepted engineering review does not decide a paid tier,
hosted service or business model.

## Boundaries

Keep local deterministic analysis useful without a model or cloud. Keep
style and accessibility suggestions optional. Do not expand into general
linting or security scanning. New features should demonstrate an editing
benefit before they add another command or default finding family.

[ROADMAP.md](./ROADMAP.md) records next outcomes;
[docs/roadmap.md](./docs/roadmap.md) records shipped implementation;
[PRD.md](./PRD.md) retains the original specification.
