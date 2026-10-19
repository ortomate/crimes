/**
 * A lexical scanner for JSP syntax.
 *
 * JSP is template text with a handful of delimited constructs embedded
 * in it, and those are all crimes needs: directives (`<%@ … %>`),
 * scriptlets (`<% … %>`, `<%= … %>`, `<%! … %>`), comments
 * (`<%-- … --%>`), and prefixed elements (`<jsp:include>`, `<c:if>`,
 * `<x:card>`). Everything else — HTML, script, style — is opaque text.
 * HTML comments are not skipped, because JSP does not skip them either:
 * a directive or custom tag inside `<!-- -->` still runs.
 *
 * Attribute values may embed EL (`${…}`, `#{…}`) and expressions
 * (`<%= … %>`), which may in turn contain quotes and `>`, so values are
 * read with a small nested lexer rather than a regular expression.
 * Anything malformed is skipped from the next `<`; the scanner never
 * throws and never backtracks.
 */

import type {
  JspAttribute,
  JspComment,
  JspDirective,
  JspElement,
  JspFileKind,
  JspScriptlet,
  ParsedJspFile,
  ParseJspInput,
} from "./types.js";

const PREFIXED_NAME = /([A-Za-z_][\w-]*):([A-Za-z_][\w.-]*)/y;
const CLOSING_TAG = /<\/([A-Za-z_][\w-]*):([A-Za-z_][\w.-]*)\s*>/y;
const DIRECTIVE_NAME = /\s*([A-Za-z][\w.-]*)/y;
const QUALIFIED_NAME = /\b[a-z_][\w]*(?:\.[a-z_][\w]*)+(?:\.[A-Z][\w]*)+/g;
const EL_FUNCTION = /([A-Za-z_][\w-]*):([A-Za-z_][\w]*)\s*\(/g;
/** Longest attribute section a start tag may have before we give up on it. */
const MAX_TAG_LENGTH = 64 * 1024;

export function jspKindFor(absolutePath: string): JspFileKind {
  const lower = absolutePath.toLowerCase();
  if (lower.endsWith(".tag")) return "tag";
  if (lower.endsWith(".jspf")) return "fragment";
  return "page";
}

export function parseJspFile(input: ParseJspInput): ParsedJspFile {
  const { source } = input;
  const lines = lineIndex(source);
  const directives: JspDirective[] = [];
  const elements: JspElement[] = [];
  const scriptlets: JspScriptlet[] = [];
  const comments: JspComment[] = [];
  const qualified = new Set<string>();
  const elFunctions = new Map<string, { prefix: string; name: string }>();
  const open: JspElement[] = [];

  const noteEl = (text: string): void => {
    if (!text.includes("{")) return;
    for (const span of elSpans(text)) {
      for (const m of span.matchAll(EL_FUNCTION)) {
        const key = `${m[1]}:${m[2]}`;
        if (!elFunctions.has(key)) elFunctions.set(key, { prefix: m[1]!, name: m[2]! });
      }
    }
  };

  const n = source.length;
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    if (source.startsWith("<%--", lt)) {
      noteEl(source.slice(textStart, lt));
      const end = indexOrEnd(source, "--%>", lt + 4);
      comments.push({ line: lines.at(lt), endLine: lines.at(end) });
      i = textStart = Math.min(n, end + 4);
      continue;
    }
    if (source.startsWith("<%", lt)) {
      noteEl(source.slice(textStart, lt));
      if (source.startsWith("<%@", lt)) {
        const end = directiveEnd(source, lt + 3);
        const directive = readDirective(source.slice(lt + 3, end), lines.at(lt));
        if (directive !== undefined) directives.push(directive);
        i = textStart = Math.min(n, end + 2);
        continue;
      }
      const marker = source[lt + 2];
      const kind: JspScriptlet["kind"] =
        marker === "=" ? "expression" : marker === "!" ? "declaration" : "scriptlet";
      const end = indexOrEnd(source, "%>", lt + 2);
      const body = source.slice(lt + 2, end);
      for (const m of body.matchAll(QUALIFIED_NAME)) qualified.add(m[0]);
      scriptlets.push({ kind, line: lines.at(lt), endLine: lines.at(end) });
      i = textStart = Math.min(n, end + 2);
      continue;
    }
    if (source[lt + 1] === "/") {
      CLOSING_TAG.lastIndex = lt;
      const m = CLOSING_TAG.exec(source);
      if (m !== null) {
        closeElement(open, m[1]!, m[2]!);
        i = lt + m[0].length;
      } else {
        i = lt + 2;
      }
      continue;
    }
    PREFIXED_NAME.lastIndex = lt + 1;
    const name = PREFIXED_NAME.exec(source);
    const after = name === null ? "" : (source[lt + 1 + name[0].length] ?? "");
    if (name === null || !(after === ">" || after === "/" || /\s/.test(after))) {
      i = lt + 1;
      continue;
    }
    const tag = readAttributes(source, lt + 1 + name[0].length);
    if (tag === undefined) {
      i = lt + 1;
      continue;
    }
    noteEl(source.slice(textStart, lt));
    for (const a of tag.attributes) if (a.dynamic) noteEl(a.value);
    const prefix = name[1]!;
    const local = name[2]!;
    const line = lines.at(lt);
    if (prefix === "jsp" && local.startsWith("directive.")) {
      directives.push({
        name: local.slice("directive.".length),
        attributes: tag.attributes,
        line,
      });
    } else {
      const element: JspElement = {
        prefix,
        name: local,
        attributes: tag.attributes,
        line,
        selfClosing: tag.selfClosing,
        childAttributes: [],
      };
      elements.push(element);
      if (prefix === "jsp" && local === "attribute") {
        const owner = ownerOf(open);
        const attrName = tag.attributes.find((a) => a.name === "name");
        if (owner !== undefined && attrName !== undefined && !attrName.dynamic) {
          owner.childAttributes.push(attrName.value.trim());
        }
      }
      if (!tag.selfClosing) open.push(element);
    }
    i = textStart = tag.end;
  }
  noteEl(source.slice(textStart));

  return {
    kind: jspKindFor(input.absolutePath),
    directives,
    elements,
    scriptlets,
    qualifiedNames: [...qualified].sort(),
    elFunctions: [...elFunctions.values()],
    comments,
    lineCount: lines.count,
  };
}

/** The element a `<jsp:attribute>` belongs to: its nearest open action. */
function ownerOf(open: readonly JspElement[]): JspElement | undefined {
  for (let k = open.length - 1; k >= 0; k -= 1) {
    const e = open[k]!;
    if (e.prefix === "jsp" && (e.name === "attribute" || e.name === "body")) continue;
    return e;
  }
  return undefined;
}

function closeElement(open: JspElement[], prefix: string, name: string): void {
  for (let k = open.length - 1; k >= 0; k -= 1) {
    const e = open[k]!;
    if (e.prefix === prefix && e.name === name) {
      open.length = k;
      return;
    }
  }
}

function readDirective(body: string, line: number): JspDirective | undefined {
  DIRECTIVE_NAME.lastIndex = 0;
  const m = DIRECTIVE_NAME.exec(body);
  if (m === null) return undefined;
  const attrs = readAttributes(`${body.slice(m[0].length)}>`, 0);
  return { name: m[1]!, attributes: attrs?.attributes ?? [], line };
}

/** End of a directive: the first `%>` outside a quoted value. */
function directiveEnd(source: string, from: number): number {
  let quote: string | undefined;
  for (let k = from; k < source.length - 1; k += 1) {
    const c = source[k];
    if (quote !== undefined) {
      if (c === "\\") k += 1;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "%" && source[k + 1] === ">") {
      return k;
    }
  }
  return indexOrEnd(source, "%>", from);
}

/**
 * Read `name="value"` pairs from `from` to the end of a start tag.
 * Returns undefined when the tag never closes within bounds or a `<`
 * appears where an attribute should be — the mark of text that only
 * looked like a tag.
 */
function readAttributes(
  source: string,
  from: number,
): { attributes: JspAttribute[]; selfClosing: boolean; end: number } | undefined {
  const attributes: JspAttribute[] = [];
  const limit = Math.min(source.length, from + MAX_TAG_LENGTH);
  let k = from;
  while (k < limit) {
    const c = source[k]!;
    if (/\s/.test(c)) {
      k += 1;
      continue;
    }
    if (c === ">") return { attributes, selfClosing: false, end: k + 1 };
    if (c === "/" && source[k + 1] === ">")
      return { attributes, selfClosing: true, end: k + 2 };
    if (c === "<" || c === '"' || c === "'" || c === "=") return undefined;
    const nameStart = k;
    while (k < limit && !/[\s=/>"'<]/.test(source[k]!)) k += 1;
    const name = source.slice(nameStart, k);
    if (name === "") {
      // A `/` that does not close the tag; step over it.
      k += 1;
      continue;
    }
    while (k < limit && /\s/.test(source[k]!)) k += 1;
    if (source[k] !== "=") {
      attributes.push({ name, value: "", dynamic: false });
      continue;
    }
    k += 1;
    while (k < limit && /\s/.test(source[k]!)) k += 1;
    const quote = source[k];
    if (quote === '"' || quote === "'") {
      const end = quotedValueEnd(source, k + 1, quote, limit);
      if (end < 0) return undefined;
      const value = source.slice(k + 1, end);
      attributes.push({ name, value, dynamic: isDynamic(value) });
      k = end + 1;
    } else {
      const valueStart = k;
      while (k < limit && !/[\s>]/.test(source[k]!) && !source.startsWith("/>", k))
        k += 1;
      const value = source.slice(valueStart, k);
      attributes.push({ name, value, dynamic: isDynamic(value) });
    }
  }
  return undefined;
}

/** Index of the closing quote, stepping over EL, expressions and escapes. */
function quotedValueEnd(
  source: string,
  from: number,
  quote: string,
  limit: number,
): number {
  let k = from;
  while (k < limit) {
    const c = source[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === quote) return k;
    if ((c === "$" || c === "#") && source[k + 1] === "{") {
      k = elEnd(source, k + 2, limit);
      continue;
    }
    if (c === "<" && source.startsWith("<%=", k)) {
      const end = source.indexOf("%>", k + 3);
      if (end < 0 || end >= limit) return -1;
      k = end + 2;
      continue;
    }
    k += 1;
  }
  return -1;
}

/** Index just past the `}` that closes an EL expression opened before `from`. */
function elEnd(source: string, from: number, limit: number): number {
  let depth = 1;
  let quote: string | undefined;
  let k = from;
  while (k < limit) {
    const c = source[k];
    if (quote !== undefined) {
      if (c === "\\") k += 1;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
    k += 1;
  }
  return limit;
}

/** The bodies of the EL expressions in a run of text. */
function elSpans(text: string): string[] {
  const spans: string[] = [];
  let k = 0;
  while (k < text.length) {
    const d = text.indexOf("{", k);
    if (d < 1) break;
    const marker = text[d - 1];
    if (marker !== "$" && marker !== "#") {
      k = d + 1;
      continue;
    }
    const end = elEnd(text, d + 1, text.length);
    spans.push(text.slice(d + 1, end - 1));
    k = end;
  }
  return spans;
}

function isDynamic(value: string): boolean {
  return value.includes("${") || value.includes("#{") || value.includes("<%=");
}

function indexOrEnd(source: string, needle: string, from: number): number {
  const at = source.indexOf(needle, from);
  return at < 0 ? source.length : at;
}

interface LineIndex {
  at(offset: number): number;
  count: number;
}

function lineIndex(source: string): LineIndex {
  const starts = [0];
  for (let k = source.indexOf("\n"); k >= 0; k = source.indexOf("\n", k + 1)) {
    starts.push(k + 1);
  }
  return {
    at(offset) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    count:
      source.length === 0 ? 0 : source.endsWith("\n") ? starts.length - 1 : starts.length,
  };
}
