# Duplication findings

Duplication findings consume the **AST hash index** that `crimes`
builds once per scan. Unlike string-based duplicate detection, the
hash collapses whitespace, identifier renaming, and trivial
reordering, so the detectors find the duplicates a refactor would
actually catch.

For the wire format, see [`docs/json-schema.md`](../json-schema.md).
For the agent workflow that consumes findings, see
[`docs/agent-usage.md`](../agent-usage.md).

## What ships

| `Finding.type`                       | Charge                       | Severity range | Confidence |
| ------------------------------------ | ---------------------------- | -------------- | ---------- |
| `exact_duplicate_block`              | Exact Duplicate Block        | medium         | 0.85-0.90  |
| `near_duplicate_block`               | Near-Duplicate Block         | low-medium     | 0.70-0.80  |
| `duplicated_role_status_plan_check`  | Duplicated Policy Logic      | medium         | 0.80       |

All three emit the standard `Finding` shape and reference each
duplicate location in `evidence`.

> Overlap audit: petty crimes already includes
> `duplicated_navigation_source` and `concept_alias_drift`. The
> duplication detectors here apply to **function bodies** and
> **policy expressions**, not navigation arrays or IA aliases —
> different sources of duplication, different detectors. See
> `.planning/archive/0.6.0-detector-scoring-completion.md` §10.1.

---

## Exact Duplicate Block (`exact_duplicate_block`)

**What it detects.** Function bodies or self-contained statement
blocks with identical AST hashes across two or more locations:
including hash-equivalent forms (whitespace, identifier rename,
reformatted but structurally identical).

**Example evidence.**

```text
identical block across 3 files (hash 9b1d2a4c)
src/api/billing.ts (lines 14–47)
src/api/account.ts (lines 22–55)
src/jobs/sync.ts (lines 8–41)
each block: 34 lines, 8 statements
```

**Why it matters.** Three copies of the same logic is a refactor
that was almost done: usually one team member started it, didn't
finish, and the others copied the older version. Every bug-fix has
to be applied three times; one of them will be missed.

**Suggested fix.** Extract the body into a named function in a
shared module. Where the inputs differ slightly, parameterise them:
the AST hash collapses identifier rename, so the detector already
matched parameter-renames as duplicates.

---

## Near-Duplicate Block (`near_duplicate_block`)

**What it detects.** Function bodies that match by AST hash with
small deltas: typically one extra statement, one branch flipped,
or one parameter substituted. Uses a Jaccard-style similarity over
the hash bag rather than an exact-match equality.

**Example evidence.**

```text
near-duplicate block (similarity 0.87)
src/billing/refund.ts (lines 14–48, 35 statements)
src/billing/cancel.ts (lines 22–62, 38 statements)
delta: 3 statements added in cancel; 1 reordered
```

**Why it matters.** Near-duplicates are where bug-fix-drift lives.
The two bodies started as copy-pastes, then diverged when one was
fixed and the other wasn't. Surfacing them lets the team decide
whether the divergence is meaningful (two genuinely different
behaviours) or a missed sync (one should fold into the other).

**Suggested fix.** Compare the two bodies side-by-side. If the delta
is a feature flag or one branch, extract a shared helper. If the
delta is a fix to one side, port the fix to the other and consider
extracting after.

---

## Duplicated Policy Logic (`duplicated_role_status_plan_check`)

**What it detects.** Conditionals or guard clauses that check the
same domain concept (role / status / plan tier / permission flag)
in multiple files with slightly different shapes. Uses both the AST
hash index and the IA alias groups so `role === 'admin'`,
`user.permissions.admin`, and `isAdmin(user)` count as the same
concept.

**Example evidence.**

```text
3 'role === admin' checks across 3 files
src/api/billing.ts:14 (if (user.role === 'admin'))
src/api/account.ts:8  (if (user.permissions.admin))
src/ui/Settings.tsx:22 (if (isAdmin(user)))
alias group: admin / admin-permission / admin-role
```

**Why it matters.** Policy checks duplicated across files are
where security holes live. The next "give moderators billing
access" change ends up touching one of three places and silently
leaving the others on the old rule. Centralising the check makes
the policy auditable.

**Suggested fix.** Extract a named predicate (`canEditBilling(user)`,
`hasAdminRole(user)`) into a shared policy module. Every call site
imports the predicate; future policy edits happen in one place. The
detector continues to flag if duplicate copies of the *new* helper
appear: by design.
