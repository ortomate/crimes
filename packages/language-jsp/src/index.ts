/**
 * `@crimes/language-jsp` — the JSP language pack.
 *
 * Registration follows `CONTRIBUTING.md` §"Adding a new language". A
 * lexical scanner, not a grammar: see `docs/superpowers/specs/
 * 2026-10-20-templates-and-stylesheets-design.md` for why. Pure
 * TypeScript, so importing it costs nothing.
 *
 * `.tld` files are claimed beside the templates because a tag library
 * descriptor is where a taglib URI is bound to tag files, tag classes
 * and EL functions; resolving templates needs them parsed.
 */

export const JSP_EXTENSIONS = [".jsp", ".jspf", ".tag", ".tld"] as const;

export { jspKindFor, parseJspFile } from "./scan.js";
export { parseTld, parseWebXml, type ParsedWebXml } from "./descriptors.js";
export {
  resolveJspProject,
  urlPatternMatches,
  type DanglingReference,
  type JspProject,
  type JspReference,
  type JspReferenceKind,
  type JspResolution,
  type TagContractBreak,
} from "./resolve.js";

export type {
  DeclaredAttribute,
  JspAttribute,
  JspComment,
  JspDirective,
  JspElement,
  JspFileKind,
  JspPropertyGroup,
  JspScriptlet,
  ParsedJspFile,
  ParsedTld,
  ParseJspInput,
  TldTag,
} from "./types.js";
