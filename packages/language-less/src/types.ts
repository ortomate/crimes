/**
 * The facts the LESS scanner extracts: what a stylesheet imports, which
 * variables and mixins it defines for the rest of a bundle, and which it
 * uses. Uses matter as much as imports do: a partial is usually compiled
 * inside a bundle whose root imported the variables first, so it uses
 * `@brand` without importing anything.
 */

export interface LessImport {
  /** The path as written, without quotes or `url()`. */
  path: string;
  /** `(reference)`, `(css)`, `(optional)` … in source order. */
  options: string[];
  line: number;
}

export interface LessDefinition {
  /** `brand` for `@brand`; `clearfix` for `.clearfix`; `gradient.vertical` for `#gradient > .vertical`. */
  name: string;
  line: number;
}

export interface ParsedLessFile {
  imports: LessImport[];
  /** Top-level variable definitions, including detached rulesets. */
  variables: LessDefinition[];
  /**
   * Top-level single-class rulesets (`.name { }`, `.name(@a) { }`) and
   * those one level inside a `#namespace { }`, which are what can be
   * called as mixins from another file.
   */
  mixins: LessDefinition[];
  /** Distinct variable names referenced, interpolations included. */
  variableRefs: string[];
  /** Distinct mixin names called or extended. */
  mixinCalls: string[];
  lineCount: number;
}

export interface ParseLessInput {
  absolutePath: string;
  source: string;
}
