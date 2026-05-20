import type { Detector } from "../detector.js";
import type { Finding } from "../finding.js";
import { findJsxElements, walkJsx } from "../jsx/walk.js";
import type { JsxElementInfo } from "../jsx/walk.js";

/**
 * Fires when a JSX file contains a clickable non-button element without
 * accessible labels or keyboard support — `<div onClick={…}>` with no
 * `role`, no `aria-label`, no `tabIndex`.
 *
 * This is not an a11y audit: the detector recognises a narrow shape
 * agents repeatedly produce (a `<div onClick>` because `<button>` was
 * too much rework on the surrounding layout) and surfaces it before
 * the next reviewer has to.
 */
export const accessibleInteractionRiskDetector: Detector = {
  id: "accessible_interaction_risk",
  name: "Accessible Interaction Risk",
  description:
    "Flags clickable non-button JSX elements without `role`, " +
    "`aria-label`, or `tabIndex` — keyboard / screen-reader users " +
    "cannot reach them.",
  whyItMatters:
    "Agents frequently produce `<div onClick={…}>` when the surrounding " +
    "layout would have to be reworked for a `<button>`. The result is " +
    "an interactive element no keyboard user can reach. Surfacing it " +
    "before review lets the team decide whether to fix the markup or " +
    "accept the trade-off explicitly.",

  run(ctx) {
    const elements = walkJsx({ source: ctx.source, ast: ctx.parsed });
    if (elements.length === 0) return [];
    const offending = findJsxElements(elements, isOffending);
    if (offending.length === 0) return [];

    const evidence: string[] = [];
    for (const el of offending.slice(0, 5)) {
      evidence.push(
        `line ${el.lines[0]}: <${el.name}> with onClick has no role / aria-label / tabIndex`,
      );
    }
    if (offending.length > 5) {
      evidence.push(`+${offending.length - 5} more clickable non-button element(s)`);
    }

    const finding: Finding = {
      id: "",
      type: "accessible_interaction_risk",
      charge: "Accessible Interaction Risk",
      severity: "medium",
      confidence: 0.85,
      file: ctx.file,
      summary:
        `${ctx.file} appears to ship ${offending.length} clickable non-button ` +
        `element${offending.length === 1 ? "" : "s"} without accessibility ` +
        "metadata. Keyboard and screen-reader users will not be able to reach " +
        "the interaction.",
      evidence,
      effort: "small",
      fix_shape: "use semantic elements; add ARIA only when semantics don't fit",
      scores: {
        severity: 0.65,
        confidence: 0.85,
      },
      suggested_actions: [
        {
          kind: "switch_to_button_or_add_aria",
          description:
            "Use a `<button>` (or `<a href>`) when the element is " +
            "interactive, or add `role=\"button\"`, `aria-label`, and `tabIndex={0}`.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

const NON_BUTTON_TAGS: ReadonlySet<string> = new Set(["div", "span"]);
const CLICK_ATTRS = ["onClick", "onPress", "onTap"];
const A11Y_ATTRS = ["role", "aria-label", "aria-labelledby", "title", "tabIndex"];

function isOffending(el: JsxElementInfo): boolean {
  if (NON_BUTTON_TAGS.has(el.name)) {
    return hasOnClick(el) && lacksA11yMetadata(el);
  }
  if (el.name === "a" && hasOnClick(el) && !el.attributes.has("href")) {
    return lacksA11yMetadata(el);
  }
  return false;
}

function hasOnClick(el: JsxElementInfo): boolean {
  for (const attr of CLICK_ATTRS) {
    if (el.attributes.has(attr)) return true;
  }
  return false;
}

function lacksA11yMetadata(el: JsxElementInfo): boolean {
  for (const attr of A11Y_ATTRS) {
    if (el.attributes.has(attr)) return false;
  }
  return true;
}
