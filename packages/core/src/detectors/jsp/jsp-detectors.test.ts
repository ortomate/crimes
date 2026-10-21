import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScanReport } from "../../finding.js";
import { context } from "../../context.js";
import { scan } from "../../scan.js";

const WEB = "web/src/main/webapp";

/**
 * A small web application: a shared fragment of taglib declarations that
 * three pages include, a tag file with a required attribute, a Java class
 * a page imports, and a LESS bundle with a variables file the partials
 * use without importing it.
 */
const FILES: Record<string, string> = {
  [`${WEB}/WEB-INF/includes/global.jspf`]:
    '<%@ taglib prefix="ui" tagdir="/WEB-INF/tags/ui" %>\n',
  [`${WEB}/WEB-INF/tags/ui/card.tag`]:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JSP source; the ${title} is EL.
    '<%@ attribute name="title" required="true" %>\n<div class="card">${title}</div>\n',
  [`${WEB}/WEB-INF/views/home.jsp`]: [
    '<%@ include file="/WEB-INF/includes/global.jspf" %>',
    '<%@ page import="com.acme.web.Money" %>',
    '<ui:card title="Home"/>',
    "",
  ].join("\n"),
  [`${WEB}/WEB-INF/views/about.jsp`]: [
    '<%@ include file="/WEB-INF/includes/global.jspf" %>',
    '<%@ include file="/WEB-INF/includes/moved-away.jspf" %>',
    "<ui:card/>",
    "",
  ].join("\n"),
  [`${WEB}/WEB-INF/views/contact.jsp`]: [
    '<%@ include file="/WEB-INF/includes/global.jspf" %>',
    '<%@ include file="/WEB-INF/from-a-library/header.jspf" %>',
    '<ui:card title="Contact"/>',
    "",
  ].join("\n"),
  "src/main/java/com/acme/web/Money.java":
    "package com.acme.web;\n\npublic class Money {}\n",
  "styles/site.less": '@import "variables";\n@import "buttons";\n',
  "styles/variables.less": "@brand: #337ab7;\n",
  "styles/buttons.less": ".btn { color: @brand; }\n",
  // A page that tries to restyle, then imports the file that undoes it.
  "styles/promo.less": '@brand: #c00;\n@import "variables";\n.promo { color: @brand; }\n',
};

describe("JSP and LESS through scan()", () => {
  let root: string;
  let report: ScanReport;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "crimes-jsp-"));
    for (const [path, source] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    report = await scan({ root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("counts templates, descriptors and stylesheets under their packs", () => {
    expect(report.coverage?.files_by_language).toMatchObject({
      jsp: 5,
      less: 4,
      java: 1,
    });
    expect(report.coverage?.packs_loaded).toContain("language-jsp");
    expect(report.coverage?.packs_loaded).toContain("language-less");
  });

  it("reports what breaks at request time, and nothing a library supplies", () => {
    const dangling = report.findings.filter(
      (f) => f.type === "dangling_template_reference",
    );
    expect(dangling.map((f) => [f.file, f.lines?.[0], f.claim])).toEqual([
      [`${WEB}/WEB-INF/views/about.jsp`, 2, "missing_include"],
      [`${WEB}/WEB-INF/views/about.jsp`, 3, "tag_contract"],
    ]);
    expect(
      dangling.every((f) => f.detector_id === "dangling_template_reference.jsp"),
    ).toBe(true);
    const contract = dangling.find((f) => f.claim === "tag_contract")!;
    expect(contract.evidence).toContain("required, not passed: title");
  });

  it("scores templates with no test gap", () => {
    const dangling = report.findings.find((f) => f.claim === "missing_include")!;
    expect(dangling.scores.test_gap).toBe(0);
  });

  it("tells an agent which pages use a tag, and does not call it tested", async () => {
    const report = await context({ root, file: `${WEB}/WEB-INF/tags/ui/card.tag` });
    expect(report.related_files.map((r) => r.file).sort()).toEqual(
      expect.arrayContaining([
        `${WEB}/WEB-INF/views/about.jsp`,
        `${WEB}/WEB-INF/views/contact.jsp`,
        `${WEB}/WEB-INF/views/home.jsp`,
      ]),
    );
    expect(report.clues?.test_gap).toBeUndefined();
    expect(report.likely_tests_reason).toMatch(/no unit-test convention/);
  });

  it("reports a LESS override a later import undoes", () => {
    const overridden = report.findings.filter((f) => f.type === "overridden_variable");
    expect(overridden.map((f) => [f.file, f.lines?.[0], f.claim, f.symbol])).toEqual([
      ["styles/promo.less", 1, "different_value", "@brand"],
    ]);
    expect(overridden[0]!.evidence).toContain(
      "overridden by: `@brand: #337ab7` at styles/variables.less:1",
    );
  });

  it("joins a LESS partial to the file defining what it uses", async () => {
    const report = await context({ root, file: "styles/variables.less" });
    expect(report.related_files.map((r) => r.file)).toContain("styles/buttons.less");
  });
});
