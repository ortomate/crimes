# §4d — a Python symbol index, scoped

The one item from the 0.18.1 remediation pass that is a **feature**
rather than a correction, and the one deliberately not attempted. This
file scopes it so the next session starts from a design rather than from
the symptom.

## The symptom

`weak_test_signal.py` follows a call to an assertion helper **two hops,
same file only**. Python's dominant test idiom puts the helper on a base
class in another module, so the detector reports tests that do assert.

Two confirmed cases:

- zulip `test_message_delete.py::test_delete_event_sent_after_transaction_commits`
  asserts through `self.capture_send_event_calls(expected_num_events=1)`,
  a context manager on `ZulipTestCase` in `zerver/lib/test_classes.py`.
  It is the single survivor of that file after the 0.18.1 nesting fix.
- airflow's assertion-helper improvement stopped at **12%** for the same
  reason (§1.16).

## Why the obvious version is wrong

Matching `self.<method>()` against any function of that name anywhere in
the repo is name collision, not call resolution. `0.18.1` removed
exactly that mistake from `pass_through_abstraction` — four unrelated
registries were joined into one "chain" because they all had a `has()`
method, at confidence 0.98 (`2e9b2da`).

Getting it wrong here is **worse than the current miss**, because the
failure mode is silent: a test gets credited with an assertion it does
not make, and `weak_test_signal` stops reporting a genuinely hollow
test. A false negative in a detector about false confidence.

## What correct looks like

Resolve through the **MRO**, not through the name:

1. The test is a method on class `C` in file `F`.
2. `C`'s bases are in `ParsedPyClass.bases` as written (`ZulipTestCase`,
   `zerver.lib.test_classes.ZulipTestCase`).
3. Resolve each base name through `F`'s own imports
   (`PyImport.module` / `.names`) using
   `packages/language-py/src/imports/resolve.ts`, which already maps a
   module path to a repo file.
4. Look for a method of the called name on that class; recurse into
   *its* bases. Depth-bound it.
5. Credit only when a method found this way asserts within its own span.

A **unique-name fallback** is defensible where the MRO cannot be
resolved: if exactly one Python function in the whole repo carries that
name, matching it is a disambiguation rather than a guess. If two or
more do, stay silent — that is the `has()` case.

## The architectural blocker, which is the real work

There is no repo-wide Python index and no obvious place to hang one.

- `LanguagePyDetectorContext` is **per file** (`detector.ts:401`).
- Python files are parsed **inside** the per-file detector loop
  (`scan-detect.ts:296`), so nothing has seen file N+1 when the detector
  runs on file N.
- `collectInto` does accumulate every `PackedFile` — but only for the
  cross-language pass, which runs *after* the per-file loop.

So one of these has to happen, and choosing between them is the design
decision:

- **(a) A pre-pass.** `buildPySymbolIndex` alongside `buildScanIndexes`,
  parsing every Python file up front. Simple and slow: airflow is ~10k
  Python files and a full scan is ~90s, so a second parse of all of them
  is not free. Needs a parse cache shared with the detector loop to be
  affordable.
- **(b) Move the detector to a second pass.** Let
  `weak_test_signal.py` run over `collectInto`'s `PackedFile[]` the way
  the cross-language pack does. No extra parsing at all. Costs the
  detector its `language-py` pack identity, which affects
  `detector_id`, fingerprints and therefore anyone's pinned
  suppressions.
- **(c) A shared parse cache** keyed by absolute path, populated by the
  first pass and read by an index built lazily on first detector
  request. Most invasive, least wasteful, and the only one that also
  helps the next Python detector that wants to follow a call.

**(c) is the recommendation** — the queue entry itself notes this index
"would also serve any other Python detector that wants to follow a
call", and (a) pays the cost twice while (b) breaks identity for
existing users.

## Acceptance

- zulip `test_message_delete.py` reports **zero** silent tests (the one
  survivor is credited through `ZulipTestCase.capture_send_event_calls`).
- airflow's credited-through-helper share moves meaningfully past 12%,
  and the number is reported before/after.
- A test pins that two same-named helpers in unrelated classes credit
  **nothing** — the `has()` case.
- Python scan wall-clock on airflow does not regress more than ~10%.
- `pnpm verify` green; fingerprint uniqueness and byte-identical
  re-scans re-checked, since this changes what `weak_test_signal` emits.

## Not in scope

Following a call into a third-party package. The index is repo-local;
`self.assertEqual` from `unittest` is already handled by the
`assert[A-Z_]` matcher and needs nothing.

---

## Outcome — shipped in `0.18.3` (`ce2963b`)

Kept for the record of what this note got right and what it got wrong.

### The architectural blocker did not exist

"The real work is architectural" was the central claim, and it was
false. All three options above answer the same question — *Python files
are parsed inside the per-file detector loop, so a repo-wide index has
nowhere to live* — and that question does not arise.

`packages/core/src/imports/python.ts` (`buildPythonImportEdges`) already
parses **every** discovered Python file in the pre-pass, and already
builds the `PyModuleIndex` that step 3 asks for. It kept
`parsed.imports` and threw the rest away. The symbol index is collected
from that same parse: a linear pass over data already in hand.

So the recommendation — **(c), a shared parse cache** — would have built
a cache for a parse that was already happening. (a) would have parsed
the repo a third time. (b) would have broken `detector_id` and every
pinned suppression to solve a problem that was not there.

The lesson worth keeping: *check where the work already happens before
designing somewhere for it to happen.* Reading `python.ts` for five
minutes would have replaced this entire section.

### The resolution design was right, and was the whole job

Steps 1–5 above survived intact. Resolution goes through the importing
file's own imports and the module index, never through a repo-wide
name search, and an unresolvable base is not followed.

The **unique-name fallback** this note called "defensible" was
implemented and then **not shipped**: the MRO and import paths alone met
the acceptance criteria (`test_message_delete.py` → 0), so the fallback
would have been unmeasured risk taken for no measured gain. If a future
case needs it, the argument for it should be a measurement, not this
paragraph.

### What neither this note nor the acceptance criteria anticipated

Crossing the file boundary silently broke an assumption same-file
resolution never had to state: **a test file's own functions are test
infrastructure by construction.** Following a call into *production*
code and crediting its `assert` gets the statement backwards — an
`assert` in a domain function is a precondition defending it from its
caller, not the caller checking a result.

Found on zulip: three test files credited through `zerver/actions/*.py`,
where `do_set_realm_property` asserts `isinstance(raw_value,
property_type)` about its own argument. Cross-file credits now require
the helper to live in test infrastructure (`isTestFile`, plus
`conftest.py`).

It was caught only by opening the files named in the evidence, which is
the argument for naming them there.

### Acceptance, against the criteria above

| criterion | result |
|---|---|
| zulip `test_message_delete.py` reports zero | **0** ✓ |
| airflow moves meaningfully, reported before/after | claimed-silent tests 634 → **462 (−27.1%)**; findings 435 → 380; files 326 → 271 ✓ (but see the note in the remediation doc — this is not the same quantity as the "12%") |
| a test pins the two-same-named-helpers case | `does NOT match a same-named method on an unrelated class`, plus `does NOT credit an assert inside production code` ✓ |
| Python wall-clock does not regress ~10% | airflow 97.1s → 99.4s over three samples each, against a ~12s spread ✓ |
| `pnpm verify`, fingerprints, byte-identical re-scans | green at 2,114 tests; collisions **identical** before and after ✓ |
