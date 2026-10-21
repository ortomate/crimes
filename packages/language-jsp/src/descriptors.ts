/**
 * The two XML descriptors JSP resolution depends on: tag library
 * descriptors (`.tld`), which bind a taglib URI to tag classes, tag files
 * and EL functions, and `web.xml`, whose `<jsp-config>` adds preludes and
 * codas to pages and can map a taglib URI to a TLD location.
 *
 * Both are read by locating elements with `indexOf` over comment-stripped
 * text, not with an XML parser or regular expressions: their schemas are
 * flat and fixed, and a descriptor from an untrusted repository must not
 * be able to make extraction super-linear. A descriptor that does not
 * match yields fewer facts rather than an error.
 */

import type { DeclaredAttribute, JspPropertyGroup, ParsedTld, TldTag } from "./types.js";

export interface ParsedWebXml {
  propertyGroups: JspPropertyGroup[];
  /** `<taglib><taglib-uri>` → `<taglib-location>`. */
  taglibs: { uri: string; location: string }[];
}

export function parseTld(source: string): ParsedTld {
  let text = removeBlocks(stripXmlComments(source), "description", () => undefined);
  const tags: TldTag[] = [];
  const tagFiles: ParsedTld["tagFiles"] = [];
  const functions: ParsedTld["functions"] = [];
  const otherClasses: string[] = [];

  text = removeBlocks(text, "tag", (body) => {
    const tag = readTldTag(body);
    if (tag !== undefined) tags.push(tag);
  });
  text = removeBlocks(text, "tag-file", (body) => {
    const name = field(body, "name");
    const path = field(body, "path");
    if (name !== undefined && path !== undefined) tagFiles.push({ name, path });
  });
  text = removeBlocks(text, "function", (body) => {
    const name = field(body, "name");
    const functionClass = field(body, "function-class");
    if (name !== undefined && functionClass !== undefined)
      functions.push({ name, functionClass });
  });
  for (const kind of ["listener", "validator"] as const) {
    text = removeBlocks(text, kind, (body) => {
      const cls = field(body, `${kind}-class`);
      if (cls !== undefined) otherClasses.push(cls);
    });
  }

  const uri = field(text, "uri");
  return {
    ...(uri !== undefined ? { uri } : {}),
    tags,
    tagFiles,
    functions,
    otherClasses,
  };
}

function readTldTag(body: string): TldTag | undefined {
  const attributes: DeclaredAttribute[] = [];
  const own = removeBlocks(body, "attribute", (attr) => {
    const name = field(attr, "name");
    if (name !== undefined) {
      attributes.push({
        name,
        required: field(attr, "required")?.toLowerCase() === "true",
      });
    }
  });
  const name = field(own, "name");
  if (name === undefined) return undefined;
  const tagClass = field(own, "tag-class");
  const teiClass = field(own, "tei-class");
  return {
    name,
    ...(tagClass !== undefined ? { tagClass } : {}),
    ...(teiClass !== undefined ? { teiClass } : {}),
    attributes,
    dynamicAttributes: field(own, "dynamic-attributes")?.toLowerCase() === "true",
  };
}

export function parseWebXml(source: string): ParsedWebXml {
  const text = stripXmlComments(source);
  const propertyGroups: JspPropertyGroup[] = [];
  removeBlocks(text, "jsp-property-group", (body) => {
    const preludes = fields(body, "include-prelude");
    const codas = fields(body, "include-coda");
    if (preludes.length === 0 && codas.length === 0) return;
    propertyGroups.push({ urlPatterns: fields(body, "url-pattern"), preludes, codas });
  });
  const taglibs: ParsedWebXml["taglibs"] = [];
  removeBlocks(text, "taglib", (body) => {
    const uri = field(body, "taglib-uri");
    const location = field(body, "taglib-location");
    if (uri !== undefined && location !== undefined) taglibs.push({ uri, location });
  });
  return { propertyGroups, taglibs };
}

/** Comments removed; an unterminated one runs to the end, as in XML. */
function stripXmlComments(source: string): string {
  let out = "";
  let k = 0;
  for (;;) {
    const open = source.indexOf("<!--", k);
    if (open < 0) return out + source.slice(k);
    out += source.slice(k, open);
    const close = source.indexOf("-->", open + 4);
    if (close < 0) return out;
    k = close + 3;
  }
}

/**
 * Hand each `<tag>…</tag>` body to `visit`, and return the text with
 * those elements removed. Linear: each search starts where the last one
 * ended, and an unclosed element ends the walk.
 */
function removeBlocks(text: string, tag: string, visit: (body: string) => void): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let out = "";
  let k = 0;
  for (;;) {
    const start = text.indexOf(open, k);
    if (start < 0) return out + text.slice(k);
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return out + text.slice(k);
    out += text.slice(k, start);
    visit(text.slice(start + open.length, end));
    k = end + close.length;
  }
}

/** Trimmed text of the first `<name>` element, if it has any. */
function field(body: string, name: string): string | undefined {
  return fields(body, name, 1)[0];
}

function fields(body: string, name: string, max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  removeBlocks(body, name, (inner) => {
    if (out.length >= max || inner.includes("<")) return;
    const value = inner.trim();
    if (value !== "") out.push(value);
  });
  return out;
}
