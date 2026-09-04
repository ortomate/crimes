# Releasing `crimes`

How a new `crimes@X.Y.Z` reaches [npm](https://www.npmjs.com/package/crimes)
and [crimes.sh](https://crimes.sh), written so that a collaborator who has
never cut one, or an AI coding agent working on their behalf, can do it
without asking. Every command is meant to be pasted as written. Facts below
were verified against the repository, GitHub and npm on 4 September 2026;
anything not verified says so.

**The short version.** One file carries the version
(`packages/cli/package.json`). One commit, titled `Prep crimes@X.Y.Z`,
bumps it and every surface that mirrors it. One human action, publishing a
GitHub Release tagged `vX.Y.Z`, fires
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
builds, tests, smoke-tests, checks the tag against the version, and runs
`npm publish` using npm Trusted Publishing. Nothing is published from a
laptop and no secret is involved.

---

## 1. What publishes what

| Surface | Mechanism | Trigger | Human involvement |
|---|---|---|---|
| npm package `crimes` | `.github/workflows/release.yml`, workflow name `Release`, job `publish-npm` | A GitHub Release with event type `published` (drafts do not fire it, bare tags do not fire it) | Publishing the release. That is the whole trigger. |
| GitHub Release page (the canonical changelog) | Created by hand or with `gh release create`; body is `docs/releases/vX.Y.Z.md` | n/a | Writing and approving the notes, clicking Publish |
| crimes.sh | Vercel production deploy from `main`, building `apps/website/` | Every push to `main` | None. Note the consequence in section 9: the site shows whatever `main` says the version is, whether or not npm has it yet. |
| `CI` workflow (`.github/workflows/ci.yml`) | Jobs `build` and `publish-smoke` | Push or pull request to `main` | None. Must be green on the prep commit before the release is cut. |
| `evals-pr-replay` (`.github/workflows/evals-pr.yml`) | Replays pinned eval results | Push or PR to `main` touching detector, scoring, language, CLI or `evals/` paths; also `workflow_dispatch` | None |

Only `packages/cli` is published. `@crimes/core`, `@crimes/reporter`,
`@crimes/language-js` and `@crimes/language-py` are workspace packages at
version `0.0.0`, bundled into `dist/index.js` by tsup, and never released on
their own. `packages/cli/scripts/prepack.mjs` strips `devDependencies` and
every `scripts` entry from the packed manifest, and `postpack.mjs` restores
them, so the tarball declares no lifecycle script and no `workspace:*`
reference.

There is no `CHANGELOG.md`, on purpose. The GitHub Release page is the
changelog; `docs/releases/vX.Y.Z.md` is its in-repo draft and stays in the
tree afterwards. `.changeset/` is not wired to anything (no
`@changesets/cli`, no config, no CI step); read
[`.changeset/README.md`](../.changeset/README.md) before adding a file
there, and delete any file whose release has shipped.

## 2. Who can do what (verified 4 September 2026)

- **GitHub `ortomate/crimes`:** `andrewfantastic` and `timcopelandnz` both
  hold `admin`. Either can push to `main`, create and publish a Release,
  and re-run a workflow. `main` has **no branch protection** (the API
  returns 404 for it), so nothing stops a direct push; the discipline is
  procedural.
- **npm `crimes`:** the only maintainer is `andrewfantastic`. Because the
  workflow authenticates with OIDC rather than a personal token, **cutting a
  release does not need an npm account at all**. What does need one, with
  its 2FA: `npm deprecate`, `npm unpublish`, `npm dist-tag`, and changing the
  Trusted Publisher configuration on npmjs.com. Today only Andrew can do
  those.
- **Vercel:** not verified from this repository. The site has deployed from
  `main` on every push through 0.27.0's prep commit, so the wiring works;
  who holds the Vercel project is not recorded here.

## 3. One-time setup (already done; here so it can be checked or redone)

**npm Trusted Publisher.** On npmjs.com, as a maintainer of `crimes`:
Package settings, Publishing access, Trusted Publishers, Add Trusted
Publisher. Provider `GitHub Actions`, organisation `ortomate`, repository
`crimes`, workflow filename `release.yml`, environment blank. This is in
place: every `Release` run from v0.22.0 through v0.26.0 succeeded, and
`npm view crimes@0.26.0 dist.attestations` shows a SLSA provenance
attestation, which only Trusted Publishing produces.

**No `NPM_TOKEN` secret.** `release.yml` references no secrets and asks for
`permissions: contents: read, id-token: write` only. Do not add a token
"just in case"; it widens what a tampered workflow file could do, and the
workflow would not use it.

**Vercel.** Project linked to this repository, production branch `main`,
build command `node ./scripts/build.mjs` in `apps/website/`, output
`apps/website/dist`. Nothing per release.

**Branch protection.** Recommended and not configured. If someone turns it
on, require the `CI` checks (`install · build · typecheck · test` and
`publish smoke (pack + install + run)`) on `main`.

## 4. Preconditions

Confirm all of these before starting the prep commit.

```bash
cd /path/to/crimes
git switch main && git pull --ff-only
git status --porcelain            # must print nothing
node --version                    # must match .nvmrc (26.7.0 as of 0.27.0)
pnpm --version                    # 10.14.0, from packageManager in package.json
gh auth status                    # logged in with access to ortomate/crimes
npm view crimes version           # the version currently on npm
node -p "require('./packages/cli/package.json').version"   # the version in the tree
```

The tree version and the npm version normally match here. If the tree is
already ahead of npm, a prep commit has landed and not been released; go to
section 7 rather than preparing a second one.

Decide the new version. Semver as this project applies it:

- **patch** (`X.Y.Z+1`): detector bug fixes and copy changes that do not
  alter the JSON schema. Note that patch numbers are also consumed by eval
  baseline bumps between releases (`evals/README.md`, section "Versioning
  policy"), so the next release version is whatever follows the highest
  patch already used, not necessarily `.1`.
- **minor** (`X.Y+1.0`): new detectors, new commands, additive schema
  fields, or any change to what a detector means (a `verdict` or
  `baseline check` gate would see different results). Every release since
  0.16.0 has been a minor.
- **major**: a breaking change to the wire format. Also bump
  `SCHEMA_VERSION` in `packages/core/src/finding.ts`. To date, schema bumps
  have shipped inside minors (0.27.0 moved `schema_version` to `0.8.0`),
  because the package itself is still `0.x`.

## 5. The prep commit

The last two prep commits, `364a333` (`Prep crimes@0.26.0`) and `928034c`
(`Prep crimes@0.27.0`), are the models. Reproduce their shape:

```bash
git show --stat 928034c
```

Checklist. Every box is a file the commit must touch, or a reason it need
not.

- [ ] `packages/cli/package.json`: `"version": "X.Y.Z"`. The only place the
      version is authoritative. `release.yml` compares the release tag to
      this field and refuses to publish on a mismatch.
- [ ] `docs/releases/vX.Y.Z.md`: the release notes, new file. This becomes
      the GitHub Release body verbatim. If the release changes fingerprints
      or the schema, lead with an "Upgrading" section (0.27.0 is the
      example). List what was planned and not done under a heading such as
      "Still unsettled", so the next plan starts from the truth.
- [ ] `README.md`: the `## Status` heading becomes `crimes@X.Y.Z`; the
      previous status body moves down into a new
      `### Earlier <previous> work (...)` subsection following the ones
      already there. The npm badge at the top reads live from npm; do not
      edit it.
- [ ] `packages/cli/README.md`: this is the npm package page. Add a
      `**X.Y.Z headline:**` paragraph above the previous one. (The list
      currently skips 0.25.0; that was a deliberate choice at 0.26.0 and is
      not to be backfilled.)
- [ ] `docs/roadmap.md`: `Current version` becomes `X.Y.Z`, the old current
      becomes `Previous version`. This file is mirrored to crimes.sh.
- [ ] `apps/website/landing/llms.txt`: add a `## X.Y.Z (current release)`
      section at the top of the release list, drop `(current release)` from
      the previous one, and link `docs/releases/vX.Y.Z.md`.
- [ ] `apps/website/landing/index.html`: three things.
      `"softwareVersion"` in the JSON-LD block; the hero pill
      `<span class="pill">vX.Y.Z · ... · <a href="/docs/releases/vX.Y.Z/">release notes</a></span>`;
      and any prose claim the release invalidated (what it scans, what it
      finds, which fields a finding carries). `verify-build` (section 6)
      fails on the first two and on detector, family and language counts; it
      cannot check prose.
- [ ] `docs/fixtures/messy-ts-app.json`: regenerate on every release, not
      only schema ones, because any detector change makes it stale:
      `node packages/cli/dist/index.js scan examples/messy-ts-app --format json > docs/fixtures/messy-ts-app.json`
- [ ] `docs/json-schema.md`: only if the schema changed and the change that
      introduced it did not already document it.
- [ ] `evals/results/<X.Y.Z>/`: the eval baseline is keyed by the version
      in `packages/cli/package.json`, so the directory moves with it. Either
      run `pnpm run evals:ranking` to seed `ranking.json` (as 0.26.0 did),
      or, when the release changed only finding identity, add a row to the
      carry-forward table in `evals/README.md` ("Identity-only bumps")
      saying why no run was needed. One or the other; not neither.
- [ ] `.changeset/`: delete any file describing a release that has shipped.
- [ ] `.planning/SPRINT-X.Y.md`: if a sprint plan exists for this release,
      record the outcome and the corrections in it (see
      `.planning/SPRINT-0.26.md` sections 8 and 9 for the shape), then move
      it to `.planning/archive/` per `.planning/README.md`. This can be a
      separate commit but should land before the release.

Do not edit `PRD.md` for a release. Do not touch `.nvmrc`, the workflows,
or `biome.jsonc` in the prep commit; formatting settings change what
`crimes` reports about itself (section 12).

Commit message: first line `Prep crimes@X.Y.Z`; body lists the files and
why, records the pre-flight results with the Node version, and states that
publishing is not part of this commit. `928034c` is the template.

## 6. Pre-flight, run locally before pushing

```bash
pnpm install --frozen-lockfile
pnpm verify                        # format:check, lint, build, typecheck, test
pnpm scan:example                  # human report against the bundled fixture
pnpm scan:example:json             # JSON report against the bundled fixture
pnpm --filter crimes smoke         # npm pack, install into a temp dir, run every command
pnpm --filter @crimes/website build && node apps/website/scripts/verify-build.mjs
```

All six must exit 0. If `format:check` fails, run `pnpm format` and commit
the result rather than hand-editing. `verify-build` runs against the built
`dist/`, so it must follow the website build or it checks a stale page.

Optional tarball inspection:

```bash
cd packages/cli && npm pack --dry-run && cd -
```

Expect `package.json`, `dist/index.js`, other `dist/*.js`, `dist/*.wasm`,
`README.md`, `LICENSE`. No sourcemaps, no `src/`, no `scripts/`, no
`workspace:*` in the packed manifest.

Then push and wait:

```bash
git push origin main
gh run watch --repo ortomate/crimes --exit-status $(gh run list --repo ortomate/crimes --branch main --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')
```

## 7. Cut the release

Two steps, deliberately split so the irreversible one is a separate act.

**7a. Draft it** (safe to repeat; a draft creates no tag and fires no
workflow):

```bash
VERSION=$(node -p "require('./packages/cli/package.json').version")
gh release create "v${VERSION}" \
  --repo ortomate/crimes \
  --draft \
  --target main \
  --title "crimes v${VERSION}" \
  --notes-file "docs/releases/v${VERSION}.md"
```

Review the draft at `https://github.com/ortomate/crimes/releases`. Check
the tag reads `vX.Y.Z` with a lower-case `v` and matches
`packages/cli/package.json` exactly.

**7b. Publish it.** A human does this. Either click **Publish release** on
the draft, or:

```bash
gh release edit "v${VERSION}" --repo ortomate/crimes --draft=false
```

Publishing creates the tag at `main` and fires `release.yml`. From here
there is no undo short of section 10.

Titles on past releases follow `crimes vX.Y.Z` optionally followed by a
short theme; either is fine.

## 8. What `release.yml` does on its own

In order, from `.github/workflows/release.yml`:

1. Checkout; set up pnpm (version from `packageManager`) and Node (from
   `.nvmrc`, registry `https://registry.npmjs.org`).
2. `pnpm install --frozen-lockfile=false`.
3. `pnpm run build`, `pnpm run typecheck`, `pnpm run test`.
4. `pnpm --filter crimes smoke`.
5. Verify `github.event.release.tag_name` equals
   `v` + `packages/cli/package.json` version. Mismatch fails the job before
   anything is published.
6. Print the OIDC token claims (payload only) for debugging.
7. `npm publish --provenance --access public` from `packages/cli`.

Past runs take a little over two minutes. Watch it:

```bash
gh run watch --repo ortomate/crimes --exit-status $(gh run list --repo ortomate/crimes --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')
```

If it fails before step 7, nothing was published: fix `main`, then either
re-run the job (`gh run rerun <id>`; it checks out the tag, so a fix on
`main` needs a new release) or delete the release and tag and start again
from section 7. If it fails at step 7 itself, read the log for the npm error
before doing anything; a Trusted Publisher mismatch shows up here and is
fixed on npmjs.com, not in the repo.

## 9. Verify afterwards

```bash
npm view crimes version                      # X.Y.Z
npm view crimes dist-tags                    # latest: X.Y.Z
npm view crimes@X.Y.Z dist.attestations      # provenance block present
gh release view vX.Y.Z --repo ortomate/crimes
cd "$(mktemp -d)" && npx --yes crimes@X.Y.Z --version && cd -
curl -s https://crimes.sh/ | grep -o '<span class="pill">v[0-9.]*'
```

The last line checks the site. Because Vercel deploys from `main` on push,
the site advertises the new version from the moment the prep commit lands,
which may be before npm has it. Keep the gap between prep and publish
short for that reason.

## 10. Rolling back or deprecating

npm allows `unpublish` within 72 hours and discourages it. Prefer shipping a
fixed patch. All of the commands below need an npm maintainer login with
2FA; as of 4 September 2026 that is only Andrew.

```bash
npm deprecate crimes@X.Y.Z "Broken: install X.Y.Z+1 instead"   # preferred
npm unpublish crimes@X.Y.Z                                      # within 72h only
npm dist-tag add crimes@<good version> latest                   # if latest points at a bad build
```

Then prepare and release the fix as a new version through sections 5 to 9.
Do not reuse a version number; npm will not accept it even after an
unpublish.

A GitHub Release can be deleted (`gh release delete vX.Y.Z --cleanup-tag`),
but doing so does not affect npm, and the release workflow has already run.

## 11. If you are an agent

Read [`AGENTS.md`](../AGENTS.md) first; its safety rules apply. Within
them, this is the division of labour.

You may do, without asking:

- Every item in section 5 (the prep commit) and section 6 (pre-flight), on
  a branch or on `main` when the user has asked for the prep.
- Draft the release notes in `docs/releases/vX.Y.Z.md`.
- Create the GitHub Release **as a draft** (section 7a). A draft creates no
  tag and triggers nothing.
- Watch workflow runs and report their result.
- Run every read-only verification in section 9.
- Open a pull request.

A human must do these, and you must not do them even if your credentials
would allow it:

- **Publish the GitHub Release** (section 7b), by clicking Publish or with
  `gh release edit --draft=false`. This is the single irreversible action
  in the process and it is what runs `npm publish`.
  **One exception.** Andrew granted the Hobbes executor release authority
  on crimes on 4 September 2026; the grant is recorded per product in
  `ortomate/hobbes` at `docs/portfolio.toml` (`release = "hobbes"`) and
  shown by `hobbes portfolio` as `release: hobbes`. When you are that
  executor working a crimes card, you may publish the release, and you must
  then verify with `npm view crimes version` before the card is done. Every
  other agent, and the executor on every other product, still stops at the
  draft. The npm-as-a-user items below stay human for everyone.
- Anything against the npm registry as a user: `npm publish`,
  `npm deprecate`, `npm unpublish`, `npm dist-tag`, `npm login`. These
  require the maintainer account and its 2FA, which you do not have and
  should not be given.
- Change the Trusted Publisher configuration on npmjs.com, or add any
  secret to the GitHub repository. `release.yml` needs none.
- `git tag` or `git push --tags`. The release creates the tag.
- Force-push, reset, or rewrite `main`.

When you have done everything you may do, stop and say exactly what remains:
"Draft release vX.Y.Z is at <url>; publishing it will run release.yml and
publish to npm." Do not describe the release as done until
`npm view crimes version` returns the new number.

## 12. Things that have bitten past releases

**The hero pill.** `apps/website/landing/index.html` carries a visible
`vX.Y.Z` pill linking to the release notes. It sat at v0.12.0 through two
releases, and at 0.26.0 it still linked to v0.25.0's notes.
`apps/website/scripts/verify-build.mjs` now fails the build on either
mistake, and on these as well, each derived from the repository rather
than hard-coded:

| Claim on the page | Derived from |
|---|---|
| JSON-LD `softwareVersion` | `packages/cli/package.json` |
| Hero pill version and its release-notes link | same, plus the built `dist/docs/releases/` |
| "N detectors across M families" | the built detector registry and `docs/finding-types/*.md` |
| Every finding-type family linked | `docs/finding-types/*.md` |
| Languages named in the prose, packages listed | `packages/language-*` |

Adding a language pack fails the build until `LANGUAGE_NAMES` in
`verify-build.mjs` and the page are both updated. That is intended.

**Biome and the self-scan.** `large_function`, `large_file`,
`exact_duplicate_block`, `near_duplicate_block` and
`magic_domain_literal_scatter` read line counts or line text, so
`lineWidth` in `biome.jsonc` (pinned at 90) changes what `crimes` reports
about itself. Do not change formatter settings in a release commit.

**Known lint debt.** `apps/website/landing/index.html` is excluded from
the linter in `biome.jsonc` for 90 real a11y diagnostics in two
`<div role="table">` blocks. It does not block a release. Do not let the
exclusion grow.

**Publishing from a dirty tree.** The tarball reflects the disk, not git.
`git status --porcelain` must be empty before `npm pack` or `smoke`.

**The changeset directory.** Nothing consumes it and nothing empties it.
Files for 0.19.0, 0.20.0, 0.21.0 and 0.25.0 were still present on
4 September 2026, all describing shipped releases.

## 13. What not to do

- Do not run `npm publish` locally. Trusted Publishing only works inside
  the workflow.
- Do not create the tag by hand. A bare tag does not fire the workflow, and
  a tag that already exists when the release is created can point at the
  wrong commit.
- Do not add `NPM_TOKEN`.
- Do not deploy the website with the Vercel CLI; it races the automatic
  deploy.
- Do not leave a prep commit on `main` unreleased for long. crimes.sh will
  advertise a version npm does not have.

---

## State of 0.27.0 on 4 September 2026

Recorded here so the next person does not have to rediscover it. Nothing in
this section was acted on; it is the list of what is left.

**Where it stands.** `main` is at `928034c` (`Prep crimes@0.27.0`, Tim
Copeland, 26 August 2026). `packages/cli/package.json` says `0.27.0`. The
`CI` workflow on that commit succeeded (run `33014542613`). No `v0.27.0`
tag, no GitHub Release (not even a draft), and npm serves `0.26.0` with
`latest` pointing at it. crimes.sh has advertised `v0.27.0` since the prep
commit landed, so the website has been nine days ahead of the registry.

**The prep commit is complete against section 5's step-2 surfaces.**
Verified in the tree: version bumped; `docs/releases/v0.27.0.md` present
(220 lines, leads with Upgrading); `README.md` status at 0.27.0 with 0.26.0
demoted; `packages/cli/README.md` headline; `docs/roadmap.md` current and
previous; `llms.txt` section; `index.html` `softwareVersion` and pill both
at 0.27.0 and linking `/docs/releases/v0.27.0/`;
`docs/fixtures/messy-ts-app.json` regenerated at schema 0.8.0. The commit
message records `pnpm verify` (2444 tests), smoke and `verify-build` green
on Node 26.7.0.

**What 0.27.0 contains versus what `.planning/SPRINT-0.27.md` planned.**
The plan (12 August) named three streams: S1 settle the recency default,
S2 Homebrew tap and standalone binaries (M6), S3 `weak_test_signal`
granularity. None of the three landed. What landed instead, in ten commits
on 26 August: the `claim` field and `schema_version` 0.8.0 (fingerprints
change for eleven types), stale-pin warnings in `coverage.warnings[]`,
`triage --apply` accepting the caller's shape, resurfaced findings
regaining `id` and `fingerprint`, three CI eval gates that had been passing
vacuously, and one Node version read from `.nvmrc`. The release notes say
so plainly in "Still unsettled", listing S1, S2 and S3 as deferred. So the
release is honest, but it is a correctness and schema release, not the
"product release" the plan set out to be.

**Left to do before or alongside publishing**, none of which blocks the
workflow:

1. **Publish the release.** The one remaining step is section 7: draft
   from `docs/releases/v0.27.0.md`, review, publish. Either GitHub admin
   can do it; no npm account is needed.
2. **`.planning/SPRINT-0.27.md` has no outcome.** It has not been touched
   since it was written. Its own definition of done asks that every place
   the plan was wrong be recorded in it, and it was wrong about the whole
   release. `SPRINT-0.26.md` sections 8 and 9 show the shape. Then move it
   to `.planning/archive/`.
3. **No eval baseline entry for 0.27.0.** There is no
   `evals/results/0.27.0/` and no row for 0.27.0 in the carry-forward table
   in `evals/README.md`. The release changed 137 fingerprints and 0 scores
   across the fixture corpus, which is the identity-only case that table
   exists for. Not blocking: `evals/runner/src/baseline.ts` walks back to
   the newest directory holding agent results plus `summary.json`, so
   `evals:replay` still resolves a baseline. Whether `evals-pr-replay`
   passes on the current `main` is unverified, because the prep commit did
   not touch a path that triggers it; `gh workflow run evals-pr-replay`
   would settle it.
4. **Four stale changesets** in `.changeset/` (0.19.0, 0.20.0, 0.21.0,
   0.25.0). Delete them; the directory's own README says so.
5. **`docs/roadmap.md` says 0.27.0 "shipped"** and has since 26 August.
   The 0.26.0 prep did the same and was released the same day; this one
   was not, and crimes.sh mirrors the file. Publishing fixes it; a longer
   delay would warrant an edit.
6. **`AGENTS.md` rule 1 said the npm name `crimes` was unclaimed.** It
   has been published since 0.0.1 in May 2026. Corrected in the same change that added
   this section, so an agent does not reason from a false premise about
   what publishing would do.
7. **Carried forward, already recorded in the release notes:** S1
   recency default, S2 M6 binaries, S3 `weak_test_signal` granularity,
   and `@types/node ^22` against `engines.node >=18`.
