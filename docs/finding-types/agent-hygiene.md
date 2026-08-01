# Agent-hygiene findings

Two detectors about the parts of a repository that act on an agent
before anyone reviews them: the dependencies it pulls in, and the
configuration it hands to whatever agent opens the checkout.

Both are **strictly local**. Neither contacts a registry, and neither
executes anything it finds.

For the wire format, see [`docs/json-schema.md`](../json-schema.md).

## What ships

| `Finding.type`              | Charge             | Severity range | Confidence  | Pack        |
| --------------------------- | ------------------ | -------------- | ----------- | ----------- |
| `dependency_provenance_gap` | Phantom Accomplice | low-high       | 0.45 - 0.95 | `universal` |
| `agent_permission_sprawl`   | Loaded Agent       | low-high       | 0.25 - 0.95 | `universal` |

Both are repo-level: they emit **once per scan**, anchored on a
deterministic file, rather than once per file scanned.

---

## `dependency_provenance_gap` — Phantom Accomplice

### Scope: local provenance only

This detector performs **no registry lookups**. It never claims a
package is malicious, hallucinated, abandoned, typo-squatted, or
unknown to npm. Those are claims about the world, and answering them
would require the network access this tool promises not to use.

Every finding is a statement about **this repository's own records**.
The evidence says so explicitly:

> no registry was contacted and no claim is made about the packages
> themselves

### What it detects

Three findings, each with its own stable `symbol` so they never collide
on a fingerprint:

| `symbol`                        | detects                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `undeclared imports`            | an external module imported with no declaring `package.json` |
| `manifest/lockfile disagreement`| a declared dependency with no entry in the committed lock    |
| `unpinned specifiers`           | a mutable git ref, a bare URL, a wildcard, or an escaping local path |

### Monorepo and workspace handling

Every `package.json` in the tree is inventoried. Resolution walks from
the importing file's **nearest** enclosing manifest up to the repo
root, which is how both pnpm workspaces and npm hoisting actually
behave — a dependency declared at the workspace root satisfies an
import in a child package.

**Workspace membership matters.** A manifest is a workspace member when
it is the root manifest, or its directory matches a glob declared in
`pnpm-workspace.yaml` or a root `workspaces` field. Manifests outside
the workspace — a sample app under `examples/`, an eval fixture, a
vendored project — are **not** compared against the root lockfile.
They were never installed by it, and comparing them would report every
one of their dependencies as missing.

Only workspace members contribute an internal package name, so a
sample app that happens to be named `react` cannot make every real
`react` dependency look internal.

### What is excluded

- Node built-ins, with and without the `node:` prefix
- relative and absolute-path imports
- TypeScript / bundler path aliases (`@/…`, `~/…`, `$lib/…`, `src/…`)
- subpath imports (`#internal/*`)
- deep subpaths of a declared package (`lodash/fp` counts as `lodash`)
- type-only imports backed by an `@types/*` package, including the
  scoped flattening (`@scope/pkg` → `@types/scope__pkg`)
- peer, optional, bundled, `workspace:`, `file:`, and `link:`
  dependencies, for the lockfile comparison — none of those is required
  to appear in a lock

### Lockfile support

| lockfile             | how names are read                                          |
| -------------------- | ----------------------------------------------------------- |
| `pnpm-lock.yaml`     | `<name>@<version>` keys, matched by pattern across format revisions (v5-v9) |
| `package-lock.json`  | the v2/v3 `packages` install-path tree **and** the v1 `dependencies` tree |
| `yarn.lock`          | entry headers (`name@range:`), v1 and berry                  |
| `bun.lockb`          | recorded as present but **unparsed** — it is binary          |

A lockfile that yields zero names is marked `unparsed`, and the
detector says nothing rather than reporting that every dependency is
missing because a file was malformed.

### Example

```
dependency_provenance_gap · Phantom Accomplice · medium (0.82)
  package.json:1  undeclared imports

  1 external package(s) imported with no declaring manifest
    `chalk` — imported at src/services/payments.ts as "chalk"
  manifests searched: package.json
  resolution walks from the importing file's nearest package.json up to the repo
    root, so hoisted and workspace-root declarations are counted
  node built-ins, relative paths, path aliases, workspace packages, and subpaths
    of declared packages are excluded
  this is a statement about this repository's records only — no registry was
    contacted and no claim is made about the packages themselves
```

```
dependency_provenance_gap · Phantom Accomplice · high (0.90)
  package.json:17  unpinned specifiers

  2 dependency specifier(s) that can resolve differently between installs:
    `anything-goes`: "*" in package.json:17 (dependencies) — wildcard version —
      resolves to whatever is newest
    `legacy-utils`: "git+https://github.com/example/legacy-utils.git#main" in
      package.json:16 (dependencies) — git dependency with no commit pin — the
      ref can move
  a lockfile pins today's resolution, but any lockfile refresh re-resolves these
    against a moving target
  no registry was contacted; this is a reading of the specifier text only
```

A git specifier **pinned to a 7-40 character commit hash** is not
reported. `#semver:` ranges and branch names are.

### Confidence and severity

Confidence for undeclared imports starts at 0.68 and rises when runtime
imports are affected; it is damped when every affected import is
type-only (-0.18), when only test or fixture files are affected
(-0.12), and in monorepos where resolution walks upward (-0.08).

Unpinned specifiers carry the highest confidence (0.85+) — the
specifier text is read directly from the manifest and requires no
inference.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "dependency_provenance_gap": {
        "reportUndeclaredImports": true,
        "reportMissingFromLock": true,
        "reportUnpinnedSpecifiers": true,
        "allowedPackages": ["some-global-ambient-types"]
      }
    }
  }
}
```

### Not implemented

Detecting *multiple newly-introduced packages serving the same narrow
capability* requires comparing dependency sets across git history and
a notion of capability overlap. Neither is available without either a
registry or a heuristic weak enough to be misleading, so it is
deliberately out of scope.

---

## `agent_permission_sprawl` — Loaded Agent

### What it inspects

The repository's **own committed agent configuration**:

- `.claude/settings.json`, `.claude/settings.local.json`
- `.claude/hooks/**` (shell scripts, read as text)
- `.mcp.json`
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
- `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`
- `.cursor/rules/**`, `.cursorrules`
- `.codex/config.toml`

These are loaded automatically by any agent that opens the checkout,
which makes them the one part of a repository that acts before anybody
reviews it.

### Nothing is ever executed

**No discovered hook, script, or configuration is run.** Everything is
read as text. A tool that executed a repository's hooks in order to
analyse them would be a remote code execution vector wearing a linter
costume. This is the single most important property of this detector.

### Three tiers, deliberately separated

#### 1. Executable configuration — medium to high

These run.

| finding                                          | severity delta |
| ------------------------------------------------ | -------------- |
| hook pipes remote content into a shell            | +0.45          |
| hook prints or transmits environment variables    | +0.40          |
| `Bash(*)` / bare `Bash` — unrestricted execution  | +0.35          |
| pre-approved destructive or self-elevating command| +0.30          |
| hook interpolates repo-controlled text into a shell | +0.30       |
| `Write(…)` reaching outside the repository        | +0.25          |
| unattended network action on an edit event        | +0.22          |

#### 2. MCP servers — medium

A server launched with `npx -y <package>` downloads and runs code that
no lockfile in the repo pins. Environment **names** passed through are
listed; values are never read.

#### 3. Prose directives — low, always

An instruction file telling an agent to skip verification, ignore
higher-level instructions, expose secrets, edit outside the repository,
or push without asking.

**Low severity and low confidence, always.** A sentence is not an
execution path, and a repository may have entirely legitimate reasons
for each of them. The finding says the sentence exists and is worth a
reviewer's eye — not that it is wrong. `scores.severity` is
hard-capped below the medium band so prose can never outrank an
executable hazard in the default ranking, and the evidence says so:

> ADVISORY: this is prose, not an execution path. A repository may have
> entirely legitimate reasons for each of these sentences — the finding
> is that they exist and are worth a reviewer's eye, not that they are
> wrong

### What is never a finding

- **A scoped development command.** `Bash(pnpm test)`,
  `Bash(git status:*)`, `Read(**)` are the tool working as intended.
- **A `deny` rule.** A repo denying `Bash(rm -rf *)` is protecting
  itself; reporting it would be exactly backwards. Only `allow` grants
  are inspected.
- **An ordinary hook.** `pnpm exec biome format --write` is a formatter.
- **Ordinary agent documentation.** "Run `pnpm verify` before declaring
  work complete" matches nothing.

### Redaction

Every quoted fragment passes through a redactor before it reaches
`Finding.evidence`. Masked: `KEY=value` pairs for secret-shaped names,
`--token`/`--key`/`--password` flag values, `Authorization: Bearer …`
headers, common provider token prefixes (`sk_`, `ghp_`, `xoxb-`, …),
and long opaque base64-ish runs.

Evidence names the permission or the execution path; it does not
reproduce credentials. The finding also states plainly:

> no hook was executed to produce this finding; the commands were read
> as text and quoted with token-shaped values masked

### Example

```
agent_permission_sprawl · Loaded Agent · high (0.88)
  .claude/settings.json:6  permissions.allow

  settings file: .claude/settings.json
  2 allow-rule(s) granting more than a scoped command:
    line 6: `Bash(*)` — grants shell execution with no command restriction
    line 7: `Write(/etc/risky/**)` — grants file writes to a scope outside the repository
  these rules are pre-approvals: an agent working in this repo will run matching
    commands without asking
  scoped development commands in the same file are not reported — only rules that
    place no bound on what may run
```

```
agent_permission_sprawl · Loaded Agent · high (0.90)
  .claude/settings.json:16  hooks

  hook configuration: .claude/settings.json
  1 hook command(s) with an execution hazard:
    line 16 [PostToolUse]: `curl -sL https://internal.example/postedit.sh | sh` —
      pipes remote content directly into a shell
  hooks run automatically for anyone who opens this repository with a matching
    agent — no prompt, no review of the change that added them
  no hook was executed to produce this finding; the commands were read as text
    and quoted with token-shaped values masked
```

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "agent_permission_sprawl": {
        "reportPermissions": true,
        "reportHooks": true,
        "reportInstructionProse": true,
        "allowedRules": ["Bash(pnpm *)"]
      }
    }
  }
}
```

### Resilience

A settings file that does not parse configures nothing, so the detector
says nothing — reporting the malformed JSON is another tool's job.
