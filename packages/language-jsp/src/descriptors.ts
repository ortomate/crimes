/**
 * The two XML descriptors JSP resolution depends on: tag library
 * descriptors (`.tld`), which bind a taglib URI to tag classes, tag files
 * and EL functions, and `web.xml`, whose `<jsp-config>` adds preludes and
 * codas to pages and can map a taglib URI to a TLD location.
 *
 * Both are read with patterns over comment-stripped text, not an XML
 * parser. Their schemas are flat and fixed, and a descriptor that does
 * not match yields fewer facts rather than an error.
 */

import type { DeclaredAttribute, JspPropertyGroup, ParsedTld, TldTag } from "./types.js";

export interface ParsedWebXml {
  propertyGroups: JspPropertyGroup[];
  /** `<taglib><taglib-uri>` → `<taglib-location>`. */
  taglibs: { uri: string; location: string }[];
}

export function parseTld(source: string): ParsedTld {
  let text = stripXmlComments(source).replace(
    /<description>[\s\S]*?<\/description>/g,
    "",
  );
  const tags: TldTag[] = [];
  const tagFiles: ParsedTld["tagFiles"] = [];
  const functions: ParsedTld["functions"] = [];
  const otherClasses: string[] = [];

  text = text.replace(/<tag>([\s\S]*?)<\/tag>/g, (_, body: string) => {
    const attributes: DeclaredAttribute[] = [];
    const own = body.replace(
      /<attribute>([\s\S]*?)<\/attribute>/g,
      (_a, attr: string) => {
        const name = field(attr, "name");
        if (name !== undefined) {
          attributes.push({
            name,
            required: field(attr, "required")?.toLowerCase() === "true",
          });
        }
        return "";
      },
    );
    const name = field(own, "name");
    if (name !== undefined) {
      const tagClass = field(own, "tag-class");
      const teiClass = field(own, "tei-class");
      tags.push({
        name,
        ...(tagClass !== undefined ? { tagClass } : {}),
        ...(teiClass !== undefined ? { teiClass } : {}),
        attributes,
        dynamicAttributes: field(own, "dynamic-attributes")?.toLowerCase() === "true",
      });
    }
    return "";
  });
  text = text.replace(/<tag-file>([\s\S]*?)<\/tag-file>/g, (_, body: string) => {
    const name = field(body, "name");
    const path = field(body, "path");
    if (name !== undefined && path !== undefined) tagFiles.push({ name, path });
    return "";
  });
  text = text.replace(/<function>([\s\S]*?)<\/function>/g, (_, body: string) => {
    const name = field(body, "name");
    const functionClass = field(body, "function-class");
    if (name !== undefined && functionClass !== undefined)
      functions.push({ name, functionClass });
    return "";
  });
  text = text.replace(
    /<(listener|validator)>([\s\S]*?)<\/\1>/g,
    (_, kind: string, body: string) => {
      const cls = field(body, `${kind}-class`);
      if (cls !== undefined) otherClasses.push(cls);
      return "";
    },
  );

  const uri = field(text, "uri");
  return {
    ...(uri !== undefined ? { uri } : {}),
    tags,
    tagFiles,
    functions,
    otherClasses,
  };
}

export function parseWebXml(source: string): ParsedWebXml {
  const text = stripXmlComments(source);
  const propertyGroups: JspPropertyGroup[] = [];
  for (const m of text.matchAll(
    /<jsp-property-group>([\s\S]*?)<\/jsp-property-group>/g,
  )) {
    const body = m[1]!;
    const preludes = fields(body, "include-prelude");
    const codas = fields(body, "include-coda");
    if (preludes.length === 0 && codas.length === 0) continue;
    propertyGroups.push({ urlPatterns: fields(body, "url-pattern"), preludes, codas });
  }
  const taglibs: ParsedWebXml["taglibs"] = [];
  for (const m of text.matchAll(/<taglib>([\s\S]*?)<\/taglib>/g)) {
    const uri = field(m[1]!, "taglib-uri");
    const location = field(m[1]!, "taglib-location");
    if (uri !== undefined && location !== undefined) taglibs.push({ uri, location });
  }
  return { propertyGroups, taglibs };
}

function stripXmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

function field(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(body);
  return m === null || m[1] === "" ? undefined : m[1];
}

function fields(body: string, name: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "g"))) {
    if (m[1] !== "") out.push(m[1]!);
  }
  return out;
}
