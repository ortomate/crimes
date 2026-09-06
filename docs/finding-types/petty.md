# Petty Crimes findings

`boolean_naming_drift` and `boolean_naming_drift.py` are optional in 0.28.
Enable them for an explicit naming review with `detectors.enable`; the
default report prioritizes change/agent risk. Other petty detectors keep
their existing defaults. See [generated reference](../reference.md).


Petty crimes flag small codebase irritants that make the next maintainer or
coding agent hesitate, guess, or copy the wrong thing. They are intentionally
smaller than structural crimes and IA crimes: the point is not that one
comment or one misleading name is catastrophic, but that these patterns create
misleading local context.

This page is the long-form reference for the petty finding types shipped on
`main`. For the wire format, see [`docs/json-schema.md`](../json-schema.md).
For the agent workflow that consumes findings, see
[`docs/agent-usage.md`](../agent-usage.md).

## What ships

| `Finding.type`                  | Charge                    | Severity range | Confidence |
| ------------------------------- | ------------------------- | -------------- | ---------- |
| `commented_out_code`            | Commented-Out Corpse      | low-medium     | 0.75-0.90  |
| `logic_in_comments`             | Logic in the Alibi        | low-medium     | 0.55-0.76  |
| `name_behavior_mismatch`        | False Identity            | low-medium     | 0.65-0.86  |
| `magic_domain_literal_scatter`  | String Sprinkles          | low-medium     | 0.66-0.85  |
| `weak_test_signal`              | Test That Proves Nothing  | low-medium     | 0.78-0.88  |
| `option_bag_junk_drawer`        | Option Bag Junk Drawer    | low            | 0.74-0.82  |
| `return_shape_roulette`         | Return Shape Roulette     | low            | 0.73-0.82  |
| `negative_flag_maze`            | Negative Flag Maze        | low            | 0.72       |
| `finder_duplicate_filename`     | Finder Duplicate Filename | medium         | 0.90       |

All emit the existing `Finding` shape. No schema bump is required:
petty crimes are a detector family, not a new severity level or required
field.

---

## Commented-Out Corpse

**What it detects.** Comment blocks or consecutive line comments that appear
to contain disabled source code rather than prose.

**Example evidence.**

```text
5 comment lines
code-like tokens: const, if, await
first code-like line: const legacyRefund = await loadRefund(user.id);
```

**Why it matters.** Dead code in comments is not harmless context. Humans and
agents can copy it, revive it, or preserve it as if it were documentation,
even though it may describe an older implementation.

**Suggested fix.** Delete the disabled code. If the old behaviour matters,
replace it with a short rationale that explains why the active code is shaped
the way it is.

**False-positive notes.**

- JSDoc blocks and `@example` examples are ignored.
- Markdown fenced examples are ignored.
- Short prose comments are ignored; the detector needs enough syntax-like
  evidence to fire.

---

## Logic in the Alibi

**What it detects.** Comments that appear to encode business rules,
operational requirements, temporal coupling, or safety constraints that are
not obviously represented by nearby code.

**Example evidence.**

```text
comment says: "Only owners can refund enterprise plans unless billing support approves."
rule terms: only, unless
domain terms not found nearby: owners, refund, plan
```

**Why it matters.** Prose-only rules are easy to miss. An agent may edit the
function body and never encode the owner/plan/billing constraint because the
rule was not represented as a guard, type, config value, or test.

**Suggested fix.** Move the rule into a named guard, type, config value, or
test. Keep comments for rationale, not as the only source of behavioural
truth.

**False-positive notes.**

- TODO/FIXME/HACK comments are handled by `todo_density`, not this detector.
- Comments whose domain terms appear in nearby guard code are ignored.
- This detector is semantic-adjacent by nature, so summaries use "appears to"
  language and confidence stays modest.

---

## False Identity

**What it detects.** Functions whose names imply safe, read-only, or pure
behaviour while their bodies perform side effects.

**Example evidence.**

```text
name prefix suggests a pure transformation
side-effect-like calls: saveRefundAudit, sendRefundEmail
2 side-effect signals in the function body
```

**Why it matters.** Humans and agents use names to decide whether a function
is safe to move, duplicate, cache, or call in tests. A `calculate*` function
that writes audit records and sends email is easy to misuse.

**Suggested fix.** Rename the function to disclose the side effect, or extract
the pure calculation/read part from the mutation.

**False-positive notes.**

- Names that disclose mutation, such as `getOrCreate*`, are ignored.
- Test files are ignored.
- The detector requires multiple side-effect signals, or one strong domain
  side effect, before it fires.

---

## String Sprinkles

**What it detects.** Domain-looking string literals repeated across three or
more production files and at least two directory areas, unless one occurrence
is already an exported constant.

**Example evidence.**

```text
literal: "enterprise"
appears in 4 production files across src, src/api, src/jobs, src/ui
representative files: src/api/plan.ts:2, src/billing.ts:7, src/jobs/plan-sync.ts:2, src/ui/pricing.ts:2
```

**Why it matters.** Repeated plan, role, status, feature, or billing strings
can indicate duplicated policy, but the same literal may also belong to
intentionally separate legacy or versioned behavior. Inspect the consumers
before deciding whether one definition should own every occurrence.

**Suggested fix.** Reuse an existing definition when the occurrences share
one policy. Keep consolidation separate unless the requested change needs
it, and preserve public and fallback behavior. A repetition finding is not
a requirement to introduce an abstraction during a small behavior edit.

**False-positive notes.**

- Test files, imports, paths, class names, prose, type-union entries, and
  bare catalogue lists are ignored.
- The detector is intentionally cross-file and may populate
  `related_files`.
- It anchors on the first file lexically so the same literal produces one
  finding, not one per file.

---

## Test That Proves Nothing

**What it detects.** `it(...)` / `test(...)` blocks in test files that have
no `expect` / `assert` calls, or only weak matchers such as `toBeTruthy`,
`toBeFalsy`, `toBeDefined`, and snapshots.

**Example evidence.**

```text
test: "loads the billing plan"
0 expect/assert calls
lines 3-5
```

**Why it matters.** Weak tests give humans and agents false confidence. A
test that only runs setup, or only proves a value exists, may not protect the
behaviour an edit is about to change.

**Suggested fix.** Assert observable behaviour, or delete the test if it only
exercises setup.

**False-positive notes.**

- Type-level tests using `expectTypeOf`, `expectAssignable`, or
  `expectError` are ignored.
- The detector reads the actual test callback body, not surrounding
  `describe` blocks.

---

## Option Bag Junk Drawer

**What it detects.** Functions that accept generic object names such as
`options`, `config`, `payload`, `data`, `params`, or `meta` and read six or
more distinct properties from that bag.

**Example evidence.**

```text
parameter: options
6 distinct property reads: currency, locale, plan, region, retry, status
```

**Why it matters.** Broad option bags hide the shape a caller must provide.
Agents can preserve the wrong fields, miss required ones, or pass the bag
through more helpers without understanding ownership.

**Suggested fix.** Replace the generic bag with a named type/object shape, or
destructure only the fields this function owns.

**False-positive notes.**

- Test files are ignored.
- Pass-through-only bags are not flagged yet; local shape evidence is
  required.

---

## Return Shape Roulette

**What it detects.** Functions with three or more object-literal return
shapes, weak key overlap between branches, and no explicit return type.

**Example evidence.**

```text
3 object-literal return shapes
lowest key overlap: 0%
example keys: { id, plan } vs { error, retryable }
```

**Why it matters.** Callers and agents infer the result contract from the
branches they notice first. Divergent anonymous shapes make it easy to miss
an error variant or optional field.

**Suggested fix.** Add an explicit return type or split branch-specific
results into named result variants.

**False-positive notes.**

- Test files are ignored.
- Functions with explicit concrete return types are ignored.

---

## Negative Flag Maze

**What it detects.** `if` / `while` conditions that combine two or more
negative flag names such as `disableBilling`, `skipRetry`, `noCache`, or
`withoutAuth`.

**Example evidence.**

```text
negative flags: disableBilling, skipRetry
condition: !disableBilling && !skipRetry
```

**Why it matters.** Double-negative conditionals are easy to invert during
maintenance. Agents are especially likely to extend the existing condition
instead of extracting a clear positive predicate.

**Suggested fix.** Prefer positive flag names or extract the predicate into a
named helper before extending the condition.

**False-positive notes.**

- Test files are ignored.
- The detector requires negative-sounding names; arbitrary `!value` checks
  are not enough.

---

## Finder Duplicate Filename

**What it detects.** macOS Finder / iCloud conflict-copy filenames that end
with a space and a number before the extension, such as `Button 2.tsx`.

**Example evidence.**

```text
filename ends with Finder conflict suffix: "Button 2.tsx"
likely intended canonical path: src/components/Button.tsx
suffix number: 2
```

**Why it matters.** These files are usually accidental local conflict copies.
Agents and humans then have to guess which file is canonical, or accidentally
edit the suffixed copy.

**Suggested fix.** Compare the suffixed file with the likely canonical file.
If it is accidental, delete it. If both are real, rename one with a
domain-specific name.

**False-positive notes.**

- Versioned names such as `Page2.tsx` and `v2.ts` are ignored.
- The detector requires the Finder-style space before the number.
