# `.changeset/`

**Read this before adding or trusting a file here.**

Changesets is **not installed**. There is no `@changesets/cli`
dependency, no `.changeset/config.json`, and no CI step that consumes
these files. Nothing runs `changeset version` or `changeset publish`.

The actual release process is in [`docs/releasing.md`](../docs/releasing.md):
you hand-edit `version` in `packages/cli/package.json`, write release
notes into `docs/releases/vX.Y.Z.md`, and cut a GitHub Release, which
is what triggers publishing. `PRD.md` §26 lists Changesets as an
intended convention; it was never wired up.

So the files here are **prose notes about a release**, not machine
input. They are useful as a one-paragraph summary of what a version
contained, and that is all they are.

## The trap

Because nothing consumes them, nothing deletes them either. Two files
sat here long after their releases shipped:

- `release-a-front-door.md` — shipped in **0.10.0**
  (`docs/releases/v0.10.0.md`)
- `release-b-triage.md` — shipped in **0.11.0**
  (`docs/releases/v0.11.0.md`), and announced a
  `schema_version` `0.1.0` → `0.2.0` migration that is now two bumps
  stale (current: `0.3.0`)

Both were deleted in the 0.16.x cleanup. Had Changesets ever actually
been installed and run, `changeset version` would have consumed all
three pending files at once and bumped a single release carrying
release notes that described the front-door redesign and a
long-completed schema migration.

## The rule

**Delete the changeset in the same commit that ships its release.** If
you are looking at a file here whose content is already described by a
file in `docs/releases/`, it is stale — delete it.

Either wire Changesets up properly or keep this directory empty between
releases. The half-state is what produced the trap above.
