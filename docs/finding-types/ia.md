# Information Architecture findings

Information architecture (IA) findings flag places where a repo gives
**multiple competing answers to the same structural question** — what a
concept is called, where it lives, which implementation owns it, how users
move through the product. They are the form of agent-risk `crimes` cares
about most: deterministic evidence of source-of-truth ambiguity that
linters and security scanners do not look for, and that AI coding agents
repeatedly trip over when they pick the wrong vocabulary, the wrong route,
or the wrong copy of a shared piece of nav.

This page is the long-form reference for the IA finding types shipped in
`crimes@0.3.0`. For the wire format, see
[`docs/json-schema.md`](../json-schema.md). For the agent workflow that
consumes these findings, see [`docs/agent-usage.md`](../agent-usage.md).

## Contents

- [Why IA crimes matter](#why-ia-crimes-matter)
- [What ships in `0.3.0`](#what-ships-in-030)
- [Missing Agent Context](#missing-agent-context)
- [Route Metadata Drift](#route-metadata-drift)
- [Duplicated Navigation Source](#duplicated-navigation-source)
- [Concept Alias Drift](#concept-alias-drift)
- [Docs-Code Drift](#docs-code-drift)
- [How IA findings stay deterministic](#how-ia-findings-stay-deterministic)

---

## Why IA crimes matter

| Audience       | What IA drift costs them                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Humans**     | Reviewers re-read the same surface three ways because the codebase calls it three names. Onboarding hires guess at canonical terms. |
| **Teams**      | A "rename the workspace concept" PR misses the four files that still say `team`. Permissions diverge from nav. Docs lie.            |
| **Customers**  | The page says "Plans" in the sidebar, "Subscription" in the title, and "Billing" in the breadcrumb. Same destination, three labels. |
| **AI agents**  | An agent extending one nav source leaves the others stale. An agent that finds `team.ts` confidently writes code that ignores the existing `workspace.ts` under another name. |

Every IA detector in `crimes` produces findings that are **evidence-first
ambiguity signals**, not claims of semantic truth. We say _"appears to
disagree"_, not _"is wrong"_. The detector cites the file, line, and
literal that disagrees. If the team has accepted the alias on purpose,
the finding is still useful — it surfaces the place where future edits
need a deliberate vocabulary choice.

**No LLM, no API key, no network access** is required to produce these
findings. Every detector is a deterministic pass over AST results,
markdown headings, and file paths.

---

## What ships in `0.3.0`

| `Finding.type`                  | Charge                          | Severity range | Confidence |
| ------------------------------- | ------------------------------- | -------------- | ---------- |
| `missing_agent_context`         | Missing Agent Context           | medium         | 0.90       |
| `route_metadata_drift`          | Route Metadata Drift            | medium         | 0.60–0.80  |
| `duplicated_navigation_source`  | Duplicated Navigation Source    | medium         | 0.70–0.85  |
| `concept_alias_drift`           | Concept Alias Drift             | low–medium     | 0.60–0.75  |
| `docs_code_drift`               | Docs-Code Drift                 | low            | 0.90       |

All five emit findings in the same `Finding` shape as the existing
structural detectors (`large_file`, `large_function`, etc.). Cross-file
findings populate the previously-reserved `related_files` field. The
schema is otherwise unchanged — `schema_version` is still `"0.1.0"`.

---

## Missing Agent Context

**What it detects.** Repos that declare a `bin` in `package.json` but
ship **no** agent-readable instructions — no `AGENTS.md`, no `CLAUDE.md`,
no `.claude/skills/*/SKILL.md`, and no `.agents/skills/*/SKILL.md`.
Agents loading the repo have nothing
to read: no install / build commands, no architecture notes, no safety
rules. They guess instead.

**Example evidence.**

```text
no AGENTS.md found at repo root
no CLAUDE.md found at repo root
no .claude/skills/*/SKILL.md present
no .agents/skills/*/SKILL.md present
package.json declares bin(s): messy — agents have no way to discover commands
```

**Why it matters.** A repo that ships a CLI is a public surface that an
agent will probably touch on someone else's behalf. Without project
context, the agent will default to generic conventions — and generic
conventions are how regressions land.

**Suggested fix.** Add an `AGENTS.md` covering install / build / test /
architecture / safety, a Claude Code skill under `.claude/skills/`, or a
Codex skill under `.agents/skills/`. Any signal is enough to silence the
finding; ship more than one for richer coverage.

**False-positive notes.**

- The detector requires a declared `bin` in `package.json`. Libraries,
  internal packages, and tiny test fixtures without a `bin` will not
  fire — agents are far less likely to be the primary editors there.
- Monorepos: today the detector only checks the **scanned root**. A
  per-package `bin` inside `packages/<foo>/package.json` will not
  trigger the finding when scanning the monorepo root. Per-package
  walking is future work.

---

## Route Metadata Drift

**What it detects.** A single route's path, file location, default-export
component name, page title, metadata title, and nav-source labels appear
to describe the destination using **different concept tokens**. The
detector needs ≥3 sources to disagree before it fires, so single-token
shorthand routes (`/`, `/api`) never trip it.

**Example evidence.**

```text
route path: /settings/billing
file: src/routes/settings/billing.tsx
component: PricingPage
metadata.title: Plans
<title>: Subscription
nav label in src/nav/registry.ts: Plans
```

**Why it matters.** An agent asked to "rename the billing page" will edit
the file it grepped first and leave the other three vocabularies stale.
Reviewers reading the PR will not notice — the diff looks consistent in
isolation. The next agent picks up the inconsistent state and amplifies
it.

**Suggested fix.** Pick the canonical name for the destination
(`Subscription`? `Plans`? `Billing`?) and align every source that
labels it — route path, file location, component name, page title /
metadata, and nav labels. Document the decision in the page header so
the next agent sees it before editing.

**False-positive notes.**

- Layouts and wrapper routes are skipped — the detector only inspects
  files whose route is a leaf path. A `layout.tsx` that wraps multiple
  pages does not fire.
- Translation-key labels are not used as drift signals — only literal
  string labels count. A `<Title>{t("billing.page.title")}</Title>` is
  ignored.
- Two-source disagreement is **not** enough; the detector requires
  ≥3 distinct concept token sets to keep noise down.

---

## Duplicated Navigation Source

**What it detects.** A single internal destination (e.g.
`/settings/billing`) appears in **two or more nav-like source files** —
sidebars, route registries, breadcrumbs, sitemap arrays — with
**different non-empty labels**. The detector parses top-level array
literals containing objects with destination + label keys
(`{ to, label }`, `{ path, title }`, etc.) and groups by normalised
destination.

**Example evidence.**

```text
destination: /settings/billing
src/nav/registry.ts label: Plans
src/nav/sidebar.ts label: Billing
```

**Why it matters.** Each nav source claims to know what a destination is
called. Agents pulled in to "update the billing label" almost always
edit the one nav file they grep first and leave the others stale. The
two then drift further with every subsequent change.

**Suggested fix.** Either consolidate into one nav source of truth, or
write down in a comment which nav file is canonical and which is
generated / derived. If both must stay, add a code-shaped invariant
(generated file, type-checked link from one to the other) so the next
agent cannot diverge them silently.

**False-positive notes.**

- External URLs (`https://…`, `mailto:`, anchors `#…`) are skipped — only
  internal destinations starting with `/` are grouped.
- Both nav sources must declare the destination with a **non-empty**
  label. A nav entry with a destination but no label is ignored.
- Labels that differ only in whitespace or letter-case are treated as
  the same label (normalised before comparison).

---

## Concept Alias Drift

**What it detects.** Multiple aliases from a single seeded concept group
(`team` / `workspace` / `organisation` / `account` for the tenant
concept; `plan` / `tier` / `subscription` / `package` for billing;
`user` / `member` / `seat`; etc.) appear across the repo's **product
surface** — route paths, page labels, nav entries, doc headings — with
each alias landing in **≥2 distinct directories**. The detector emits at
most one finding per concept group and caps the total at the three
strongest groups per scan.

**Example evidence.**

```text
alias group: tenant
aliases found: account, organisation, team, workspace
"account" in 2 file(s): docs/billing.md, src/routes/account/subscription.tsx
"organisation" in 2 file(s): docs/teams.md, src/routes/team/index.tsx
"team" in 2 file(s): docs/teams.md, src/routes/team/index.tsx
"workspace" in 2 file(s): docs/teams.md, src/routes/workspace/members.tsx
```

**Why it matters.** Agents asked to add a feature for "the team" will
write the new code under whichever alias they grep first. The
corresponding logic under the other three aliases stays put and
diverges. Reviewers, customers, and docs all keep paying the cost.

**Suggested fix.** Pick the canonical alias (or document the deliberate
distinction between aliases — `account` for billing, `workspace` for
collaboration, etc.). Update the docs that describe the concept first
so future edits have a single reference.

**False-positive notes.**

- Quorum is strict: **≥3 aliases from the same group, each in ≥2 distinct
  directories, with ≥1 product-surface hit** (route, label, nav, or doc
  heading — not just a file-path token). Reduces noise on repos that
  legitimately distinguish, say, `account` (billing identity) from
  `workspace` (collaboration scope).
- Test, fixture, and mock files are excluded from alias counting
  (`__tests__/`, `__mocks__/`, `tests/`, `fixtures/`, `mocks/`,
  `*.test.*`, `*.spec.*`).
- This is an **ambiguity signal**, not a rename instruction. Aliases
  used deliberately (compat layers, migration shims, multi-tenancy
  boundaries) will still trip the detector — the right response is
  often to document the distinction, not to consolidate.
- The seeded alias catalogue ships in
  [`packages/core/src/ia/aliases.ts`](../../packages/core/src/ia/aliases.ts).
  Adding speculative groups raises the false-positive rate of every
  scan; the catalogue is intentionally small.

---

## Docs-Code Drift

**What it detects.** A markdown document under `docs/` (or a root-level
`*.md`) contains a **local link that does not resolve to a file on
disk**. Broken doc links lead agents to follow stale instructions or
imagined paths.

**Example evidence.**

```text
docs/teams.md:5 → ./setup.md (not found)
```

**Why it matters.** Documentation is the second-most-trusted source an
agent has after the code itself. When `docs/teams.md` says "see
`./setup.md`" and that file no longer exists, every agent reading the
doc follows the dead link, gets confused, and improvises.

**Suggested fix.** Either restore the referenced file, update the link
to point at its replacement, or remove the reference entirely. Whichever
is right, do it in the same PR as whatever caused the drift.

**False-positive notes.**

- External links (`http://`, `https://`, `mailto:`, `tel:`, `ftp://`)
  are not validated — only local links.
- Anchor-only links (`#section`) are ignored.
- Query strings and fragments are stripped before resolution.
- Links inside inline backtick spans (`` `[label](path)` ``) are not
  flagged — examples in code-doc text are common and benign.
- The detector currently scans `docs/**/*.md` + root-level `*.md` /
  `*.mdx`. Markdown elsewhere in the tree is not walked.
- **Command-drift** detection (docs referencing a CLI command the `bin`
  does not implement) is **deferred to a later release**. It needs
  deterministic command-registration scanning that we have not yet
  shipped — until then, broken command references are not flagged.

---

## How IA findings stay deterministic

Every finding above is built from one or more of these inputs, all
deterministic:

- **Path tokens** — repo-relative POSIX file paths, normalised and
  stop-word filtered.
- **Route paths** — derived from `src/pages/`, `src/app/`, `src/routes/`,
  `src/screens/` (and their unprefixed variants) by convention.
- **AST results** — `<title>`, `metadata.title`, `document.title`,
  `useTitle()`-style hooks, top-level nav-array literals, default-export
  identifiers, and `<Breadcrumb>` / `<Nav*>` / `<Sidebar*>` /
  `<Menu*>` / `<Tab*>` label attributes.
- **Markdown headings + local link targets** — parsed without an
  external markdown library, conservative about ambiguous syntax.
- **`package.json` `bin` entries** — read once per scan.

No detector calls out to an LLM, no detector reads the network, and no
detector consults git history. Two runs over the same repo produce
identical IA findings (same fingerprints, same evidence).

This is intentional. Every IA finding must be **quotable verbatim** —
the user, reviewer, or agent reading the report should be able to point
at a line in a specific file and say "this is the evidence." Anything
softer than that belongs in a PR comment, not a deterministic detector.

---

## New in 0.6.0

Five additional IA detectors land in `crimes@0.6.0`. Each follows the
same evidence-first contract above — concrete files, line numbers,
and quoted literals; hedged phrasing on the summary; no LLM.

### Orphaned Destination (`orphaned_destination`)

A route declared in a nav / IA index (`registry.ts`, `sidebar.tsx`,
sitemap) for which no source or route file resolves the destination.

**Example evidence.**

```text
nav entry declares destination "/workspace/billing" at src/nav/sidebar.tsx:14
no route file matches src/app/workspace/billing/{page,route}.{ts,tsx}
no top-level export in any src/routes/** file declares this path
```

### Parallel Destination (`parallel_destination`)

> **Off by default.** This detector produced 2,819 findings from 134
> files on n8n's `editor-ui` — 52.8% of that package's report — and
> nothing anywhere else in the corpus, so it ships gated. Turn it on
> with `"detectors": { "enable": ["parallel_destination"] }`, which is
> additive and leaves every other detector running. See
> [`configuration.md`](../configuration.md#default-off-detectors).

Two nav-like surfaces declare different routes for the same canonical
destination — e.g. `/billing` vs `/account/billing` vs
`/settings/subscription`.

**Example evidence.**

```text
3 routes appear to resolve the same destination "billing"
src/nav/sidebar.tsx:8  → /billing
src/nav/header.tsx:14  → /account/billing
src/nav/footer.tsx:22  → /settings/subscription
```

### Permission IA Drift (`permission_ia_drift`)

The same role / permission identifier is categorised differently
across surfaces — e.g. a nav source treats `billing-admin` as a
sub-role of `admin` while a route guard treats it as a peer.

**Example evidence.**

```text
role "billing-admin" appears with conflicting parents
src/nav/admin.tsx:14   nests under "admin"
src/middleware.ts:47   peers with "admin" and "moderator"
```

### Action Label Drift (`action_label_drift`)

The same domain action labelled differently across surfaces. Reads
the UI string literal index plus the IA alias seeds.

**Example evidence.**

```text
"delete" / "remove" / "archive" used for the same action
src/ui/MemberRow.tsx:22 → "Remove member"
src/api/team.ts:14      → handler name "deleteMember"
src/routes/team/index.tsx:47 → confirm dialog "Archive this user?"
```

### Command Docs / Code Drift (`command_drift_docs_code_drift`)

Markdown that references a `bin` subcommand the CLI no longer
implements. Variant of `docs_code_drift` that consumes the command
registrar index instead of filesystem checks.

**Example evidence.**

```text
docs/agent-usage.md:172 references `crimes ask`
no `program.command("ask"...)` found in packages/cli/src/commands/
no `register*Command` exports an "ask" subcommand
```
