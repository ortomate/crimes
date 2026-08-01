# Structural findings

Structural crimes flag file- and function-shaped code smells: bodies
that are too long, too many TODOs, or testability issues that come
from reaching for environment-coupled primitives in domain code.
They're the oldest detector category — `crimes@0.1.0` shipped the
first four — and the most fixture-tuned.

For the wire format, see [`docs/json-schema.md`](../json-schema.md).
For the agent workflow that consumes findings, see
[`docs/agent-usage.md`](../agent-usage.md).

## What ships

| `Finding.type`     | Charge              | Severity range | Confidence |
| ------------------ | ------------------- | -------------- | ---------- |
| `large_function`   | God Function        | low-high       | 0.80-0.95  |
| `large_file`       | God File            | medium-high    | 0.80-0.90  |
| `todo_density`     | TODO Tombstone      | low-medium     | 0.75-0.85  |
| `direct_date`      | Temporal Recklessness | medium       | 0.80       |
| `timezone_unsafe_parse` | Timezone Roulette | medium-high  | 0.90       |
| `mixed_utc_local_methods` | Half-UTC, Half-Local | high     | 0.85       |
| `locale_drift`     | Host-Locale Drift   | low-high       | 0.85       |
| `dst_naive_arithmetic` | DST-Naive Day Math | medium-high | 0.80       |
| `date_string_concat` | Date String Sewing | low-medium    | 0.85       |
| `boolean_naming_drift` | Unprefixed Boolean | low-medium   | 0.80       |
| `singular_plural_type_mismatch` | Plural Mismatch | low-medium | 0.70   |
| `sync_io_in_hotpath` | Sync I/O in Hot Path | low-high     | 0.90       |
| `hardcoded_local_path` | Localhost-on-Disk  | medium-high  | 0.90       |
| `hardcoded_localhost` | Dev-Server URL    | medium-high   | 0.90       |

All emit the standard `Finding` shape. No schema bump is required.

---

## God Function (`large_function`)

**What it detects.** Functions whose body exceeds a per-shape line
threshold. The detector classifies each function into one of six
shapes and applies a tailored budget per shape, so a 240-line
`describe()` callback isn't charged at the same threshold as a
240-line domain function.

| Shape                   | Threshold | Severity at threshold | Severity at 2× |
| ----------------------- | --------- | --------------------- | -------------- |
| `domain`                | config (default 60) | medium | high |
| `route_handler`         | 100       | medium                | high           |
| `react_component`       | 200       | medium                | high           |
| `page_export`           | 200       | medium                | high           |
| `test_callback`         | 200       | low                   | medium         |
| `cli_command_registrar` | 200       | low                   | medium         |
| `unknown`               | 80        | medium                | high           |

The `cli_command_registrar` shape (new in 0.6.0) recognises
Commander-style `register*Command(program)` wrapper functions and the
anonymous arrows passed to their `.action(...)` calls. The chain is
declarative DSL, not branching logic, so a long body there shouldn't
read like a domain god-function.

**Example evidence.**

```text
lines 24–286 (263 lines)
3.2× the React component threshold (200 lines)
function declaration
shape: React component (PascalCase name "PricingPage"; body returns JSX)
```

**Why it matters.** Bodies past the shape's threshold usually mix
multiple responsibilities. An agent editing one section misses
interactions in another, and the function becomes a magnet for
further duplication. Smaller, named helpers give every editor — human
or AI — a smaller surface to reason about per edit.

**Suggested fix.** The `suggested_actions[0].description` is tailored
to the shape: extract markup sections for React components, extract
request parsing / authorisation / persistence for route handlers,
move the action body into a named function for CLI registrars, etc.

**Configuration knobs.** `thresholds.largeFunctionLines` (legacy
domain threshold, kept for back-compat) and the per-shape
`thresholds.largeFunction.<shape>` overrides. See
[`docs/configuration.md`](../configuration.md).

---

## God File (`large_file`)

**What it detects.** Source files past a per-shape line threshold.
Counts non-empty lines so generated whitespace can't lower the count.

| Shape       | Threshold              | Severity at threshold | Severity at 2× |
| ----------- | ---------------------- | --------------------- | -------------- |
| `domain`    | config (default 300)   | medium                | high           |
| `test_file` | 1500                   | low                   | medium         |
| `docs`      | 1000                   | low                   | medium         |

The `test_file` shape (new in 0.6.0) matches `**/*.{test,spec}.[jt]sx?`
and files under `__tests__/`. Tests legitimately grow large with many
small `it()` blocks, so the budget is much higher and severity caps
at `low` / `medium`.

The `docs` shape (new in 0.17.0) matches `.md`, `.mdx`, `.markdown`,
`.rst`, `.adoc`, `.asciidoc`, and `.txt`. Without it, prose was scored
against the domain-code budget, so a schema reference or a
configuration guide was charged as a God File for being thorough. Data
formats stay on the `domain` budget — a 3000-line `.json` is a finding,
not a document.

**Example evidence.**

```text
523 non-empty lines
1.7× the configured 300-line file threshold
22 top-level functions declared in this file
```

**Why it matters.** Files this size accumulate unrelated
responsibilities and become harder to navigate by name. Splitting
them by concern lets agents and reviewers reason about each piece in
isolation.

**Suggested fix.** Identify cohesive groups of functions (data
access, formatting, validation, transport) and extract each into its
own file. Re-exporting from a barrel is fine if the consumers prefer
the flat import. For `test_file` shape, split into per-feature or
per-scenario suites.

**Configuration knobs.** `thresholds.largeFileLines` (legacy domain
threshold, kept for back-compat) and the per-shape
`thresholds.largeFile.<shape>` overrides. See
[`docs/configuration.md`](../configuration.md).

---

## TODO Tombstone (`todo_density`)

**What it detects.** Files where the count of `TODO` / `FIXME` /
`XXX` / `HACK` markers per 1k non-empty lines crosses
`thresholds.todoDensityPerKLoc` (default 10).

**Example evidence.**

```text
8 markers in 420 LOC (19.0 per 1k LOC)
worst lines: 33, 47, 88, 102, 178
```

**Why it matters.** High marker density is a *map of the unowned
work in the file*. Without context, an agent can't tell whether each
TODO is "fix this before merging" or "we accepted this years ago" —
so it either treats everything as urgent or learns to ignore the
marker entirely. Reducing density forces the team to either resolve
or stop pretending the TODO is meaningful.

**Suggested fix.** Convert load-bearing TODOs into tracker tickets
referenced by id. Delete or close the rest. The detector doesn't
care about marker style — `// TODO(@alex)` survives unchanged.

**Self-reference exemption (new in 0.6.0).** A file whose own source
contains the literal token sequence `TODO|FIXME|XXX|HACK` (i.e., it
*defines* the marker pattern rather than carrying markers) is
skipped. This stops the detector from flagging its own source and
any fixture or test of the marker pattern. Prose that just mentions
one marker name in passing is unaffected.

---

## Temporal Recklessness (`direct_date`)

**What it detects.** Domain code that reaches directly for
`Date.now()` or `new Date()` rather than accepting an injectable
clock. Files matching the test glob (`*.test.ts`, `*.spec.ts`,
`__tests__/**`) are exempt — explicit test-time injection is the
fix, not the smell.

**Example evidence.**

```text
3 direct uses of `Date.now()` / `new Date()`
lines: 18 (new Date), 47 (Date.now), 102 (new Date)
file lives in domain path (no test-file shape)
```

**Why it matters.** A domain function that reads "now" from the
process is untestable without monkeypatching, runs differently in
prod vs CI, and silently fails timezone tests. Pass a clock — an
`Injectable<() => Date>` or just a `now()` parameter — and the
finding goes away.

**Suggested fix.** Replace the direct call with a parameter on the
nearest call boundary (`now()`, `clock`, etc.). Inject the real clock
from the entry point and a fixed timestamp from tests.

---

## Timezone Roulette (`timezone_unsafe_parse`)

**What it detects.** `new Date("…")` calls whose string argument has
no timezone marker — no trailing `Z`, no `±HH:MM` offset, no
`GMT±NNNN` segment. The detector skips literals that don't look
date-like (no 4-digit year + separator), epoch numbers, multi-arg
forms, and dynamic expressions. Test files are exempt — fixtures
routinely pin literal dates.

**Example evidence.**

```text
unsafe literals: "2026-12-25T07:00:00", "2027-01-01", "2027-06-15T14:30:00", …
lines: 29, 33, 41
add `Z` for UTC, `±HH:MM` for an offset, or parse through a timezone-aware library
```

**Why it matters.** JavaScript parses date strings differently
depending on their shape:

- `"2026-12-25"` (date-only, ISO 8601 calendar date) → **UTC**
  midnight per the ES spec. The developer often expects local
  midnight.
- `"2026-12-25T07:00:00"` (datetime with no zone) → **local** time.
  The developer often expects UTC.
- `"2026-12-25T07:00:00Z"` → **UTC**, explicit. No ambiguity.
- `"2026-12-25T07:00:00+05:30"` → that offset, explicit.

Coding agents are especially prone to this — they copy a literal
that worked in one environment and silently break in another. Adding
`Z` or an explicit offset removes the guess.

**Severity ramp.** Default `medium`; escalates to `high` when one
file accrues 5 or more unsafe literals (a systemic pattern, not an
accident). Confidence is `0.90` — the pattern is unambiguous when
the string survives the date-like filter.

**Suggested fix.** Append `Z` for UTC, an explicit `±HH:MM` offset,
or switch to a timezone-aware library (Luxon, Temporal API,
date-fns-tz).

**Exemptions.** For configuration-style literals that legitimately
represent "whatever the host's local zone is", add the exact literal
to `detectors.options.timezone_unsafe_parse.allowedLiterals` in
`crimes.config.json`:

```jsonc
{
  "detectors": {
    "options": {
      "timezone_unsafe_parse": {
        "allowedLiterals": ["2026-12-25T07:00:00"]
      }
    }
  }
}
```

The option is validated at config-load time — unknown keys or
wrong-shape values fail fast with `ConfigParseError` (exit `2`).
For a one-off exception, prefer `crimes ignore <fingerprint>`
with a reason instead.

---

## Half-UTC, Half-Local (`mixed_utc_local_methods`)

**What it detects.** A single receiver identifier (`const d = new Date()`)
reads or writes both UTC-family methods (`getUTCHours`, `setUTCDate`,
…) and local-family methods (`getHours`, `setDate`, …) in the same
file. The detector groups calls by receiver name and fires when the
same name touches both families.

**Example evidence.**

```text
"d" uses getUTCFullYear() @L13 and getMonth() @L13
…and 1 more receiver
```

**Why it matters.** Mixing UTC and local Date methods silently
shifts the value by the host's UTC offset. Tests that don't cross
a DST or international-date-line boundary will pass; production
quietly misbehaves whenever the runtime sits in a non-UTC timezone.
Convention: UTC for storage and computation, local only at the
display boundary.

**Severity.** High by default — the bug class is silent and rarely
caught by tests. Confidence `0.85` (heuristic: the receiver is
inferred from name, not type).

**Suggested fix.** Convert all reads on the receiver to one family.
If both views are genuinely needed, derive them from a single
canonical value rather than mixing on the same instance.

---

## Host-Locale Drift (`locale_drift`)

**What it detects.** `.toLocaleString()`, `.toLocaleDateString()`,
or `.toLocaleTimeString()` invoked with no locale argument. Output
varies by the runtime's host locale.

**Example evidence.**

```text
due.toLocaleDateString() @L17
lines: 17, 24, 41
pass an explicit locale (e.g. 'en-US') or use Intl.DateTimeFormat
```

**Why it matters.** Same line renders as `"3/15/2026"` on a US
machine, `"15/03/2026"` on a UK one, and `"15.03.2026"` on a German
one. For logs, IDs, persisted text, or anything passed across a
network, the drift produces silent bugs. For user-facing copy, the
implicit locale is rarely the right contract either — make it
explicit.

**Severity ramp.** Default `low`; bumped to `medium` in
user-facing paths (`ui/`, `components/`, `pages/`, `app/`,
`routes/`, `views/`) and to `high` when one user-facing file has 5
or more locale-naive calls. Non-user-facing paths escalate from
`low` to `medium` at 3+ hits.

**Suggested fix.** Pass an explicit BCP-47 locale (`'en-US'`), or
construct an `Intl.DateTimeFormat(locale, options)` once and reuse
it. For machine-readable strings, switch to `toISOString()`.

---

## DST-Naive Day Math (`dst_naive_arithmetic`)

**What it detects.** `+` / `-` arithmetic on timestamps where the
numeric operand is a recognised day-level millisecond constant:
86,400,000 (1 day), 604,800,000 (1 week), 2,419,200,000 /
2,592,000,000 (≈ 1 month), 31,536,000,000 (≈ 1 year). Folded
multiplications like `24 * 60 * 60 * 1000` are recognised as the
same constant.

**Example evidence.**

```text
+ 86400000 (day) @L23
lines: 23, 47
file looks like scheduling/billing code — drift here directly affects users
```

**Why it matters.** A "day" isn't always 86,400,000 ms. DST
transitions skip an hour in spring and repeat an hour in autumn;
leap seconds and timezone-policy changes nudge it further. Adding
the constant silently drifts the result. Tests that don't cross a
transition won't catch the bug; the report runs differently in
March or October.

**Severity ramp.** Default `medium`, with two escalations to
`high`: files matching `billing` / `invoice` / `schedul` / `cron` /
`payment` / `subscription` paths jump immediately, and any file
with 3+ occurrences also escalates.

**Suggested fix.** Use a timezone-aware library that knows about
the calendar — Luxon's `plus({ days: 1 })`, the Temporal API,
date-fns-tz, etc. For low-level "exactly N milliseconds later",
keep the math but rename the variable to `nextEpochMs` so the
reader doesn't expect a calendar day.

---

## Date String Sewing (`date_string_concat`)

**What it detects.** String literals concatenated with Date method
results — `"year-" + d.getUTCFullYear()` or
`d.getMonth() + "-month"`. The parser captures only the
concat-with-literal form to keep noise low.

**Example evidence.**

```text
`"…" + .getUTCFullYear()` @L29
lines: 29, 30, 31
use `toISOString()` or `Intl.DateTimeFormat` instead of `+`-concatenation
```

**Why it matters.** Hand-rolled date strings routinely drop
zero-padding (`"2026-3-5"` instead of `"2026-03-05"`), ignore
timezones, and forget that months are zero-indexed. The result
looks fine in dev and breaks parsers in production. `toISOString()`
and `Intl.DateTimeFormat` give you correctness for free.

**Severity ramp.** Default `low`; escalates to `medium` at 3+
hits in one file (a recurring formatter is usually a small bag of
bugs).

**Suggested fix.** Replace the concatenation with
`d.toISOString()`, `Intl.DateTimeFormat(locale, opts).format(d)`,
or a timezone-aware library's formatter.

---

## Unprefixed Boolean (`boolean_naming_drift`)

**What it detects.** Declarations whose value is clearly boolean —
annotated `: boolean`, or initialised from `true`/`false`/`!x`/
`a === b`/`a || b` — and whose name lacks a recognised boolean
prefix (`is`/`has`/`should`/`can`/`will`/`did`/`was`/`were`/`are`/
`needs`/`wants`/`allows`/`supports`/`owns`/`knows`/`expects`/
`requires`/`enables`/`prevents`/`blocks`/`denies`).

**Example evidence.**

```text
`paid` @L17
`expired` @L20
`stale` @L23
lines: 17, 20, 23
built-in React-state names (loading/ready/active/…) are exempt; …
```

**Why it matters.** Booleans named without a prefix read as nouns
to skimming reviewers and coding agents. The convention is cheap
and lets every `if (x.thing)` call site match the reader's
expectation. Coding agents in particular often introduce subtle
bugs by passing a boolean where a value is expected, or vice
versa, when the names don't disclose intent.

**Severity ramp.** Default `low`; escalates to `medium` at 5+
offenders in one file. Confidence `0.80`.

**Built-in exemptions.** 26 React-state idioms are exempt by
default: `loading, ready, active, disabled, expanded, pending,
open, closed, visible, hidden, selected, focused, dirty, valid,
submitting, editing, dragging, hovering, checked, busy, empty,
full, online, offline, mounted, unmounted`. All-uppercase
constants (`FEATURE_X_ENABLED`) and single-letter names are also
exempt.

**Project-specific exemptions** via
`detectors.options.boolean_naming_drift.allowedNames`:

```jsonc
{
  "detectors": {
    "options": {
      "boolean_naming_drift": {
        "allowedNames": ["pristine", "processed"]
      }
    }
  }
}
```

**Suggested fix.** Rename to one of the recognised prefixes
(`isPaid`, `hasExpired`, `shouldRetry`, `canEdit`). For names
that are project-specific UI-state idioms, add them to
`allowedNames` rather than renaming.

---

## Plural Mismatch (`singular_plural_type_mismatch`)

**What it detects.** Declarations where the name's plural shape
disagrees with the annotated type's array shape:

- `users: User` — name plural, type singular
- `user: User[]` (or `Array<User>` / `ReadonlyArray<User>`) — name
  singular, type array

**Example evidence.**

```text
plural name, singular type: `users: User` @L26
singular name, array type: `invoice: Invoice[]` @L29
v1 detector — type aliases and generic types are silently skipped
```

**Why it matters.** When an identifier's plural form lies about
the value's shape, readers and coding agents iterate the wrong
way: `for (const u of users)` against a `User`, or `.find(...)`
on a `User[]`. The name and the type are both load-bearing — they
should agree.

**v1 limitations.** The detector fires only on a bare type
annotation that's either an `Identifier` (`User`) or a simple
array shape (`User[]` / `Array<User>` / `ReadonlyArray<User>`).
Aliased types (`type UserId = string`), generic types (`Map<…>`),
and union types are silently skipped. This is intentional — the
v1 detector trades coverage for confidence. A v2 backed by full
type info is tracked for 0.9.0+.

**Severity ramp.** Default `low`; escalates to `medium` at 4+
offenders in one file. Confidence `0.70`.

**Uncountable nouns.** Names matching the built-in uncountable
list (`data`, `information`, `news`, `software`, `staff`, …) are
exempt — they're singular and plural simultaneously.

**Project-specific exemptions** via
`detectors.options.singular_plural_type_mismatch.allowedNames`.

**Suggested fix.** Rename to match the type's shape, or change
the type to match the name. If the project intentionally
diverges, add the name to `allowedNames`.

## Sync I/O in Hot Path (`sync_io_in_hotpath`)

**What it detects.** Calls to synchronous Node.js I/O APIs —
`fs.readFileSync` / `fs.writeFileSync` / `fs.existsSync` /
`fs.statSync` / `fs.readdirSync` / the rest of the `node:fs`
`*Sync` family, plus the synchronous process-spawning helpers
(`execSync`, `spawnSync`, `execFileSync`) — invoked inside a
function whose `FunctionShape` is one of `route_handler`,
`page_export`, `react_component`, or `domain`. Test callbacks and
CLI command-registrar callbacks are exempt — sync I/O in those
shapes is either intentional or harmless.

The detector consumes the `syncIoCalls` parser surface (added in
phase 4a of 0.8.0), which captures, for each call site, the full
chain of enclosing function-like ancestors innermost-first. Any
`test_callback` or `cli_command_registrar` ancestor anywhere in
the chain suppresses the finding; otherwise the innermost
hot-path ancestor is named in the evidence line.

**Example evidence.**

```text
`fs.readFileSync` @L21 in `GET` (route handler)
`fs.statSync` @L25 in `GET` (route handler)
lines: 21, 25
swap for the async variant (`readFile`, `writeFile`, `exec`, …) and `await` it
```

**Why it matters.** Synchronous I/O blocks the Node.js event
loop for the entire duration of the read or write. In a route
handler, every request pays the stall; in a React component
(used server-side via Next.js or a similar framework), every
render does. The async counterparts (`fs.readFile`, `fs.writeFile`,
`fs.promises.*`, child-process equivalents) exist for every
method captured and behave identically outside the performance
envelope.

Coding agents reach for the `*Sync` variant disproportionately
because it produces shorter, synchronous-looking code. The bug
class is silent: tests still pass (tests themselves are
single-threaded), and the cost only materialises under
concurrent load.

**Severity ramp.**
- `high` — two or more sync calls inside the same request-surface
  shape (`route_handler` / `page_export` / `react_component`).
- `medium` — one sync call inside a request-surface shape.
- `low` — sync calls inside `domain` functions. Domain stays low
  because the per-request amplification that justifies medium /
  high isn't there; the bug class becomes "library happens to
  block under load" rather than "request handler stalls on every
  hit". Available under `--all`.

Confidence `0.90` — the syntactic pattern is unambiguous.

**Suggested fix.** Replace the `*Sync` call with its async
counterpart (`readFile`, `writeFile`, `exec`, …) and `await` it.
The function may need to be marked `async`; React components
should move the I/O into a Server Component or `loader` rather
than the render body.

## Localhost-on-Disk (`hardcoded_local_path`)

**What it detects.** User-home subpaths hardcoded into source —
`/Users/<name>/…` (macOS), `/home/<name>/…` (Linux), and
`C:\Users\<name>\…` (Windows, including the forward-slashed
`C:/Users/<name>/…` form many editors display). Test files,
`scripts/`, `examples/`, `fixtures/`, and `test/` / `tests/`
directories are exempt — these are surfaces where a developer-
specific path is legitimate.

**Example evidence.**

```text
`/Users/andrew/dev/app/config.json` @L4
`/home/alex/projects/data.json` @L7
lines: 4, 7
replace with `os.homedir()`, `process.env.HOME`, or a config-driven base path
```

**Why it matters.** A path hardcoded to one developer's home
directory works on that developer's laptop and nowhere else. The
failure mode is silent: tests pass locally, CI fails for unrelated-
looking reasons, and the user-named segment is exactly the kind
of constant a coding agent copies between files without
noticing it's machine-specific. `os.homedir()`,
`process.env.HOME`, or a config-driven base path eliminates the
surface.

**Severity ramp.** Default `medium`; escalates to `high` at 3+
hardcoded paths in one file. Confidence `0.90`.

**Project-specific exemptions** via
`detectors.options.hardcoded_local_path.allowedPaths` — list any
literal substrings that should be tolerated (sample paths in
docstrings, intentionally-embedded references).

```json
{
  "detectors": {
    "options": {
      "hardcoded_local_path": {
        "allowedPaths": ["/Users/ci-runner/cache"]
      }
    }
  }
}
```

**Suggested fix.** Replace the literal with `os.homedir()` (or
`process.env.HOME`) joined with the remainder of the path, or
move the base path into configuration so each environment
supplies its own.

## Dev-Server URL (`hardcoded_localhost`)

**What it detects.** Dev-server URLs hardcoded into non-test,
non-config source — `localhost:NNNN`, `127.0.0.1:NNNN`,
`0.0.0.0:NNNN`, and the IPv6 loopback `[::1]:NNNN`. The port
requirement (2–5 digits) is what makes the signal strong: a bare
`localhost` reference is often a doc placeholder, but
`localhost:3000` is "the URL of the dev server I happen to be
running right now."

The following surfaces are exempt: test files, files under
`scripts/` / `examples/` / `docs/` / `fixtures/` / `test/` /
`tests/` / `__tests__/`, and config-style basenames (`.env*`,
`*.config.{js,ts,mjs,cjs,json,yaml,yml}`, `docker-compose*`,
`Dockerfile*`, `README*.md`, `CHANGELOG*.md`).

**Example evidence.**

```text
`localhost:3000` @L8
`127.0.0.1:8080` @L12
lines: 8, 12
move the value behind a config / env var (`process.env.API_URL`, settings module, etc.)
```

**Why it matters.** A `localhost:NNNN` URL inside source code is
the URL of one specific dev server on one specific machine. In
production the request hits whatever the deploy environment
happens to have running on that port (often nothing), and the
failure mode is opaque. Coding agents reach for the literal
because they were just shown a working dev URL in the conversation
— it sticks around long after that conversation ends.
Configuration (env vars, settings module, framework runtime config)
makes the per-environment value explicit.

**Severity ramp.** Default `medium`; escalates to `high` at 3+
hardcoded URLs in one file. Confidence `0.90`.

**Project-specific exemptions** via
`detectors.options.hardcoded_localhost.allowedUrls`:

```json
{
  "detectors": {
    "options": {
      "hardcoded_localhost": {
        "allowedUrls": ["localhost:9229"]
      }
    }
  }
}
```

**Suggested fix.** Replace the literal with a config-supplied
URL (`process.env.API_URL`, a settings module, the framework's
runtime config). Keep the dev-server URL in `.env.local` or
`.env.example` so each environment supplies its own.
