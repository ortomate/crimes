/**
 * `@crimes/language-less` — the LESS language pack.
 *
 * Registration follows `CONTRIBUTING.md` §"Adding a new language". A
 * lexical scanner, not a grammar: see `docs/superpowers/specs/
 * 2026-10-20-templates-and-stylesheets-design.md`. Pure TypeScript, so
 * importing it costs nothing.
 *
 * Plain `.css` is claimed too and read as the LESS subset it is: its
 * `@import`s and the JavaScript that imports it join the graph. Coverage
 * counts those files as `css`.
 */

export const LESS_EXTENSIONS = [".less", ".css"] as const;

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
export { findOverriddenVariables, type OverriddenVariable } from "./overrides.js";
