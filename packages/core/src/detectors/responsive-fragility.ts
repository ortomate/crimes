import type { Detector } from "../detector.js";
import type { Finding } from "../finding.js";
import { findJsxElements, walkJsx } from "../jsx/walk.js";
import type { JsxElementInfo } from "../jsx/walk.js";

/**
 * Fires when a JSX file's style expressions contain fixed pixel widths,
 * large pixel font sizes, or hard-coded grid templates without nearby
 * media-query handling — heuristics that flag UI likely to break on
 * narrow viewports.
 */
export const responsiveFragilityDetector: Detector = {
  id: "responsive_fragility",
  name: "Responsive Fragility",
  description:
    "Flags JSX with fixed widths, large pixel font sizes, or hard-" +
    "coded grid templates without responsive handling — the most " +
    "common shapes that break on mobile.",
  whyItMatters:
    "Fixed widths and pixel-sized typography quietly fail at small " +
    "viewports. Agents extending the page rarely test below desktop, " +
    "and the regression only shows up when a customer screenshots a " +
    "broken layout.",

  pack: "language-js",
  run(ctx) {
    const elements = walkJsx({ source: ctx.source, ast: ctx.parsed });
    if (elements.length === 0) return [];
    const targets = findJsxElements(elements, (el) =>
      el.attributes.has("style") || el.attributes.has("className"),
    );
    if (targets.length === 0) return [];

    const hits: FragilityHit[] = [];
    const hasMediaQuery = ctx.source.includes("@media");

    for (const el of targets) collectFragilityHits(el, hits, hasMediaQuery);
    if (hits.length < 3) return [];

    const evidence: string[] = [
      `${hits.length} responsive-risk style value${hits.length === 1 ? "" : "s"}`,
    ];
    for (const hit of hits.slice(0, 5)) {
      evidence.push(`line ${hit.line}: ${hit.reason}`);
    }
    if (hits.length > 5) {
      evidence.push(`+${hits.length - 5} more value(s)`);
    }
    if (!hasMediaQuery) {
      evidence.push("no `@media` query found in the file");
    }

    return [
      {
        id: "",
        type: "responsive_fragility",
        charge: "Responsive Fragility",
        severity: "low",
        confidence: 0.65,
        file: ctx.file,
        summary:
          `${ctx.file} contains ${hits.length} fixed-size style value` +
          `${hits.length === 1 ? "" : "s"} that likely break at small ` +
          "viewports. Add responsive alternatives or convert to fluid units.",
        evidence,
        effort: "small",
        fix_shape: "drive layout from container queries or a fluid scale, not pixel media queries",
        scores: {
          severity: 0.4,
          confidence: 0.65,
        },
        suggested_actions: [
          {
            kind: "make_responsive",
            description:
              "Replace fixed widths with `max-width` plus `width: 100%`; use " +
              "`clamp()` / `rem` for typography; add `@media` queries for grid " +
              "templates that need to collapse on mobile.",
            risk: "low",
          },
        ],
      },
    ];
  },
};

interface FragilityHit {
  reason: string;
  line: number;
}

function collectFragilityHits(
  el: JsxElementInfo,
  hits: FragilityHit[],
  hasMediaQuery: boolean,
): void {
  const style = el.attributes.get("style");
  if (style && style.kind === "expression") {
    scanStyle(style.source, el.lines[0], hits, hasMediaQuery);
  }
  const className = el.attributes.get("className");
  if (className && className.kind === "string") {
    scanStyle(className.value, el.lines[0], hits, hasMediaQuery);
  }
}

const FIXED_WIDTH_RE = /\bwidth\s*:\s*["']?(\d{3,})(?:px)?\b/g;
const FONT_SIZE_RE = /\bfontSize\s*:\s*["']?(\d{2,})(?:px)?\b/g;
const GRID_TEMPLATE_RE = /\bgridTemplateColumns\s*:\s*["']([^"']*(?:px[^"']*){2,})["']/g;

function scanStyle(
  source: string,
  line: number,
  hits: FragilityHit[],
  hasMediaQuery: boolean,
): void {
  for (const m of source.matchAll(FIXED_WIDTH_RE)) {
    const n = Number(m[1]);
    if (n > 320) {
      hits.push({ reason: `width ${n}px`, line });
    }
  }
  for (const m of source.matchAll(FONT_SIZE_RE)) {
    const n = Number(m[1]);
    if (n > 16 && !hasMediaQuery) {
      hits.push({ reason: `fontSize ${n}px (no @media in file)`, line });
    }
  }
  for (const m of source.matchAll(GRID_TEMPLATE_RE)) {
    hits.push({ reason: `gridTemplateColumns ${m[1]}`, line });
  }
}
