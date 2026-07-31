import type { LanguageJsDetector, PerFileDetectorContext } from "../detector.js";
import { ACTION_GROUPS, analyse } from "./action-label-drift.js";

/**
 * Frontend-restricted variant of `action_label_drift`. Inputs are
 * limited to JSX label literals (text inside elements like `<Button>`,
 * `<NavLink>`, breadcrumb labels) — string-valued props elsewhere in
 * the codebase don't contribute. The two detectors share the same
 * grouping logic via `analyse(...)` so the heuristic stays in sync.
 *
 * Both detectors can fire on the same area; the action-label-drift
 * variant is broader (label + nav signals) while this one targets the
 * pure UI-copy surface.
 */
export const copyIaDriftDetector: LanguageJsDetector = {
  id: "copy_ia_drift",
  name: "Copy / IA Drift",
  description:
    "Flags inconsistent UI copy where the same action is labelled with " +
    "different verbs across JSX text nodes.",
  whyItMatters:
    "When the UI copy for one action drifts across views, users see " +
    "three different labels for the same intent. Agents extending one " +
    "view pick whichever word fits locally and quietly add a fourth.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];
    if (!isPrimaryAnchor(ctx)) return [];
    return analyse(
      ctx.ia,
      ACTION_GROUPS,
      "copy_ia_drift",
      "Copy / IA Drift",
      "pick the canonical label; redirect copies to it",
      { restrictToJsxLabel: true },
    );
  },
};

function isPrimaryAnchor(ctx: PerFileDetectorContext): boolean {
  if (!ctx.ia) return false;
  const files = Object.keys(ctx.ia.files).sort();
  return files.length > 0 && files[0] === ctx.file;
}
