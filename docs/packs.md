# Pack model

`crimes` groups detectors into **packs** based on what they need to
read. Each finding carries a `pack` field identifying its origin pack.

## Packs

- **`universal`** — Evidence is filename + bytes + git + IA index.
  Runs on every discovered file in every repo. Includes the asset
  pipeline (raster size, SVG content).
- **`language-js`** — Requires AST parsing via `@crimes/language-js`
  (TypeScript-ESTree). Runs only on `.ts/.tsx/.js/.jsx/.mjs/.cjs/.cts/.mts`.
- **`language-py`** (0.14.0) — Requires AST parsing via
  `@crimes/language-py` (tree-sitter-python). Runs only on `.py/.pyi`.
- **`cross-language`** (0.15.0) — Requires aligning artefacts from
  two or more language packs. Runs once per scan, after every per-pack
  pass.

## Tier vs pack

Don't confuse `Finding.pack` (detector capability) with
`Finding.tier` (file scope). `pack` answers "what kind of evidence
produced this finding"; `tier` answers "was the file in the
domain-code scope or the non-domain scope".

## Detector ids vs finding types

`Finding.type` is the **abstract charge** — `large_function` — and is
the same string regardless of which language produced it. Everything
that groups or matches findings keys off `type`: the reporter,
baselines, suppressions, triage, and feedback. Fingerprints are
`<type>::<file>::<symbol>`, which is why adding a language pack never
invalidates anything already on disk.

`Finding.detector_id` is the **qualified** form — `large_function.js`,
`large_function.py` — populated at finalisation.

The detector's own `id`, the one you write in config, differs by pack
for historical reasons:

| pack | detector `id` | `Finding.detector_id` |
| --- | --- | --- |
| `universal` | `todo_density` | `todo_density` |
| `language-js` | `large_function` | `large_function.js` |
| `language-py` | `large_function.py` | `large_function.py` |

The JS detectors keep unqualified ids because existing user configs
reference them. Python is qualified from the start, which means you can
disable one language's version without touching the other:

```json
{ "detectors": { "disable": ["large_function.py"] } }
```

Per-detector options use the same key:

```json
{
  "detectors": {
    "options": {
      "large_function.py": { "thresholds": { "domain": 80 } }
    }
  }
}
```

## The Python pack

### What it needs at install and scan time

**No Python runtime.** The pack parses Python with a WebAssembly build
of `tree-sitter-python`; it never shells out to an interpreter and does
not care whether one is installed.

It also ships **no native code**. The grammar is a vendored `.wasm`
blob (MIT, see
[`packages/language-py/vendor/ATTRIBUTION.md`](../packages/language-py/vendor/ATTRIBUTION.md))
and the runtime that executes it is `web-tree-sitter`, which is pure
JS + WASM. There is no addon to compile and no install script to run,
so `npx crimes scan` works the same on every platform Node supports.

Parser initialisation is **lazy**: a repo with no `.py` files never
loads the grammar and pays nothing for the pack existing.

If you have an unusual packaging layout and the grammar cannot be
located, set `CRIMES_PY_GRAMMAR_WASM` to its absolute path.

### Detectors

Eight, chosen to prove the pack seam rather than to reach parity with
the JS catalogue:

| detector | what it reads |
| --- | --- |
| `large_function.py` | line budget per function shape, plus nesting depth |
| `direct_date.py` | `datetime.now()` / `utcnow()` / `date.today()` / `time.time()`, and whether the result is naive |
| `mixed_utc_local_methods.py` | modules that read the clock through both `utcnow()` and local `now()` |
| `sync_io_in_hotpath.py` | `open` / `requests.*` / `urlopen` / `subprocess.*` / `time.sleep` inside handlers and domain code |
| `boolean_naming_drift.py` | names bound to boolean expressions without an `is_` / `has_` / `should_` prefix |
| `weak_test_signal.py` | pytest / unittest files whose test functions assert nothing |
| `circular_dependency.py` | strongly-connected components among Python modules |
| `deep_import.py` | dotted depth and long relative climbs |

These are not ports. `direct_date.py` charges naive datetimes, which
has no JS analogue; `circular_dependency.py` explains an `ImportError`
at startup rather than a bundling problem; `sync_io_in_hotpath.py`
escalates when the blocking call sits inside an `async def`, because
there it stalls the whole event loop rather than one worker.

Further Python detectors can land additively in patch releases without
their own minor bump.

### Function shapes

`large_function.py` picks a line budget from the function's shape, the
same way the JS detector does. The budgets are tighter than the JS ones
because Python is denser at equivalent complexity.

| shape | budget | recognised by |
| --- | --- | --- |
| `domain` | 50 | anything not matched below |
| `unknown` | 60 | name could not be recovered |
| `dunder` | 70 | `__init__`, `__enter__`, … |
| `route_handler` | 80 | `@app.get`, `@router.post`, `@bp.route`, `@api_view` |
| `django_view` | 80 | a Django view base class, or a first parameter named `request` |
| `cli_command` | 120 | `@click.command`, `@app.command` (Typer) |
| `test_function` | 150 | `test_*` name, `unittest.TestCase` method, `@pytest.fixture` |

Override any of them under
`detectors.options."large_function.py".thresholds`.

### Import resolution

The Python import graph feeds `circular_dependency.py`,
`deep_import.py`, and `scores.blast_radius`. Package roots are found the
way Python finds them — walk up from a file while each directory
contains an `__init__.py` — so flat layouts and `src/` layouts both work
without either being special-cased.

Resolved: absolute (`from billing.service import x`), relative
(`from . import y`, `from ..rates import z`), and submodule imports
(`from billing import service` also depends on `billing/service.py`).

**Not resolved**, and treated as external rather than guessed at: PEP
420 namespace packages, `importlib` calls, runtime `sys.path`
manipulation, and installed distributions. A missed edge understates
blast radius; a guessed edge would invent a dependency and produce a
`circular_dependency` finding that does not exist.

### Test pairing

`test_gap` understands Python's conventions as of 0.14.0. Both
`test_billing.py` and `billing_test.py` pair with `billing.py`, whether
they sit beside it or under a `tests/` directory. Before 0.14.0 only
suffix conventions were understood, so every Python file scored
`test_gap: 1.0` — "no test at all" — regardless of coverage.

`crimes context` reads the same table for `likely_tests`, and matches
Python imports by dotted module path (`from billing.rates import x`,
`from .rates import x`) rather than by relative path specifier.

Project roots are detected from `pyproject.toml`, `setup.py` and
`setup.cfg` as well as `package.json`, so running `crimes context` from
a subdirectory of a Python repo still scans the whole project.

## The cross-language pack

Three detectors, added in 0.15.0. Each one reports a disagreement
**between** two languages — the findings no single-language tool can
produce, because neither side's type checker, linter or compiler can
see the other half.

| detector | the disagreement |
| --- | --- |
| `cross_language_route_drift` | the frontend calls a path the backend doesn't serve, or the two disagree on the HTTP method |
| `cross_language_type_drift` | a closed set (Python `Enum`, TS string-literal union) listed differently on each side |
| `cross_language_concept_alias_drift` | the same concept named `team` in one language and `workspace` in the other |

### How they run

Unlike every other detector, these run **once per scan** rather than
once per file — a cross-language finding is by definition about two
files, so there is no single "current" file. The detector receives the
whole parsed corpus (`ctx.files`, each entry tagged with its pack) and
picks its own anchor.

Findings still carry a `file`, because fingerprints are
`<type>::<file>::<symbol>` and baselines, suppressions, triage and the
file-grouped report all key off it. The anchor is the file a reader
would edit first; the rest goes in `related_files`.

### What they will not do

The false-positive surface for a cross-language detector is roughly
squared — two languages' worth of source to mismatch — so all three are
deliberately conservative:

- **They never fire one-sided.** Each returns early unless both
  languages are present with the relevant evidence. In a JS-only repo,
  "no backend route" for every `fetch` would be noise proportional to
  the repo's size.
- **They only use quotable evidence.** A path assembled at runtime
  (`@app.get(PREFIX + "/users")`, ``fetch(`${base}/users`)``) is
  skipped on both sides, and a union with any non-literal member
  (`"free" | string`) is dropped whole rather than captured partially.
- **They require real overlap before calling something drift.** Two
  same-named `Status` types sharing no members are different concepts,
  not a disagreement.

**Matching is on literal strings, not resolved symbols.** A
cross-language import graph is deferred, so `cross_language_route_drift`
lines up the path text both sides wrote down. Path parameters are
normalised, so `/users/{user_id}`, `/users/<int:user_id>`, `/users/:id`
and ``/users/${id}`` all compare equal. A route or URL that only exists
at runtime is invisible to it, and the finding's own evidence says so.

One non-obvious behaviour worth knowing: `cross_language_concept_alias_drift`
reads Python docstrings, so a docstring that uses both names — "the
team, called a workspace in the UI" — suppresses the finding. That is
intentional. A codebase that documents its own mapping where a reader
will find it has this problem far less than one that does not.

### `crimes context` in a monorepo

`crimes context <file>` auto-scopes to the nearest enclosing package
root, which keeps the pre-edit briefing fast. In a monorepo that root
is one package — so the other language is not in scope, and the
cross-language detectors correctly decline to fire one-sided:

```console
$ crimes context packages/api/billing/plans.py
risk: NONE  (0 findings)          # scoped to packages/api — Python only

$ crimes context packages/api/billing/plans.py --root .
risk: HIGH  (2 findings)          # whole monorepo in scope
```

Pass `--root` at the monorepo root when you want cross-language
findings from `context`. `crimes scan` is unaffected — it uses the root
you give it, so cross-language findings appear normally there.

This is a deliberate trade rather than an oversight: widening the
context root automatically would make every `crimes context` call parse
the entire monorepo, including the `PreToolUse` hook that runs on every
agent edit.

## Coverage

Every `ScanReport.coverage` block reports how many files each pack
claimed:

```json
{
  "files_total": 550,
  "files_by_language": { "js": 412, "py": 138 },
  "files_universal_only": 0,
  "packs_loaded": ["universal", "language-js", "language-py"]
}
```

`packs_loaded` names every pack that ran. The universal pack always
leads it — it claims every file unconditionally, so a repo no language
pack recognises still reports `["universal"]`. Coverage prose in the
human reporter filters it out, because "which language packs claimed
files" is the question a coverage banner answers.

The human reporter prints a one-line banner when >50% of files
were unclaimed; `--explain-coverage` prints the full breakdown.

Coverage is derived from the `LanguagePackRouter` — the same registry
the detector orchestrator routes on — so it cannot drift from what
actually ran. A pack that registers extensions is reported here
automatically; there is no second list to update.

### `by_package` (0.15.0)

On a monorepo — two or more directories carrying a package manifest —
coverage gains a per-package breakdown:

```json
{
  "by_package": [
    { "path": "packages/api", "files_total": 138,
      "files_by_language": { "py": 138 }, "dominant_language": "py" },
    { "path": "packages/web", "files_total": 412,
      "files_by_language": { "js": 412 }, "dominant_language": "js" }
  ]
}
```

The repo-wide `files_by_language` says a repo is 75% TypeScript.
`by_package` says *which part* is the Python one, which is what decides
where a change is risky — in a mostly-TypeScript repo a single Python
service otherwise looks like a rounding error.

Details worth knowing:

- **Absent on single-package repos**, so presence is itself the "this
  is a monorepo" signal. One entry restating the repo total would be
  noise.
- **Manifests are found on disk**, not in the discovered file set —
  `include` covers source and docs, so `package.json` and
  `pyproject.toml` are never scanned. `Cargo.toml` and `go.mod` count
  as package roots too, even though no pack parses those languages:
  naming the package is more useful than folding it into the repo total.
- **Files attribute to the deepest enclosing package**, so a nested
  package inside another is counted separately.
- **`dominant_language` needs a strict majority.** A package that is
  45% Python and 40% TypeScript gets `null` rather than a label, because
  calling either one dominant puts a confident answer on a coin flip.

`--explain-coverage` prints the same breakdown.
