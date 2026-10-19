/**
 * `@crimes/language-less` — the LESS language pack.
 *
 * Registration follows `CONTRIBUTING.md` §"Adding a new language". A
 * lexical scanner, not a grammar: see `docs/superpowers/specs/
 * 2026-10-20-templates-and-stylesheets-design.md`. Pure TypeScript, so
 * importing it costs nothing.
 *
 * Plain `.css` is not claimed: it would add every JavaScript project's
 * stylesheets to the report for an import graph of little value.
 */

export const LESS_EXTENSIONS = [".less"] as const;

export { parseLessFile } from "./scan.js";
export {
  resolveLessProject,
  type LessProject,
  type LessReference,
  type LessReferenceKind,
  type LessResolution,
} from "./resolve.js";
export type {
  LessDefinition,
  LessImport,
  ParsedLessFile,
  ParseLessInput,
} from "./types.js";
