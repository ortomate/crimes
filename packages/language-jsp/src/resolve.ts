/**
 * Resolve what JSP files reach: other JSP files, tag files, tag library
 * descriptors and Java classes.
 *
 * Pure: every fact about the file system arrives through
 * {@link JspProject}, so core owns the I/O and this module owns the
 * rules. All paths are repo-relative with forward slashes.
 *
 * **Web roots.** A path starting with `/` is relative to the web
 * application root, the directory holding `WEB-INF`. A repository can
 * hold several (a multi-module build, or a library shipping resources
 * under `META-INF/resources`). A root-relative path resolves against the
 * file's own root first and then every other root, because a library's
 * resources are served from the application's root at run time.
 *
 * **Prefixes.** A static include is textual, so a translation unit is a
 * page plus everything it includes, and a taglib declared anywhere in it
 * binds its prefix for all of it. That is how a fragment of shared
 * declarations works: it declares `x`, every page includes it, and the
 * pages use `<x:card>`. A fragment analysed alone takes its bindings from
 * its includers. A prefix with no binding found is left alone — it is
 * typically declared in a fragment supplied by a library jar.
 *
 * **Dangling references** are reported only when the target's directory
 * exists and the file does not, and a relative path in a fragment or a
 * library page only when something in the repository includes it. A missing directory is the signature of
 * resources supplied from outside the repository (a jar, a WAR overlay),
 * and on a real estate every unresolved include was that.
 */

import { dirname, join, normalize } from "node:path/posix";
import type { ParsedWebXml } from "./descriptors.js";
import type {
  DeclaredAttribute,
  JspAttribute,
  JspDirective,
  JspElement,
  ParsedJspFile,
  ParsedTld,
} from "./types.js";

export interface JspProject {
  /** Every JSP, fragment and tag file, by repo path. */
  files: ReadonlyMap<string, ParsedJspFile>;
  /** Every tag library descriptor in the repository, by repo path. */
  tlds: ReadonlyMap<string, ParsedTld>;
  /** `WEB-INF/web.xml` of each web root, keyed by the root's repo path. */
  webXml: ReadonlyMap<string, ParsedWebXml>;
  /** Web roots in the repository; `""` is the repository root. */
  webRoots: readonly string[];
  /** The web root a file belongs to. */
  webRootOf(file: string): string | undefined;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  /** The file declaring a fully qualified Java class, if it is in the repo. */
  javaClass(qualifiedName: string): string | undefined;
}

export type JspReferenceKind = "include" | "prelude" | "coda" | "tag" | "taglib" | "java";

export interface JspReference {
  from: string;
  to: string;
  /** What the source wrote: a path, `<x:card>`, a taglib URI, a class name. */
  specifier: string;
  kind: JspReferenceKind;
}

export interface DanglingReference {
  file: string;
  line: number;
  kind: "include" | "tag" | "taglib";
  /** The reference as written. */
  specifier: string;
  /** Where the file was expected. */
  expected: string;
}

export interface TagContractBreak {
  file: string;
  line: number;
  /** `x:card` */
  tag: string;
  /** The tag file or TLD that declares the contract. */
  definedIn: string;
  missing: string[];
  undeclared: string[];
}

export interface JspResolution {
  references: JspReference[];
  dangling: DanglingReference[];
  contractBreaks: TagContractBreak[];
}

interface Binding {
  prefix: string;
  tagdir?: string;
  uri?: string;
  /** The file whose directive declared it, for resolving root-relative paths. */
  declaredIn: string;
}

interface TagDefinition {
  definedIn: string;
  attributes: DeclaredAttribute[];
  dynamicAttributes: boolean;
}

const JSTL_CORE_URI = /(?:\/jstl\/core|^jakarta\.tags\.core)$/;

export function resolveJspProject(project: JspProject): JspResolution {
  const references = new Map<string, JspReference>();
  const dangling: DanglingReference[] = [];
  const contractBreaks: TagContractBreak[] = [];
  const files = [...project.files.keys()].sort();

  const addRef = (ref: JspReference): void => {
    if (ref.from === ref.to) return;
    const key = `${ref.from}\0${ref.to}`;
    if (!references.has(key)) references.set(key, ref);
  };

  // Root-relative or file-relative path → existing repo path, trying the
  // file's own web root before the others.
  const locate = (from: string, path: string): { found?: string; expected?: string } => {
    const clean = path.replace(/[?#].*$/, "");
    if (clean === "" || /^[a-z][\w+.-]*:/i.test(clean)) return {};
    if (clean.startsWith("/")) {
      const own = project.webRootOf(from);
      const roots =
        own === undefined
          ? project.webRoots
          : [own, ...project.webRoots.filter((r) => r !== own)];
      for (const root of roots) {
        const candidate = repoJoin(root, clean);
        if (candidate !== undefined && project.isFile(candidate))
          return { found: candidate };
      }
      if (own === undefined) return {};
      const expected = repoJoin(own, clean);
      return expected === undefined ? {} : { expected };
    }
    const candidate = repoJoin(dirname(from), clean);
    if (candidate === undefined) return {};
    return project.isFile(candidate) ? { found: candidate } : { expected: candidate };
  };

  const reportDangling = (
    file: string,
    line: number,
    kind: DanglingReference["kind"],
    specifier: string,
    expected: string,
  ): void => {
    if (project.isDirectory(dirname(expected))) {
      dangling.push({ file, line, kind, specifier, expected });
    }
  };

  // Static includes, preludes and codas: the edges that make up a
  // translation unit.
  const staticIncludes = new Map<string, string[]>();
  const includers = new Map<string, string[]>();
  const linkStatic = (
    from: string,
    to: string,
    specifier: string,
    kind: JspReferenceKind,
  ): void => {
    addRef({ from, to, specifier, kind });
    if (!project.files.has(to) || from === to) return;
    const targets = staticIncludes.get(from) ?? [];
    targets.push(to);
    staticIncludes.set(from, targets);
    const list = includers.get(to) ?? [];
    list.push(from);
    includers.set(to, list);
  };
  // A fragment's relative paths resolve where it is included, which is
  // not where it lives: retried from its includers once those are known.
  // A library's pages (under `META-INF/resources`) are treated the same
  // way, because consuming applications include them from their own
  // directories.
  const inLibraryRoot = (file: string): boolean =>
    /(?:^|\/)META-INF\/resources$/.test(project.webRootOf(file) ?? "");
  const pending: { file: string; line: number; path: string; expected: string }[] = [];
  for (const file of files) {
    const parsed = project.files.get(file)!;
    for (const d of parsed.directives) {
      if (d.name !== "include") continue;
      const path = staticValue(d.attributes, "file");
      if (path === undefined) continue;
      const { found, expected } = locate(file, path);
      if (found !== undefined) linkStatic(file, found, path, "include");
      else if (expected === undefined) continue;
      else if (
        !path.startsWith("/") &&
        (parsed.kind === "fragment" || inLibraryRoot(file))
      ) {
        pending.push({ file, line: d.line, path, expected });
      } else reportDangling(file, d.line, "include", path, expected);
    }
    if (parsed.kind === "page") {
      for (const { path, kind } of preludesAndCodas(project, file)) {
        const { found } = locate(file, path);
        if (found !== undefined) linkStatic(file, found, path, kind);
      }
    }
  }
  const locateFromIncluders = (file: string, path: string): string | undefined => {
    const seen = new Set([file]);
    let frontier = [file];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const parent of [...(includers.get(f) ?? [])].sort()) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          const { found } = locate(parent, path);
          if (found !== undefined) return found;
          next.push(parent);
        }
      }
      frontier = next;
    }
    return undefined;
  };
  for (const p of pending) {
    const found = locateFromIncluders(p.file, p.path);
    if (found !== undefined) linkStatic(p.file, found, p.path, "include");
    // Nobody here includes it: it is resolved wherever a consumer of the
    // library does, so there is nothing to check it against.
    else if (includers.has(p.file))
      reportDangling(p.file, p.line, "include", p.path, p.expected);
  }

  // Taglib bindings declared in a file and everything it statically includes.
  const downMemo = new Map<string, Binding[]>();
  const down = (file: string, seen: Set<string>): Binding[] => {
    const memo = downMemo.get(file);
    if (memo !== undefined) return memo;
    if (seen.has(file)) return [];
    seen.add(file);
    const out = [...declaredBindings(file, project.files.get(file)?.directives ?? [])];
    for (const t of staticIncludes.get(file) ?? []) out.push(...down(t, seen));
    downMemo.set(file, out);
    return out;
  };
  const bindingsFor = (file: string): Map<string, Binding> => {
    const map = new Map<string, Binding>();
    const take = (list: readonly Binding[]): void => {
      for (const b of list) if (!map.has(b.prefix)) map.set(b.prefix, b);
    };
    take(down(file, new Set()));
    // Upward: the units this file is part of, nearest includer first.
    const seen = new Set([file]);
    let frontier = [file];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const parent of [...(includers.get(f) ?? [])].sort()) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          take(down(parent, new Set()));
          next.push(parent);
        }
      }
      frontier = next;
    }
    return map;
  };

  // TLDs by URI, and through web.xml's explicit mappings.
  const tldByUri = new Map<string, string>();
  for (const path of [...project.tlds.keys()].sort()) {
    const uri = project.tlds.get(path)!.uri;
    if (uri !== undefined && !tldByUri.has(uri)) tldByUri.set(uri, path);
  }
  // A URI is a logical name first (`/struts-tags` is one, bound by a
  // TLD inside a jar), and a path only when it names a `.tld` file.
  const tldFor = (file: string, uri: string): { found?: string; expected?: string } => {
    const byUri = tldByUri.get(uri);
    if (byUri !== undefined) return { found: byUri };
    if (uri.startsWith("/") && uri.toLowerCase().endsWith(".tld")) {
      const located = locate(file, uri);
      if (located.found !== undefined && !project.tlds.has(located.found)) return {};
      return located;
    }
    const root = project.webRootOf(file);
    const mapped =
      root === undefined
        ? undefined
        : project.webXml.get(root)?.taglibs.find((t) => t.uri === uri)?.location;
    if (mapped !== undefined) {
      const located = locate(
        file,
        mapped.startsWith("/") ? mapped : `/WEB-INF/${mapped}`,
      );
      if (located.found !== undefined && project.tlds.has(located.found)) return located;
    }
    return {};
  };

  // TLD → Java classes and tag files.
  for (const path of [...project.tlds.keys()].sort()) {
    const tld = project.tlds.get(path)!;
    const classes = [
      ...tld.tags.flatMap((t) => [t.tagClass, t.teiClass]),
      ...tld.functions.map((f) => f.functionClass),
      ...tld.otherClasses,
    ];
    for (const cls of classes) {
      if (cls === undefined) continue;
      const to = project.javaClass(cls.trim());
      if (to !== undefined)
        addRef({ from: path, to, specifier: cls.trim(), kind: "java" });
    }
    for (const tf of tld.tagFiles) {
      const { found } = locate(path, tf.path);
      if (found !== undefined)
        addRef({ from: path, to: found, specifier: tf.path, kind: "tag" });
    }
  }

  const tagFileContract = (tagFile: string): TagDefinition => {
    const parsed = project.files.get(tagFile);
    const units = [tagFile, ...(staticIncludes.get(tagFile) ?? [])];
    const attributes: DeclaredAttribute[] = [];
    let dynamicAttributes = false;
    for (const unit of units) {
      for (const d of project.files.get(unit)?.directives ?? []) {
        if (d.name === "attribute") {
          const name = staticValue(d.attributes, "name");
          if (name === undefined) continue;
          const required =
            staticValue(d.attributes, "required")?.trim().toLowerCase() === "true";
          attributes.push({ name, required });
        } else if (
          d.name === "tag" &&
          d.attributes.some((a) => a.name === "dynamic-attributes")
        ) {
          dynamicAttributes = true;
        }
      }
    }
    if (parsed === undefined) dynamicAttributes = true;
    return { definedIn: tagFile, attributes, dynamicAttributes };
  };

  const checkContract = (
    file: string,
    element: JspElement,
    definition: TagDefinition,
  ): void => {
    const passed = new Set([
      ...element.attributes.map((a) => a.name),
      ...element.childAttributes,
    ]);
    const declared = new Set(definition.attributes.map((a) => a.name));
    const missing = definition.attributes
      .filter((a) => a.required && !passed.has(a.name))
      .map((a) => a.name);
    const undeclared = definition.dynamicAttributes
      ? []
      : [...passed].filter((name) => !declared.has(name) && !name.includes(":"));
    if (missing.length > 0 || undeclared.length > 0) {
      contractBreaks.push({
        file,
        line: element.line,
        tag: `${element.prefix}:${element.name}`,
        definedIn: definition.definedIn,
        missing,
        undeclared: undeclared.sort(),
      });
    }
  };

  for (const file of files) {
    const parsed = project.files.get(file)!;
    const bindings = bindingsFor(file);

    for (const element of parsed.elements) {
      if (element.prefix === "jsp") {
        resolveStandardAction(file, element);
        continue;
      }
      const binding = bindings.get(element.prefix);
      if (binding === undefined) continue;
      const specifier = `<${element.prefix}:${element.name}>`;
      if (binding.tagdir !== undefined) {
        const base = binding.tagdir.replace(/\/+$/, "");
        const tagPath = `${base}/${element.name}.tag`;
        const { found, expected } = locate(binding.declaredIn, tagPath);
        if (found !== undefined) {
          addRef({ from: file, to: found, specifier, kind: "tag" });
          checkContract(file, element, tagFileContract(found));
        } else if (
          expected !== undefined &&
          !project.isFile(expected.replace(/\.tag$/, ".tagx"))
        ) {
          reportDangling(file, element.line, "tag", specifier, expected);
        }
        continue;
      }
      if (binding.uri === undefined) continue;
      if (JSTL_CORE_URI.test(binding.uri) && element.name === "import") {
        const url = staticValue(element.attributes, "url");
        if (url !== undefined && !/^[a-z][\w+.-]*:/i.test(url)) {
          const { found } = locate(file, url);
          if (found !== undefined)
            addRef({ from: file, to: found, specifier: url, kind: "include" });
        }
        continue;
      }
      const { found: tldPath } = tldFor(binding.declaredIn, binding.uri);
      if (tldPath === undefined) continue;
      addRef({ from: file, to: tldPath, specifier: binding.uri, kind: "taglib" });
      const tld = project.tlds.get(tldPath)!;
      const tagFile = tld.tagFiles.find((t) => t.name === element.name);
      if (tagFile !== undefined) {
        const { found } = locate(tldPath, tagFile.path);
        if (found !== undefined) {
          addRef({ from: file, to: found, specifier, kind: "tag" });
          checkContract(file, element, tagFileContract(found));
        }
        continue;
      }
      const tag = tld.tags.find((t) => t.name === element.name);
      if (tag !== undefined) {
        checkContract(file, element, {
          definedIn: tldPath,
          attributes: tag.attributes,
          dynamicAttributes: tag.dynamicAttributes,
        });
      }
    }

    for (const fn of parsed.elFunctions) {
      const binding = bindings.get(fn.prefix);
      if (binding?.uri === undefined) continue;
      const { found: tldPath } = tldFor(binding.declaredIn, binding.uri);
      if (tldPath !== undefined) {
        addRef({ from: file, to: tldPath, specifier: binding.uri, kind: "taglib" });
      }
    }

    for (const d of parsed.directives) {
      if (d.name !== "taglib") continue;
      const uri = staticValue(d.attributes, "uri");
      if (
        uri === undefined ||
        !uri.startsWith("/") ||
        !uri.toLowerCase().endsWith(".tld")
      )
        continue;
      const { expected } = tldFor(file, uri);
      if (expected !== undefined) reportDangling(file, d.line, "taglib", uri, expected);
    }

    for (const name of javaNames(parsed)) {
      const resolved = resolveJavaName(project, name);
      if (resolved !== undefined) {
        addRef({ from: file, to: resolved.file, specifier: resolved.name, kind: "java" });
      }
    }
  }

  function resolveStandardAction(file: string, element: JspElement): void {
    if (element.name === "include" || element.name === "forward") {
      const page = staticValue(element.attributes, "page");
      if (page === undefined) return;
      const located = locate(file, page);
      const fragment =
        !page.startsWith("/") &&
        (project.files.get(file)?.kind === "fragment" || inLibraryRoot(file));
      const found =
        located.found ?? (fragment ? locateFromIncluders(file, page) : undefined);
      if (found !== undefined)
        addRef({ from: file, to: found, specifier: page, kind: "include" });
      else if (located.expected !== undefined && (!fragment || includers.has(file))) {
        reportDangling(file, element.line, "include", page, located.expected);
      }
    }
  }

  const sortedRefs = [...references.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  dangling.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  contractBreaks.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { references: sortedRefs, dangling, contractBreaks };
}

function declaredBindings(file: string, directives: readonly JspDirective[]): Binding[] {
  const out: Binding[] = [];
  for (const d of directives) {
    if (d.name !== "taglib") continue;
    const prefix = staticValue(d.attributes, "prefix");
    if (prefix === undefined) continue;
    const tagdir = staticValue(d.attributes, "tagdir");
    const uri = staticValue(d.attributes, "uri");
    out.push({
      prefix,
      ...(tagdir !== undefined ? { tagdir } : {}),
      ...(uri !== undefined ? { uri } : {}),
      declaredIn: file,
    });
  }
  return out;
}

function preludesAndCodas(
  project: JspProject,
  file: string,
): { path: string; kind: "prelude" | "coda" }[] {
  const root = project.webRootOf(file);
  if (root === undefined) return [];
  const groups = project.webXml.get(root)?.propertyGroups ?? [];
  const url = `/${root === "" ? file : file.slice(root.length + 1)}`;
  const out: { path: string; kind: "prelude" | "coda" }[] = [];
  for (const g of groups) {
    if (!g.urlPatterns.some((p) => urlPatternMatches(p, url))) continue;
    for (const path of g.preludes) out.push({ path, kind: "prelude" });
    for (const path of g.codas) out.push({ path, kind: "coda" });
  }
  return out;
}

/** Servlet URL patterns: `*.ext`, `/dir/*`, or an exact path. */
export function urlPatternMatches(pattern: string, url: string): boolean {
  if (pattern.startsWith("*.")) return url.endsWith(pattern.slice(1));
  if (pattern.endsWith("/*"))
    return url.startsWith(pattern.slice(0, -1)) || url === pattern.slice(0, -2);
  return pattern === url;
}

/** Java types a file names: imports, bean and attribute types, scriptlet references. */
function javaNames(parsed: ParsedJspFile): string[] {
  const names = new Set<string>();
  for (const d of parsed.directives) {
    if (d.name === "page" || d.name === "tag") {
      const imports = staticValue(d.attributes, "import");
      for (const part of imports?.split(",") ?? []) {
        const name = part.trim();
        if (name !== "" && !name.endsWith("*")) names.add(name);
      }
    }
    if (d.name === "attribute") addType(names, staticValue(d.attributes, "type"));
    if (d.name === "variable")
      addType(names, staticValue(d.attributes, "variable-class"));
  }
  for (const e of parsed.elements) {
    if (e.prefix === "jsp" && e.name === "useBean") {
      addType(names, staticValue(e.attributes, "class"));
      addType(names, staticValue(e.attributes, "type"));
    }
  }
  for (const q of parsed.qualifiedNames) names.add(q);
  return [...names].sort();
}

function addType(names: Set<string>, type: string | undefined): void {
  if (type === undefined) return;
  const name = type.replace(/<.*$/, "").replace(/\[\]$/, "").trim();
  if (name.includes(".")) names.add(name);
}

/** `com.acme.Money.ZERO` → the file of `com.acme.Money`; nested classes too. */
function resolveJavaName(
  project: JspProject,
  name: string,
): { file: string; name: string } | undefined {
  const parts = name.split(".");
  for (let end = parts.length; end >= 2; end -= 1) {
    const last = parts[end - 1]!;
    if (!/^[A-Z]/.test(last)) break;
    const qualified = parts.slice(0, end).join(".");
    const found = project.javaClass(qualified);
    if (found !== undefined) return { file: found, name: qualified };
  }
  return undefined;
}

function staticValue(
  attributes: readonly JspAttribute[],
  name: string,
): string | undefined {
  const a = attributes.find((x) => x.name === name);
  if (a === undefined || a.dynamic) return undefined;
  const value = a.value.trim();
  return value === "" ? undefined : value;
}

/** Join and normalise a repo path; undefined when it climbs out of the repo. */
function repoJoin(base: string, path: string): string | undefined {
  const joined = normalize(join(base === "" ? "." : base, path.replace(/^\/+/, "")));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/"))
    return undefined;
  return joined === "." ? undefined : joined;
}
