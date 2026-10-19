/**
 * The facts the JSP scanner extracts. Deliberately not a tree: what core
 * needs is where a file reaches — includes, tags, tag libraries and Java
 * types — and what a tag file promises its callers.
 */

/** `.jsp` page, `.jspf` fragment, or `.tag` tag file. */
export type JspFileKind = "page" | "fragment" | "tag";

export interface JspAttribute {
  name: string;
  /** The value as written, without its quotes. */
  value: string;
  /**
   * True when the value is computed at request time — it contains an EL
   * expression (`${…}`, `#{…}`) or a scriptlet expression (`<%= … %>`) —
   * so it cannot be resolved statically.
   */
  dynamic: boolean;
}

/**
 * A directive: `<%@ page … %>`, `<%@ include … %>`, `<%@ taglib … %>`,
 * and in tag files `<%@ tag … %>`, `<%@ attribute … %>`,
 * `<%@ variable … %>`. The XML form `<jsp:directive.include … />` is
 * reported here too, under the same name.
 */
export interface JspDirective {
  name: string;
  attributes: JspAttribute[];
  line: number;
}

/**
 * An element whose name has a prefix: a standard action (`jsp:include`)
 * or a custom tag (`c:if`, `x:card`). Unprefixed HTML is not recorded.
 */
export interface JspElement {
  prefix: string;
  name: string;
  attributes: JspAttribute[];
  line: number;
  selfClosing: boolean;
  /**
   * Attributes supplied as `<jsp:attribute name="…">` children rather
   * than in the start tag. Only direct children count, as in JSP.
   */
  childAttributes: string[];
}

export interface JspScriptlet {
  kind: "scriptlet" | "expression" | "declaration";
  line: number;
  endLine: number;
}

export interface JspComment {
  line: number;
  endLine: number;
}

export interface ParsedJspFile {
  kind: JspFileKind;
  directives: JspDirective[];
  elements: JspElement[];
  scriptlets: JspScriptlet[];
  /**
   * Dotted names that end in a capitalised segment (`com.acme.Money`,
   * `com.acme.Money.ZERO`), seen inside scriptlets and expressions.
   * Core keeps the ones that name a class in the repository.
   */
  qualifiedNames: string[];
  /** EL function calls (`${fn:escapeXml(x)}`), distinct by prefix and name. */
  elFunctions: { prefix: string; name: string }[];
  /** `<%-- … --%>` comments; their content is not scanned. */
  comments: JspComment[];
  lineCount: number;
}

export interface ParseJspInput {
  absolutePath: string;
  source: string;
}

/** One `<attribute>` of a TLD tag, or an `<%@ attribute %>` of a tag file. */
export interface DeclaredAttribute {
  name: string;
  required: boolean;
}

export interface TldTag {
  name: string;
  tagClass?: string;
  teiClass?: string;
  attributes: DeclaredAttribute[];
  dynamicAttributes: boolean;
}

export interface ParsedTld {
  /** `<uri>`, the name pages use in `<%@ taglib uri="…" %>`. */
  uri?: string;
  tags: TldTag[];
  /** `<tag-file>`: a tag implemented as a `.tag` file under `path`. */
  tagFiles: { name: string; path: string }[];
  functions: { name: string; functionClass: string }[];
  /** Listener and validator classes. */
  otherClasses: string[];
}

/** A `<jsp-property-group>` from `web.xml` that adds a prelude or coda. */
export interface JspPropertyGroup {
  urlPatterns: string[];
  preludes: string[];
  codas: string[];
}
