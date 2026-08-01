# Correctness-risk findings

Four detectors covering code that is **correct today and unsafe on a
bad day**: a failure that leaves no trace, a retry that replays a
write, a fan-out that scales with the data, and a test that stays green
regardless.

None of these is a bug the type checker can see, and none is a bug the
test suite will catch — in one case because the test suite is the
problem.

All four are **file-local**: they read the parsed file and nothing
else, so they work on a single-file `crimes context` run as well as on
a full scan.

For the wire format, see [`docs/json-schema.md`](../json-schema.md).

## What ships

| `Finding.type`           | Charge               | Severity range | Confidence  | Pack          |
| ------------------------ | -------------------- | -------------- | ----------- | ------------- |
| `swallowed_error`        | Catch and Release    | low-high       | 0.45 - 0.95 | `language-js` |
| `unsafe_retry`           | Double Jeopardy      | medium-high    | 0.45 - 0.95 | `language-js` |
| `unbounded_async_fanout` | Concurrency Stampede | low-high       | 0.50 - 0.90 | `language-js` |
| `mock_saturation`        | Mock Alibi           | low-high       | 0.50 - 0.95 | `language-js` |

---

## `swallowed_error` — Catch and Release

### What it detects

A handler swallows when it neither **propagates** the failure nor
**records** it. Concretely:

- an empty or comment-only `catch`
- `.catch(() => {})` and `.catch(noop)`
- a `catch` returning `null` / `undefined` / `false` / `0` / `""` /
  `[]` / `{}` without first inspecting the error
- a discarded rejection: `doThing().catch(() => {})` as a statement, or
  behind `void`
- a handler that logs a message but **never passes the error**, losing
  the stack, the cause chain, and the error code

### Complete defences

Any one of these means nothing is reported:

- **rethrow**, including `return Promise.reject(e)`
- **a typed result** — `return { ok: false, error: e }`. Nothing was
  lost; the caller can still branch on it. Both halves are required: a
  discriminant (`ok` / `success` / `status` / `type`) *and* a carrier
  (`error` / `err` / `reason` / `cause`).
- **observability with the error attached** — any call whose method
  name is observability-shaped (`log`, `warn`, `error`,
  `captureException`, `recordException`, `reportError`, `notify`, …)
  that receives the error value. **No specific library is required.**
- **error discrimination** — `e.code === "ENOENT"`,
  `e instanceof NotFound`, `isFooError(e)`. Inspecting the error and
  recovering from a specific case is precise error handling.

### Down-ranked, not silenced

Severity and confidence both drop when the suppression is *documented*:

- a comment matching best-effort / fire-and-forget / non-critical /
  cleanup / "not fatal" / "safe to ignore"
- an enclosing function named for cleanup (`teardown`, `dispose`,
  `shutdown`, `close`, `abort`, …)
- an enclosing function that **announces** failure tolerance in its own
  name: `safelyBuildIndex`, `tryParse`, `maybeReadConfig`,
  `readOrNull`. The author declared the contract in the signature and
  every caller reads it there.
- `.catch(noop)` — a named no-op is a deliberate choice, and is
  reported as such rather than as an anonymous discarded rejection

### Severity escalation

Escalates with the consequence of the protected operation, matched
against the callee names inside the `try`:

| boundary                       | delta |
| ------------------------------ | ----- |
| payment                        | +0.35 |
| database write                 | +0.28 |
| authentication / authorization | +0.28 |
| queue publish                  | +0.24 |
| state transition               | +0.20 |
| file write                     | +0.14 |
| external request               | +0.10 |

### Example

```ts
export async function persistOrder(order) {
  try {
    await db.orders.insert(order);
  } catch (e) {}
}
```

```
swallowed_error · Catch and Release · medium (0.92)
  src/repo/orders.ts:5  persistOrder → insert

  protected operation: await db.orders.insert(order);
  calls inside the protected region: db.orders.insert
  handler kind: try/catch (line 5)
  what happens to the failure: the handler body is empty
  boundary: database write (matched on `db`) — a silent failure here does not
    surface until something downstream is missing
  missing signal: no rethrow or rejected promise; no logging, telemetry, or
    error-wrapping call; no typed error result the caller could branch on;
    the error is never inspected
```

### False-positive boundaries

- Test files never fire. Tests catch deliberately and constantly.
- Generated and vendored code never fires.
- A handler doing something the collector does not recognise is
  **silent** — reporting "we could not tell what this does" is noise.

### Fingerprint stability

`Finding.symbol` is `<enclosing> → <first protected call>`, e.g.
`readManifest → readFile`. A function with two `try` blocks therefore
produces two findings with distinct fingerprints, rather than one
fingerprint that every downstream surface would treat as a single
finding.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "swallowed_error": {
        "reportLogWithoutError": true,
        "reportFallbackReturns": true,
        "treatCommentAsIntent": false,
        "allowedFunctions": ["shutdown", "drainQueue"]
      }
    }
  }
}
```

### What it deliberately does not claim

A logging convention. It recognises any observability-shaped call that
receives the error, and does not tell you which library to use.

---

## `unsafe_retry` — Double Jeopardy

### What it detects

A retry construct wrapping potentially-mutating work with **no
idempotency or deduplication key visible**.

### The primary crime

Retrying is a bet that the first attempt did not take effect. For a
read the bet costs nothing. For a write it is a coin flip: a request
that timed out *after* the server committed it will be replayed, and
the customer is charged twice, the order ships twice, or the queue
receives a duplicate nothing downstream expects.

**The absence of an idempotency signal around a retried mutation is the
finding.** Everything else — no bound, no backoff, no jitter, no error
classification — appears as *supporting evidence on the same finding*
rather than as separate ones. They are symptoms of the same unreviewed
retry, and four findings for one construct would be four times the
noise for none of the extra signal.

### Recognised retry constructs

| kind         | recognised by                                              |
| ------------ | ---------------------------------------------------------- |
| `loop`       | a `for`/`while`/`do` header naming an attempt counter, or a body that catches and `continue`s |
| `helper`     | `retry`, `withRetry`, `pRetry`, `backOff`, `promiseRetry`, `asyncRetry`, … |
| `recursion`  | a function calling itself from inside its own `catch`       |
| `sdk_config` | `maxRetries` / `retries` / `retryStrategy` in an options object, including `new Client(key, { maxRetries: 3 })` |

A bare `for (const x of xs)` is **not** a retry. `retries: 0` disables
retrying and is not reported.

### Recognised mutations

- HTTP `POST`, `PUT`, `PATCH`, `DELETE` — via `fetch(url, { method })`
  or `axios.post` / `client.put` / `http.delete` shapes
- a callee whose name carries a write-shaped word: `create`, `insert`,
  `update`, `upsert`, `delete`, `save`, `publish`, `enqueue`, `send`,
  `charge`, `transfer`, `commit`, …

A call matching neither is treated as a **read**, which is the
conservative default: over-reporting would flag every codebase that
owns a retry helper.

### Recognised safeguards

Inventoried and reported even when the finding fires, so a reader sees
what *is* in place: idempotency key, transaction, bounded attempts,
delay/backoff, jitter, error classification, timeout/cancellation.

An idempotency key is recognised from an identifier or option key
matching `idempoten*`, `dedup*`, `requestId`, `clientToken`, `nonce`,
`correlationId`, `messageId`, `transactionId`, `externalId`, or from an
`Idempotency-Key` / `X-Request-Id` header literal.

By default a **transaction is not** sufficient: it makes one attempt
atomic, it does not make a *replay* safe. `transactionCountsAsIdempotent`
opts into treating it as sufficient.

### Example

```
unsafe_retry · Double Jeopardy · high (0.92)
  src/services/payments.ts:12  submitPayment → post

  retry construct: attempt loop: for (let attempt = 0; attempt < 3; attempt++) (line 12)
    retried mutation — api.post at line 15 (HTTP POST)
  boundary: payment (matched on `payment`) — a duplicate here is visible to the
    customer, not just to the logs
  safeguards visible at this site:
    bounded attempt count: loop bounded at 3 attempt(s)
  missing safeguard (primary): no idempotency or deduplication key — nothing lets
    the receiver recognise a replayed attempt as the same operation
  also absent: error classification, delay, jitter, timeout, transaction
  attempt bound: 3
```

### What it deliberately does not claim

That the operation is not idempotent. A dedup key computed three files
away is invisible to a static reader, and the finding says so: it
reports that **no idempotency signal is visible at this call site**,
which is a statement about reviewability as much as about correctness.
An SDK documented as idempotent is respected via `idempotentCalls`.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "unsafe_retry": {
        "transactionCountsAsIdempotent": false,
        "reportDelete": true,
        "mutatingCalls": ["ledger.append"],   // project-specific writes
        "idempotentCalls": ["cache.set"]      // known-safe replays
      }
    }
  }
}
```

---

## `unbounded_async_fanout` — Concurrency Stampede

### What it detects

`Promise.all` / `Promise.allSettled` over a runtime-sized collection,
where the callback does expensive per-element work and no bound is
visible.

### Why it is a change-risk finding, not a perf nit

The code is correct. It passes review, passes tests, and works in every
environment where the collection is small. Then a backfill runs, or a
customer with 40 000 rows signs up, and the same line opens 40 000
sockets at once. The failure lands on the *dependency* — connections
exhausted, rate limits, file descriptors — so the stack trace points
somewhere other than the cause.

What makes it a **change** risk is that nothing about the line changes
when the danger arrives. The collection got bigger somewhere else.

### Required signals — all three

1. The collection is **not statically sized** (not a small array
   literal; the bound is 8 by default).
2. The callback does something **expensive** per element — network,
   database, filesystem, subprocess, or queue work.
3. **No bound is visible** — no `.slice()` / `.take()`, no
   `take` / `limit` / `first` / `pageSize` option on the producing
   query, no batching helper, no concurrency-limit library, no
   `concurrency` option.

A pure transform over a large array is not reported: `Promise.all` over
ten thousand already-resolved values is fine.

### Collection-source resolution

The detector resolves a bare identifier one hop back to its binding, so
the canonical shape reads correctly:

```ts
const orders = await db.orders.findMany();   // ← resolved
return Promise.all(orders.map((o) => api.post("/notify", o)));
```

Without that, the most common real-world fan-out would classify as an
opaque parameter. The resolution is scope-lite — it does not track
reassignment or shadowing — and is treated as a hint that raises
confidence, never as proof.

### Example

```
unbounded_async_fanout · Concurrency Stampede · medium (0.88)
  src/jobs/notify.ts:11  notifyEveryone → post

  fan-out: Promise.all at line 11
  collection: orders (← await db.orders.findMany()).map(…)
  collection source: an awaited call (query, request, or listing)
  produced by: db.orders.findMany
  per-element work (1):
    network request — api.post at line 12
  no bound visible: no `.slice()` or `take`/`limit` on the source, no batching,
    no concurrency-limit helper, no semaphore
  if the collection holds N elements, N concurrent network request start at
    once — N is a property of the data, not of this code
```

### What it deliberately does not claim

That the collection *is* large. A static reader cannot know. The
finding is that nothing in the code bounds it, and that the size is
therefore a property of the data rather than of the program.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "unbounded_async_fanout": {
        "staticallySmall": 8,
        "reportUnclassifiedWork": false,
        "boundedHelpers": ["mapWithLimit"]
      }
    }
  }
}
```

---

## `mock_saturation` — Mock Alibi

### What it detects

A test that replaces most or all of its collaborators with
behaviourless doubles and then asserts **only on those doubles**.

Such a test says: "when I call the function, it calls the thing I
replaced with a thing that does nothing, with the arguments I
expected." That is a restatement of the implementation, not a check on
it. It passes before and after a refactor that breaks production, and
it fails whenever the implementation is improved without changing
behaviour — the exact opposite of what a test should do.

### This is not "mocks are bad"

Mocks are how you make a unit test fast and deterministic. A focused
test that mocks a clock and asserts a returned value is excellent. The
detector requires a **combination**:

- most collaborators replaced (default: ≥80%), **and**
- at least one replacement is *hollow* — a factory of bare `vi.fn()` /
  `jest.fn()` with no implementation, or an auto-mocked module — **and**
- **every** assertion is a mock interaction

Any one of those alone is normal. Together they mean the test cannot
observe behaviour, because there is no behaviour left to observe.

### Assertion categories

| category           | examples                                            | counts as behaviour? |
| ------------------ | --------------------------------------------------- | -------------------- |
| `mock_interaction` | `toHaveBeenCalled`, `toHaveBeenCalledWith`, `calledOnce` | no               |
| `value`            | `toBe`, `toEqual`, `toMatchObject`, `deepStrictEqual`    | **yes**          |
| `error`            | `toThrow`, `rejects`, `throws`                           | **yes**          |
| `truthiness`       | `toBeTruthy`, `toBeDefined`, `ok`                        | no                   |
| `snapshot`         | `toMatchSnapshot`                                        | no                   |
| `type`             | `toEqualTypeOf`                                          | no                   |

`truthiness` is deliberately excluded: `expect(x).toBeDefined()` after
a mocked call proves the mock returned, not that the code worked. A
snapshot of mock output is a snapshot of the mock.

### The collaborator ratio

The denominator is the union of (production modules the test imports,
**excluding the subject**) and (modules the test mocks by specifier).
The subject is what is being tested, not a collaborator — counting it
would cap a fully-saturated two-import test at 50%.

Test infrastructure (`vitest`, `jest`, `sinon`, `chai`, `msw`, …) and
Node built-ins never count toward saturation. Mocking a clock is
hygiene, not an alibi.

### Frameworks recognised

Vitest (`vi.*`), Jest (`jest.*`), Sinon (`sinon.*`), and `node:test`
(`mock.*`). They differ in spelling and agree in structure, so one
collector covers all four.

### Severity escalation

Rises when the doubles stand in for consequential boundaries —
persistence, payment, authorization, queues — because those are where
"it called the right function" and "it did the right thing" diverge
most expensively. Rises furthest when **the subject itself is mocked**,
which means the code the test is named for never runs.

### Example

```
mock_saturation · Mock Alibi · medium (0.90)
  src/services/payments.test.ts:10  submitPayment › posts the charge

  test case: "submitPayment › posts the charge" (lines 10-14)
  subject under test: ./payments.js
  mocked collaborators (2): ../lib/api.js (no implementation), ../lib/stripe.js (no implementation)
  100% of this test's collaborators are replaced by doubles (the subject itself
    is excluded from the count)
  mocked boundaries: external request, payment
  assertion categories observed: mock_interaction (2 mock-interaction, 0 behavioural)
    line 12: toHaveBeenCalled → mock_interaction
    line 13: toHaveBeenCalledWith → mock_interaction
  every assertion inspects a double's calls or arguments; none inspects a value,
    state change, or error the subject produced — so a behaviour change that
    keeps the same call shape cannot fail this test
```

### Boundary with `weak_test_signal`

A test case with **no assertions at all** is
[`weak_test_signal`](./petty.md)'s crime, not this one.
`mock_saturation` requires at least one assertion, all of them
interaction-only. Emitting both would be two findings for one problem.

### Suggested remediation

Deliberately **additive**. The recommendation is never "remove the
mocks":

1. Keep this test, and add an assertion on something the subject
   produces — a returned value, a thrown error, a state change.
2. Add one integration or contract test that exercises the riskiest
   mocked boundary for real; an in-memory or containerised substitute
   is enough.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "mock_saturation": {
        "minMockedRatio": 0.8,
        "minMockedCollaborators": 2,
        "reportInteractionOnlyTests": false,
        "alwaysAllowedMocks": ["./clock.js"]
      }
    }
  }
}
```

### Churn integration

Where git history is available, the scoring pass already folds `churn`
and `test_gap` into every finding's `agent_risk`, so a mock-saturated
test over a hot file ranks above one over a stable file. **Git history
is not required** for the detector to function.
