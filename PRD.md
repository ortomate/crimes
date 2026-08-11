PRD: crimes — Agent-Native Codebase Risk Scanner

1. Summary

crimes is an open-source CLI that investigates a codebase for maintainability risks, code smells, architectural drift, duplicated business rules, weak test boundaries, and agent-confusing patterns.

It is not intended to be “another linter”. Linters catch local syntax/style issues. crimes should answer a higher-value question:

“Where in this repo is future change most likely to go wrong, and what should a human or coding agent know before editing it?”

The product should be useful to two audiences:

1. Developers who want a readable, evidence-backed “crime scene report” for their codebase.
2. Coding agents that need structured, machine-readable guidance before making code changes.

The initial release should support TypeScript/JavaScript repositories first, with an architecture that allows additional language packs later.

⸻

2. Product positioning

One-line positioning

crimes is a crime scene investigator for your codebase: built for agents, readable by humans.

Slightly longer positioning

crimes scans your repository for maintainability risks that ordinary linters miss: risky hotspots, duplicated domain rules, ambiguous sources of truth, hidden side effects, weakly tested change areas, and architecture drift. It produces human-readable reports and structured JSON so AI coding agents can make safer changes in unfamiliar codebases.

What makes it different

Most code quality tools focus on defects, security, style, or static code smells. crimes should focus on change risk and agent risk.

It should combine:

* Static code structure
* Git history
* Dependency graphs
* Test proximity and coverage signals
* Domain-specific heuristics
* Agent-oriented context output
* Optional LLM-assisted explanations later

The initial moat is not “we detect more smells”. It is:

“We make messy codebases easier for agents to understand before they edit.”

⸻

3. Problem statement

AI coding agents are increasingly asked to work inside unfamiliar or messy repositories. They often fail not because they cannot write code, but because they misunderstand the repo:

* They edit the wrong source of truth.
* They duplicate business rules instead of reusing existing policy logic.
* They miss relevant tests.
* They introduce hard-coded assumptions.
* They change risky files without understanding hidden side effects.
* They are fooled by misleading names, ambiguous conventions, or duplicated implementations.

Traditional linters do not solve this well because they usually inspect files locally and produce warnings for humans. Agents need structured repo context and prioritised risk signals.

crimes should become a pre-flight and post-flight tool for code agents:

crimes context src/billing/tax.ts --format json
crimes scan --changed --format json
crimes ask "where is plan pricing defined?"
crimes verdict

⸻

4. Goals

Product goals

* Help humans and agents identify risky areas in a codebase.
* Prioritise findings by real-world change risk, not just static ugliness.
* Produce structured output that agents can reliably consume.
* Make reports explainable, evidence-backed, and low-noise.
* Support simple installation via npm first, then Homebrew.
* Provide first-class documentation for beginners and agents.
* Be easy to run locally, in CI, and in coding-agent workflows.

Open-source goals

* Make the public repo welcoming and easy to navigate.
* Keep the README excellent and beginner-friendly.
* Include example outputs, fixtures, and test repos.
* Use permissive licensing unless there is a strategic reason not to.
* Make contribution paths clear without overcomplicating governance.

Non-goals for v0/v1

* Replacing ESLint, Semgrep, SonarQube, or security scanners.
* Supporting every programming language immediately.
* Automatically rewriting complex code by default.
* Making cloud accounts mandatory.
* Depending on an LLM to produce core findings.
* Becoming a full SaaS platform in the first release.

⸻

5. Target users

Primary user: agent-assisted developer

A developer using Cursor, Claude Code, OpenAI Codex-style agents, GitHub Copilot Workspace, or another coding agent.

Needs:

* “What should the agent know before changing this file?”
* “Did the agent introduce new maintainability risks?”
* “What tests should be run?”
* “Where is the real source of truth?”

Secondary user: senior engineer / tech lead

A senior engineer reviewing a repo, PR, or technical debt area.

Needs:

* Prioritised risk report
* Hotspots by churn and complexity
* Architectural drift visibility
* Duplicated business rule detection
* Useful PR/CI feedback

Tertiary user: open-source maintainer

A maintainer who wants lightweight quality checks without enterprise tooling.

Needs:

* Simple install
* Low configuration
* Friendly output
* CI mode
* Baseline/suppressions

⸻

6. Core product principles

6.1 Prioritise signal over exhaustiveness

By default, crimes scan should show the top findings, not hundreds of warnings.

Default behaviour:

Found 148 possible crimes.
Showing top 10 by risk.
Run `crimes scan --all` for everything.

6.2 Evidence before judgement

Every finding should include concrete evidence:

* Lines of code
* Function size
* Import patterns
* Git churn
* Test proximity
* Duplicate locations
* Side-effect signals
* Dependency relationships

6.3 Agent-readable first, human-readable second

Human output should be beautiful and readable, but the underlying product contract should be structured JSON.

6.4 Deterministic before magical

The initial product should work without an LLM. LLM features can be optional later.

6.5 Baseline legacy debt

Teams should be able to adopt crimes without fixing everything immediately.

crimes baseline save
crimes diff main...HEAD --fail-on new-high

6.6 Be playful, not unserious

The naming can be fun, but the findings must be credible.

Good:

Charge: Duplicated Policy Logic
Evidence: export permission checks appear in 4 places with inconsistent conditions.

Bad:

Lol this file is criminal.

⸻

7. Product surface

7.1 CLI commands

crimes scan

Run a repository scan.

Examples:

crimes scan
crimes scan src/billing
crimes scan --format json
crimes scan --all
crimes scan --severity high
crimes scan --changed
crimes scan --staged

Expected output:

CRIME SCENE REPORT
High severity
  1. src/billing/invoice.ts
     Charge: God Function
     Evidence: generateInvoice() is 214 lines and mixes calculation, DB writes, PDF rendering, and email.
  2. src/api/users.ts
     Charge: Duplicated Policy Logic
     Evidence: role checks repeated across 11 handlers.
Medium severity
  3. src/lib/date.ts
     Charge: Temporal Recklessness
     Evidence: UTC, local time, and hard-coded offsets mixed in one module.

crimes explain <crime-id>

Explain one finding with evidence and suggested next steps.

crimes explain crime_01982
crimes explain crime_01982 --format json

crimes context <file-or-symbol>

Produce agent-oriented local context for a file or symbol.

crimes context src/billing/tax.ts
crimes context src/billing/tax.ts --format json

Should return:

* File purpose inference
* Risk level
* Known crimes
* Related files
* Likely tests
* Imports/dependants
* Recent churn
* Safe editing guidance

crimes hotspots

Rank risky files based on churn, complexity, test gap, and dependency blast radius.

crimes hotspots
crimes hotspots --since 90d
crimes hotspots --format json

crimes diff <base...head>

Report new, fixed, and changed crimes between two Git refs.

crimes diff main...HEAD
crimes diff origin/main...HEAD --fail-on new-high

crimes verdict

Summarise whether the current branch improved or worsened repo health.

crimes verdict

Example:

Verdict: Slightly worse
New crimes:
- 1 medium duplicated business rule
Improved:
- removed one large function in billing
Recommendation:
Fix duplicated plan limit text before merging.

crimes tests <file-or-symbol>

Identify likely relevant tests.

crimes tests src/billing/tax.ts

crimes architecture

Detect architectural and dependency issues.

crimes architecture

crimes ask "<question>"

Optional v1+ natural language query mode.

crimes ask "where is plan pricing defined?"
crimes ask "what files are risky to edit for cancellation flow?"

This should initially be heuristic/search-based. LLM support can be optional later.

crimes baseline save

Save the current state so future CI can fail only on new crimes.

crimes baseline save

Creates:

.crimes/baseline.json

crimes ignore <crime-id>

Suppress a finding with a reason.

crimes ignore crime_01982 --reason "Legacy billing module, rewrite planned"

Creates or updates:

.crimes/suppressions.json

crimes init

Create project config.

crimes init

Creates:

.crimes/config.json

Or:

crimes.config.json

Recommendation: use crimes.config.json for simple projects, and .crimes/ for baseline/suppressions/cache.

⸻

8. Finding taxonomy

8.1 Structural crimes

* God Function
* God File
* Mega Component
* Kitchen Sink Utility
* Circular Dependency
* Layer Violation
* Deep Import Abuse
* Feature Entanglement
* Overloaded Abstraction

8.2 Change-risk crimes

* Hotspot File
* Bug Magnet
* Frequently Changed + Weakly Tested
* Large Diff Magnet
* Ownership Ambiguity
* High Blast Radius Module

8.3 Duplication crimes

* Duplicated Business Rule
* Duplicated Policy Logic
* Near-Duplicate Component
* Copy-Pasted Error Handling
* Parallel Implementation
* Repeated Magic Literal

8.4 Testability crimes

* Hidden Side Effects
* Hard-Coded Clock
* Hard-Coded Randomness
* Direct Network Call in Domain Logic
* Constructor Does Work
* Global State Mutation
* Untestable Function

8.5 Domain-specific crimes

* Money Stored as Float
* Timezone Ambiguity
* Stringly-Typed Status
* Boolean Flag Explosion
* Business Logic in UI
* Authorisation Logic in Client
* Plan/Role Confusion
* Raw Environment Access Outside Config

8.6 Agent-specific crimes

* Ambiguous Source of Truth
* Missing Local Context
* No Obvious Test Target
* Name/Behaviour Mismatch
* Comment-Code Drift
* Implicit Convention
* Generated-Looking Handwritten Code
* Similar Files with Different Behaviour

⸻

9. Finding schema

The JSON output is a core product API.

Example:

{
  "schema_version": "0.1.0",
  "repo": {
    "name": "acme-app",
    "root": "/repo",
    "git_ref": "HEAD"
  },
  "summary": {
    "total": 42,
    "high": 3,
    "medium": 12,
    "low": 27
  },
  "findings": [
    {
      "id": "crime_01982",
      "type": "god_function",
      "charge": "God Function",
      "severity": "high",
      "confidence": 0.88,
      "file": "src/billing/invoice.ts",
      "symbol": "generateInvoice",
      "lines": [41, 255],
      "summary": "Function mixes calculation, persistence, rendering, and email side effects.",
      "evidence": [
        "214 lines long",
        "imports database, PDF renderer, mailer, and tax module",
        "contains 6 await calls",
        "writes to 3 tables"
      ],
      "scores": {
        "severity": 0.86,
        "confidence": 0.88,
        "blast_radius": 0.72,
        "churn": 0.64,
        "test_gap": 0.58,
        "agent_risk": 0.91
      },
      "effort": "medium",
      "fix_shape": "extract orchestration; move pure helpers to a sibling module",
      "suggested_actions": [
        {
          "kind": "extract_function",
          "description": "Extract pure invoice calculation into calculateInvoiceTotals().",
          "risk": "low"
        }
      ],
      "related_files": [
        "src/billing/tax.ts",
        "src/billing/invoice.test.ts"
      ]
    }
  ]
}

⸻

10. Scoring model

Each finding should have multiple scores:

Severity

How bad the smell is in isolation.

Confidence

How certain the detector is.

Blast radius

How many files, modules, routes, or features may depend on it.

Churn

How often it changes.

Test gap

How poorly protected it appears to be.

Agent risk

How likely an AI agent is to misunderstand or damage this area.

Examples of high agent risk:

* Multiple apparent sources of truth
* Misleading names
* Similar files with different behaviour
* Weak tests
* Hidden side effects
* Domain rules duplicated across UI/API/jobs
* Important conventions only present in comments

Default ranking should sort by an aggregate risk score, not severity alone.

⸻

11. MVP scope

11.1 Language support

Start with:

* TypeScript
* JavaScript
* React/TSX/JSX
* Node projects

Do not attempt all languages at launch.

11.2 MVP detectors

Static structure

* Large function
* Large file
* Deep nesting
* Too many parameters
* High branching complexity
* Large React component
* Too many props
* Barrel/kitchen sink files

Dependency structure

* Circular dependencies
* Deep imports
* Layer violations via config
* High fan-in/fan-out modules

Duplication

* Exact duplicate blocks
* Near-duplicate functions/components
* Repeated string literals
* Duplicated role/status/plan checks

Testability

* Direct Date.now() / new Date() in domain code
* Direct Math.random() in domain code
* Direct process.env outside config
* Direct network/database calls in otherwise domain-looking functions
* Functions with mixed pure calculation and side effects

Git/history

* Churn hotspots
* Many-author hotspots
* Files changed frequently with few/no tests
* Files often touched in bug-fix commits

Test discovery

* Nearby test files
* Naming convention matching
* Import graph test references

11.3 MVP commands

Required:

crimes scan
crimes scan --changed
crimes explain <id>
crimes context <file>
crimes hotspots
crimes diff main...HEAD
crimes verdict
crimes init

Nice-to-have v0.2:

crimes tests <file>
crimes baseline save
crimes ignore <id>

Later:

crimes ask "..."
crimes plan <id>
crimes pr-comment

⸻

12. Recommended tech stack

12.1 CLI implementation language

Recommendation: TypeScript on Node.js.

Reasons:

* Best fit for npm distribution.
* Familiar to JS/TS open-source contributors.
* Natural first target is TS/JS repositories.
* Can use excellent parser ecosystem.
* Easy to integrate with package managers and CI.
* Simple path to npx crimes and npm install -g crimes.

Alternative: Rust.

Rust would give faster binaries and easier Homebrew distribution, but would slow early development and make TypeScript AST analysis more awkward. If performance becomes a problem later, specific engines can be moved to Rust.

12.2 CLI framework

Recommendation for v0: Commander.js + TypeScript.

Why not oclif immediately?

* oclif is powerful and plugin-oriented, but more framework-heavy.
* crimes should move quickly early.
* Commander is enough for subcommands, flags, help text, and beginner-friendly CLI structure.

Potential future: migrate to oclif if plugin ecosystems become central.

12.3 Build tooling

Recommendation:

* pnpm for package management
* tsup for bundling CLI packages
* tsx for development scripts
* Vitest for tests
* Biome or ESLint/Prettier for formatting/linting
* Changesets for versioning and changelogs
* GitHub Actions for CI and publishing

12.4 AST and code analysis

For TypeScript/JavaScript:

* typescript compiler API or ts-morph for symbol-level analysis
* @typescript-eslint/typescript-estree for ESTree-compatible parsing
* madge or custom dependency graph for circular dependencies
* jscpd-style approach or custom token hashing for duplication
* simple-git or direct Git commands for history
* fast-glob for file discovery
* ignore for .gitignore support

Recommendation:

Start with pragmatic, composable detectors rather than building a perfect compiler-grade analyser.

12.5 Output libraries

* chalk or picocolors for terminal colour
* ora for spinners, if used sparingly
* boxen optional for summary boxes
* zod for validating internal schemas/config

12.6 Website/docs

Recommendation:

* Next.js or Astro for crimes.sh
* Use the same monorepo initially
* Deploy with Vercel
* Docs generated from Markdown/MDX

Astro may be simpler for a docs/marketing site. Next.js may be more familiar and flexible. Either is fine. If the site is mostly static, Astro is leaner.

Recommended: Astro + Starlight for docs if the site is documentation-led. Use a custom homepage plus docs.

⸻

13. Repo strategy

13.1 Recommended structure

Use a public monorepo.

crimes/
  apps/
    website/               # crimes.sh site and docs
  packages/
    cli/                   # published npm package
    core/                  # detectors, scoring, schemas
    language-js/           # JS/TS language support
    reporter/              # terminal/json/markdown reporters
  examples/
    messy-ts-app/          # intentionally messy fixture repo
  docs/                    # optional shared docs source if not inside website
  .github/
    workflows/
      ci.yml
      release.yml
      website.yml
  .changeset/
  README.md
  CONTRIBUTING.md
  CODE_OF_CONDUCT.md
  LICENSE
  SECURITY.md
  package.json
  pnpm-workspace.yaml
  turbo.json

13.2 Should the website live in the public repo?

Yes, probably.

This is normal for open-source developer tools. The website is not “pollution” if it is useful documentation and onboarding. In fact, for this product, the website/docs are part of the product.

Recommended approach:

* Keep the website in the same public monorepo.
* Keep it clearly separated under apps/website.
* Make the root README focused on the CLI.
* Make apps/website easy to ignore for contributors who only care about the CLI.

Reasons to include the website publicly:

* Docs stay versioned with the CLI.
* Contributors can fix docs in the same PR as code.
* Agents can read the docs and source together.
* Vercel can deploy only apps/website from the monorepo.
* It signals openness and maturity.

Reasons to keep the site private would be weak at this stage unless there are private analytics, commercial copy experiments, or paid product assets. Those can be kept out via environment variables or separate private repos later.

13.3 Publishing model

One repo can publish multiple things:

1. npm package: packages/cli
2. Website: apps/website to Vercel
3. GitHub releases: release notes and optional binary bundles later
4. Homebrew tap: later, either separate repo homebrew-tap or generated formula

The public repo can be the source of truth for all open-source code and docs.

⸻

14. Package naming and install strategy

14.1 npm package name

Potential names:

* crimes
* @crimes/cli
* code-crimes
* repo-crimes

Recommendation:

Try to get crimes on npm if available and appropriate. If not, use a scoped package:

npm install -g @crimes/cli

But ensure the binary is still:

crimes

In package.json:

{
  "name": "@crimes/cli",
  "bin": {
    "crimes": "dist/index.js"
  }
}

14.2 Install commands

Primary:

npx crimes scan

or if scoped:

npx @crimes/cli scan

Global install:

npm install -g crimes
crimes scan

or:

npm install -g @crimes/cli
crimes scan

Package-manager variants:

pnpm dlx crimes scan
bunx crimes scan

14.3 Homebrew

Homebrew is nice, but npm should come first.

For a Node-based CLI, Homebrew can work, but it is not the primary path. Homebrew is best when distributing standalone binaries. For v0, support npm. Later, add Homebrew using either:

* a packaged binary generated with pkg/nexe/Node SEA, or
* a formula that installs via npm, though this is less ideal, or
* a rewritten/compiled launcher strategy.

Recommended staged approach:

v0

npm install -g crimes

v0.2

brew tap crimes-sh/tap
brew install crimes

v1

Standalone binaries for macOS/Linux/Windows via GitHub Releases.

⸻

15. Release and publishing workflow

15.1 npm publishing

Use GitHub Actions with npm trusted publishing where possible. Avoid long-lived npm tokens if the setup supports it.

Release flow:

1. Merge PRs with changesets.
2. Changesets opens a version PR.
3. Merging version PR tags a release.
4. GitHub Actions runs tests/build.
5. GitHub Actions publishes package to npm.
6. GitHub release is created with changelog.
7. Website deploys automatically from Vercel.

15.2 Versioning

Use semver:

* Patch: detector bug fixes, output copy tweaks that do not break schemas
* Minor: new detectors, new commands, non-breaking JSON fields
* Major: breaking JSON schema or CLI behaviour changes

The JSON schema should include schema_version from day one.

15.3 CI checks

Required checks:

* Typecheck
* Unit tests
* Fixture/integration tests
* Lint/format
* Build CLI
* Smoke test crimes scan against fixture repo
* Validate generated JSON schema

⸻

16. Website: crimes.sh

16.1 Site purpose

The website should help someone understand, trust, install, and use crimes quickly.

It should serve humans and agents.

16.2 Site structure

One-page homepage plus docs.

Homepage sections:

1. Hero
2. Install command
3. Example report
4. Why agents need this
5. What crimes detects
6. Agent-native JSON examples
7. CI usage
8. Comparison with linters
9. Open-source/community
10. Links to GitHub, npm, docs

Docs sections:

/docs
  /getting-started
  /commands
  /configuration
  /agent-usage
  /ci
  /finding-types
  /json-schema
  /suppressions
  /contributing-detectors

16.3 Homepage copy direction

Hero:

A crime scene investigator for your codebase.
`crimes` finds maintainability risks, duplicated business rules, ambiguous sources of truth, and agent-confusing code before humans or AI agents make risky changes.

CTA:

npx crimes scan

Secondary CTA:

Read the agent guide

16.4 Agent documentation

Create a first-class page:

/docs/agent-usage

It should include:

* Commands agents should run before editing
* Commands agents should run after editing
* JSON examples
* How to interpret agent_risk
* How to use crimes context
* How to use crimes diff
* Suggested system prompt snippets for agents

Example snippet:

Before editing a file, run:
crimes context <file> --format json
After editing, run:
crimes scan --changed --format json
Do not ignore high-severity new findings unless the user explicitly accepts the risk.

⸻

17. README requirements

The root README should be excellent. It should assume the reader has never installed a CLI before.

Suggested README outline:

# crimes
A crime scene investigator for your codebase. Built for agents, readable by humans.
## Install
## Quick start
## What it finds
## Why agents use it
## Example output
## Commands
## Configuration
## CI usage
## JSON output
## Roadmap
## Contributing
## License

The README should include:

* Copy-paste install command
* npx quick start
* Example human output
* Example JSON output
* Clear statement that it is not a security scanner or linter replacement
* “For agents” section
* “For first-time CLI users” section
* Link to website/docs

⸻

18. Configuration

Two keys govern how much the scan is allowed to skip, and both default
to the safe-but-quiet answer with an explicit way out (added 0.25.0):

- `excludeDefaults` (default `true`) — a user `exclude` is **additive**
  to the built-in list. Set `false` for wholesale replacement, which is
  the only way to *un*-exclude something the defaults drop. Governs
  `assets.exclude` too. Before 0.25.0 replacement was the only
  behaviour, so setting one pattern silently un-excluded `node_modules`
  and every lockfile.
- `honourToolingExcludes` (default `true`) — skip paths the repository's
  own tooling excludes, but only when **two or more independent tools**
  name the same path (ruff, coverage, pyright, codespell; build-backend
  tables are never read). Every skipped file is reported under
  `coverage.warnings[]` with the config keys that authorised it, so the
  suppression is never silent.

crimes.config.json example:

{
  "$schema": "https://crimes.sh/schema/config.json",
  "language": ["typescript", "javascript"],
  "include": ["src/**/*.{ts,tsx,js,jsx}"],
  "exclude": ["node_modules", "dist", "coverage", "*.generated.ts"],
  "excludeDefaults": true,
  "honourToolingExcludes": true,
  "architecture": {
    "layers": [
      { "name": "ui", "pattern": "src/components/**" },
      { "name": "api", "pattern": "src/api/**" },
      { "name": "domain", "pattern": "src/domain/**" },
      { "name": "infra", "pattern": "src/infra/**" }
    ],
    "rules": [
      { "from": "domain", "cannotImport": ["ui", "api"] },
      { "from": "ui", "cannotImport": ["infra"] }
    ]
  },
  "domainRules": {
    "money": {
      "forbidFloatMath": true,
      "allowedModules": ["decimal.js", "big.js"]
    },
    "time": {
      "forbidDirectDateNowIn": ["src/domain/**", "src/billing/**"]
    }
  },
  "thresholds": {
    "largeFunctionLines": 80,
    "largeFileLines": 500,
    "maxParams": 5
  },
  "triage": {
    "resurfaceBase": "main"
  }
}

18.1 Zero-config behaviour

crimes scan should work without config.

Default exclusions:

* node_modules
* dist
* build
* .next
* coverage
* generated lockfiles
* minified files

⸻

19. Agentic workflows

19.1 Pre-edit workflow

crimes context src/billing/tax.ts --format json

Agent receives:

* What the file appears to do
* Risk score
* Known crimes
* Related files
* Relevant tests
* Safe editing guidance

19.2 Post-edit workflow

crimes scan --changed --format json

Agent receives:

* New findings introduced by the change
* Existing findings touched by the change
* Recommended next action

19.3 Task investigation workflow

Future:

crimes ask "add annual plan discounts"

Output:

* Likely source of truth
* Duplicated implementations
* Relevant tests
* Files to avoid editing directly
* Known risks

19.4 CI workflow

crimes diff origin/main...HEAD --fail-on new-high

CI should fail only when new high-severity issues are introduced.

⸻

20. Competition and differentiation

20.1 Competitive landscape

Relevant categories:

Linters

Examples:

* ESLint
* Biome
* Pylint
* RuboCop

Strengths:

* Fast
* Local
* Mature
* Great for syntax/style/common errors

Weaknesses relative to crimes:

* Usually file-local
* Not focused on repo-level change risk
* Not designed around agent context
* Often noisy for broader maintainability questions

Static analysis and code quality platforms

Examples:

* SonarQube
* Qodana
* Codacy
* DeepSource
* Code Climate

Strengths:

* Mature rule ecosystems
* CI integration
* Dashboards
* Broad language support
* Security/quality metrics

Weaknesses relative to crimes:

* Often platform-first, dashboard-first, or enterprise-oriented
* Less focused on local agentic workflows
* May produce issue lists rather than structured editing guidance
* Agent-native JSON context is not usually the core product

Security/static analysis tools

Examples:

* Semgrep
* CodeQL
* Snyk Code
* Checkmarx

Strengths:

* Security rules
* Custom policies
* CI enforcement
* Deep semantic analysis

Weaknesses relative to crimes:

* Security-first rather than maintainability/agent-risk-first
* Not primarily about codebase navigation or change safety

Code health / hotspot tools

Example:

* CodeScene

Strengths:

* Strong code health positioning
* Hotspots and code smell analysis
* Git history-aware insights
* Existing CLI and IDE integrations

Weaknesses / wedge for crimes:

* crimes should be open-source-first and agent-native-first
* crimes should expose stable structured context specifically for coding agents
* crimes can optimise for local repo use, JSON contracts, and task-specific context
* crimes can build a playful, developer-friendly OSS identity

20.2 Differentiation statement

crimes should not compete head-on as “a better SonarQube”. It should compete as:

“The local, open-source repo investigation layer for AI coding agents.”

This is a narrower and more compelling wedge.

⸻

21. Risks and mitigations

Risk: noisy output

Mitigation:

* Show top findings only by default
* Include confidence scoring
* Require evidence
* Make suppressions easy
* Tune using fixture repos

Risk: looks like a toy because of the name

Mitigation:

* Keep copy playful but credible
* Use serious evidence-backed explanations
* Avoid silly jokes in core output

Risk: too much overlap with existing tools

Mitigation:

* Position around agent workflows
* Prioritise context, diff, verdict, and JSON contracts
* Do not try to be a universal linter

Risk: first version is too ambitious

Mitigation:

* Start JS/TS only
* Start deterministic only
* Ship a small number of excellent detectors
* Make outputs excellent

Risk: hard to detect semantic/domain crimes accurately

Mitigation:

* Start with conservative heuristics
* Mark confidence honestly
* Allow config for domain conventions
* Avoid overclaiming

Risk: package name unavailable

Mitigation:

* Use @crimes/cli with crimes binary
* Use crimes.sh as the brand anchor

⸻

22. Milestones

Milestone 0: Repo foundation

Deliverables:

* Public GitHub repo
* pnpm workspace
* CLI package skeleton
* Core package skeleton
* Website app skeleton
* CI running tests/typecheck/build
* README draft
* Licence
* Code of conduct
* Contributing guide

Milestone 1: First working CLI

Deliverables:

* crimes scan
* File discovery
* TS/JS parsing
* Basic structural detectors
* Human output
* JSON output
* Fixture repo
* Unit tests

Milestone 2: Risk model

Deliverables:

* Scoring model
* Git churn analysis
* Test proximity detection
* crimes hotspots
* Ranked report

Milestone 3: Agent context

Deliverables:

* crimes context <file>
* Related files
* Likely tests
* Known crimes per file
* Agent-safe JSON schema
* Agent docs page

Milestone 4: Diff and CI

Deliverables:

* crimes diff main...HEAD
* crimes scan --changed
* crimes verdict
* Baseline support
* GitHub Action docs

Milestone 5: Public launch

Deliverables:

* npm publishing
* crimes.sh live
* polished README
* getting started docs
* demo GIF/video
* example reports
* release notes

Milestone 6: Homebrew and binaries

Deliverables:

* GitHub Releases
* macOS/Linux/Windows binaries if feasible
* Homebrew tap
* Install docs updated

⸻

Versioned milestones (post-launch)

crimes@0.11.0 — Triage as the front door (Release B)

Theme: explicit per-finding triage replaces reflexive baseline.

Deliverables:

* crimes triage command — top-of-rank interactive walk with five dispositions (fix-now, fix-this-PR, needs-design, wont-fix, scaffolding)
* .crimes/triage.json on-disk schema with required reason + owner + date per entry
* Triage- and baseline-aware resurfacing on touched files (config.triage.resurfaceBase, default "main")
* New Finding fields effort + fix_shape; schema_version bump 0.1.0 → 0.2.0
* PreToolUse Edit hook in crimes init --agents (.claude/settings.local.json), with --no-hooks opt-out and a forward-looking Codex stub
* Human-readable secondary scores in scan + context renderers (JSON numerics unchanged)
* New scan flags: --show-triaged, --gate-needs-design, --gate-resurfaced

⸻

23. First implementation plan

23.1 Week 1 style target

Build a small but real CLI:

npx crimes scan

It should:

* Discover files
* Parse TS/JS
* Detect large functions
* Detect large files
* Detect TODO/FIXME density
* Detect direct Date.now() / new Date()
* Detect repeated string literals
* Output readable report
* Output JSON

This is enough to validate the product feel.

23.2 Early package design

packages/core
  src/
    model/
      finding.ts
      score.ts
      repo.ts
    detectors/
      large-function.ts
      large-file.ts
      todo-density.ts
      direct-date.ts
    scan.ts
    config.ts
packages/cli
  src/
    index.ts
    commands/
      scan.ts
      explain.ts
      context.ts
    reporters/
      human.ts
      json.ts
packages/language-js
  src/
    parse.ts
    symbols.ts
    imports.ts

23.3 Example detector shape

export interface Detector {
  id: string;
  name: string;
  run(context: DetectorContext): Promise<Finding[]>;
}
export interface Finding {
  id: string;
  type: string;
  charge: string;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  file: string;
  symbol?: string;
  lines?: [number, number];
  summary: string;
  evidence: string[];
  scores: FindingScores;
  suggestedActions: SuggestedAction[];
}

⸻

24. Open-source project assets

Required files:

README.md
LICENSE
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SECURITY.md
CHANGELOG.md
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/feature_request.yml
.github/PULL_REQUEST_TEMPLATE.md

Recommended licence:

* MIT for maximum adoption, or
* Apache-2.0 if patent protection matters.

Recommendation: MIT unless there is a specific reason to choose Apache-2.0.

⸻

25. Success metrics

25.1 Product quality metrics

* Time to first scan under 60 seconds for medium TS repo
* Human report shows fewer than 10 findings by default
* JSON schema stable across patch releases
* False positive reports decrease over time
* Detectors include confidence and evidence

25.2 Adoption metrics

* GitHub stars
* npm weekly downloads
* Website visits
* Issues opened by real users
* PRs from contributors
* Mentions in agent workflows/docs

25.3 Agent usefulness metrics

Harder to measure, but important:

* Agents can identify relevant files using crimes context
* Agents reduce newly introduced duplicate business rules
* Agents run relevant tests more often
* PRs using crimes introduce fewer high-severity findings

⸻

26. Open questions

1. Is the npm package name crimes available?
2. Should the GitHub org be crimes-sh, codecrimes, or something else?
3. Should the initial licence be MIT or Apache-2.0?
4. Should the first website use Astro/Starlight or Next.js?
5. Should v0 support only JS/TS, or should Python be included early?
6. Should LLM integration be deferred entirely until deterministic workflows are strong?
7. Should we offer a GitHub Action wrapper from day one?
8. Should crimes ask exist in v0 as heuristic search, or wait until v1?

⸻

27. Recommendation summary

Build this as a public TypeScript monorepo:

apps/website
packages/cli
packages/core
packages/language-js
packages/reporter
examples/messy-ts-app

Publish the CLI to npm first. Add Homebrew later.

Keep the website in the same public repo. It is documentation, not brochure clutter, and it helps contributors and agents understand the product.

Start with deterministic JS/TS analysis. Avoid LLM dependency in the core product. Make JSON output and agent context first-class from day one.

The wedge is not “better linter”. The wedge is:

Local, open-source, agent-native codebase risk and context.
