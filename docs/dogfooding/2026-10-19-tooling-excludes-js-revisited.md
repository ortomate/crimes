# Tooling excludes on JavaScript, revisited: built, under the same rule

**Date:** 2026-10-19
**Build under test:** `crimes` 0.29.5 (shipped), re-measured on 0.29.8
**Supersedes, in part:** [2026-08-11 tooling excludes on the JavaScript
corpus](./2026-08-11-tooling-excludes-js.md), which decided *do not build*.

That record measured `.eslintignore`, root `tsconfig.exclude` and
`.gitattributes linguist-vendored` on hono, cal.com, n8n and posthog,
found **zero** corroborated patterns, and closed the work. It also named
two things it did not decide: ESLint 9's flat-config `ignores` (it noted
`.eslintignore` was a dead format, not that flat config was unreadable)
and nested configs ("a separate decision with its own failure modes").

## What changed the answer

A private Java + JavaScript estate (its frontend, a nested package) names its vendored libraries in two independent
tools, in a nested package directory:

| source | entry |
| --- | --- |
| `eslint.config.mjs` | `{ ignores: ['js/lib/*', 'js/vendor/*', …] }` |
| `.prettierignore` | `/js/lib/`, `/js/vendor/`, … |

`js/lib/` holds old copies of third-party libraries. It produced **271
of 1,596 findings (17%)** and the top-ranked file in the report — the
same shape of problem as pydantic's `pydantic/v1`, which is why the
pyproject reader exists.

## What was built, and how it keeps the old guarantees

`packages/core/src/manifest/js-tooling-excludes.ts` and
`scan-tooling-excludes.ts`:

- **Corroboration is unchanged:** two independent tools must name the
  pattern. ESLint's two sources (`.eslintignore`, flat config) count once.
- **Per directory, anchored.** Configs are read in any directory holding
  scanned files and corroborate only with configs *in the same
  directory*; patterns apply anchored to it. Where ESLint (anchored) and
  Prettier (unanchored) differ, the narrower reading wins.
- **Flat config is read as text, never executed,** and only an object
  whose sole key is `ignores` counts — the only form ESLint treats as a
  global ignore. A non-literal element drops the object.
- **Any negation voids its source,** since dropping `!keep.js` and keeping
  the rest would exclude more than the repo does.
- Skips stay listed under `files_excluded_by_tooling`, and
  `honourToolingExcludes: false` still turns the rule off.

## The n8n case, re-checked

The 2026-08-11 record's load-bearing example is n8n's `.prettierignore`,
which ends `**/*.ts` / `**/*.js` under `# Handled by biome`. Read alone it
would drop the whole codebase. Under this rule it pairs with nothing:
n8n's `.prettierignore` is at the root, and its `eslint.config.mjs` files
are in `packages/cli`, `packages/core`, `packages/node-dev` and
`packages/nodes-base`. Different directories do not corroborate.

## Re-measured on the same corpus (current default branches, shallow)

| repo | JS tooling configs present | corroborated | files excluded |
| --- | --- | --- | --- |
| hono | none | 0 | 0 |
| cal.com | none | 0 | 0 |
| n8n | root `.prettierignore`; ESLint flat config in 4 packages | 0 | 0 |
| posthog | 4 `.prettierignore`, no ESLint flat config | 0 | 0 |

The rule still excludes nothing on the corpus the original decision was
measured on, and excludes exactly the vendored tree on the repository
that motivated it. That is the property the corroboration rule was meant
to have: silent on preference files, active on agreement.

## Incidental: wall time on the corpus

Measured on the same shallow clones, a 0.29.7 working build (before the 0.29.8
`--liftoff-only` change), one machine, the four
scans concurrent: hono 3.6 s, cal.com 120 s, n8n 1,602 s, posthog 2,601 s.
n8n's full scan [did not finish in 60 minutes](./2026-08-02-log.md) in
August. Large-repository cost is still the open item in
[roadmap status](../roadmap.md); a 90-second profile of n8n is entirely
TypeScript parsing for the IA index, not the tooling-exclude reader.
