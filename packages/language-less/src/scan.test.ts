import { describe, expect, it } from "vitest";
import { resolveLessProject } from "./resolve.js";
import { parseLessFile } from "./scan.js";

const parse = (source: string) => parseLessFile({ absolutePath: "/a.less", source });

describe("parseLessFile", () => {
  it("reads imports in every form, with their options", () => {
    const parsed = parse(
      [
        '@import "variables";',
        "@import (reference) 'mixins.less';",
        '@import (css, optional) url("print.css") print;',
        "@import url(theme.less);",
        '@import "~bootstrap/less/grid";',
      ].join("\n"),
    );
    expect(parsed.imports).toEqual([
      { path: "variables", options: [], line: 1 },
      { path: "mixins.less", options: ["reference"], line: 2 },
      { path: "print.css", options: ["css", "optional"], line: 3 },
      { path: "theme.less", options: [], line: 4 },
      { path: "~bootstrap/less/grid", options: [], line: 5 },
    ]);
  });

  it("separates top-level variable definitions from uses", () => {
    const parsed = parse(
      [
        "@brand: #337ab7;",
        "@link: darken(@brand, 10%);",
        "@detached: { color: red; };",
        '.a { @local: 1px; color: @link; width: ~"calc(100% - @{gutter})"; }',
        "@media (min-width: @screen-sm) { .b { margin: 0 } }",
      ].join("\n"),
    );
    expect(parsed.variables.map((v) => [v.name, v.line])).toEqual([
      ["brand", 1],
      ["link", 2],
      ["detached", 3],
    ]);
    expect(parsed.variableRefs).toEqual([
      "brand",
      "detached",
      "gutter",
      "link",
      "local",
      "screen-sm",
    ]);
  });

  it("finds mixin definitions, namespaced ones included, and calls", () => {
    const parsed = parse(
      [
        ".clearfix() { &:after { clear: both; } }",
        ".button-variant(@color; @bg) when (iscolor(@color)) { color: @color; }",
        ".plain { color: red; }",
        ".not-a-mixin, .other { color: red; }",
        ".compound.selector { color: red; }",
        "#gradient {",
        "  .vertical(@start; @end) { background: @start; }",
        "}",
        ".btn {",
        "  .clearfix();",
        "  .button-variant(#fff; @brand) !important;",
        "  #gradient > .vertical(red; blue);",
        "  #gradient.horizontal(red; blue);",
        "  .plain",
        "}",
        ".x:extend(.base all) { }",
      ].join("\n"),
    );
    expect(parsed.mixins.map((m) => m.name)).toEqual([
      "clearfix",
      "button-variant",
      "plain",
      "gradient.vertical",
      "btn",
    ]);
    expect(parsed.mixinCalls).toEqual([
      "base",
      "button-variant",
      "clearfix",
      "gradient.horizontal",
      "gradient.vertical",
      "plain",
    ]);
  });

  it("does not read comments, and keeps // inside URLs", () => {
    const parsed = parse(
      [
        "// @import 'commented';",
        "/* @old: 1;",
        "   .gone(); */",
        ".a { background: url(//cdn.example/x.png); color: @kept; }",
      ].join("\n"),
    );
    expect(parsed.imports).toEqual([]);
    expect(parsed.variables).toEqual([]);
    expect(parsed.mixinCalls).toEqual([]);
    expect(parsed.variableRefs).toEqual(["kept"]);
  });

  it("stays linear on hostile input", () => {
    for (const unit of [
      ".m(".repeat(1) + ")".repeat(3),
      "@{",
      "/*",
      "url(",
      "#ns > .m(;",
    ]) {
      const source = unit.repeat(Math.ceil(400_000 / unit.length));
      const started = performance.now();
      parse(source);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe("resolveLessProject", () => {
  const project = (sources: Record<string, string>) => ({
    files: new Map(
      Object.entries(sources).map(([path, source]) => [
        path,
        parseLessFile({ absolutePath: `/repo/${path}`, source }),
      ]),
    ),
    isFile: (path: string) => path in sources,
  });

  it("joins imports and the files defining what a partial uses", () => {
    const result = resolveLessProject(
      project({
        "less/site.less":
          '@import "variables";\n@import "mixins";\n@import "buttons";\n@import "missing";',
        "less/variables.less": "@brand: blue;",
        "less/mixins.less": ".clearfix() { clear: both; }",
        "less/buttons.less": ".btn { color: @brand; .clearfix(); }",
      }),
    );
    expect(
      result.references.map((r) => `${r.from} -> ${r.to} ${r.kind} ${r.specifier}`),
    ).toEqual([
      "less/buttons.less -> less/mixins.less mixin .clearfix",
      "less/buttons.less -> less/variables.less variable @brand",
      "less/site.less -> less/buttons.less import buttons",
      "less/site.less -> less/mixins.less import mixins",
      "less/site.less -> less/variables.less import variables",
    ]);
    expect(result.unresolvedImports).toEqual([
      { file: "less/site.less", line: 4, path: "missing" },
    ]);
  });

  it("draws no usage edge to a name defined in many files, or the file's own", () => {
    const themes = Object.fromEntries(
      ["a", "b", "c", "d"].map((t) => [`themes/${t}.less`, "@primary: red;"]),
    );
    const result = resolveLessProject(
      project({
        ...themes,
        "use.less": ".x { color: @primary; }",
        "self.less": "@mine: 1px; .y { width: @mine; }",
      }),
    );
    expect(result.references).toEqual([]);
  });
});
