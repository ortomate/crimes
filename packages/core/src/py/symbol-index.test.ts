import { buildPyModuleIndex } from "@crimes/language-py";
import { describe, expect, it } from "vitest";
import { buildPySymbolIndex, collectPyFileSymbols } from "./symbol-index.js";
import type { PyFileSymbolsInput } from "./symbol-index.js";

/**
 * Hand-built inputs rather than real parses: these tests are about the
 * *resolution* rule, and driving them through tree-sitter would make
 * the MRO the thing that is hardest to see.
 */
function file(
  path: string,
  spec: {
    classes?: Array<{
      name: string;
      bases?: string[];
      methods?: Array<[string, boolean]>;
    }>;
    functions?: Array<[string, boolean]>;
    imports?: Array<{ module: string; names?: string[]; level?: number; alias?: string }>;
  },
): PyFileSymbolsInput {
  let line = 0;
  const method = ([name, asserts]: [string, boolean]) => {
    line += 10;
    return { name, startLine: line, endLine: line + 5, asserts };
  };
  return {
    file: path,
    classes: (spec.classes ?? []).map((c) => ({
      name: c.name,
      bases: c.bases ?? [],
      methods: (c.methods ?? []).map(method),
    })),
    functions: (spec.functions ?? []).map(method),
    imports: (spec.imports ?? []).map((i) => ({
      from: path,
      module: i.module,
      relativeLevel: i.level ?? 0,
      names: i.names ?? [],
      kind: (i.names ?? []).length > 0 ? ("from_import" as const) : ("import" as const),
      ...(i.alias !== undefined ? { alias: i.alias } : {}),
    })),
  };
}

function indexOf(files: PyFileSymbolsInput[]) {
  return buildPySymbolIndex({
    files,
    moduleIndex: buildPyModuleIndex(files.map((f) => f.file)),
  });
}

describe("buildPySymbolIndex — resolving a method through the MRO", () => {
  it("finds an asserting method on a base class in another file", () => {
    // zulip's case: `test_message_delete.py` asserts through
    // `self.capture_send_event_calls(...)`, a context manager on
    // `ZulipTestCase` in `zerver/lib/test_classes.py`.
    const index = indexOf([
      file("zerver/lib/test_classes.py", {
        classes: [
          { name: "ZulipTestCase", methods: [["capture_send_event_calls", true]] },
        ],
      }),
      file("zerver/__init__.py", {}),
      file("zerver/lib/__init__.py", {}),
      file("zerver/tests/test_message_delete.py", {
        imports: [{ module: "zerver.lib.test_classes", names: ["ZulipTestCase"] }],
        classes: [
          {
            name: "DeleteMessageTest",
            bases: ["ZulipTestCase"],
            methods: [["test_x", false]],
          },
        ],
      }),
    ]);

    const found = index.resolveMethod(
      "zerver/tests/test_message_delete.py",
      "DeleteMessageTest",
      "capture_send_event_calls",
    );
    expect(found?.asserts).toBe(true);
    expect(found?.file).toBe("zerver/lib/test_classes.py");
  });

  it("walks more than one level of inheritance", () => {
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/base.py", { classes: [{ name: "Root", methods: [["check", true]] }] }),
      file("pkg/mid.py", {
        imports: [{ module: "pkg.base", names: ["Root"] }],
        classes: [{ name: "Mid", bases: ["Root"] }],
      }),
      file("pkg/leaf.py", {
        imports: [{ module: "pkg.mid", names: ["Mid"] }],
        classes: [{ name: "Leaf", bases: ["Mid"] }],
      }),
    ]);
    expect(index.resolveMethod("pkg/leaf.py", "Leaf", "check")?.asserts).toBe(true);
  });

  it("resolves a base written as a dotted path", () => {
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/base.py", { classes: [{ name: "Root", methods: [["check", true]] }] }),
      file("pkg/leaf.py", {
        imports: [{ module: "pkg.base" }],
        classes: [{ name: "Leaf", bases: ["pkg.base.Root"] }],
      }),
    ]);
    expect(index.resolveMethod("pkg/leaf.py", "Leaf", "check")?.asserts).toBe(true);
  });

  it("resolves a base reached through a relative import", () => {
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/base.py", { classes: [{ name: "Root", methods: [["check", true]] }] }),
      file("pkg/leaf.py", {
        imports: [{ module: "base", names: ["Root"], level: 1 }],
        classes: [{ name: "Leaf", bases: ["Root"] }],
      }),
    ]);
    expect(index.resolveMethod("pkg/leaf.py", "Leaf", "check")?.asserts).toBe(true);
  });

  it("prefers a method the class defines itself over an inherited one", () => {
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/base.py", { classes: [{ name: "Root", methods: [["check", true]] }] }),
      file("pkg/leaf.py", {
        imports: [{ module: "pkg.base", names: ["Root"] }],
        classes: [{ name: "Leaf", bases: ["Root"], methods: [["check", false]] }],
      }),
    ]);
    expect(index.resolveMethod("pkg/leaf.py", "Leaf", "check")?.asserts).toBe(false);
  });
});

describe("buildPySymbolIndex — what it refuses to resolve", () => {
  it("does NOT match a same-named method on an unrelated class", () => {
    // The `has()` case from `2e9b2da`. Two classes, no inheritance
    // between them, one method name. Crediting here would mean a test
    // is credited with an assertion it does not make — a false negative
    // in a detector about false confidence, which is worse than the
    // miss it replaces.
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/a.py", { classes: [{ name: "Alpha", methods: [["verify", true]] }] }),
      file("pkg/b.py", { classes: [{ name: "Beta", methods: [["verify", true]] }] }),
      file("pkg/test_thing.py", {
        classes: [{ name: "Standalone", methods: [["test_x", false]] }],
      }),
    ]);
    expect(
      index.resolveMethod("pkg/test_thing.py", "Standalone", "verify"),
    ).toBeUndefined();
  });

  it("does not resolve a base it cannot reach through an import", () => {
    // `ZulipTestCase` exists in the repo, but the test file never
    // imports it. Without the import there is no evidence these two
    // names refer to the same class.
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/base.py", { classes: [{ name: "Root", methods: [["check", true]] }] }),
      file("pkg/leaf.py", { classes: [{ name: "Leaf", bases: ["Root"] }] }),
    ]);
    expect(index.resolveMethod("pkg/leaf.py", "Leaf", "check")).toBeUndefined();
  });

  it("terminates on an inheritance cycle", () => {
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/a.py", {
        imports: [{ module: "pkg.b", names: ["B"] }],
        classes: [{ name: "A", bases: ["B"] }],
      }),
      file("pkg/b.py", {
        imports: [{ module: "pkg.a", names: ["A"] }],
        classes: [{ name: "B", bases: ["A"] }],
      }),
    ]);
    expect(index.resolveMethod("pkg/a.py", "A", "nope")).toBeUndefined();
  });

  it("stops at the depth bound rather than walking an arbitrary chain", () => {
    const files: PyFileSymbolsInput[] = [file("pkg/__init__.py", {})];
    const DEPTH = 12;
    files.push(
      file("pkg/c0.py", { classes: [{ name: "C0", methods: [["check", true]] }] }),
    );
    for (let i = 1; i <= DEPTH; i += 1) {
      files.push(
        file(`pkg/c${i}.py`, {
          imports: [{ module: `pkg.c${i - 1}`, names: [`C${i - 1}`] }],
          classes: [{ name: `C${i}`, bases: [`C${i - 1}`] }],
        }),
      );
    }
    const index = indexOf(files);
    expect(index.resolveMethod("pkg/c3.py", "C3", "check")?.asserts).toBe(true);
    expect(index.resolveMethod(`pkg/c${DEPTH}.py`, `C${DEPTH}`, "check")).toBeUndefined();
  });
});

describe("buildPySymbolIndex — module-level functions", () => {
  it("resolves a helper imported by name from another module", () => {
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/helpers.py", { functions: [["check_valid", true]] }),
      file("pkg/test_thing.py", {
        imports: [{ module: "pkg.helpers", names: ["check_valid"] }],
      }),
    ]);
    expect(index.resolveFunction("pkg/test_thing.py", "check_valid")?.asserts).toBe(true);
  });

  it("does not resolve a bare name the file never imported", () => {
    const index = indexOf([
      file("pkg/__init__.py", {}),
      file("pkg/helpers.py", { functions: [["check_valid", true]] }),
      file("pkg/test_thing.py", {}),
    ]);
    expect(index.resolveFunction("pkg/test_thing.py", "check_valid")).toBeUndefined();
  });
});

describe("collectPyFileSymbols — reading a parsed file", () => {
  it("marks a method as asserting when an assertion falls in its span", () => {
    const symbols = collectPyFileSymbols("t.py", {
      classes: [{ name: "C", bases: ["Base"], startLine: 1, endLine: 20 }],
      functions: [
        { name: "does", className: "C", startLine: 2, endLine: 6 },
        { name: "does_not", className: "C", startLine: 8, endLine: 12 },
        { name: "module_level", startLine: 14, endLine: 18 },
      ],
      assertions: [{ line: 4 }, { line: 16 }],
      imports: [],
    });
    const cls = symbols.classes[0];
    expect(cls?.bases).toEqual(["Base"]);
    expect(cls?.methods.find((m) => m.name === "does")?.asserts).toBe(true);
    expect(cls?.methods.find((m) => m.name === "does_not")?.asserts).toBe(false);
    expect(symbols.functions.find((f) => f.name === "module_level")?.asserts).toBe(true);
  });

  it("keeps a method out of the module-level function list", () => {
    const symbols = collectPyFileSymbols("t.py", {
      classes: [{ name: "C", bases: [], startLine: 1, endLine: 9 }],
      functions: [{ name: "helper", className: "C", startLine: 2, endLine: 5 }],
      assertions: [],
      imports: [],
    });
    expect(symbols.functions).toHaveLength(0);
    expect(symbols.classes[0]?.methods).toHaveLength(1);
  });
});
