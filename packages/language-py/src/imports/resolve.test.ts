import { describe, expect, it } from "vitest";
import {
  buildPyModuleIndex,
  resolvePyImports,
  type PyImportSpecifierInput,
} from "./resolve.js";

const FLAT_LAYOUT = [
  "billing/__init__.py",
  "billing/service.py",
  "billing/rates.py",
  "billing/tax/__init__.py",
  "billing/tax/vat.py",
  "app.py",
  "tests/test_service.py",
];

const SRC_LAYOUT = [
  "src/billing/__init__.py",
  "src/billing/service.py",
  "src/billing/rates.py",
  "pyproject.toml",
];

describe("buildPyModuleIndex", () => {
  it("maps a flat package layout to dotted module paths", () => {
    const index = buildPyModuleIndex(FLAT_LAYOUT);
    expect(index.moduleToFile.get("billing")).toBe("billing/__init__.py");
    expect(index.moduleToFile.get("billing.service")).toBe("billing/service.py");
    expect(index.moduleToFile.get("billing.tax")).toBe("billing/tax/__init__.py");
    expect(index.moduleToFile.get("billing.tax.vat")).toBe("billing/tax/vat.py");
    expect(index.moduleToFile.get("app")).toBe("app.py");
  });

  it("treats a src/ directory as a path root because it has no __init__.py", () => {
    const index = buildPyModuleIndex(SRC_LAYOUT);
    expect(index.moduleToFile.get("billing.service")).toBe("src/billing/service.py");
    expect(index.moduleToFile.has("src.billing.service")).toBe(false);
  });

  it("records the package each file belongs to", () => {
    const index = buildPyModuleIndex(FLAT_LAYOUT);
    expect(index.filePackage.get("billing/service.py")).toBe("billing");
    expect(index.filePackage.get("billing/tax/vat.py")).toBe("billing.tax");
    // An __init__.py is *in* its own package.
    expect(index.filePackage.get("billing/tax/__init__.py")).toBe("billing.tax");
    // A directory with no __init__.py is not a package.
    expect(index.filePackage.get("tests/test_service.py")).toBe("");
    expect(index.filePackage.get("app.py")).toBe("");
  });

  it("prefers the .py module over a .pyi stub of the same name", () => {
    const index = buildPyModuleIndex(["pkg/__init__.py", "pkg/api.py", "pkg/api.pyi"]);
    expect(index.moduleToFile.get("pkg.api")).toBe("pkg/api.py");
  });

  it("ignores non-Python files", () => {
    const index = buildPyModuleIndex(["a.py", "README.md", "b.ts"]);
    expect([...index.moduleToFile.keys()]).toEqual(["a"]);
  });
});

function resolve(
  files: string[],
  specs: PyImportSpecifierInput[],
): Array<[string, string, boolean]> {
  const index = buildPyModuleIndex(files);
  return resolvePyImports({ index, specifiers: specs }).map((e) => [
    e.specifier,
    e.to,
    e.external,
  ]);
}

describe("resolvePyImports — absolute imports", () => {
  it("resolves an absolute module to its file", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "app.py",
          module: "billing.service",
          relativeLevel: 0,
          names: [],
          kind: "import",
        },
      ]),
    ).toEqual([["billing.service", "billing/service.py", false]]);
  });

  it("resolves a from-import to the package and to the named submodule", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "app.py",
          module: "billing",
          relativeLevel: 0,
          names: ["service", "Customer"],
          kind: "from_import",
        },
      ]),
    ).toEqual([
      ["billing", "billing/__init__.py", false],
      ["billing", "billing/service.py", false],
    ]);
  });

  it("marks stdlib and third-party modules external", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        { from: "app.py", module: "os", relativeLevel: 0, names: [], kind: "import" },
        {
          from: "app.py",
          module: "requests",
          relativeLevel: 0,
          names: ["get"],
          kind: "from_import",
        },
      ]),
    ).toEqual([
      ["os", "", true],
      ["requests", "", true],
    ]);
  });
});

describe("resolvePyImports — relative imports", () => {
  it("resolves `from . import x` against the current package", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "billing/service.py",
          module: "",
          relativeLevel: 1,
          names: ["rates"],
          kind: "from_import",
        },
      ]),
    ).toEqual([
      // `.` is the `billing` package itself, plus the named submodule.
      [".", "billing/__init__.py", false],
      [".", "billing/rates.py", false],
    ]);
  });

  it("resolves `from .mod import x` as a sibling module", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "billing/service.py",
          module: "rates",
          relativeLevel: 1,
          names: ["standard"],
          kind: "from_import",
        },
      ]),
    ).toEqual([[".rates", "billing/rates.py", false]]);
  });

  it("walks up one package per extra dot", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "billing/tax/vat.py",
          module: "rates",
          relativeLevel: 2,
          names: [],
          kind: "from_import",
        },
      ]),
    ).toEqual([["..rates", "billing/rates.py", false]]);
  });

  it("resolves a relative import in a src layout", () => {
    expect(
      resolve(SRC_LAYOUT, [
        {
          from: "src/billing/service.py",
          module: "rates",
          relativeLevel: 1,
          names: [],
          kind: "from_import",
        },
      ]),
    ).toEqual([[".rates", "src/billing/rates.py", false]]);
  });

  it("records an unresolved relative import as non-external", () => {
    // A relative import that fails is a real intra-repo reference we
    // could not place (namespace package, generated module) — calling it
    // "external" would be a lie.
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "billing/service.py",
          module: "missing",
          relativeLevel: 1,
          names: [],
          kind: "from_import",
        },
      ]),
    ).toEqual([[".missing", "", false]]);
  });

  it("does not resolve above the repo root", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "billing/service.py",
          module: "",
          relativeLevel: 5,
          names: ["x"],
          kind: "from_import",
        },
      ]),
    ).toEqual([[".....", "", false]]);
  });
});

describe("resolvePyImports — edge cases", () => {
  it("never emits a self-edge", () => {
    expect(
      resolve(FLAT_LAYOUT, [
        {
          from: "billing/__init__.py",
          module: "billing",
          relativeLevel: 0,
          names: [],
          kind: "import",
        },
      ]),
    ).toEqual([]);
  });

  it("deduplicates repeated specifiers", () => {
    const spec: PyImportSpecifierInput = {
      from: "app.py",
      module: "billing.service",
      relativeLevel: 0,
      names: [],
      kind: "import",
    };
    expect(resolve(FLAT_LAYOUT, [spec, spec])).toHaveLength(1);
  });

  it("returns edges in a deterministic order", () => {
    const specs: PyImportSpecifierInput[] = [
      { from: "b.py", module: "billing", relativeLevel: 0, names: [], kind: "import" },
      { from: "a.py", module: "billing", relativeLevel: 0, names: [], kind: "import" },
    ];
    const forward = resolve([...FLAT_LAYOUT, "a.py", "b.py"], specs);
    const reversed = resolve([...FLAT_LAYOUT, "a.py", "b.py"], [...specs].reverse());
    expect(forward).toEqual(reversed);
  });
});
