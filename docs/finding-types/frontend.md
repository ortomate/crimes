# Frontend findings

Since 0.28, `design_token_escape` and `accessible_interaction_risk` are
optional (`detectors.enable`). The former keeps its stable type but its
charge is **Raw Style Concentration**: it counts raw style literals and
size patterns; it does not establish that a design-token system exists.
Inspect project conventions before recommending tokens. Accessibility
remains useful to an explicit UI review but is outside default change-risk
triage. See [configuration](../configuration.md) and [reference](../reference.md).


Frontend findings consume the **JSX inspection layer** that `crimes`
builds during parse. They flag UI-specific risks: hand-rolled values
that escape the design system, interactive elements without a label,
and near-duplicate components that should share a primitive.

For the wire format, see [`docs/json-schema.md`](../json-schema.md).
For the agent workflow that consumes findings, see
[`docs/agent-usage.md`](../agent-usage.md).

## What ships

| `Finding.type`                  | Charge                       | Severity range | Confidence |
| ------------------------------- | ---------------------------- | -------------- | ---------- |
| `design_token_escape`           | Raw Style Concentration          | low-medium     | 0.70-0.85  |
| `accessible_interaction_risk`   | Hidden Interaction           | low-medium     | 0.70-0.85  |
| `duplicate_component_shape`     | Duplicate Component Shape    | low-medium     | 0.75-0.85  |
| `responsive_fragility`          | Responsive Fragility         | low            | 0.65-0.75  |
| `copy_ia_drift`                 | Copy / IA Drift (frontend)   | low-medium     | 0.70-0.80  |

All five emit the standard `Finding` shape. The detectors run only on
files that the parser identifies as JSX-bearing.

`visual_regression_review_hint` shipped in 0.6.0 and was removed in
0.7.5 — its trigger ("file changed many times recently") was a poor
proxy for "needs visual review": active development often means rapid
iteration, not regression risk.

---

## Raw Style Concentration (`design_token_escape`)

**What it detects.** A concentration of raw color literals and pixel-size
values in JSX style expressions. It does not inspect whether the repository
has a token system. The stable detector id remains `design_token_escape`.

**Evidence.** Counts and line locations of observed literals. References to
Tailwind configuration or available tokens are not emitted by this check.

**Why it may help.** Repeated style values can make coordinated visual
changes harder. They can also be appropriate local values. Inspect the
component and project conventions before deciding to consolidate.

**Suggested review.** Reuse existing tokens when they express the same
meaning. Introduce shared definitions only where repeated values represent
a shared design decision; do not create a token system to clear a warning.

---

## Hidden Interaction (`accessible_interaction_risk`)

**What it detects.** JSX elements that handle pointer events
(`onClick`, `onMouseDown`, etc.) but have no accessible label —
typically a `<div>` or `<span>` with handlers and no `aria-label`,
`aria-labelledby`, role, or visible text child.

**Example evidence.**

```text
<div onClick={handlePicker}> at line 47
no children, no aria-label, no role
nearest semantic alternative: <button>
```

**Why it matters.** Interactive elements without a label fail
screen-reader navigation and keyboard interaction. Agents writing
new UI often reach for `<div onClick>` because it's the path of
least resistance; the finding redirects them at write-time rather
than at audit-time.

**Suggested fix.** Use the appropriate semantic element (`<button>`,
`<a>`, `<input type="checkbox">`). If a non-semantic element is
required, add a `role` and `aria-label`, plus `tabIndex={0}` and
keyboard handlers.

---

## Duplicate Component Shape (`duplicate_component_shape`)

**What it detects.** Two or more React components whose JSX bodies
have the same AST hash (modulo whitespace and identifier renaming).
Consumes the same hash index as the `exact_duplicate_block` and
`near_duplicate_block` detectors but scopes the comparison to
component-shaped functions.

**Example evidence.**

```text
identical JSX shape across 3 components
src/ui/Card.tsx (lines 10–48)
src/ui/Tile.tsx (lines 14–52)
src/ui/PanelCard.tsx (lines 8–46)
shared shape: <article><header><h3 /></header>...<footer />
```

**Why it matters.** When three components share a layout, the team
usually meant to extract a primitive and didn't. The next change
(a padding tweak, an a11y fix) gets applied to one and forgotten on
the others, and the divergence locks the duplication in.

**Suggested fix.** Extract a shared `Card` primitive that takes the
specific bits as props or children. The detector counts identical
shape, not identical content — so the primitive doesn't have to be
exhaustive.

---

## Responsive Fragility (`responsive_fragility`)

**What it detects.** Components mixing many breakpoint-specific
utility classes (`sm:hidden md:flex lg:grid-cols-3`) without a
visible breakpoint strategy, or hard-pixel widths (`w-[847px]`) that
won't survive a font-size change.

**Example evidence.**

```text
12 breakpoint-tagged utility classes across 3 elements
lines: 14, 28, 47
hard-pixel measurements: w-[847px], w-[1230px]
```

**Why it matters.** Heavy per-element breakpoint logic is hard to
keep coherent — the next change at one breakpoint silently breaks
another. Hard-pixel widths bypass the type ramp entirely. Both
patterns surface frequently in agent-generated UI that pixel-pushed
its way to "looks right at this zoom".

**Suggested fix.** Move shared breakpoint logic up to a parent that
sets a layout context; let children inherit it. For widths, use the
spacing scale (`w-1/3`, `max-w-prose`) or container queries.

---

## Copy / IA Drift, frontend variant (`copy_ia_drift`)

**What it detects.** Multiple JSX strings naming the same
destination differently — e.g. one nav file using "Members" and a
breadcrumb using "Team". Reads the IA index to confirm the
destinations resolve to the same route.

**Example evidence.**

```text
2 labels for /workspace/members
src/nav/sidebar.tsx:14 → "Members"
src/routes/team/index.tsx:8 (breadcrumb) → "Team"
```

**Why it matters.** Copy drift makes the same area of the product
feel like two different places to users; agents picking up "fix the
copy on Team" can't tell which version is canonical. The detector
surfaces them as a *list* — picking the canonical wording is a
human call.

**Suggested fix.** Pick one canonical label and update all surfaces.
If both labels are legitimate (e.g. the nav label is short, the page
title is long), keep them deliberately and update the
`crimes.config.json` `ia.aliasGroups` entry so they no longer drift-
flag against each other.
