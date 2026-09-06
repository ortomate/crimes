# Dependency findings

Dependency findings consume the **import graph** that `crimes` builds
once per scan. They flag architecture-shaped problems that
file-by-file detectors can't see: cycles, deep cross-package reaches,
modules with too many neighbours, and `architecture.layers` rule
violations.

For the wire format, see [`docs/json-schema.md`](../json-schema.md).
For the agent workflow that consumes findings, see
[`docs/agent-usage.md`](../agent-usage.md).

## What ships

| `Finding.type`           | Charge                  | Severity range | Confidence |
| ------------------------ | ----------------------- | -------------- | ---------- |
| `layer_violation`        | Layer Border Crossing   | medium-high    | 0.85       |
| `circular_dependency`    | Tangled Imports         | medium-high    | 0.90       |
| `deep_import`            | Deep Import Abuse       | low-medium     | 0.70-0.85  |
| `high_fan_in_fan_out`    | Crowded Module          | low-medium     | 0.70-0.80  |

All four use the standard `Finding` shape and add an `imports_limited`
flag to `ScanReport` when the graph hit its performance budget — same
shape as `HotspotsReport.history_limited`.

---

## Layer Border Crossing (`layer_violation`)

**What it detects.** An import that crosses a forbidden boundary in
`crimes.config.json` `architecture.layers` + `architecture.rules`.
The config defines named layers by file glob and explicit
`from → cannotImport` rules; the detector emits one finding per
imported file that violates a rule.

**Example evidence.**

```text
file src/ui/PricingPage.tsx imports src/db/billing.ts
layer "ui" cannotImport from "db"
matching rule: { from: "ui", cannotImport: ["db", "infrastructure"] }
```

**Why it matters.** Architecture rules are usually enforced
informally — a tribal "UI components don't talk to the database"
norm. Coding agents have no access to that norm, so the first edit
that pulls a db query into a component looks reasonable in isolation
and gets merged. Encoding the rule in `crimes.config.json` makes the
boundary review-able.

**Configuration knobs.** `architecture.layers[].name` /
`architecture.layers[].pattern` (glob, e.g. `"src/ui/**"`) and
`architecture.rules[].from` / `architecture.rules[].cannotImport`.
Layers default to "no rules", so adding the section is opt-in. See
[`docs/configuration.md`](../configuration.md).

---

## Tangled Imports (`circular_dependency`)

**What it detects.** Strongly-connected components in the import
graph with ≥ 2 files. A 2-file cycle (`a.ts` ↔ `b.ts`) is flagged at
medium severity; ≥ 3 files at high severity.

**Example evidence.**

```text
2-file cycle: src/billing.ts → src/coupon.ts → src/billing.ts
imports at: billing.ts:14 → coupon.ts; coupon.ts:7 → billing.ts
```

**Why it matters.** Circular imports usually mean the two files
share too much state. Beyond bundler quirks (TDZ errors, hoisting
oddities), the cycle is a code-review smell: every PR that touches
either file has to consider the other. Breaking the cycle into a
shared types module or a one-way dependency makes the relationship
explicit.

**Suggested fix.** Identify the genuinely shared declarations (types,
constants) and move them to a third file both can import. If the
cycle is between sibling modules, consider whether one should own
the other rather than peer with it.

---

## Deep Import Abuse (`deep_import`)

**What it detects.** Imports that reach more than `n` segments deep
into another package's source tree — typically
`@org/pkg/src/internal/util/format`. The detector applies to
workspace-relative imports too.

**Example evidence.**

```text
import path: ../../../../core/src/internal/format
6 segments deep
crosses workspace boundary into packages/core
```

**Why it matters.** Deep imports bypass a package's public surface
and pin the consumer to internal implementation details. The next
refactor of the internal file breaks every consumer that reached in,
even though nothing about the package's public API changed.

**Suggested fix.** Add the function to the package's public
`index.ts` and import it from there. If the function isn't ready to
be public, the import was probably premature — find a cheaper
surface to depend on.

---

## Crowded Module (`high_fan_in_fan_out`)

**What it detects.** Files with unusually high `fan-in` (number of
files importing this one) and/or local `fan-out` (number of resolved local
imports). With at least five graph files, the detector uses the repository's
95th percentile, with a floor of five edges. The 99th percentile has a floor
of eight and can promote the finding to medium. Mostly type-only fan-in stays
low unless fan-out independently warrants promotion. These cutoffs are
currently implementation constants, not configuration options.

**Example evidence.**

```text
fan-out: 5 imports (p95 cutoff: 5, p99: 8)
```

**Why it matters.** Many importers can spread a change; many imports expose
the file to changes in its dependencies. These directions have different
implications. `scores.blast_radius` measures incoming direct/transitive
importers, not the number of dependencies the file imports. A test that
imports five modules and has no importers can have zero blast radius.

**Suggested action.** Read the relevant consumers and dependencies before
editing. Shared hubs and integration tests can be connected by design;
restructuring needs an evidenced problem beyond the edge count. Preserve
useful regression checks. Removing assertions or moving them into a temporary
command solely to clear this finding loses durable coverage. Review and
record intentional connectivity through triage when appropriate.
