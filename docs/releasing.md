# Releasing `crimes`

This is the recipe for publishing a new `crimes@X.Y.Z` to
[npm](https://www.npmjs.com/package/crimes) and deploying
[crimes.sh](https://crimes.sh).

Releases are automated. **Never run `npm publish` locally.** All
publishing happens in
[`.github/workflows/release.yml`](../.github/workflows/release.yml) via
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (no
`NPM_TOKEN` required).

---

## One-time setup

Do these once per package and per repo. They are not needed on every
release.

### npmjs.com — configure Trusted Publisher

1. Log in at <https://www.npmjs.com> as a maintainer of the `crimes`
   package.
2. Navigate to: **Package settings → Publishing access → Trusted
   Publishers → "Add Trusted Publisher"**.
3. Configure:
   - **Provider:** GitHub Actions
   - **Organization or user:** `ortomate`
   - **Repository name:** `crimes`
   - **Workflow filename:** `release.yml`
   - **Environment:** _leave blank_
4. Save.

Once this is in place, the release workflow can mint a short-lived
publish token from its OIDC identity at publish time. **No
`NPM_TOKEN` secret should be added** to GitHub — Trusted Publishing
replaces it. If you intentionally abandon Trusted Publishing later, add
the secret then, not now.

### Vercel — already wired

[crimes.sh](https://crimes.sh) is deployed by Vercel from `main` against
`apps/website/` (`buildCommand: node ./scripts/build.mjs`, output
`apps/website/dist`). Every push to `main` triggers a production deploy
automatically — there is nothing to do per release.

### GitHub — branch protection (recommended)

If not already configured, require the `CI` workflow checks to pass on
`main` before merge. This keeps the release tag pointing at a green
commit.

---

## Per-release checklist

This is the steady-state recipe. The numbered steps assume you are on
`main` with a clean working tree.

### 1. Bump the version

Edit
[`packages/cli/package.json`](../packages/cli/package.json) and set
`"version"` to `X.Y.Z`. Semver:

- **patch** — detector bug fixes, output copy tweaks that do not change
  the JSON schema
- **minor** — new detectors, new commands, new optional fields in the
  JSON schema
- **major** — breaking changes to the wire format (also bump
  `schema_version` in [`finding.ts`](../packages/core/src/finding.ts))

### 2. Update changelogs and docs

Every file in this list must reflect `X.Y.Z` **before** the GitHub
Release is cut — they are mirrored to the website and to the npm
README at publish time, and stale ones are not patched after the fact.

- **[`README.md`](../README.md)** — root README. Update the
  `## Status — crimes@X.Y.Z` heading and the lead paragraph; push the
  previous version down into an "Earlier X.Y.Z work" subsection
  following the existing pattern. The shields.io badge at the top
  pulls live from npm; no edit needed there.
- **[`packages/cli/README.md`](../packages/cli/README.md)** — npm
  package README (this is what users see on npmjs.com). Update the
  `**X.Y.Z headline:**` line and any version references in the lead.
- **[`docs/roadmap.md`](./roadmap.md)** — milestone status mirror.
- **[`docs/releases/vX.Y.Z.md`](./releases/)** — in-repo draft release
  notes. Add the new file; its body is the canonical text for the
  GitHub Release in Step 5.
- **[`apps/website/landing/llms.txt`](../apps/website/landing/llms.txt)**
  — add a `docs/releases/vX.Y.Z.md` entry so the AI-overview pass picks
  up the new release. (The landing page's "What's next" strip points
  at the GitHub Releases page rather than maintaining its own list,
  so no per-release `index.html` edit is needed.)
- **JSON schema only if it changed.** If the schema gained fields,
  also update [`docs/json-schema.md`](./json-schema.md) and the pinned
  fixture at [`docs/fixtures/messy-ts-app.json`](./fixtures/messy-ts-app.json).
  Major schema changes also bump `schema_version` in
  [`finding.ts`](../packages/core/src/finding.ts).

`CHANGELOG.md` is intentionally not maintained — the GitHub Release
page is the canonical changelog surface.

### 3. Run the local pre-flight

These should all succeed before you push:

```bash
pnpm build
pnpm typecheck
pnpm test

pnpm scan:example          # human report against the bundled fixture
pnpm scan:example:json     # JSON report against the bundled fixture

pnpm --filter crimes smoke # pack + install in a temp dir + run every command
```

Optional spot-check of the tarball contents:

```bash
cd packages/cli && npm pack --dry-run
```

You should see `package.json`, `dist/index.js`, `README.md`, and
`LICENSE`. No sourcemaps, no raw sources, no dev scripts, and **no
`workspace:*` runtime dependencies** in the packed `package.json`.

### 4. Commit and push

```bash
git add packages/cli/package.json docs/roadmap.md   # etc.
git commit -m "Prep crimes@X.Y.Z"
git push
```

Wait for the `CI` workflow on `main` to go green.

### 5. Create the GitHub Release

Either via the web UI or the `gh` CLI:

```bash
gh release create vX.Y.Z \
  --title "crimes vX.Y.Z" \
  --notes "<release notes here>"
```

The tag **must** be `vX.Y.Z` (lower-case `v`, matching
`packages/cli/package.json`). The release workflow refuses to publish
if these disagree.

Clicking **Publish release** in the UI is what fires the
`release: published` trigger. Drafts do not trigger the workflow.

### 6. Watch the Release workflow

Open the **Actions** tab. The `Release` workflow should run:

1. Checkout
2. pnpm install
3. Build, typecheck, test
4. Smoke test (pack + install + run)
5. Verify tag matches `packages/cli/package.json` version
6. `npm publish --provenance --access public`

When it completes, the package is live.

### 7. Verify the release

```bash
npm view crimes version          # should print X.Y.Z

# In a clean directory (not this repo):
npm install -g crimes
crimes --version                 # should print X.Y.Z
crimes scan .

# Or via npx:
npx crimes@X.Y.Z scan .
```

Then open <https://crimes.sh> to confirm Vercel picked up the latest
`main`.

---

## What not to do

- **Do not** run `npm publish` locally. Trusted Publishing requires
  OIDC, which only works inside the GitHub Actions runner.
- **Do not** create the git tag manually (`git tag vX.Y.Z`). Creating
  the **GitHub Release** is what fires the workflow; a bare tag does
  not.
- **Do not** add an `NPM_TOKEN` GitHub secret while Trusted Publishing
  is configured. It is unnecessary and increases blast radius if a
  workflow file is ever tampered with.
- **Do not** deploy the website manually with the Vercel CLI. Vercel
  auto-deploys `main`; manual deploys can race with the auto-deploy and
  serve stale content.
- **Do not** publish from a dirty working tree. The packed tarball
  reflects what is on disk, not what is in git — uncommitted changes
  will ship.

---

## Rollback

`npm` allows unpublishing for the first 72 hours, but
[discouraged](https://docs.npmjs.com/policies/unpublish). Prefer
publishing a **higher patch version** with the fix.

If the published tarball is genuinely broken (cannot install, wrong
binary, etc.):

```bash
# Within 72 hours, as a package maintainer:
npm unpublish crimes@X.Y.Z

# Otherwise: deprecate and ship a fix:
npm deprecate crimes@X.Y.Z "Broken release — install X.Y.(Z+1) instead"
```

Then bump and re-release following the checklist above.
