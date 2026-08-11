import { describe, expect, it } from "vitest";
import {
  buildPyModuleReferenceIndex,
  hasMainGuard,
  isUnreferencedScript,
  moduleNameOf,
} from "./module-references.js";

const GUARD = 'if __name__ == "__main__":\n    main()\n';

describe("hasMainGuard", () => {
  it("finds the guard in either quote style", () => {
    expect(hasMainGuard(GUARD)).toBe(true);
    expect(hasMainGuard("if __name__ == '__main__':\n    main()")).toBe(true);
  });

  it("is not fooled by __name__ used for anything else", () => {
    expect(hasMainGuard("tracer = trace.get_tracer(__name__)")).toBe(false);
    expect(hasMainGuard('type(x).__name__ == "Asset"')).toBe(false);
  });
});

describe("moduleNameOf", () => {
  it("takes the basename", () => {
    expect(moduleNameOf("a/b/task_runner.py")).toBe("task_runner");
  });

  it("ignores dunder modules, which name a package not a leaf", () => {
    expect(moduleNameOf("pkg/__init__.py")).toBeUndefined();
    expect(moduleNameOf("pkg/__main__.py")).toBeUndefined();
  });

  it("ignores non-Python files", () => {
    expect(moduleNameOf("src/app.ts")).toBeUndefined();
  });
});

describe("buildPyModuleReferenceIndex", () => {
  it("counts an ordinary import", () => {
    const index = buildPyModuleReferenceIndex([
      { file: "scripts/gen.py", source: GUARD },
      { file: "app/main.py", source: "from scripts.gen import build\n" },
    ]);
    expect(index.referencesTo("scripts/gen.py")).toEqual({ total: 1, test: 0 });
  });

  it("counts a dotted string reference the import graph cannot see", () => {
    // The task_runner case: mock.patch("a.b.task_runner.startup").
    const index = buildPyModuleReferenceIndex([
      { file: "sdk/task_runner.py", source: GUARD },
      {
        file: "app/wire.py",
        source: 'patch("airflow.sdk.execution_time.task_runner.startup")\n',
      },
    ]);
    expect(index.referencesTo("sdk/task_runner.py")?.total).toBe(1);
  });

  it("does not count a module referring to itself", () => {
    const index = buildPyModuleReferenceIndex([
      { file: "scripts/gen.py", source: `${GUARD}\n# see scripts.gen for details\n` },
    ]);
    expect(index.referencesTo("scripts/gen.py")).toEqual({ total: 0, test: 0 });
  });

  it("separates test references from the rest", () => {
    const index = buildPyModuleReferenceIndex([
      { file: "sdk/runner.py", source: GUARD },
      { file: "tests/test_runner.py", source: "from sdk.runner import go\n" },
      { file: "app/use.py", source: "from sdk.runner import go\n" },
    ]);
    expect(index.referencesTo("sdk/runner.py")).toEqual({ total: 2, test: 1 });
  });

  it("is word-bounded so a longer name is a different module", () => {
    const index = buildPyModuleReferenceIndex([
      { file: "sdk/runner.py", source: GUARD },
      { file: "app/use.py", source: "from sdk.runner_v2 import go\n" },
    ]);
    expect(index.referencesTo("sdk/runner.py")?.total).toBe(0);
  });
});

describe("isUnreferencedScript", () => {
  const scriptIndex = buildPyModuleReferenceIndex([
    { file: "scripts/gen.py", source: GUARD },
    { file: "sdk/runner.py", source: GUARD },
    { file: "app/use.py", source: "from sdk.runner import go\n" },
  ]);

  it("is true for a guarded module nothing references", () => {
    expect(isUnreferencedScript("scripts/gen.py", GUARD, scriptIndex)).toBe(true);
  });

  it("is false for a guarded module something references", () => {
    // task_runner.py's shape, and the reason the three earlier
    // candidate signals were rejected.
    expect(isUnreferencedScript("sdk/runner.py", GUARD, scriptIndex)).toBe(false);
  });

  /**
   * The bucket 0.25.0 deferred and 0.25.3 took. Inspected across the
   * Python corpus it is 63 findings in 36 modules, every one of them
   * developer or CI tooling with a mirrored unit test —
   * `scripts/ci/prek/check_deprecations.py` referenced once, by
   * `scripts/tests/ci/prek/test_check_deprecations.py`.
   */
  it("is true for a guarded module only tests reference", () => {
    const index = buildPyModuleReferenceIndex([
      { file: "scripts/ci/check.py", source: GUARD },
      {
        file: "scripts/tests/ci/test_check.py",
        source: "from scripts.ci.check import main\n",
      },
    ]);
    expect(index.referencesTo("scripts/ci/check.py")).toEqual({ total: 1, test: 1 });
    expect(isUnreferencedScript("scripts/ci/check.py", GUARD, index)).toBe(true);
  });

  it("is false as soon as one non-test reference exists", () => {
    // The guard is what makes the test-only bar safe, but a single
    // production mention still has to defeat it — that is task_runner.py.
    const index = buildPyModuleReferenceIndex([
      { file: "scripts/ci/check.py", source: GUARD },
      {
        file: "scripts/tests/ci/test_check.py",
        source: "from scripts.ci.check import main\n",
      },
      { file: "app/wire.py", source: 'mock.patch("scripts.ci.check.main")\n' },
    ]);
    expect(isUnreferencedScript("scripts/ci/check.py", GUARD, index)).toBe(false);
  });

  it("is false without a guard, however unreferenced", () => {
    const index = buildPyModuleReferenceIndex([
      { file: "app/orphan.py", source: "def f():\n    pass\n" },
    ]);
    expect(isUnreferencedScript("app/orphan.py", "def f():\n    pass\n", index)).toBe(
      false,
    );
  });

  it("is false when the index is absent, so a stub keeps old behaviour", () => {
    // Missing the exemption costs a false positive; applying it wrongly
    // costs a silence. Fail toward reporting.
    expect(isUnreferencedScript("scripts/gen.py", GUARD, undefined)).toBe(false);
  });
});
