# Claims — one type, one claim

`type` names the detector. **`claim` names what the detector alleged.**

Those were the same thing for as long as every detector said exactly one
thing. Eleven do not.

This page is for people adding or changing detectors. If you are
consuming the JSON, read [`json-schema.md`](./json-schema.md#claim); if
you are writing config, read
[`configuration.md`](./configuration.md#disabling-one-claim).

## The failure this prevents

`weak_test_signal` emits two messages:

```
Test "renders the enterprise plan" contains no expect/assert calls.
Test "creates an invoice" only uses weak assertion matchers.
```

Different questions, different answers, different fixes. On a 761-file
TypeScript monorepo it produced 105 findings. A consumer read the first
message, verified three findings of that shape, found all three false —
they asserted through a same-file helper the detector does not follow —
and disabled the type.

That judgement was correct about 38 findings and wrong about 67 others,
which were right and named something worth fixing: 449 instances of
`expect(screen.getBy*(…)).toBeTruthy()`, where the query already throws
if it finds nothing, so the assertion proves nothing the query had not
already proved.

The mistake is one a careful reader makes once. An agent triaging by
`type` makes it every single time — and `crimes` is marketed as built
for agents, so this is the main path.

## The rule

> **The unit a reader can silence must be the unit that carries one
> truth value.**

Triage, suppressions, the baseline and `detectors.disable` all key on
`type` plus fingerprint. So `type` has to mean one thing, or the thing
it means has to be spelled out alongside it.

## What is and isn't a claim

A claim is an assertion with **its own truth value and its own fix**.

| Not a claim | Why |
| --- | --- |
| "1 declaration" vs "3 declarations" | Same statement, different count. |
| "domain function threshold 60" vs "test callback threshold 200" | Same statement ("this function is too long"), different tier. |
| "guard clause" vs "boolean rule" | Same statement about a different subject. |
| A JS and a Python pack wording one statement differently | Same claim. That is `KNOWN_DISAGREEMENTS` territory, not this. |

| A claim | Why |
| --- | --- |
| "asserts nothing" vs "asserts weakly" | You verify them with different questions. |
| "the copies are identical" vs "the copies disagree" | Opposite truth values; the second needs a decision before the first's fix applies. |
| "imported but undeclared" vs "declared but unpinned" | Different failures, different commands to fix. |

The test to apply: **would a reader who confirmed one have confirmed the
other?** If not, they are two claims.

## Declaring claims on a detector

```ts
export const weakTestSignalDetector: LanguageJsDetector = {
  id: "weak_test_signal",
  claims: ["no_assertions", "weak_assertion_matchers"],
  run(ctx) {
    // …
    findings.push({
      type: "weak_test_signal",
      claim: assertions.length === 0 ? "no_assertions" : "weak_assertion_matchers",
      // …
    });
  },
};
```

Claim ids are `[a-z0-9_]+`, unique within the detector, and **stable
across releases** — they appear in users' committed config and
suppression files. Rename one with the same care as renaming the
detector.

Leave `claims` unset when the detector says exactly one thing. Most
should: the majority of detectors carry no claim and keep the
fingerprint shape they have always had.

### Alternatives vs conjunctions

Most multi-claim detectors pick exactly **one** claim per finding — a
test either asserts nothing or asserts weakly, never both. Emit a single
atom.

A few legitimately assert a **conjunction** about one subject.
`config_drift` reports one finding per environment variable listing
everything wrong with it, because a reviewer wants `DATABASE_URL`'s
problems in one place rather than spread across findings that happen to
share a symbol. Those emit a composite, built with `composeClaim`:

```ts
import { composeClaim } from "../claims.js";

claim: composeClaim(issues.map((i) => i.id)),
// -> "type_disagreement+undocumented"
```

`composeClaim` sorts and de-duplicates. That is load-bearing, not
tidiness: if the id depended on the order the checks happened to run in,
an unrelated reordering inside the detector would move every fingerprint
it emits and silently drop every pin against them.

A composite is still one truth value — the conjunction holds exactly
when every atom does. It is **not** a licence to bundle. If a detector's
claims are alternatives, emit atoms, so silencing one cannot silence the
other.

### When two packs share a type

`large_function` is emitted by both the JS and Python packs, and only
the Python side makes the second claim (`deeply_nested`). Both packs
declare and set claims anyway.

Consumers group by `type`, and a labelled finding sitting beside an
unlabelled one under the same type is exactly the ambiguity `claim`
exists to remove — an agent cannot name that group, pass it to
`detectors.disable`, or describe it in a triage note. The rule is
enforced by `detector-claims.test.ts`: for any abstract type, either
every detector emitting it declares claims, or none does.

## What declaring a claim changes

- **The fingerprint** gains the claim on its first segment:
  `weak_test_signal/no_assertions::test/a.test.ts::::renders the plan`.
  It rides on `type` rather than becoming a fifth segment because the
  fourth is the discriminator — opaque detector-chosen text that may
  itself contain `::`, so nothing appended after it can be read back
  out.
- **Pins move.** Every existing suppression, baseline entry, and triage
  disposition for that type stops matching. That is the intent, and the
  same trade `schema_version` 0.4.0 made when it added the
  discriminator: the old pin was recorded when the type meant something
  broader, and it was silencing statements its author never read.
- **`detectors.disable` gains `<id>/<claim>`**, validated against the
  declared list so a typo is rejected at config load rather than
  silently disabling nothing.
- **`crimes triage` walks the findings grouped by `(type, claim)`** and
  names the group, so the run of findings a reviewer generalises over is
  a homogeneous one.

Because pins move, a change here needs its **own release and its own
eval baseline**. Don't bundle it with a scoring change — nothing would
be attributable afterwards.

## The gate

`packages/core/src/detector-claims.test.ts` asserts the declared
registry is well-formed, and `scan.test.ts` asserts the runtime half:
every emitted `finding.claim` is an atom the detector declared. The
declaration would be worth nothing if a detector could emit a claim that
is not in it — `detectors.disable` validates against the declaration and
would reject a selector for a claim that really ships.

If you add a second claim to a detector that had one, the gate will
require you to give the **pre-existing** claim an id too. That is
correct: it changes that claim's fingerprints, and it should, because
pins against it were recorded when the type meant something narrower.
