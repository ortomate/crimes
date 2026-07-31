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
  two or more language packs. Runs after every per-pack pass.

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
