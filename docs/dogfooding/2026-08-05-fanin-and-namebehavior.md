# `high_fan_in_fan_out` and `name_behavior_mismatch`: R3 items 3 and 4

Both re-verified against `main` before anything was touched — see
[the Step 0 pass](./2026-08-05-choreograph-reverify.md) — and both
[pre-measured](./2026-08-05-r3-premeasurements.md) before a line was
changed, which is what stopped item 3 shipping the wrong rule.

---

## `high_fan_in_fan_out`: the notes' rule would have been a no-op

**Complaint:** "`src/lib/types.ts` flagged at 33 importers. High fan-in
is a shared types module's entire job. Consider **exempting modules
whose exports are type-only**."

**Measured before implementing:** that file exports **24** interfaces
and **one** `const` (`JOB_STUCK_THRESHOLD_SECONDS`). An
exports-are-type-only test fails on the exact file the complaint is
about — and would silently re-arm the moment anyone added a constant to
any types module. A rule a single line defeats is a rule that quietly
stops working.

**What shipped instead** uses a signal that was already in the import
graph and that this detector had never consulted: `ImportEdge.typeOnly`.
On that file, **32 of 33 importers write `import type`**.

The threshold is 80%, not 100%, for the same reason the exports rule
failed: a types module routinely exports a constant or two alongside its
declarations.

### What moves is the judgement, not the evidence

The finding is **not** suppressed and the count is **not** adjusted:

```
fan-in: 33 importers (p95 cutoff: 6, p99: 30)
32 of 33 importers take types only — a shared type module's coupling is
compile-time, and being depended on is its job
```

Only the p99 promotion is withheld, so the file no longer competes with
runtime hubs for the top of the report. "33 importers, 32 of them
type-only" is a fact worth having on an audit run, and `CLAUDE.md` says
evidence before judgement.

The reasoning behind the demotion, stated so it can be argued with: the
coupling is real, and it is **compile-time**. Change an interface and
every importer fails to build — loudly, immediately, before anything
ships. That is a different risk from a runtime hub, and ranking them
together is what made this read as a category error.

### Measured

| | before | after |
|---|---|---|
| choreograph `high_fan_in_fan_out` | 36 | **36** |
| medium | 8 | **7** |
| low | 28 | 29 |

One file moves: `src/lib/types.ts`, `medium → low`.

**One eval fixture moves**, and it is the right one:
`04-monorepo`'s `src/plugin.ts`, `medium → low`. Nine of its ten
importers write `import type { Plugin }`; only `index.ts` takes a value
(`PluginContainer`). That is a plugin-contract module, and the
demotion is correct rather than incidental.

---

## `name_behavior_mismatch`: building the thing you read through

**Complaint:** "`getChoreoByDate() → calls createClient` — flagged five
times in `api.ts` alone, because a `get*` function makes a
'side-effect-like call'. But `createClient()` is constructing the client
in order to *do the read*. Every data-access layer in every Next.js app
has this shape."

The shape, verbatim from the repo:

```ts
export async function getChoreoByDate(person: string, date: string) {
  const supabase = await createClient()
  const { data, error } = await supabase.from('choreograph_posts')…
```

The result is bound, then dereferenced. A `create*` called for its
*effect* — `await createOrder(cart)` — has no such follow-up: the return
value is returned, discarded or destructured, never used as a receiver.

So the rule is that **shape**, not a `createClient` allowlist. An
allowlist is a treadmill — the next framework names it `getConnection`,
`makePool`, `initSupabase` — and it would bake one ecosystem's
vocabulary into a detector that is supposed to be about naming in
general.

### The first version of the rule was too broad, and the corpus said so

Bound-and-dereferenced alone silently dropped a **real** finding in
`src/lib/integrations/google-oauth.ts`:

```ts
const res = await fetch(url, { method: 'POST' })
const json = await res.json()
```

That fits the shape exactly, and a network call is a side effect
whatever you do with the response. The callee now has to *look* like a
constructor — `/^(?:create|make|build|init|connect|open)[A-Z_]/` — which
is what "factory" means. Anchored and requiring a capitalised
remainder, so `create` matches `createAdminClient` but not `created`.

Only the factory call is discounted. A `get*` that builds a client
**and** deletes a row still reports, with a standing test.

### Measured

| | before | after |
|---|---|---|
| choreograph `name_behavior_mismatch` | 19 | **7** |
| choreograph total findings | 491 | 475 |

All **12** removals are `createClient` / `createAdminClient` — the
complaint exactly, across `src/lib/api.ts` (5), `lib/api.ts` (2),
`integrations/store.ts`, `notify/emails.ts`, `collectors/location.ts`,
`collectors/apple-health.ts` and one script.

Everything kept is a genuine effect: `fetch` in the OAuth handler,
`createElement`/`setAttribute` DOM building, `insertAdjacentHTML`, and
three React `set*` state writers.

**No eval fixture moves.**

### One known false positive left, out of scope

`scripts/_backfill-song-type.ts` reports `setUTCDate` — a `Date` mutator
caught by the `set[A-Z]` pattern. That is a different defect (the
side-effect regex not knowing built-in methods) and tuning it in the
same change would break the one-at-a-time rule. Recorded, not fixed.

---

## Eval baseline

**One fixture moved**, so this group gets a real run rather than the
"fixtures provably unmoved" argument used for `logic_in_comments` and
`direct_date`. Run from a dedicated worktree, per the rule `0.18.0`
bought the hard way.
