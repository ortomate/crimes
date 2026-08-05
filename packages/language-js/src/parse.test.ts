import { describe, expect, it } from "vitest";
import { parseFile } from "./parse/index.js";

function parse(source: string, ext = ".ts") {
  return parseFile({ absolutePath: `/tmp/x${ext}`, source });
}

describe("parseFile", () => {
  it("counts non-empty lines", () => {
    const result = parse("a\nb\nc\n");
    expect(result.lineCount).toBe(3);
  });

  it("captures function declarations with names", () => {
    const src = `function foo(a: number) {\n  return a;\n}\n`;
    const result = parse(src);
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0]!.name).toBe("foo");
    expect(result.functions[0]!.kind).toBe("function");
    expect(result.functions[0]!.startLine).toBe(1);
    expect(result.functions[0]!.endLine).toBe(3);
  });

  it("captures methods and constructors", () => {
    const src = `class A {\n  constructor() {}\n  m() { return 1; }\n}\n`;
    const result = parse(src);
    const kinds = result.functions.map((f) => f.kind).sort();
    expect(kinds).toEqual(["constructor", "method"]);
  });

  it("infers names for arrow functions assigned to variables", () => {
    const src = `const greet = (name: string) => 'hi ' + name;\n`;
    const result = parse(src);
    expect(result.functions[0]!.name).toBe("greet");
    expect(result.functions[0]!.kind).toBe("arrow");
  });

  it("captures Date.now() and new Date() uses with line numbers", () => {
    const src = `const a = Date.now();\nconst b = new Date('2026-01-01');\n`;
    const result = parse(src);
    // `usage: "value"` on both: each is bound to a `const` that nothing
    // in the snippet compares. See the `usage` block below for the
    // classification rules.
    expect(result.dateNowOrNewDateUses).toEqual([
      { kind: "now", line: 1, usage: "value" },
      {
        kind: "new",
        line: 2,
        argKind: "string-literal",
        argValue: "2026-01-01",
        usage: "value",
      },
    ]);
  });

  it("classifies new Date() with no args as argKind:none", () => {
    const result = parse("const a = new Date();\n");
    expect(result.dateNowOrNewDateUses).toEqual([
      { kind: "new", line: 1, argKind: "none", usage: "value" },
    ]);
  });

  it("classifies new Date(epoch) as argKind:number", () => {
    const result = parse("const a = new Date(1704067200000);\n");
    expect(result.dateNowOrNewDateUses).toEqual([
      {
        kind: "new",
        line: 1,
        argKind: "number",
        argValue: "1704067200000",
        usage: "value",
      },
    ]);
  });

  it("classifies multi-arg new Date() as argKind:expression", () => {
    const result = parse("const a = new Date(2024, 0, 1);\n");
    expect(result.dateNowOrNewDateUses).toEqual([
      { kind: "new", line: 1, argKind: "expression", usage: "value" },
    ]);
  });

  it("classifies new Date(identifier) as argKind:expression", () => {
    const result = parse("const a = new Date(ts);\n");
    expect(result.dateNowOrNewDateUses).toEqual([
      { kind: "new", line: 1, argKind: "expression", usage: "value" },
    ]);
  });

  /**
   * `usage` says what a clock reading is *for*: does it decide a branch,
   * or is it recorded and rendered? `direct_date` splits its evidence
   * and caps its severity on this.
   *
   * Unknown resolves to `compared`, because a misclassification in that
   * direction leaves a finding where it already was, and the other one
   * silently downgrades a real one.
   */
  describe("DateUse.usage", () => {
    it("marks a direct comparison as compared", () => {
      const result = parse("if (Date.now() > deadline) { stop(); }\n");
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("compared");
    });

    it("sees through the arithmetic in a timeout check", () => {
      // The canonical shape, and the reading is three nodes below the
      // comparison: call -> binary minus -> binary >= -> if.
      const result = parse("if (Date.now() - startedAt >= TIMEOUT) { stop(); }\n");
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("compared");
    });

    it("sees through .getTime() on a fresh Date", () => {
      const result = parse("if (new Date().getTime() > deadline) { stop(); }\n");
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("compared");
    });

    it("follows a local binding one hop into a comparison", () => {
      const result = parse(
        "function f(d) {\n  const now = Date.now();\n  return now > d;\n}\n",
      );
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("compared");
    });

    it("marks a recorded timestamp as a value", () => {
      const result = parse("row.completed_at = new Date().toISOString();\n");
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("value");
    });

    it("marks a call argument as a value", () => {
      const result = parse("setElapsed(Date.now() - startedAt);\n");
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("value");
    });

    it("marks a bound-but-never-compared reading as a value", () => {
      const result = parse(
        "function f() {\n  const now = Date.now();\n  return { startedAt: now };\n}\n",
      );
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("value");
    });

    it("terminates on a self-referential binding", () => {
      // The one-hop scan calls back into the classifier for every
      // reference to the name — including the declaration's own. The
      // first version recursed until the stack ran out.
      const result = parse(
        "function f() {\n  const now = Date.now();\n  return now;\n}\n",
      );
      expect(result.dateNowOrNewDateUses[0]!.usage).toBe("value");
    });
  });

  it("collects Date method calls with family and receiver", () => {
    const src =
      "const d = new Date();\n" +
      "const a = d.getUTCHours();\n" +
      "const b = d.getHours();\n" +
      "const c = d.toLocaleDateString('en-GB');\n";
    const result = parse(src);
    expect(result.dateMethodCalls).toEqual([
      { receiver: "d", method: "getUTCHours", family: "utc", line: 2, argCount: 0 },
      { receiver: "d", method: "getHours", family: "local", line: 3, argCount: 0 },
      {
        receiver: "d",
        method: "toLocaleDateString",
        family: "local",
        line: 4,
        argCount: 1,
      },
    ]);
  });

  it("ignores toString and other broad methods", () => {
    const src = "const d = new Date();\nconst s = d.toString();\n";
    const result = parse(src);
    expect(result.dateMethodCalls).toBeUndefined();
  });

  it("ignores chained-receiver method calls (a.b.getHours())", () => {
    const src = "const x = obj.inner.getHours();\n";
    const result = parse(src);
    expect(result.dateMethodCalls).toBeUndefined();
  });

  it("collects day-level arithmetic with magic constants", () => {
    const src =
      "const tomorrow = now + 86400000;\n" + "const lastWeek = ts - 604800000;\n";
    const result = parse(src);
    expect(result.dateArithmetic).toEqual([
      { kind: "add", line: 1, operand: 86400000, unit: "day" },
      { kind: "subtract", line: 2, operand: 604800000, unit: "week" },
    ]);
  });

  it("folds nested * to recognise 24 * 60 * 60 * 1000 as a day", () => {
    const src = "const tomorrow = now + 24 * 60 * 60 * 1000;\n";
    const result = parse(src);
    expect(result.dateArithmetic).toEqual([
      { kind: "add", line: 1, operand: 86400000, unit: "day" },
    ]);
  });

  it("does not flag arbitrary additions", () => {
    const src = "const x = a + 1000;\nconst y = b + offset;\n";
    const result = parse(src);
    expect(result.dateArithmetic).toBeUndefined();
  });

  it("leaves date fields absent when source has no date code", () => {
    const result = parse("export const ok = 1;\n");
    expect(result.dateNowOrNewDateUses).toEqual([]);
    expect(result.dateMethodCalls).toBeUndefined();
    expect(result.dateArithmetic).toBeUndefined();
    expect(result.dateStringConcats).toBeUndefined();
  });

  it('captures `"…" + d.dateMethod()` string concatenation', () => {
    const src =
      "const d = new Date();\n" +
      'const s = "year-" + d.getUTCFullYear();\n' +
      'const t = d.getMonth() + "-month";\n';
    const result = parse(src);
    expect(result.dateStringConcats).toEqual([
      { line: 2, method: "getUTCFullYear" },
      { line: 3, method: "getMonth" },
    ]);
  });

  it("ignores `string + nonDateMethod()` concatenations", () => {
    const src = 'const s = "x-" + obj.toString();\n';
    const result = parse(src);
    expect(result.dateStringConcats).toBeUndefined();
  });

  it("ignores method+method concatenations without a string operand", () => {
    const src = "const s = d.getUTCFullYear() + d.getUTCMonth();\n";
    const result = parse(src);
    expect(result.dateStringConcats).toBeUndefined();
  });

  it("captures typed const/let declarations with annotation text and initializer kind", () => {
    const src =
      "const isReady: boolean = false;\n" +
      "let count: number = 1;\n" +
      "const users: User[] = [];\n";
    const result = parse(src);
    expect(result.typedDeclarations).toEqual([
      {
        name: "isReady",
        declarationKind: "const",
        type: "boolean",
        initializerKind: "boolean_literal",
        exported: false,
        line: 1,
      },
      {
        name: "count",
        declarationKind: "let",
        type: "number",
        initializerKind: "number",
        exported: false,
        line: 2,
      },
      {
        name: "users",
        declarationKind: "const",
        type: "User[]",
        initializerKind: "array",
        exported: false,
        line: 3,
      },
    ]);
  });

  it("marks top-level export modifiers on variable statements", () => {
    const src = 'export const KEY: string = "x";\n';
    const result = parse(src);
    expect(result.typedDeclarations).toEqual([
      {
        name: "KEY",
        declarationKind: "const",
        type: "string",
        initializerKind: "string",
        exported: true,
        line: 1,
      },
    ]);
  });

  it("classifies initializer expressions by shape", () => {
    const src =
      "const isHidden = !visible;\n" +
      "const sameDay = a === b;\n" +
      "const eitherOr = a || b;\n" +
      "const greeting = `hi`;\n" +
      "const obj = { ok: 1 };\n" +
      "const result = fetchSomething();\n" +
      "const other = (x) => x;\n";
    const result = parse(src);
    const byName = Object.fromEntries(
      (result.typedDeclarations ?? []).map((d) => [d.name, d.initializerKind]),
    );
    expect(byName).toEqual({
      isHidden: "negation",
      sameDay: "comparison",
      eitherOr: "logical",
      greeting: "string",
      obj: "object",
      result: "call",
      other: "other",
    });
  });

  it("captures function parameters as typed declarations", () => {
    const src = "function f(loading: boolean, name: string): void {}\n";
    const result = parse(src);
    expect(result.typedDeclarations).toEqual([
      {
        name: "loading",
        declarationKind: "param",
        type: "boolean",
        exported: false,
        line: 1,
      },
      {
        name: "name",
        declarationKind: "param",
        type: "string",
        exported: false,
        line: 1,
      },
    ]);
  });

  it("captures class properties as typed declarations", () => {
    const src =
      "class X {\n" + "  active: boolean = true;\n" + '  label: string = "hi";\n' + "}\n";
    const result = parse(src);
    expect(result.typedDeclarations).toEqual([
      {
        name: "active",
        declarationKind: "property",
        type: "boolean",
        initializerKind: "boolean_literal",
        exported: false,
        line: 2,
      },
      {
        name: "label",
        declarationKind: "property",
        type: "string",
        initializerKind: "string",
        exported: false,
        line: 3,
      },
    ]);
  });

  it("skips destructuring patterns (only simple identifier names)", () => {
    const src = "const { a, b } = obj;\nconst [x, y] = arr;\n";
    const result = parse(src);
    expect(result.typedDeclarations).toBeUndefined();
  });

  it("normalises whitespace in type annotation text", () => {
    const src = "const x: string   |   null = null;\n";
    const result = parse(src);
    expect(result.typedDeclarations?.[0]?.type).toBe("string | null");
  });

  it("normalises Array<User> the same as User[] (both as written)", () => {
    const src = "const a: Array<User> = [];\nconst b: User[] = [];\n";
    const result = parse(src);
    expect(result.typedDeclarations?.map((d) => d.type)).toEqual([
      "Array<User>",
      "User[]",
    ]);
  });

  it("parses TSX without throwing", () => {
    const src = `export const Hello = () => <div>hi</div>;\n`;
    const result = parse(src, ".tsx");
    expect(result.functions).toHaveLength(1);
  });
});

describe("parseFile — sync I/O calls", () => {
  it("captures `fs.readFileSync` with property-access callee and receiver", () => {
    const src =
      "import fs from 'node:fs';\n" +
      "function load() {\n" +
      "  return fs.readFileSync('/etc/x', 'utf8');\n" +
      "}\n";
    const result = parse(src);
    expect(result.syncIoCalls).toEqual([
      {
        callee: "fs.readFileSync",
        method: "readFileSync",
        receiver: "fs",
        line: 3,
        enclosingFunctions: [{ name: "load", shape: "domain", startLine: 2, endLine: 4 }],
      },
    ]);
  });

  it("captures bare-identifier sync calls (named imports)", () => {
    const src =
      "import { existsSync } from 'node:fs';\n" +
      "function check() { return existsSync('/etc/x'); }\n";
    const result = parse(src);
    expect(result.syncIoCalls).toEqual([
      {
        callee: "existsSync",
        method: "existsSync",
        line: 2,
        enclosingFunctions: [
          { name: "check", shape: "domain", startLine: 2, endLine: 2 },
        ],
      },
    ]);
  });

  it("records the full enclosing chain, innermost first", () => {
    const src =
      "import fs from 'node:fs';\n" +
      "describe('x', () => {\n" +
      "  it('y', () => {\n" +
      "    fs.readFileSync('/etc/x');\n" +
      "  });\n" +
      "});\n";
    const result = parse(src);
    const call = result.syncIoCalls?.[0];
    expect(call?.callee).toBe("fs.readFileSync");
    const shapes = call?.enclosingFunctions.map((f) => f.shape) ?? [];
    expect(shapes).toEqual(["test_callback", "test_callback"]);
  });

  it("attributes shape to a Next.js route handler", () => {
    const result = parseFile({
      absolutePath: "/repo/app/api/users/route.ts",
      source:
        "import fs from 'node:fs';\n" +
        "export async function GET() {\n" +
        "  return new Response(fs.readFileSync('/data', 'utf8'));\n" +
        "}\n",
    });
    const call = result.syncIoCalls?.[0];
    expect(call?.enclosingFunctions[0]?.shape).toBe("route_handler");
    expect(call?.enclosingFunctions[0]?.name).toBe("GET");
  });

  it("ignores non-sync calls and unrelated method names", () => {
    const src =
      "import fs from 'node:fs';\n" +
      "function f() {\n" +
      "  fs.readFile('x', cb);\n" +
      "  fs.promises.readFile('x');\n" +
      "  console.log('ok');\n" +
      "}\n";
    const result = parse(src);
    expect(result.syncIoCalls).toBeUndefined();
  });

  it("ignores chained-receiver sync calls (foo.fs.readFileSync())", () => {
    const src = "function f() { return obj.fs.readFileSync('/x'); }\n";
    const result = parse(src);
    expect(result.syncIoCalls).toBeUndefined();
  });

  it("captures top-level sync calls with empty enclosingFunctions", () => {
    const src =
      "import fs from 'node:fs';\n" + "const data = fs.readFileSync('/etc/x', 'utf8');\n";
    const result = parse(src);
    expect(result.syncIoCalls).toEqual([
      {
        callee: "fs.readFileSync",
        method: "readFileSync",
        receiver: "fs",
        line: 2,
        enclosingFunctions: [],
      },
    ]);
  });

  it("leaves syncIoCalls absent when no sync I/O is observed", () => {
    const result = parse("export const ok = 1;\n");
    expect(result.syncIoCalls).toBeUndefined();
  });
});

describe("parseFile — default export", () => {
  it("captures `export default function Foo`", () => {
    const result = parse(`export default function Foo() { return 1; }\n`);
    expect(result.defaultExport).toBe("Foo");
  });

  it("captures `export default class Foo`", () => {
    const result = parse(`export default class Foo { run() {} }\n`);
    expect(result.defaultExport).toBe("Foo");
  });

  it("captures `export default Identifier`", () => {
    const src = `const PricingPage = () => null;\nexport default PricingPage;\n`;
    const result = parse(src);
    expect(result.defaultExport).toBe("PricingPage");
  });

  it("captures `export { Foo as default }`", () => {
    const src = `function Foo() {}\nexport { Foo as default };\n`;
    const result = parse(src);
    expect(result.defaultExport).toBe("Foo");
  });

  it("leaves defaultExport undefined when there is no default export", () => {
    const result = parse(`export const x = 1;\n`);
    expect(result.defaultExport).toBeUndefined();
  });

  it("leaves defaultExport undefined for anonymous default arrows", () => {
    const result = parse(`export default () => null;\n`);
    expect(result.defaultExport).toBeUndefined();
  });
});

describe("parseFile — nav literals", () => {
  it("captures a top-level nav array assigned to a variable", () => {
    const src = `
      const sidebar = [
        { href: "/settings/billing", label: "Billing" },
        { href: "/team", label: "Team" },
      ];
    `;
    const result = parse(src);
    expect(result.navLiterals).toHaveLength(1);
    const nav = result.navLiterals![0]!;
    expect(nav.identifier).toBe("sidebar");
    expect(nav.entries.map((e) => e.destination)).toEqual(["/settings/billing", "/team"]);
    expect(nav.entries.map((e) => e.label)).toEqual(["Billing", "Team"]);
  });

  it("handles `as const` and `satisfies` wrappers", () => {
    const src = `
      export const items = [
        { path: "/a", title: "A" },
        { path: "/b", title: "B" },
      ] as const;
    `;
    const result = parse(src);
    expect(result.navLiterals).toHaveLength(1);
    expect(result.navLiterals![0]!.entries[0]!.destination).toBe("/a");
  });

  it("captures non-key attributes on entries", () => {
    const src = `
      const nav = [
        { href: "/admin", label: "Admin", permission: "owner" },
        { href: "/billing", label: "Billing", permission: "billing.manage" },
      ];
    `;
    const result = parse(src);
    const entries = result.navLiterals![0]!.entries;
    expect(entries[0]!.attributes.permission).toBe("owner");
    expect(entries[1]!.attributes.permission).toBe("billing.manage");
  });

  it("does not fire on arrays without any destination+label entry", () => {
    const src = `
      const counts = [
        { count: "1" },
        { count: "2" },
      ];
    `;
    const result = parse(src);
    expect(result.navLiterals).toEqual([]);
  });

  it("does not fire on single-element arrays", () => {
    const src = `
      const x = [{ href: "/a", label: "A" }];
    `;
    const result = parse(src);
    expect(result.navLiterals).toEqual([]);
  });

  it("captures `export default [...]` nav arrays", () => {
    const src = `
      export default [
        { to: "/a", name: "A" },
        { to: "/b", name: "B" },
      ];
    `;
    const result = parse(src);
    expect(result.navLiterals).toHaveLength(1);
    expect(result.navLiterals![0]!.identifier).toBe("default");
  });
});

describe("parseFile — UI string literals", () => {
  it("captures <title>X</title>", () => {
    const result = parse(
      `export const Head = () => (<title>Subscription</title>);\n`,
      ".tsx",
    );
    expect(result.uiStringLiterals).toContainEqual(
      expect.objectContaining({ value: "Subscription", context: "jsx_title" }),
    );
  });

  it("captures document.title = 'X'", () => {
    const result = parse(`document.title = "Plans";\n`);
    expect(result.uiStringLiterals).toContainEqual(
      expect.objectContaining({ value: "Plans", context: "document_title" }),
    );
  });

  it("captures useTitle('X')", () => {
    const result = parse(`useTitle("Subscription");\n`);
    expect(result.uiStringLiterals).toContainEqual(
      expect.objectContaining({ value: "Subscription", context: "use_title" }),
    );
  });

  it("captures setTitle('X')", () => {
    const result = parse(`setTitle("Plans");\n`);
    expect(result.uiStringLiterals).toContainEqual(
      expect.objectContaining({ value: "Plans", context: "use_title" }),
    );
  });

  it("captures `export const metadata = { title: 'X' }`", () => {
    const result = parse(`export const metadata = { title: "Billing" };\n`);
    expect(result.uiStringLiterals).toContainEqual(
      expect.objectContaining({ value: "Billing", context: "metadata_title" }),
    );
  });

  it("captures <Breadcrumb label='X' />", () => {
    const result = parse(`const X = <Breadcrumb label="Billing" />;\n`, ".tsx");
    expect(result.uiStringLiterals).toContainEqual(
      expect.objectContaining({
        value: "Billing",
        context: "jsx_label",
        source: "Breadcrumb",
      }),
    );
  });

  it("captures <NavLink title='X'>...</NavLink>", () => {
    const result = parse(
      `const X = <NavLink title="Settings">stuff</NavLink>;\n`,
      ".tsx",
    );
    expect(result.uiStringLiterals).toContainEqual(
      expect.objectContaining({ value: "Settings", context: "jsx_label" }),
    );
  });

  it("does not fire on arbitrary string literals", () => {
    const result = parse(`const x = "Just a string";\n`);
    expect(result.uiStringLiterals).toEqual([]);
  });

  it("skips JSX titles with mixed content", () => {
    const result = parse(`const X = <title>Settings — {productName}</title>;\n`, ".tsx");
    expect(result.uiStringLiterals).toEqual([]);
  });
});

describe("parseFile — cli_command_registrar shape", () => {
  it("classifies a `registerXCommand(program)` wrapper as cli_command_registrar", () => {
    const src = `
import type { Command } from "commander";
export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .description("Scan a repository.")
    .option("--all", "show every finding", false)
    .action(() => { return; });
}
`;
    const result = parse(src);
    const fn = result.functions.find((f) => f.name === "registerScanCommand");
    expect(fn).toBeDefined();
    expect(fn!.shape).toBe("cli_command_registrar");
    expect(fn!.shapeEvidence?.some((e) => /register\*Command/.test(e))).toBe(true);
  });

  it("classifies an anonymous `.action(...)` callback as cli_command_registrar", () => {
    const src = `
import type { Command } from "commander";
export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .action(async (path: string) => {
      const x = path;
      return x;
    });
}
`;
    const result = parse(src);
    const callbacks = result.functions.filter(
      (f) => f.shape === "cli_command_registrar" && !f.name,
    );
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]!.kind).toBe("arrow");
  });

  it("leaves a `register` function with no Commander chain alone", () => {
    const src = `
export function registerScanCommand(program: unknown): void {
  console.log(program);
}
`;
    const result = parse(src);
    const fn = result.functions.find((f) => f.name === "registerScanCommand");
    expect(fn).toBeDefined();
    expect(fn!.shape).not.toBe("cli_command_registrar");
  });

  it("classifies a `register*Subcommand(parent)` wrapper as cli_command_registrar", () => {
    // CLIs that compose `feedback list` / `feedback export` style command
    // trees register each sub-tree via a `register*Subcommand(parent)`
    // wrapper, not `register*Command`. Same Commander DSL inside; relax
    // the name pattern so these don't trip large_function.
    const src = `
import type { Command } from "commander";
export function registerFeedbackListSubcommand(parent: Command): void {
  parent
    .command("list")
    .description("List feedback entries.")
    .option("--format <format>", "output format", "human")
    .action(() => { return; });
}
`;
    const result = parse(src);
    const fn = result.functions.find((f) => f.name === "registerFeedbackListSubcommand");
    expect(fn).toBeDefined();
    expect(fn!.shape).toBe("cli_command_registrar");
  });

  it("does not classify .action callbacks outside a .command chain", () => {
    // A standalone `something.action(...)` call that isn't preceded by
    // `.command(...)` is not a Commander DSL — it could be Redux, Zustand,
    // etc. Don't grab them.
    const src = `
store.action(() => { return; });
`;
    const result = parse(src);
    const arrows = result.functions.filter((f) => f.kind === "arrow");
    expect(arrows.every((f) => f.shape !== "cli_command_registrar")).toBe(true);
  });
});

describe("parseFile — cross-language surfaces (0.15.0)", () => {
  it("captures fetch() with a literal same-origin path", () => {
    const p = parse(`
      const r = await fetch("/api/users");
      const s = await fetch("/api/invoices", { method: "POST" });
    `);
    expect(p.fetchSites?.map((f) => [f.method, f.url])).toEqual([
      ["get", "/api/users"],
      ["post", "/api/invoices"],
    ]);
  });

  it("captures axios/client wrappers", () => {
    const p = parse(`
      await axios.get("/api/a");
      await client.post("/api/b");
    `);
    expect(p.fetchSites?.map((f) => [f.method, f.url])).toEqual([
      ["get", "/api/a"],
      ["post", "/api/b"],
    ]);
  });

  it("skips absolute third-party URLs and runtime-built paths", () => {
    const p = parse(`
      await fetch("https://example.com/api/users");
      await fetch(\`\${base}/api/users\`);
      await fetch(pathVar);
    `);
    expect(p.fetchSites).toBeUndefined();
  });

  it("does not treat an unrelated .get as a request", () => {
    const p = parse(`cache.get("/not-a-request");`);
    expect(p.fetchSites).toBeUndefined();
  });

  it("captures a string-literal union type alias", () => {
    const p = parse(`export type Plan = "free" | "pro" | "enterprise";`);
    expect(p.stringUnionTypes).toEqual([
      { name: "Plan", members: ["free", "pro", "enterprise"], exported: true, line: 1 },
    ]);
  });

  it("captures a single-member alias", () => {
    const p = parse(`type Only = "one";`);
    expect(p.stringUnionTypes?.[0]?.members).toEqual(["one"]);
  });

  it("skips a union that is not a closed set of strings", () => {
    // A partial member list would invent a disagreement that isn't there.
    const p = parse(`
      type Loose = "free" | string;
      type Mixed = "a" | 1;
      type Ref = "a" | Other;
    `);
    expect(p.stringUnionTypes).toBeUndefined();
  });

  it("omits both surfaces entirely on a file that has neither", () => {
    const p = parse(`export const x = 1;`);
    expect(p.fetchSites).toBeUndefined();
    expect(p.stringUnionTypes).toBeUndefined();
  });
});
