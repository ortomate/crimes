import { describe, expect, it } from "vitest";
import { parseTld, parseWebXml } from "./descriptors.js";
import { parseJspFile } from "./scan.js";

const parse = (source: string, absolutePath = "/app/WEB-INF/views/page.jsp") =>
  parseJspFile({ absolutePath, source });

describe("parseJspFile", () => {
  it("reads directives with either quote style, across lines", () => {
    const parsed = parse(
      [
        '<%@ page contentType="text/html" import="com.acme.Money, java.util.List" %>',
        "<%@ taglib prefix='x'",
        '    tagdir="/WEB-INF/tags/ui" %>',
        '<%@ include file="/WEB-INF/includes/global.jspf" %>',
      ].join("\n"),
    );
    expect(parsed.directives.map((d) => [d.name, d.line])).toEqual([
      ["page", 1],
      ["taglib", 2],
      ["include", 4],
    ]);
    expect(parsed.directives[1]!.attributes).toEqual([
      { name: "prefix", value: "x", dynamic: false },
      { name: "tagdir", value: "/WEB-INF/tags/ui", dynamic: false },
    ]);
  });

  it("reads the XML directive form under the same name", () => {
    const parsed = parse('<jsp:directive.include file="a.jspf"/>');
    expect(parsed.directives).toEqual([
      {
        name: "include",
        attributes: [{ name: "file", value: "a.jspf", dynamic: false }],
        line: 1,
      },
    ]);
    expect(parsed.elements).toEqual([]);
  });

  it("steps over EL and expressions that contain quotes and >", () => {
    const parsed = parse(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: JSP source; the ${…} is EL the scanner must read as text.
      '<x:card title="${a > b ? "big" : \'small\'}" href="<%= url("x>y") %>" size=3/>',
    );
    expect(parsed.elements).toHaveLength(1);
    const card = parsed.elements[0]!;
    expect(card.selfClosing).toBe(true);
    expect(card.attributes.map((a) => [a.name, a.dynamic])).toEqual([
      ["title", true],
      ["href", true],
      ["size", false],
    ]);
  });

  it("skips JSP comments but not HTML comments, as JSP does", () => {
    const parsed = parse(
      ["<%-- <x:gone/> --%>", "<!-- <x:runs/> -->", "<%--", "multi", "--%>"].join("\n"),
    );
    expect(parsed.elements.map((e) => e.name)).toEqual(["runs"]);
    expect(parsed.comments).toEqual([
      { line: 1, endLine: 1 },
      { line: 3, endLine: 5 },
    ]);
  });

  it("gives <jsp:attribute> children to their direct owner only", () => {
    const parsed = parse(
      [
        "<x:outer>",
        '  <jsp:attribute name="heading"><x:inner><jsp:attribute name="label">L</jsp:attribute></x:inner></jsp:attribute>',
        "  <jsp:body>b</jsp:body>",
        "</x:outer>",
      ].join("\n"),
    );
    const byName = new Map(parsed.elements.map((e) => [e.name, e]));
    expect(byName.get("outer")!.childAttributes).toEqual(["heading"]);
    expect(byName.get("inner")!.childAttributes).toEqual(["label"]);
  });

  it("records scriptlets and the qualified names inside them", () => {
    const parsed = parse(
      [
        "<% com.acme.Money m = com.acme.Money.ZERO; %>",
        "<%= java.util.UUID.randomUUID() %>",
        "<%! int n = 0; %>",
      ].join("\n"),
    );
    expect(parsed.scriptlets.map((s) => s.kind)).toEqual([
      "scriptlet",
      "expression",
      "declaration",
    ]);
    expect(parsed.qualifiedNames).toEqual([
      "com.acme.Money",
      "com.acme.Money.ZERO",
      "java.util.UUID",
    ]);
  });

  it("collects EL function calls from text and attribute values", () => {
    const parsed = parse(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: JSP source; the ${…} is EL the scanner must read as text.
      '<p>${fn:escapeXml(name)}</p><x:card title="${util:label(a)}"/>',
    );
    expect(parsed.elFunctions).toEqual([
      { prefix: "fn", name: "escapeXml" },
      { prefix: "util", name: "label" },
    ]);
  });

  it("ignores things that only look like prefixed tags", () => {
    const parsed = parse('<script>if (a<b:c) {}</script><a href="x">mailto:me</a> <b:c');
    expect(parsed.elements).toEqual([]);
  });

  it("steps over a stray slash inside a start tag", () => {
    const parsed = parse('<x:card / title="t"></x:card><%@ include file="a.jspf" / %>');
    expect(parsed.elements.map((e) => e.attributes.map((a) => a.name))).toEqual([
      ["title"],
    ]);
    expect(parsed.directives).toHaveLength(1);
  });

  it("classifies by extension", () => {
    expect(parse("", "/a/x.tag").kind).toBe("tag");
    expect(parse("", "/a/x.jspf").kind).toBe("fragment");
    expect(parse("", "/a/x.jsp").kind).toBe("page");
  });
});

describe("parseTld", () => {
  it("reads tags, tag files, functions and the URI", () => {
    const tld = parseTld(`<?xml version="1.0"?>
<taglib>
  <!-- <uri>commented</uri> -->
  <description>Has <name>noise</name></description>
  <short-name>ui</short-name>
  <uri>http://acme.example/ui</uri>
  <tag>
    <name>money</name>
    <tag-class>com.acme.web.MoneyTag</tag-class>
    <attribute><name>value</name><required>true</required></attribute>
    <attribute><name>currency</name></attribute>
  </tag>
  <tag-file><name>card</name><path>/WEB-INF/tags/ui/card.tag</path></tag-file>
  <function>
    <name>label</name>
    <function-class>com.acme.web.Labels</function-class>
    <function-signature>java.lang.String label(java.lang.String)</function-signature>
  </function>
  <listener><listener-class>com.acme.web.Startup</listener-class></listener>
</taglib>`);
    expect(tld).toEqual({
      uri: "http://acme.example/ui",
      tags: [
        {
          name: "money",
          tagClass: "com.acme.web.MoneyTag",
          attributes: [
            { name: "value", required: true },
            { name: "currency", required: false },
          ],
          dynamicAttributes: false,
        },
      ],
      tagFiles: [{ name: "card", path: "/WEB-INF/tags/ui/card.tag" }],
      functions: [{ name: "label", functionClass: "com.acme.web.Labels" }],
      otherClasses: ["com.acme.web.Startup"],
    });
  });
});

describe("parseWebXml", () => {
  it("reads property groups with preludes and taglib mappings", () => {
    const xml = parseWebXml(`<web-app>
  <jsp-config>
    <taglib><taglib-uri>urn:ui</taglib-uri><taglib-location>/WEB-INF/ui.tld</taglib-location></taglib>
    <jsp-property-group>
      <url-pattern>/WEB-INF/views/*</url-pattern>
      <include-prelude>/WEB-INF/includes/prelude.jspf</include-prelude>
    </jsp-property-group>
    <jsp-property-group><url-pattern>*.jsp</url-pattern><page-encoding>UTF-8</page-encoding></jsp-property-group>
  </jsp-config>
</web-app>`);
    expect(xml).toEqual({
      propertyGroups: [
        {
          urlPatterns: ["/WEB-INF/views/*"],
          preludes: ["/WEB-INF/includes/prelude.jspf"],
          codas: [],
        },
      ],
      taglibs: [{ uri: "urn:ui", location: "/WEB-INF/ui.tld" }],
    });
  });
});
