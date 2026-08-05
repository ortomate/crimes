# R3 pre-measurements: what the field notes' suggested fixes would actually do

Measurements taken before touching any detector, on the same
`choreograph.cc@5107cce` worktree used for
[Step 0](./2026-08-05-choreograph-reverify.md). Recorded here so the R3
work starts from evidence rather than from the notes' own suggestions —
two of which do not survive contact with the file that prompted them.

Nothing below has been acted on. Each entry is a hypothesis with a
measurement attached.

---

## `high_fan_in_fan_out`: the notes' suggested rule is a no-op on the file
## that prompted it

The [field notes](./2026-08-05-choreograph-field-notes.md) ask:

> Consider exempting modules whose exports are **type-only**.

`src/lib/types.ts` — the file flagged at 33 importers — exports:

| kind | count |
|---|---|
| `export interface` / `export type` | 24 |
| `export const` | **1** (`JOB_STUCK_THRESHOLD_SECONDS`) |

**An exports-are-type-only rule would not exempt it.** One 8-minute
timeout constant, in a 345-line file that is otherwise entirely type
declarations, is enough to fail the test. And the rule would be
brittle in the direction that matters: adding a single constant to a
types module would silently re-arm the finding.

### The importer-side signal is already in the graph and is more accurate

`ImportEdge.typeOnly` has existed since the graph was built, and
`high_fan_in_fan_out` does not consult it (only `deep_import` and
`dependency_provenance_gap` do). Measured on the same file:

| | count |
|---|---|
| files importing `@/lib/types` | 20 |
| of those, written as `import type { … }` | **19** |
| mixed `import { type X, VALUE }` | 1 |
| plain value imports | **0** |

So the importer-side signal separates this module cleanly where the
exports-side rule does not.

### But it is not obviously the right rule either — decide in R3, with a corpus number

A type-only edge is not a *runtime* coupling, which is what
`blast_radius` is about. It is still a **compile-time** coupling: change
an interface and all 19 importers fail to build. The honest question is
not "is this coupling real" — it is — but "is it the kind of coupling
this charge is about". `high_fan_in_fan_out`'s own rationale is that a
hub is expensive to change; for a types module that is true and also its
entire purpose, and the failure mode is loud and immediate rather than
silent.

Three candidate rules, to be measured on the corpus before one is
chosen:

1. **Discount type-only edges in the fan-in count.** Cheap, uses data
   already in the graph. choreograph `types.ts`: 33 → ~1.
2. **Keep the count, drop the severity** when the great majority of
   in-edges are type-only. Preserves the evidence ("33 importers, 19
   type-only") while stopping it leading the report.
3. **Leave it alone and call it a workflow mismatch.** A types module
   with 33 importers is a fact worth knowing on an audit run, and the
   complaint arose from a one-shot design task. This is the §15
   precedent and it is a legitimate outcome.

Option 2 is the one to beat: it is the only one that keeps the evidence
honest, and `CLAUDE.md` says evidence before judgement.

**Note the interaction:** `blast_radius` normalises
`transitiveImporterCount`, and R4 carries an open item about that count
treating a file as its own importer on a cycle. Changing what counts as
an importer touches both. Do not tune them in the same eval run — the
aggregate cannot attribute two changes at once.

---

## `logic_in_comments`: all ten hits reproduce, and the split is worth measuring

Ten findings on choreograph, unchanged from `0.17.0`, in the exact files
the notes named. The notes propose two possible fixes:

- drop confidence hard when the comment references **no identifier
  appearing in the adjacent code**; or
- split the charge into **prescriptive** vs **explanatory**.

The representative hit, `src/lib/types.ts` L239:

> "Panorama — 360° equirectangular bonus piece (day % 3 == 2; never
> required for publish). Authored by the Curator…"
> — rule terms: never, required

That comment *does* reference adjacent identifiers, so the first
proposed fix would not silence it. It is explanatory prose that happens
to contain two modal words. The second fix — prescriptive vs
explanatory — is the one that addresses this hit, and it is the harder
one.

**Measure the split on the corpus before choosing**, per the plan. The
specific thing to count: of all `logic_in_comments` findings across the
corpus, how many sit adjacent to code that *does* encode the rule (the
comment is redundant, not actionable) versus code that does not.

---

## `direct_date`: the narrow signal is real, and the volume is in the wide one

choreograph: 91 findings on `main` (94 at `0.17.0`). The named example,
`src/components/admin/JobDetail.tsx`, reports the evidence string
byte-identically to the notes:

```
9× Date.now(), 4× new Date()
```

and essentially all of it is display formatting. The notes' framing —
time used in a **branch or comparison** is the risky case; time used as
a value to record or display is not — is the right axis. What has not
been measured is how much of the corpus's 91-per-repo volume is which.

That measurement is the first R3 task for this detector, and it is
cheap: classify each hit by whether the `Date` expression flows into a
comparison / conditional, or into a property assignment, template
literal, or format call.

---

## `name_behavior_mismatch`: the shape is a framework idiom, not a repo quirk

`src/lib/api.ts` reports five hits, all with the same evidence:

```
name prefix suggests a read
side-effect-like calls: createClient
3 side-effect signals in the function body
```

`lib/api.ts` (a second copy at the repo root) reports two more with the
identical shape. **Every data-access layer in every Next.js + Supabase
app has this shape**, because `createClient()` constructs the client *in
order to do the read*.

The question for R3 is whether the fix is a `createClient` allowlist
(narrow, and a treadmill — the next framework has a different name) or a
rule about **constructor-like calls whose result is used within the same
function**, which is what actually distinguishes "this `get*` writes
something" from "this `get*` builds the thing it reads through".

The second is the real rule. Measure how many corpus hits it silences
before committing to it — a rule that quiets a whole detector is as
suspect as one that fires on everything.
