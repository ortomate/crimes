# risky-service

An intentionally risky TypeScript service. It is a **fixture**, not a
reference implementation — every file below contains at least one crime
the 0.16.0 detector slate is meant to find, and several contain crimes
that only become visible when two files are read together.

Scan it:

```bash
npx crimes scan examples/risky-service
npx crimes scan examples/risky-service --format json --all
```

## What is planted where

| detector                    | where                                                       |
| --------------------------- | ----------------------------------------------------------- |
| `duplicated_policy`         | `routes/export.ts` + `services/entitlements.ts`              |
| `contract_drift`            | `contracts/user.ts` + `repo/user-schema.ts`                  |
| `swallowed_error`           | `repo/orders.ts`, `jobs/reconcile.ts`                        |
| `unsafe_retry`              | `services/payments.ts`                                       |
| `unbounded_async_fanout`    | `jobs/notify.ts`                                             |
| `mock_saturation`           | `services/payments.test.ts`                                  |
| `config_drift`              | `config/index.ts` + `jobs/notify.ts` + `services/payments.ts` |
| `pass_through_abstraction`  | `routes/users.ts` → `services/users.ts` → `repo/users.ts` → `repo/user-store.ts` |
| `dependency_provenance_gap` | `package.json` (unpinned specifiers, undeclared import)      |
| `agent_permission_sprawl`   | `.claude/settings.json`, `AGENTS.md`                         |

## Interactions worth noticing

- The duplicated entitlement rule in `routes/export.ts` and
  `services/entitlements.ts` disagrees with the plan values the contract
  in `contracts/user.ts` declares — so `duplicated_policy` and
  `contract_drift` are describing two halves of one confusion.
- `REQUEST_TIMEOUT_MS` is parsed three ways across `config/index.ts`,
  `jobs/notify.ts`, and `services/payments.ts`, and the retry in
  `services/payments.ts` depends on it.
- `services/payments.test.ts` mocks away exactly the boundary
  (`unsafe_retry`) that carries the most risk, which is why a green suite
  says nothing about it.
