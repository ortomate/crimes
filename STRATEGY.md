---
stage: pre-PMF
posture: active
visibility: shared
last reviewed: 2026-09-04
promoted: 2026-09-04, from docs/strategy-drafts, on Andrew's word
---

# crimes

**Draft for approval. Hobbes drafted this from evidence; Andrew owns the result.** The front matter carries only the bare values the register parses; every caveat the draft of 24 August put beside them is in the section below, and nothing here is a decision Andrew has made unless it says so.

## Stage, and why it is provisional

pre-PMF, close to launch, proposed. Inferred from the 0.27.0 sprint plan calling itself the first product release, which is Andrew's own statement of intent. Since the draft: crimes@0.26.0 is on npm, crimes.sh is live, and the roadmap of 4 September counts 2,835 npm downloads in the month to 29 August with bots not separated from people. Still not evidence of customers. Posture active: third in the portfolio sequence of 4 September.

## Objective

Proposed, not confirmed. The portfolio is its own first user: every card the executor runs already runs crimes, and nine repositories under ~/dev carry a committed `.crimes/` (roadmap M2, marked reached on Andrew's word of 4 September: "we should be dogfooding crimes too"). What winning looks like beyond that, for an open-source CLI (adoption, a paid tier, a hosted service, or a credential that makes other things possible), is the draft's first question and is still unanswered; the roadmap's M6 is a placeholder for Andrew's answer.

## Current bet

Ship 0.27.0 as the first product release.

The roadmap of 4 September records origin/main ten commits ahead of this clone, all by Tim Copeland on 26 August, ending in "Prep crimes@0.27.0", while npm and GitHub Releases still say 0.26.0. 0.27.0 moves schema_version to 0.8.0 and changes fingerprints for eleven detector types, which orphans every suppression in the nine dogfooding repositories until they are re-pinned with `crimes triage --apply`. It is not the product release SPRINT-0.27.md planned. (derived from the roadmap on 4 September 2026)

## Success measure

Not established by the draft; see "What Andrew needs to decide". The roadmap proposes: `npm view crimes version` prints 0.27.0 and the nine dogfooding repositories' pins match again (M3); three portfolio feedback verdicts are cited in crimes' fixtures, backlog or a release note (M4); one issue, PR or feedback export on ortomate/crimes comes from an account that is not a collaborator (M6, the weakest observable form of adoption). (derived from the roadmap on 4 September 2026)

## Non-goals

Not a linter, per the README. Not a hosted service or paid tier, on current evidence; revisit when Andrew answers what winning looks like. From the roadmap: `crimes ask` (PRD §26), deferred in every sprint plan; Windows binaries until macOS and Linux ship under M5.

**Draft for approval, rewritten on 24 August after the repository was cloned.**
The first version of this file was nearly empty and said so, because `crimes`
was not on this machine and inventing a strategy for an unread repository would
have been fabrication. It is cloned now, so this is written from evidence.

## What was observed

- **528 commits, every one authored by Andrew Mayfield.** That is the largest
  genuine commit history in the portfolio. Thickening Time is 328, orto.band
  265, Angry Assistant 244. The two products that appear larger in the register,
  Bossary at 797 and eval.dog at 810, are MakerKit starters whose history is not
  Andrew's (`docs/portfolio-strategy.md` §7).
- 553 source files. Last commit 12 August 2026. Production deployed 12 days ago.
- **It is published to npm** as `crimes`, carries a licence badge and runs CI on
  GitHub Actions. **It is the only public repository in the portfolio**; every
  other one checked is private.
- The README states the product plainly: "A crime scene investigator for your
  codebase. Built for agents, readable by humans." An open-source CLI that scans
  a repository for maintainability risks, code smells, duplicated business
  rules, weak test boundaries, "and patterns that confuse AI coding agents." It
  explicitly positions against linters.
- The last commits are release work: `Prep crimes@0.26.0`, and a sprint plan
  described as "the first product release" in the subject line.
- There is also a `crimes` skill installed at `~/.hermes/skills`, unexamined.
- Zero open board tasks.

## What is inferred, and how weakly

Proposed stage **pre-PMF, close to launch**. The inference rests on the 0.27.0
sprint plan calling itself the first product release, which is a stronger signal
than anything available for the other sixteen because it is Andrew's own
statement of intent rather than a deploy timestamp. It is still not evidence of
customers, and npm download figures were not checked.

## Why this one is different from the rest of the portfolio

Three things, and they are strategic rather than cosmetic.

1. **It is open source and published.** Every other product is a private
   web app behind a domain. The distribution mechanism, the licence, and the
   competitive posture are all different, and the portfolio strategy's §6
   coherence rules were written for web products.
2. **Its customer is an agent, or an engineer who runs agents.** That is the
   same population this whole programme is building for.
3. **The portfolio should be its own first user.** Spec 4 gives the Sweeper
   cleanup, simplification and performance work across seventeen repositories.
   `crimes` scans repositories for exactly those things. If it is good, the
   Sweeper should run it; if the Sweeper would not run it, that is worth knowing
   before asking anyone else to.

## What Andrew needs to decide

1. **What does winning look like?** An open-source CLI has several: adoption,
   a paid tier, a hosted service, or a credential that makes other things
   possible. The repository does not say and the answer changes everything.
2. **Is 0.27.0 still the plan?** The sprint plan is dated 12 August and nothing
   has moved since.
3. **Should the Sweeper use it**, and is the `crimes` skill in `~/.hermes/skills`
   the mechanism? That would make it portfolio infrastructure as well as a
   product, which under §5 outranks single-product work.
4. **Does public and open source change what a Bot may do to it?** Spec 4 §7
   gates production, billing, auth and customer data. It says nothing about
   publishing to a public registry, which is irreversible in a way a deploy is
   not.

## Where this came from

Read on 24 August 2026 after cloning `git@github.com:ortomate/crimes.git`: the
README, `package.json`, `git log`, commit authorship counts, and the manifest
entry. No cmd pack exists for this product.
