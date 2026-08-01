# Cross-file authority findings

Four detectors that answer one question: **where does this repository
keep the truth about X, and does it keep it in more than one place?**

A rule, a record shape, or a setting with two independently maintained
homes has no mechanism keeping the homes in agreement. Nothing in the
type system checks it, nothing in the test suite checks it, and the
divergence is invisible until a value produced by one half reaches the
other. These detectors find the second home.

They share the **cross-file risk index**, built once per scan in a
single parse pass — see
[`packages/core/src/risk/build.ts`](../../packages/core/src/risk/build.ts).

For the wire format, see [`docs/json-schema.md`](../json-schema.md).
For the agent workflow, see [`docs/agent-usage.md`](../agent-usage.md).

## What ships

| `Finding.type`             | Charge                 | Severity range | Confidence  | Pack         |
| -------------------------- | ---------------------- | -------------- | ----------- | ------------ |
| `duplicated_policy`        | Policy Doppelgänger    | medium-high    | 0.55 - 0.95 | `language-js` |
| `contract_drift`           | Contract Split-Brain   | medium-high    | 0.45 - 0.95 | `language-js` |
| `config_drift`             | Environment Roulette   | low-high       | 0.50 - 0.98 | `language-js` |
| `pass_through_abstraction` | Abstraction Laundering | low-medium     | 0.50 - 0.90 | `language-js` |

---

## `duplicated_policy` — Policy Doppelgänger

### What it detects

The same business rule — authorization, eligibility, validation,
feature gating, pricing, or a state transition — implemented
independently in two or more production locations.

Two shapes are reported:

- **exact clone** — the same rule, normalised, in ≥2 files
- **near-clone family** — several variants of one rule shape that
  differ only in a literal value, in ≥2 files

### Why it matters

A duplicated formatting helper costs nothing when it drifts. A
duplicated authorization rule that drifts means one route enforces a
policy the other does not, and nothing tells you which.

For agents the cost is specific and predictable. Asked to "let team
owners export billing data too", an agent finds the check it was
pointed at, changes it, and reports success. It has no reason to
suspect a second copy exists in a middleware three directories away.
The change looks complete, reviews as complete, and ships half-applied.

### How rules are normalised

A rule is rendered into a canonical form that two independent
implementations agree on.

**Kept**, because they carry the rule:

- comparison and logical operators (`===`, `!==`, `>=`, `&&`, `||`, `!`)
- the **tail** of every property path (`ctx.session.user.role` → `.role`)
- string and numeric literal values verbatim
- callee names (`isAdmin`, `hasPermission`)
- membership tests (`.includes`, `.has`) and their arguments

**Dropped**, because they are naming and layout:

- local identifier names → positional `$0`, `$1`, …
- the root object of a property path (`user` vs `member` vs `actor`)
- whitespace, parentheses, `as` casts, non-null assertions

Dropping the path root is the load-bearing decision. `user.role ===
"admin"` in a route and `member.role === "admin"` in a service are the
same policy under two local names. Keeping the *tail* is what stops the
normalisation collapsing into "any two comparisons match" — `.role ===
"admin"` and `.status === "admin"` stay distinct.

Commutative comparisons are ordered lexically, so `u.plan === "pro"`
and `"pro" === u.plan` normalise identically.

### Example

```ts
// src/routes/export.ts
export async function exportBilling(user, res) {
  if (user.role === "admin" && user.plan !== "free") {
    return res.send(await loadBillingExport(user.tenantId));
  }
  return res.status(403).end();
}

// src/services/entitlements.ts
export function canExportBilling(member) {
  if (member.role === "admin" && member.plan !== "free") {
    return true;
  }
  return false;
}
```

```
duplicated_policy · Policy Doppelgänger · medium (0.88)
  src/routes/export.ts:4

  normalised rule: (("admin" === .role) && ("free" !== .plan))
  2 occurrence(s) across 2 file(s)
  src/routes/export.ts:4 in exportBilling(): user.role === "admin" && user.plan !== "free"
  src/services/entitlements.ts:3 in canExportBilling(): member.role === "admin" && member.plan !== "free"
  shared literal value(s): "admin", "free"
  shared property path(s): user.role, user.plan
  domain vocabulary: admin, member, plan, role, user
  spans 2 layers: routes, services
  each copy is inlined in a different function (canExportBilling, exportBilling)
    rather than delegating to a shared one — no call site links them
  confidence 0.88 = 0.60 base + 0.12 (domain vocabulary: …) + 0.10 (spans 2 layers) + 0.06 (2 distinct enclosing functions)
  severity raised by: authorization rule, billing / pricing rule, spans an architectural boundary
```

### Confidence and severity rules

Confidence starts at **0.60** for an exact clone, **0.55** for a
near-clone family, and rises with:

| signal                              | delta |
| ----------------------------------- | ----- |
| appears in ≥3 files                 | +0.10 |
| domain vocabulary present           | +0.12 |
| spans packages, directories, layers | +0.10 |
| ≥2 distinct enclosing functions     | +0.06 |
| substantial rule (8+ tokens)        | +0.04 |

Severity starts at **0.42** and rises for authorization (+0.18),
billing (+0.14), tenancy (+0.12), ≥3 copies (+0.10), and crossing an
architectural boundary (+0.08).

Every finding carries a `confidence …= … base + …` evidence line, so
the arithmetic is reconstructable.

### False-positive boundaries

- Trivial null and truthiness checks are never extracted.
- Structural comparisons — `items.length > 0`, `count <= 0`, `i < n` —
  are never extracted. A predicate whose only property paths are
  `.length` / `.size` / `.index` and whose only literals are small
  integers is bounds arithmetic, not a rule.
- **A clone with no unambiguously-business vocabulary is never
  reported, at any repetition count.** The gate uses a narrow token
  tier (`role`, `permission`, `plan`, `tenant`, `status`,
  `entitlement`, …) rather than the broader catalogue used for
  confidence, so repetition alone cannot promote a generic predicate
  into a finding.
- Tests, fixtures, migrations, generated, and vendored files never
  contribute occurrences — including any file carrying an
  `@generated` / `DO NOT EDIT` banner regardless of path.
- A rule appearing twice in one file is a local branch, not a split
  source of truth, and is not reported.

### Boundary with `duplicated_role_status_plan_check`

The 0.6.0 detector
[`duplicated_role_status_plan_check`](./duplication.md) owns one
specific shape: the same role / status / plan literal compared with two
or more **different** expressions across **three or more** files.

`duplicated_policy`'s near-clone pass skips pairs matching all three of
those conditions. Everything else is `duplicated_policy`'s: exact
clones (which the older detector cannot report — it requires two
distinct expression shapes), compound predicates, guards, switch
tables, and comparisons on fields the older detector's fixed name list
does not cover. **Neither detector reports the other's territory, so
one crime never produces two findings.**

### What it deliberately does not claim

That the duplication is a bug. Two matching rules may be correct today.
The finding is that they are *independently maintained*.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "duplicated_policy": {
        "minFiles": 2,             // distinct production files required
        "minTokens": 3,            // normalised-token floor
        "reportNearClones": true,  // report one-value variants
        "ignorePaths": ["env"]     // property tails to skip entirely
      }
    }
  }
}
```

### Suggested remediation

Extract one authoritative policy function and have every site call it.
Add a test against the extracted function covering each branch, so a
future change fails loudly rather than applying in one place only.

---

## `contract_drift` — Contract Split-Brain

### What it detects

Two declarations that describe the same record and disagree about it.

### Supported contract forms

| form                  | example                                        |
| --------------------- | ---------------------------------------------- |
| `interface`           | `interface User { id: string }`                 |
| object type alias     | `type User = { id: string }`                    |
| Zod object schema     | `const User = z.object({ id: z.string() })`     |
| Valibot object schema | `const User = v.object({ id: v.string() })`     |

Zod and Valibot are supported because both express optionality and
closed value sets **structurally**, so field-level comparison against a
TypeScript interface is exact rather than inferred. Chained
refinements are walked through, and an explicit `.partial()` is
honoured rather than reported as drift.

**Not supported**, deliberately: JSON Schema, OpenAPI, GraphQL SDL, and
ORM model DSLs. Each is a separate parsing problem in a separate file
format, and a partial reading of any of them would produce confident,
wrong drift reports. Adding one later is additive — the detector
consumes a normalised contract, not the syntax that produced it.

### How two declarations are matched

Both names reduce to a **concept key**. `User`, `UserDTO`, `UserModel`,
`UserSchema`, and `UserEntity` all reduce to `user`. The pair must
additionally share at least 60% of the smaller declaration's fields.

**Projection markers are retained in the key.** `UserSummary`,
`CreateUserInput`, `PublicUser`, `UserRow`, and `UpdateUserRequest` are
all supposed to differ from `User`, so they never pair with it —
reporting them would be reporting the design as a bug. Two declarations
carrying the *same* marker (`UserSummary` and `UserSummaryDTO`) do pair.

### What counts as disagreement

| kind             | example                                 |
| ---------------- | --------------------------------------- |
| `requiredness`   | `email: string` vs `email?: string`      |
| `nullability`    | `deletedAt: Date` vs `Date \| null`      |
| `type`           | `tenantId: string` vs `number`           |
| `enum_members`   | `"admin" \| "member"` vs `+ "owner"`     |
| `nesting`        | flat vs nested object                    |
| `missing_field`  | a **critical** field on one side only    |

`missing_field` is only reported for identifier, tenancy, permission,
money, status, and timestamp fields — and **never** against a
declaration marked `partial` (one that extends, intersects, or spreads
something the scan did not expand), because the field may well be
present via the unexpanded part.

### Example

```
contract_drift · Contract Split-Brain · high (0.95)
  src/contracts/user.ts:5

  A: `User` (interface) — src/contracts/user.ts:5, 6 field(s)
  B: `UserSchema` (zod) — src/repo/user-schema.ts:4, 6 field(s)
  matched because: both names reduce to the concept "user" (`User` / `UserSchema`)
  matched because: 6 shared field(s), 100% of the smaller declaration
  matched because: declared in different forms (interface vs zod), so no type checker compares them
  4 field-level disagreement(s):
    createdAt: A is Date, B is string (type) [timestamp field]
    email: A is required, B is optional (requiredness)
    plan: A is "free" | "pro", B is "enterprise" | "free" | "pro" (value set)
    tenantId: A is string, B is number (type) [identifier field]
  confidence 0.95 = 0.58 base + 0.14 (100% field overlap) + 0.10 (2 disagreements on critical field(s)) + 0.08 (declared in different forms) + 0.05 (both exported)
  severity raised by: disagreement on identifier field / timestamp field, the disagreement is about the field's type, not just its optionality, value sets disagree, declarations are in different files
```

### Confidence and severity rules

Confidence starts at **0.58** and moves with field overlap (+0.14 at
≥85%), critical-field disagreements (+0.10), differing declaration
forms (+0.08), and both sides being exported (+0.05). It is **damped**
when both declarations live in the same file (-0.12, which may be
deliberate) or when either side is `partial` (-0.08).

Severity escalates most for a *type* disagreement on a critical field:
one side will reject values the other legitimately produces. A
requiredness difference on the same field is a smaller problem — both
sides can still represent every value — and is scored separately.

### What it deliberately does not claim

That one side is correct. The finding is that two independently
maintained declarations of one record disagree, and that nothing in the
build checks them against each other.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "contract_drift": {
        "minOverlap": 0.6,          // field-set overlap required to pair
        "minDisagreements": 1,      // disagreements before reporting
        "ignoreNames": ["LegacyUser"],
        "reportRequiredness": true  // optional-vs-required is tunable
      }
    }
  }
}
```

### Suggested remediation

Derive one declaration from the other — `type User = z.infer<typeof
UserSchema>` — so the two cannot disagree again. Where both must exist
independently, resolve the disagreeing fields in one change.

---

## `config_drift` — Environment Roulette

### What it detects

An inventory of every environment read in the repository, and the
variables whose handling disagrees between call sites:

- **type** — parsed as an integer here, compared as a string there
- **default** — two call sites supply different fallbacks
- **requiredness** — one site asserts it must exist, another shrugs
- **unit** — the name implies conflicting units
- **boundary bypass** — a direct read in a repo that has a central
  config module
- **client exposure** — a server-shaped secret behind a
  `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_` / `REACT_APP_` prefix, or read
  from a file that looks browser-reachable
- **undocumented** — used in code, absent from `.env.example`
- **unused** — documented but never read (low severity, opt-in)

Sources read: `process.env`, `import.meta.env`, destructuring
(`const { PORT } = process.env`), and `.env.example` / `.env.sample` /
`.env.template` / `.env.defaults` inventories.

### Values are never reported

Only names, locations, parsers, and **defaults written as literals in
committed source**. A default is a committed constant, visible to
anyone reading the file, and the whole point of the finding is that two
files disagree about it.

A real `.env` is **never opened**. The discovery glob excludes it and a
second, independent filter rejects it — the rule is enforced at
discovery rather than downstream, so a later change cannot quietly undo
it. Every finding carries the line *"no configuration values are
reported by this detector"* so a reader can see the promise.

### Example

```
config_drift · Environment Roulette · high (0.98)
  src/config/index.ts:4  REQUEST_TIMEOUT_MS

  variable: REQUEST_TIMEOUT_MS
  4 read(s) across 3 file(s)
    src/config/index.ts:4 — via process.env, parsed as number, default "5000", not asserted
    src/jobs/notify.ts:2 — via process.env, parsed as boolean, no default, not asserted
    src/services/payments.ts:9 — via process.env, parsed as int, default "30", not asserted
  issue — parsed as different types:
    parsers observed: boolean, int, number
  issue — given different defaults:
    defaults observed: "30", "5000"
  issue — read directly despite a central config module:
    this repo funnels configuration through src/config/index.ts
  no configuration values are reported by this detector — names, locations,
    and literal defaults written in committed source only
```

### False-positive boundaries

- `Number`, `parseInt`, and `parseFloat` are collapsed to one type.
  Reporting them as a type disagreement would flag every codebase that
  uses both spellings.
- A single-file read that is only *undocumented* is a chore, not a
  risk, and is not reported.
- A non-secret public variable (`NEXT_PUBLIC_SITE_URL`) is not
  exposure.
- Boundary bypass is only reported when a central config module was
  actually detected — a module concentrating ≥3 distinct variables with
  a config-shaped filename.

### What it deliberately does not claim

That a bundler will ship a value to the browser. Client reachability is
a path heuristic, and the finding says *"appears to be reachable from
client code"* because proving a bundling outcome needs the bundler.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "config_drift": {
        "reportUndocumented": true,
        "reportUnused": false,          // documented-but-unread; opt-in
        "reportBoundaryBypass": true,
        "ignoreNames": ["CI", "NODE_ENV"],
        "publicPrefixes": ["CLIENT_"]   // project-specific conventions
      }
    }
  }
}
```

### Suggested remediation

Parse each setting once — one module, one coercion, one default, one
unit — and have every consumer import the parsed value. For an exposed
secret, rename to drop the public prefix, read it only on the server,
and rotate the value.

---

## `pass_through_abstraction` — Abstraction Laundering

### What it detects

Two shapes:

- a **chain** of ≥3 wrappers spanning ≥2 files where no layer adds
  anything
- a **cluster** of ≥4 wrappers in one file that all forward to the same
  collaborator

### What it does not detect

**An isolated thin wrapper.** A single function that forwards to
another is how a façade, a port, a compatibility shim, and a
dependency-injection seam are all spelled. Reporting those would be
reporting good design as a defect. The crime is indirection that
*stacks*.

### Why it matters

Each empty layer is a place the behaviour might live and does not.
Finding out what a call actually does means opening every file in the
chain. Deciding where a change belongs becomes genuinely ambiguous — so
two people making the same change pick different layers.

For an agent the cost is measured directly in context window: every hop
is a file read that ends in another forward.

### Example

```
pass_through_abstraction · Abstraction Laundering · medium (0.88)
  src/routes/users.ts:3  createUser

  call chain, 4 layers across 4 files:
    src/routes/users.ts:3 `createUser(…)` → `createUserService(…)` — adds nothing
      src/services/users.ts:3 `createUserService(…)` → `saveUser(…)` — adds nothing
        src/repo/users.ts:3 `saveUser(…)` → `persistUser(…)` — adds nothing
          src/repo/user-store.ts:2 `persistUser(…)` → `db.users.insert(…)` — adds nothing
            ⇒ db.users.insert(…)
  forwarding fidelity: identical
  no layer performs a transformation, applies a default, narrows a type, or
    adds instrumentation — reading the chain end to end yields the same call
    the caller wrote
```

### What counts as "adds something"

A layer that transforms, reshapes, or computes an argument; supplies a
default; narrows a return type with `as` / `satisfies`; or `await`s the
result (which changes the caller's error handling). **A chain where any
layer adds something is never reported.**

### False-positive boundaries

Excluded by path: `adapters/`, `ports/`, `facades/`, `gateways/`,
`shims/`, `compat/`, `public-api/`, `generated/`, and files named
`adapter.ts`, `port.ts`, `facade.ts`, `client.ts`, `sdk.ts`,
`instrumentation.ts`, `telemetry.ts`, `index.ts`. Additional fragments
can be declared via `boundaryPaths`.

Also excluded: recursion (a self-call is not indirection), chains
confined to one file, tests, fixtures, generated, and vendored code.

### Severity

**Low by default.** It rises to medium only when the chain is long
enough that ownership is genuinely obscured — four or more layers, or
four or more files.

### Configuration

```jsonc
{
  "detectors": {
    "options": {
      "pass_through_abstraction": {
        "minChainLength": 3,
        "minChainFiles": 2,
        "minClusterSize": 4,
        "boundaryPaths": ["src/legacy-bridge/"]
      }
    }
  }
}
```

### Suggested remediation

Collapse the empty layers and keep the one boundary that earns its
place. If one layer is a deliberate seam, say so in a comment at that
layer — so the next reader, and this detector, can tell it from the
rest.

---

## Shared infrastructure

All four detectors read the cross-file risk index, and three of them
share two calibration modules worth knowing about:

- **Domain vocabulary**
  ([`domain/vocabulary.ts`](../../packages/core/src/domain/vocabulary.ts))
  — a two-tier catalogue. The *broad* tier raises confidence; the
  *strong* tier gates whether a finding is emitted at all. The
  separation exists because words like `state`, `valid`, `flag`, and
  `total` are useful signals and terrible gates.
- **Confidence ladders**
  ([`scoring/confidence.ts`](../../packages/core/src/scoring/confidence.ts))
  — every score is a base plus named, signed deltas, rendered into
  evidence so a reader can reconstruct the verdict.
- **Scope classification**
  ([`util/scope-class.ts`](../../packages/core/src/util/scope-class.ts))
  — one answer to "is this generated / vendored / a migration / a
  fixture / a test?", so two detectors can never disagree about the
  same file.
