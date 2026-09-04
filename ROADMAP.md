# Roadmap

Reviewed: 2026-09-04

## Milestones

- [x] M1 Public launch: crimes installs from npm, crimes.sh is live, and every release since 0.10.0 carries notes
  <!-- draft note: PRD §22 milestones 0 to 5 compressed into one reached outcome. Evidence: npm `crimes@0.26.0` published 12 August 2026; crimes.sh returns 200 today; release notes in docs/releases/ and GitHub Releases through v0.26.0; 2,835 npm downloads in the month to 29 August, bots not separated from people. -->
- [x] M2 The portfolio's own repositories run crimes on every card
  <!-- draft note: Andrew's word, 4 September 2026: "we should be dogfooding crimes too". Nine repositories under ~/dev carry a committed `.crimes/` (feedback.jsonl and suppressions.json, 17 to 22 August), and the executor skill runs `crimes context`, `crimes scan --changed` and `crimes verdict` on every card. Marked reached on that evidence; whether the verdicts flow back is M4. -->
- [ ] M3 0.27.0 is published, and the portfolio's pins survive it
  Done when: `npm view crimes version` prints 0.27.0 and the nine dogfooding repositories' pins match again.
  <!-- draft note: origin/main is ten commits ahead of this clone, all by Tim Copeland (a repository collaborator) on 26 August, ending in "Prep crimes@0.27.0"; docs/roadmap.md there calls 0.27.0 shipped, but npm latest and the newest GitHub Release are both 0.26.0 today. 0.27.0 moves schema_version to 0.8.0 and changes fingerprints for eleven detector types, which orphans every suppression in the nine dogfooding repositories until they are re-pinned with `crimes triage --apply`. It is not the product release SPRINT-0.27.md planned: its own "Still unsettled" section defers S1 (the recency default) and M6 (binaries) again. -->
- [ ] M4 What the portfolio's scans say reaches crimes: false positives recorded in the products' feedback.jsonl become fixtures, scenarios or closed backlog entries
  Done when: three portfolio feedback verdicts are cited in crimes' fixtures, backlog or a release note.
  <!-- draft note: a guess at the missing half of dogfooding. The products' feedback.jsonl files hold verdicts with reasons, but no `~/.crimes/feedback-rollup.jsonl` exists on this machine and nothing in crimes' evals, .planning or docs cites a portfolio verdict. The 2 August dogfooding log ran crimes over thickeningtime as a corpus, which is the tool reading a repository, not a repository answering back. docs/feedback.md describes the rollup path. -->
- [ ] M5 The default sort is a written decision, and crimes installs from Homebrew as a standalone binary
  Done when: a Homebrew-installed binary scans fixture 11-py-service with JSON byte-identical to `npx crimes`.
  <!-- draft note: PRD milestone 6 and SPRINT-0.27.md streams S1 and S2, in the plan's own order: settle recency before widening the install base. The Done when is the sprint plan's, which insists the Python findings be present, because the WASM asset walk is expected to fail silently under packaging. Deferred in every release since 0.17.0. -->
- [ ] M6 Someone outside Ortomate uses crimes and says so
  Done when: one issue, PR or feedback export on ortomate/crimes comes from an account that is not a collaborator.
  <!-- draft note: the weakest observable form of adoption, chosen because nothing stronger is stated anywhere. Today: 2 stars, 0 forks, and the one issue and six PRs are all from the two collaborators. The strategy draft's first question, what winning looks like for an open-source CLI, is still unanswered, and Andrew's answer should replace this milestone. -->

## Not on the roadmap

- `crimes ask` (PRD §26). Deferred in every sprint plan; SPRINT-0.27.md asks whether it is still the intent. Revisit when M6 has a first outside user to ask for.
- A hosted service or paid tier. Nothing in the repository proposes one; revisit when Andrew answers what winning looks like, and no later than M6.
- The scoring-model tail: STRUCTURAL_CEILING's level (P2.1), the empty `standard` class (P2.2), inline intrinsic ladders (P2.4) and `weak_test_signal` granularity (S3). Deferred with reasons in SPRINT-0.27.md §5; revisit in the sprint after M5.
- Windows binaries. PRD milestone 6 says "if feasible"; revisit once macOS and Linux ship under M5.
