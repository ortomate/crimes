import { describe, expect, it } from "vitest";
import { parseTld, parseWebXml, type ParsedWebXml } from "./descriptors.js";
import { resolveJspProject, urlPatternMatches, type JspProject } from "./resolve.js";
import { parseJspFile } from "./scan.js";
import type { ParsedJspFile, ParsedTld } from "./types.js";

const ROOT = "web/src/main/webapp";

/**
 * A project from a map of repo path → source. `.tld` files become TLDs,
 * `WEB-INF/web.xml` the root's descriptor, `.java` paths Java classes
 * (named by their path under `src/main/java`), and everything else is a
 * JSP file. Directories exist when some file lies under them.
 */
function project(sources: Record<string, string>, extraDirs: string[] = []): JspProject {
  const files = new Map<string, ParsedJspFile>();
  const tlds = new Map<string, ParsedTld>();
  const webXml = new Map<string, ParsedWebXml>();
  const java = new Map<string, string>();
  const dirs = new Set<string>(extraDirs);
  for (const [path, source] of Object.entries(sources)) {
    for (let d = path; d.includes("/"); ) {
      d = d.slice(0, d.lastIndexOf("/"));
      dirs.add(d);
    }
    if (path.endsWith(".tld")) tlds.set(path, parseTld(source));
    else if (path.endsWith("WEB-INF/web.xml"))
      webXml.set(path.replace(/\/WEB-INF\/web\.xml$/, ""), parseWebXml(source));
    else if (path.endsWith(".java")) {
      java.set(
        path
          .replace(/^.*src\/main\/java\//, "")
          .replace(/\.java$/, "")
          .replaceAll("/", "."),
        path,
      );
    } else files.set(path, parseJspFile({ absolutePath: `/repo/${path}`, source }));
  }
  const webRoots = [...dirs]
    .filter((d) => dirs.has(`${d}/WEB-INF`) || d.endsWith("META-INF/resources"))
    .sort();
  return {
    files,
    tlds,
    webXml,
    webRoots,
    webRootOf: (file) =>
      webRoots
        .filter((r) => file.startsWith(`${r}/`))
        .sort((a, b) => b.length - a.length)[0],
    isFile: (path) => path in sources,
    isDirectory: (path) => dirs.has(path),
    javaClass: (name) => java.get(name),
  };
}

describe("resolveJspProject", () => {
  it("binds a prefix declared in an included fragment to the pages that include it", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/includes/global.jspf`]:
          '<%@ taglib prefix="x" tagdir="/WEB-INF/tags/ui" %>',
        [`${ROOT}/WEB-INF/views/home.jsp`]:
          '<%@ include file="/WEB-INF/includes/global.jspf" %>\n<x:card title="t"/>',
        [`${ROOT}/WEB-INF/tags/ui/card.tag`]:
          '<%@ attribute name="title" required="true" %>',
      }),
    );
    expect(
      result.references.map((r) => [
        r.from.split("/").pop(),
        r.to.split("/").pop(),
        r.kind,
      ]),
    ).toEqual([
      ["home.jsp", "global.jspf", "include"],
      ["home.jsp", "card.tag", "tag"],
    ]);
    expect(result.contractBreaks).toEqual([]);
    expect(result.dangling).toEqual([]);
  });

  it("lets a fragment use prefixes its includers declare", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]:
          '<%@ taglib prefix="x" tagdir="/WEB-INF/tags/ui" %>\n<%@ include file="part.jspf" %>',
        [`${ROOT}/WEB-INF/views/part.jspf`]: "<x:card/>",
        [`${ROOT}/WEB-INF/tags/ui/card.tag`]: "",
      }),
    );
    expect(result.references).toContainEqual({
      from: `${ROOT}/WEB-INF/views/part.jspf`,
      to: `${ROOT}/WEB-INF/tags/ui/card.tag`,
      specifier: "<x:card>",
      kind: "tag",
    });
  });

  it("applies web.xml preludes to matching pages, and their prefixes", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/web.xml`]:
          "<jsp-property-group><url-pattern>/WEB-INF/views/*</url-pattern><include-prelude>/WEB-INF/prelude.jspf</include-prelude></jsp-property-group>",
        [`${ROOT}/WEB-INF/prelude.jspf`]:
          '<%@ taglib prefix="x" tagdir="/WEB-INF/tags" %>',
        [`${ROOT}/WEB-INF/views/home.jsp`]: "<x:card/>",
        [`${ROOT}/WEB-INF/other/plain.jsp`]: "<x:card/>",
        [`${ROOT}/WEB-INF/tags/card.tag`]: "",
      }),
    );
    const from = (f: string) =>
      result.references.filter((r) => r.from.endsWith(f)).map((r) => r.kind);
    expect(from("home.jsp")).toEqual(["prelude", "tag"]);
    expect(from("plain.jsp")).toEqual([]);
  });

  it("reports a missing include only when its directory exists", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]: [
          '<%@ include file="/WEB-INF/views/moved.jspf" %>',
          '<%@ include file="/WEB-INF/from-a-jar/header.jspf" %>',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: JSP source; the ${…} is EL the scanner must read as text.
          '<jsp:include page="${dynamic}"/>',
        ].join("\n"),
      }),
    );
    expect(result.dangling).toEqual([
      {
        file: `${ROOT}/WEB-INF/views/home.jsp`,
        line: 1,
        kind: "include",
        specifier: "/WEB-INF/views/moved.jspf",
        expected: `${ROOT}/WEB-INF/views/moved.jspf`,
      },
    ]);
  });

  it("resolves a fragment's relative include where the fragment is included", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]: '<%@ include file="../shared/part.jspf" %>',
        [`${ROOT}/WEB-INF/shared/part.jspf`]:
          '<%@ include file="sibling-of-page.jspf" %>',
        [`${ROOT}/WEB-INF/views/sibling-of-page.jspf`]: "",
      }),
    );
    expect(result.dangling).toEqual([]);
    expect(result.references.map((r) => r.to.split("/").pop())).toContain(
      "sibling-of-page.jspf",
    );
  });

  it("does not judge relative includes in a fragment nothing includes", () => {
    const orphan = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/shared/part.jspf`]: '<%@ include file="elsewhere.jspf" %>',
      }),
    );
    expect(orphan.dangling).toEqual([]);
    const included = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]: '<%@ include file="../shared/part.jspf" %>',
        [`${ROOT}/WEB-INF/shared/part.jspf`]: '<%@ include file="nowhere.jspf" %>',
      }),
    );
    expect(included.dangling.map((d) => d.specifier)).toEqual(["nowhere.jspf"]);
    const library = resolveJspProject(
      project(
        {
          "lib/src/main/resources/META-INF/resources/WEB-INF/views/page.jsp":
            '<%@ include file="consumer-supplied.jspf" %>',
        },
        ["lib/src/main/resources/META-INF/resources"],
      ),
    );
    expect(library.dangling).toEqual([]);
  });

  it("treats a taglib URI as a logical name unless it names a .tld file", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]: [
          '<%@ taglib prefix="s" uri="/struts-tags" %>',
          '<%@ taglib prefix="m" uri="/WEB-INF/missing.tld" %>',
          '<s:text name="x"/>',
        ].join("\n"),
      }),
    );
    expect(result.dangling.map((d) => [d.kind, d.specifier])).toEqual([
      ["taglib", "/WEB-INF/missing.tld"],
    ]);
  });

  it("reports a tagdir tag with no tag file in an existing tag directory", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]:
          '<%@ taglib prefix="x" tagdir="/WEB-INF/tags/ui" %>\n<x:card/>\n<x:panel/>',
        [`${ROOT}/WEB-INF/tags/ui/card.tag`]: "",
      }),
    );
    expect(result.dangling.map((d) => [d.kind, d.specifier, d.line])).toEqual([
      ["tag", "<x:panel>", 3],
    ]);
  });

  it("resolves root-relative paths against other web roots, as a jar's resources are served", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]:
          '<%@ include file="/WEB-INF/lib-tags/shared.jspf" %>',
        "lib/src/main/resources/META-INF/resources/WEB-INF/lib-tags/shared.jspf": "",
      }),
    );
    expect(result.references.map((r) => r.to)).toEqual([
      "lib/src/main/resources/META-INF/resources/WEB-INF/lib-tags/shared.jspf",
    ]);
    expect(result.dangling).toEqual([]);
  });

  it("checks callers against a tag file's attribute directives", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]: [
          '<%@ taglib prefix="x" tagdir="/WEB-INF/tags" %>',
          '<x:card title="a"/>',
          '<x:card subtitle="b"/>',
          '<x:card><jsp:attribute name="title">a</jsp:attribute></x:card>',
          '<x:loose anything="1"/>',
        ].join("\n"),
        [`${ROOT}/WEB-INF/tags/card.tag`]:
          '<%@ attribute name="title" required="true" %>',
        [`${ROOT}/WEB-INF/tags/loose.tag`]: '<%@ tag dynamic-attributes="rest" %>',
      }),
    );
    expect(result.contractBreaks).toEqual([
      {
        file: `${ROOT}/WEB-INF/views/home.jsp`,
        line: 3,
        tag: "x:card",
        definedIn: `${ROOT}/WEB-INF/tags/card.tag`,
        missing: ["title"],
        undeclared: ["subtitle"],
      },
    ]);
  });

  it("joins pages to TLDs and TLDs to Java classes and tag files", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/ui.tld`]: `<taglib><uri>urn:ui</uri>
          <tag><name>money</name><tag-class>com.acme.MoneyTag</tag-class>
            <attribute><name>value</name><required>true</required></attribute></tag>
          <tag-file><name>card</name><path>/WEB-INF/tags/card.tag</path></tag-file>
          <function><name>label</name><function-class>com.acme.Labels</function-class></function>
        </taglib>`,
        [`${ROOT}/WEB-INF/tags/card.tag`]: "",
        [`${ROOT}/WEB-INF/views/home.jsp`]: [
          '<%@ taglib prefix="u" uri="urn:ui" %>',
          '<%@ page import="com.acme.Money" %>',
          "<u:money/>",
          "<u:card/>",
        ].join("\n"),
        [`${ROOT}/WEB-INF/views/fn.jsp`]:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: JSP source; the ${…} is EL the scanner must read as text.
          '<%@ taglib prefix="u" uri="/WEB-INF/ui.tld" %>${u:label(x)}',
        "src/main/java/com/acme/MoneyTag.java": "",
        "src/main/java/com/acme/Labels.java": "",
        "src/main/java/com/acme/Money.java": "",
      }),
    );
    const edges = result.references.map(
      (r) => `${r.from.split("/").pop()} -> ${r.to.split("/").pop()} (${r.kind})`,
    );
    expect(edges).toEqual([
      "ui.tld -> Labels.java (java)",
      "ui.tld -> MoneyTag.java (java)",
      "ui.tld -> card.tag (tag)",
      "fn.jsp -> ui.tld (taglib)",
      "home.jsp -> Money.java (java)",
      "home.jsp -> card.tag (tag)",
      "home.jsp -> ui.tld (taglib)",
    ]);
    expect(result.contractBreaks.map((b) => [b.tag, b.missing])).toEqual([
      ["u:money", ["value"]],
    ]);
  });

  it("follows scriptlet references to repo classes, through static members", () => {
    const result = resolveJspProject(
      project({
        [`${ROOT}/WEB-INF/views/home.jsp`]:
          "<%= com.acme.Money.ZERO %> <% java.util.List l; %>",
        "src/main/java/com/acme/Money.java": "",
      }),
    );
    expect(result.references.map((r) => [r.to, r.specifier])).toEqual([
      ["src/main/java/com/acme/Money.java", "com.acme.Money"],
    ]);
  });
});

describe("urlPatternMatches", () => {
  it("implements the servlet pattern forms", () => {
    expect(urlPatternMatches("*.jsp", "/a/b.jsp")).toBe(true);
    expect(urlPatternMatches("/a/*", "/a/b.jsp")).toBe(true);
    expect(urlPatternMatches("/a/*", "/ab.jsp")).toBe(false);
    expect(urlPatternMatches("/a/b.jsp", "/a/b.jsp")).toBe(true);
  });
});
