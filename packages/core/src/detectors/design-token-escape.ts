import type { LanguageJsDetector } from "../detector.js";
import type { Severity } from "../finding.js";
import { findJsxElements, walkJsx } from "../jsx/walk.js";
import type { JsxAttributeValue, JsxElementInfo } from "../jsx/walk.js";

/**
 * Fires when a file's JSX `style={{...}}` expressions or `className`
 * literals contain ≥5 hard-coded colour / spacing / radius / shadow
 * values that look like design-token candidates. The detector does NOT
 * try to verify a token exists for the value — that would require
 * loading the project's design system. Instead it surfaces "this file
 * has unusually many raw style literals" as an agent-edit-risk signal.
 */
export const designTokenEscapeDetector: LanguageJsDetector = {
  id: "design_token_escape",
  name: "Design Token Escape",
  description:
    "Flags JSX files with many hard-coded style values (hex / rgb / " +
    "px / numeric radius / shadow) that probably belong in the design " +
    "system.",
  whyItMatters:
    "Hard-coded style values spread across components are how design " +
    "systems quietly stop being followed. The next agent extending a " +
    "screen has no way to tell which numbers are deliberate exceptions " +
    "and which are drift; reviewers can't audit the palette from the " +
    "diff alone.",

  pack: "language-js",
  run(ctx) {
    const elements = walkJsx({ source: ctx.source, ast: ctx.parsed });
    if (elements.length === 0) return [];
    const targets = findJsxElements(elements, (el) => hasStyleAttribute(el));
    if (targets.length === 0) return [];

    const hits: TokenHit[] = [];
    for (const el of targets) {
      collectHits(el, hits);
    }
    if (hits.length < 5) return [];

    const severity: Severity = hits.length >= 10 ? "medium" : "low";
    const confidence = 0.75;

    const distinctKinds = new Set(hits.map((h) => h.kind));
    const evidence: string[] = [
      `${hits.length} hard-coded style value${hits.length === 1 ? "" : "s"} ` +
        `across ${distinctKinds.size} kind${distinctKinds.size === 1 ? "" : "s"} ` +
        `(${[...distinctKinds].sort().join(", ")})`,
    ];
    for (const hit of hits.slice(0, 5)) {
      evidence.push(`line ${hit.line}: ${hit.kind} ${hit.value}`);
    }
    if (hits.length > 5) {
      evidence.push(`+${hits.length - 5} more raw value(s)`);
    }

    return [
      {
        id: "",
        type: "design_token_escape",
        charge: "Design Token Escape",
        severity,
        confidence,
        file: ctx.file,
        summary:
          `${ctx.file} contains ${hits.length} hard-coded style value` +
          `${hits.length === 1 ? "" : "s"} in JSX. Many of these probably ` +
          "belong in the design system; agents extending the file may copy " +
          "them forward without realising they bypass the tokens.",
        evidence,
        effort: "quick",
        fix_shape: "replace raw values with the design token",
        scores: {
          severity: severity === "medium" ? 0.55 : 0.4,
          confidence,
        },
        suggested_actions: [
          {
            kind: "use_design_tokens",
            description:
              "Replace raw literals with the project's design tokens " +
              "(theme colors, spacing scale, radius scale) where possible.",
            risk: "low",
          },
        ],
      },
    ];
  },
};

interface TokenHit {
  kind: TokenKind;
  value: string;
  line: number;
}

type TokenKind = "color" | "rgb" | "px" | "shadow" | "radius";

function hasStyleAttribute(el: JsxElementInfo): boolean {
  for (const [name, value] of el.attributes) {
    if (name === "style" && value.kind === "expression") return true;
    if (name === "className" && value.kind === "string") return true;
  }
  return false;
}

function collectHits(el: JsxElementInfo, hits: TokenHit[]): void {
  const style = el.attributes.get("style");
  if (style && style.kind === "expression") scan(style, el.lines[0], hits);
  const className = el.attributes.get("className");
  if (className && className.kind === "string") {
    scan({ kind: "expression", source: className.value }, el.lines[0], hits);
  }
}

function scan(
  attr: Extract<JsxAttributeValue, { kind: "expression" }>,
  line: number,
  hits: TokenHit[],
): void {
  const source = attr.source;
  for (const m of source.matchAll(HEX_COLOR)) {
    hits.push({ kind: "color", value: m[0]!, line });
  }
  for (const m of source.matchAll(RGB_COLOR)) {
    hits.push({ kind: "rgb", value: m[0]!, line });
  }
  for (const m of source.matchAll(PX_LITERAL)) {
    const value = m[0]!;
    if (isAllowedPxValue(value)) continue;
    hits.push({ kind: "px", value, line });
  }
  if (SHADOW_LITERAL.test(source)) {
    hits.push({ kind: "shadow", value: extractShadow(source), line });
  }
  for (const m of source.matchAll(RADIUS_LITERAL)) {
    hits.push({ kind: "radius", value: m[0]!, line });
  }
}

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_COLOR = /rgba?\([^)]+\)|hsla?\([^)]+\)/g;
const PX_LITERAL = /\b\d+(?:\.\d+)?(?:px|rem|em)\b/g;
const SHADOW_LITERAL = /\bbox[Ss]hadow\s*:/;
const RADIUS_LITERAL = /\bborder[Rr]adius\s*:\s*\d+/g;

const ALLOWED_PX = new Set(["0px", "1px", "2px"]);

function isAllowedPxValue(value: string): boolean {
  return ALLOWED_PX.has(value);
}

function extractShadow(source: string): string {
  const match = source.match(/boxShadow\s*:\s*["'`]?([^"'`,}]+)/);
  return match?.[1]?.trim() ?? "boxShadow";
}
