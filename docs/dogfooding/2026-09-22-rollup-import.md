# Rollup import: 2026-09-22

**Entries:** 54 new of 54 in the rollup
**Recorded by:** dogfood-i (22), dogfood-j (18), dogfood-g (6), dogfood-h (5), dogfood-k (3)
**Produced by crimes:** 0.26.0 (54)
**Verdicts:** fp (54)

Untriaged. These are verdicts other sessions recorded in their own
repos, imported mechanically. A verdict is one reader's judgement, not
an established fact about the detector — read the reasons before acting.
A run of `fp` notes that all say the same thing is the signal worth
chasing; a single `fp` usually is not.

## By detector

| Detector | Entries | Repos |
| --- | --- | --- |
| `direct_date` | 11 | 2 |
| `swallowed_error` | 9 | 4 |
| `high_fan_in_fan_out` | 8 | 1 |
| `config_drift` | 5 | 2 |
| `magic_domain_literal_scatter` | 4 | 3 |
| `duplicated_policy` | 2 | 2 |
| `duplicated_role_status_plan_check` | 2 | 2 |
| `large_file` | 2 | 1 |
| `name_behavior_mismatch` | 2 | 1 |
| `hardcoded_localhost` | 1 | 1 |
| `logic_in_comments` | 1 | 1 |
| `near_duplicate_block` | 1 | 1 |
| `option_bag_junk_drawer` | 1 | 1 |
| `orphaned_destination` | 1 | 1 |
| `return_shape_roulette` | 1 | 1 |
| `sync_io_in_hotpath` | 1 | 1 |
| `unsafe_retry` | 1 | 1 |
| `weak_test_signal` | 1 | 1 |

## The reasons

Paraphrased per detector. The original entries named files, symbols and
services in private repositories and are not reproduced here; the
anonymised repo labels match the counts above.

### `direct_date` (11)

Nine say a request, server-action, render or cron boundary captures one
instant and injects it inward, so the domain code never reads the clock
and is tested with a fixed instant. Two say the `Date` was built from an
injected or validated value, not read from the wall clock.

### `swallowed_error` (9)

Four say the catch fails closed on untrusted input (malformed model
JSON, signed state, a cookie), and that logging the payload would itself
be attacker-controlled noise. Two say telemetry is deliberately best
effort after the authoritative write. Three say the failure is not
swallowed at all: it is classified, persisted, rethrown or returned as a
typed failure.

### `high_fan_in_fan_out` (8)

All eight, from one branch: adding a module moved the repo's percentile
cutoff, so files the branch never touched became "new".

### `config_drift` (5)

Two say a provider's publishable or anon key is a public browser key by
design. One says `NODE_ENV` is set by the runtime. Two say a value is an
ephemeral credential exported by a test wrapper and must not be
documented in `.env.example`.

### `magic_domain_literal_scatter` (4)

A shared field name (`status`, `processed`, an owner column) used by
unrelated state machines, not one policy repeated.

### `duplicated_policy` (2)

The same: two status checks with similar syntax belonging to unrelated
provider contracts or state machines.

### `duplicated_role_status_plan_check` (2)

One finding on a file the branch did not modify. One grouped
`Promise.allSettled`'s `status === "rejected"` with a product status.

### `large_file` (2)

Generated data fixtures, not code modules.

### `name_behavior_mismatch` (2)

`createHash(…)` and `ts.createSourceFile(…)` build values in memory; no
side effect.

### Single reports

- `hardcoded_localhost`: a development fallback behind a production throw.
- `logic_in_comments`: the comment explains a guard the code enforces.
- `near_duplicate_block`: hoisted test-mock registries for unrelated
  boundaries.
- `option_bag_junk_drawer`: a named, destructured config interface.
- `orphaned_destination`: a route's sibling `.test.ts` read as a route.
- `return_shape_roulette`: a declared discriminated-union return type
  the detector did not see.
- `sync_io_in_hotpath`: a one-shot CLI script, never on a server path.
- `unsafe_retry`: idempotency enforced by a unique index.
- `weak_test_signal`: assertions in an async callback spanning several
  lines.
