---
"crimes": minor
---

Correctness and authority slate (0.16.0): ten detectors across four families.

**Cross-file authority** — `duplicated_policy` (Policy Doppelgänger) finds the same business rule implemented independently in two or more production locations, including near-clone families that differ by one value; `contract_drift` (Contract Split-Brain) finds two declarations of one record that disagree, reading TypeScript interfaces, object type aliases, Zod, and Valibot.

**False confidence** — `mock_saturation` (Mock Alibi) finds tests that replace every collaborator with a behaviourless double and assert only on those doubles; `swallowed_error` (Catch and Release) finds failures caught and discarded with no propagation and no record.

**Production realism** — `unsafe_retry` (Double Jeopardy) finds retries around mutating operations with no visible idempotency key; `config_drift` (Environment Roulette) finds environment variables handled inconsistently, read past a central config boundary, or exposed to client bundles; `unbounded_async_fanout` (Concurrency Stampede) finds `Promise.all` over runtime-sized collections doing per-element I/O with no bound.

**Agent hygiene** — `dependency_provenance_gap` (Phantom Accomplice) finds imports with no declaring manifest, manifest/lockfile disagreements, and unpinned specifiers, entirely locally with no registry calls; `pass_through_abstraction` (Abstraction Laundering) finds chains and clusters of wrappers that add nothing; `agent_permission_sprawl` (Loaded Agent) finds repository-local agent settings, hooks, and MCP servers that grant unrestricted execution — read as text, never executed.

New shared infrastructure: a one-pass cross-file risk index, a two-tier domain vocabulary, explainable confidence/severity ladders rendered into evidence, and one shared scope classifier. Eight new `language-js` parser surfaces collected in the existing AST walk.

`schema_version` unchanged (`0.3.0`) — new `type` values are additive to a documented-open enumeration. No CLI changes. Existing detector ids, baselines, suppressions, and triage files are unaffected. `duplicated_policy` deliberately cedes the bare role/status/plan divergence shape to the existing `duplicated_role_status_plan_check` so one crime never produces two findings.
