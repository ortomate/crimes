# `crimes explain`

`crimes explain <id-or-fingerprint>` produces a deterministic,
evidence-backed long-form rationale for one finding. Use it as the
rung between **"I see the charge in the scan output"** and
**"I commit to fix or suppress"**.

## When to use

| Question | Command |
| -------- | ------- |
| What does this charge mean? Why does the detector care? | `crimes explain` |
| What should I do about this file as a whole? | `crimes context <file>` |
| Which files are most at risk in this repo? | `crimes scan` |

`explain` is **per-finding**. `context` is **per-file**. They don't
overlap.

## Two input modes

### `--from <scan.json>` (recommended for agents)

```bash
crimes scan -f json > scan.json
crimes explain crime_00005 --from scan.json
```

The scan output is already in the agent's context. `--from` reuses it
instead of re-scanning. The explanation uses the findings from that report.

Either `crime_00005` (per-scan id) or
`large_function::src/billing.ts::generateInvoice` (stable fingerprint)
works. The id only resolves correctly within the same scan; the
fingerprint survives across scans.

### Default mode

```bash
crimes explain large_function::src/billing.ts::generateInvoice
```

No `--from`. The command runs a fresh scan against the cwd, then
looks up the finding. This takes longer than `--from` and needs no saved
report. Use it for a terminal lookup.

Default mode silently includes suppressed findings (annotated as
such). The point of `crimes explain` is to read about a finding the
team has already chosen to live with: running `explain` after
suppressing should still work.

## Output

Human (default):

```
CRIMES EXPLAIN
charge:    God Function
type:      large_function
severity:  high   confidence: 0.95
file:      src/billing.ts
symbol:    generateInvoice
lines:     37–240

What this detector looks for
  Flags functions whose body exceeds a per-shape line threshold …

Why it matters
  Functions this large mix multiple responsibilities into one body. An
  agent editing one section often misses interactions in another …

Evidence
  · lines 37–240 (204 lines)
  · 3.4× the domain function threshold (60 lines)
  · function declaration

Suggested actions
  · extract_function (risk: low)
      Extract cohesive sections into named helpers — start with the
      pure calculations.

Related files
  · src/billing.test.ts
  · src/billing.helpers.ts

To suppress (only if the team has decided this is acceptable)
  crimes ignore large_function::src/billing.ts::generateInvoice --reason "<one-sentence justification>"
```

JSON (`--format json`):

```jsonc
{
  "schema_version": "0.1.0",
  "report_type": "explain",
  "finding": { /* same Finding shape as crimes scan */ },
  "detector": {
    "type": "large_function",
    "charge": "God Function",
    "description": "Flags functions whose body exceeds a per-shape line threshold …"
  },
  "why_it_matters": "Functions this large …",
  "suggested_suppression_command": "crimes ignore large_function::src/billing.ts::generateInvoice --reason \"<one-sentence justification>\""
}
```

See [`json-schema.md`](./json-schema.md#explainreport-output-of-crimes-explain)
for the full schema.

## Determinism

`crimes explain` is fully deterministic: no LLM, no network. Every
string in the output is either:

- already on the finding (`charge`, `evidence`, `suggested_actions`,
  `related_files`)
- baked into the detector at build time (`description`, `why_it_matters`)
- constructed from the fingerprint (`suggested_suppression_command`)

The same input always produces the same output.

## Exit codes

- `0`: success.
- `2`: `--from` file missing or invalid, id/fingerprint did not
  resolve, bad `--format`.

## Agent recipe

The canonical agent flow:

```bash
# 1. Run a scan, save the JSON.
crimes scan -f json > /tmp/scan.json

# 2. Pick a finding to investigate.
jq '.findings[0] | {id, charge, file, symbol, severity}' /tmp/scan.json

# 3. Read the rationale.
crimes explain crime_00001 --from /tmp/scan.json

# 4. Decide: fix the code, or suppress with a reason.
#    The suggested command line is verbatim — copy it and add the reason.
crimes ignore large_function::src/billing.ts::generateInvoice \
  --reason "Legacy billing module — rewrite tracked in #1234."
```

This sequence keeps each step reviewable. The suppression entry
records that the agent considered the rationale before opting to live
with the finding.
