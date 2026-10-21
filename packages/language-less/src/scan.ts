/**
 * A lexical scanner for LESS.
 *
 * Two passes. The first blanks comments (keeping newlines, so offsets
 * still map to lines) while respecting strings and unquoted `url(…)`,
 * where `//` is part of a URL. The second splits the text into
 * statements at `;`, `{` and `}`, tracking depth and stepping over
 * strings and `@{…}` interpolation, whose braces are not blocks.
 *
 * Only statement shapes that are unambiguous are recorded: `@import`,
 * `@name:` at the top level, a single-class ruleset header, a mixin call
 * statement, and `:extend(.name)`. Everything else is a declaration or a
 * selector and is ignored.
 */

import type {
  LessDefinition,
  LessImport,
  ParsedLessFile,
  ParseLessInput,
} from "./types.js";

const AT_RULES = new Set([
  "import",
  "media",
  "keyframes",
  "font-face",
  "charset",
  "supports",
  "plugin",
  "page",
  "namespace",
  "document",
  "viewport",
  "arguments",
  "rest",
  "counter-style",
  "layer",
  "container",
  "property",
]);

const VARIABLE_REF = /@@?\{?([A-Za-z_][\w-]*)/g;
const VARIABLE_DEF = /^@([A-Za-z_][\w-]*)\s*:/;
const NAME = /^[A-Za-z_][\w-]*/;
const EXTEND = /:extend\(\s*\.([A-Za-z_][\w-]*)/g;
const IMPORT = /^@import\s*((?:\([^)]*\)\s*)*)(?:url\(\s*)?(["']?)([^"')]+)\2/;

export function parseLessFile(input: ParseLessInput): ParsedLessFile {
  const text = blankComments(input.source);
  const lines = lineStarts(text);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const imports: LessImport[] = [];
  const variables: LessDefinition[] = [];
  const mixins: LessDefinition[] = [];
  const calls = new Set<string>();
  // One entry per open block: the namespace name when the block is a
  // top-level `#namespace { }`, otherwise undefined.
  const blocks: (string | undefined)[] = [];

  const statement = (raw: string, start: number): void => {
    const s = raw.trim();
    if (s === "") return;
    const at = start + raw.length - raw.trimStart().length;
    for (const m of s.matchAll(EXTEND)) calls.add(m[1]!);
    if (s.startsWith("@import")) {
      const m = IMPORT.exec(s);
      if (m !== null) {
        const options = (m[1] ?? "").split(/[()\s,]+/).filter((o) => o !== "");
        imports.push({
          path: m[3]!.trim(),
          options,
          line: lineAt(at),
          nested: blocks.length > 0,
        });
      }
      return;
    }
    if (blocks.length === 0) {
      const v = VARIABLE_DEF.exec(s);
      if (v !== null && !AT_RULES.has(v[1]!)) {
        const value = s.slice(v[0].length).replace(/\s+/g, " ").trim().slice(0, 120);
        variables.push({ name: v[1]!, line: lineAt(at), value });
        return;
      }
    }
    const call = mixinCall(s);
    if (call !== undefined) calls.add(call);
  };

  const header = (raw: string, start: number): string | undefined => {
    const s = raw.trim();
    const at = start + raw.length - raw.trimStart().length;
    for (const m of s.matchAll(EXTEND)) calls.add(m[1]!);
    if (blocks.length === 0) {
      const v = /^@([A-Za-z_][\w-]*)\s*:\s*$/.exec(s);
      if (v !== null) {
        variables.push({ name: v[1]!, line: lineAt(at), value: "{…}" });
        return undefined;
      }
      const ns = s.startsWith("#") ? selectorName(s.slice(1)) : undefined;
      if (ns !== undefined) return ns;
      const mixin = mixinHeader(s);
      if (mixin !== undefined) mixins.push({ name: mixin, line: lineAt(at) });
      return undefined;
    }
    const namespace = blocks.length === 1 ? blocks[0] : undefined;
    if (namespace !== undefined) {
      const mixin = mixinHeader(s);
      if (mixin !== undefined)
        mixins.push({ name: `${namespace}.${mixin}`, line: lineAt(at) });
    }
    return undefined;
  };

  let start = 0;
  let k = 0;
  // `;` separates mixin arguments inside parentheses, so it ends a
  // statement only outside them. Braces reset the count, so one stray
  // `(` cannot swallow the rest of the file.
  let parens = 0;
  const n = text.length;
  while (k < n) {
    const c = text[k];
    if (c === "(") parens += 1;
    else if (c === ")") parens = Math.max(0, parens - 1);
    if (c === '"' || c === "'") {
      k = stringEnd(text, k);
      continue;
    }
    if (c === "@" && text[k + 1] === "{") {
      const close = text.indexOf("}", k + 2);
      k = close < 0 ? n : close + 1;
      continue;
    }
    if (c === ";" && parens === 0) {
      statement(text.slice(start, k), start);
      start = k + 1;
    } else if (c === "{") {
      blocks.push(header(text.slice(start, k), start));
      start = k + 1;
      parens = 0;
    } else if (c === "}") {
      statement(text.slice(start, k), start);
      blocks.pop();
      start = k + 1;
      parens = 0;
    }
    k += 1;
  }
  statement(text.slice(start), start);

  const refs = new Set<string>();
  for (const m of text.matchAll(VARIABLE_REF)) {
    if (!AT_RULES.has(m[1]!)) refs.add(m[1]!);
  }

  return {
    imports,
    variables,
    mixins,
    variableRefs: [...refs].sort(),
    mixinCalls: [...calls].sort(),
    lineCount:
      input.source.length === 0
        ? 0
        : input.source.endsWith("\n")
          ? lines.length - 1
          : lines.length,
  };
}

/*
 * Selector shapes are matched with string operations rather than one
 * regular expression each: patterns like `\([^{]*\)\s*(?:when…)?$`
 * backtrack over every `)` in a long statement.
 */

/** `name` or `name(…)`: a single simple selector, optionally with arguments. */
function selectorName(s: string): string | undefined {
  const m = NAME.exec(s);
  if (m === null) return undefined;
  const rest = s.slice(m[0].length).trim();
  return rest === "" || (rest.startsWith("(") && rest.endsWith(")")) ? m[0] : undefined;
}

/** `.name`, `.name(@a)`, `.name(@a) when (…)`: what another file can call. */
function mixinHeader(s: string): string | undefined {
  if (!s.startsWith(".")) return undefined;
  const guard = s.search(/\swhen\b/);
  return selectorName((guard < 0 ? s : s.slice(0, guard)).slice(1));
}

/** `.name;`, `.name(…);`, `#ns > .name(…) !important;` → `name` or `ns.name`. */
function mixinCall(s: string): string | undefined {
  let rest = s.endsWith("!important") ? s.slice(0, -"!important".length).trimEnd() : s;
  let namespace: string | undefined;
  if (rest.startsWith("#")) {
    const m = NAME.exec(rest.slice(1));
    if (m === null) return undefined;
    namespace = m[0];
    rest = rest.slice(1 + namespace.length).trimStart();
    if (rest.startsWith(">")) rest = rest.slice(1).trimStart();
  }
  if (!rest.startsWith(".")) return undefined;
  const name = selectorName(rest.slice(1));
  if (name === undefined) return undefined;
  return namespace !== undefined ? `${namespace}.${name}` : name;
}

/** Replace comments with spaces, keeping newlines and everything else. */
function blankComments(source: string): string {
  const out = source.split("");
  const n = source.length;
  let k = 0;
  while (k < n) {
    const c = source[k];
    if (c === '"' || c === "'") {
      k = stringEnd(source, k);
      continue;
    }
    if (c === "u" && source.startsWith("url(", k)) {
      const close = source.indexOf(")", k + 4);
      k = close < 0 ? n : close + 1;
      continue;
    }
    if (c === "/" && source[k + 1] === "*") {
      const close = source.indexOf("*/", k + 2);
      const end = close < 0 ? n : close + 2;
      for (let j = k; j < end; j += 1) if (out[j] !== "\n") out[j] = " ";
      k = end;
      continue;
    }
    if (c === "/" && source[k + 1] === "/") {
      let end = source.indexOf("\n", k);
      if (end < 0) end = n;
      for (let j = k; j < end; j += 1) out[j] = " ";
      k = end;
      continue;
    }
    k += 1;
  }
  return out.join("");
}

/** Index just past the string opened at `from`; a newline ends it unclosed. */
function stringEnd(text: string, from: number): number {
  const quote = text[from];
  let k = from + 1;
  while (k < text.length) {
    const c = text[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === quote) return k + 1;
    if (c === "\n") return k;
    k += 1;
  }
  return text.length;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let k = text.indexOf("\n"); k >= 0; k = text.indexOf("\n", k + 1))
    starts.push(k + 1);
  return starts;
}
