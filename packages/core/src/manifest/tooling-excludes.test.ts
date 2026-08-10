import { describe, expect, it } from "vitest";
import {
  TOOLING_EXCLUDE_TABLES,
  corroborate,
  normaliseExcludePattern,
  readPyprojectExcludes,
} from "./tooling-excludes.js";

/** Convenience: just the glob strings, order-independent. */
function globs(toml: string): string[] {
  return readPyprojectExcludes(toml)
    .flatMap((e) => e.patterns)
    .sort();
}

describe("readPyprojectExcludes — the safety cases first", () => {
  it("ignores an exclude under a table that is not on the allowlist", () => {
    // airflow, pyproject.toml line 589. A reader that honours "any
    // exclude key" reports the entire repository as clean. This is the
    // single most important assertion in the file.
    const toml = [
      "[tool.hatch.build.targets.sdist]",
      'exclude = ["*"]',
      "",
      "[tool.hatch.build.targets.wheel]",
      "bypass-selection = true",
    ].join("\n");
    expect(readPyprojectExcludes(toml)).toEqual([]);
  });

  it("ignores a key that merely starts with skip", () => {
    // airflow again: [tool.coverage.report] skip_empty = true.
    const toml = ["[tool.coverage.report]", "skip_empty = true"].join("\n");
    expect(readPyprojectExcludes(toml)).toEqual([]);
  });

  it("ignores a key that merely starts with exclude", () => {
    // [tool.uv] exclude-newer = "4 days" — an exclude-prefixed key whose
    // value is a duration, not a path.
    const toml = ["[tool.uv]", 'exclude-newer = "4 days"'].join("\n");
    expect(readPyprojectExcludes(toml)).toEqual([]);
  });

  it("excludes nothing from a file it cannot make sense of", () => {
    // Truncated mid-array. The safe direction is always "scan it":
    // missing an exclusion costs noise, inventing one costs silence.
    const toml = ["[tool.ruff]", "extend-exclude = ['pydantic/v1',"].join("\n");
    expect(readPyprojectExcludes(toml)).toEqual([]);
  });

  it("excludes nothing from an empty or absent file", () => {
    expect(readPyprojectExcludes("")).toEqual([]);
    expect(readPyprojectExcludes("# just a comment\n")).toEqual([]);
  });

  it("does not treat a bare `exclude` outside any table as tool config", () => {
    expect(readPyprojectExcludes('exclude = ["src"]')).toEqual([]);
  });
});

describe("readPyprojectExcludes — the four tables it does honour", () => {
  it("reads ruff extend-exclude", () => {
    const toml = [
      "[tool.ruff]",
      "line-length = 120",
      "extend-exclude = ['pydantic/v1', 'tests/mypy', 'tests/pydantic_core']",
    ].join("\n");
    const [entry] = readPyprojectExcludes(toml);
    expect(entry?.table).toBe("tool.ruff");
    expect(entry?.key).toBe("extend-exclude");
    expect(entry?.patterns).toEqual(["pydantic/v1", "tests/mypy", "tests/pydantic_core"]);
  });

  it("reads coverage omit", () => {
    const toml = [
      "[tool.coverage.run]",
      "branch = true",
      "omit = ['pydantic/deprecated/*', 'pydantic/v1/*']",
    ].join("\n");
    expect(globs(toml)).toEqual(["pydantic/deprecated/*", "pydantic/v1/*"]);
  });

  it("reads pyright exclude — which is the table pydantic actually has", () => {
    // The backlog names this one "mypy". pydantic has no [tool.mypy]
    // table at all; the third exclusion is [tool.pyright]. It matters
    // because pyright takes globs and mypy takes regexes.
    const toml = [
      "[tool.pyright]",
      "exclude = ['pydantic/_hypothesis_plugin.py', 'pydantic/mypy.py', 'pydantic/v1']",
    ].join("\n");
    expect(globs(toml)).toContain("pydantic/v1");
  });

  it("ignores [tool.mypy] entirely, because its exclude is a regex dialect", () => {
    // airflow's is [".*/node_modules/.*", ".*/\\..*"]. Read as globs
    // those match nothing at best and the wrong thing at worst.
    const toml = ["[tool.mypy]", "exclude = ['.*/node_modules/.*']"].join("\n");
    expect(readPyprojectExcludes(toml)).toEqual([]);
  });

  it("reads codespell skip, which is legitimately a comma-separated string", () => {
    // pydantic: skip = '.git,env*,pydantic/v1/*,uv.lock'. So "reject
    // every string value" is not the rule either.
    const toml = ["[tool.codespell]", "skip = '.git,env*,pydantic/v1/*,uv.lock'"].join(
      "\n",
    );
    expect(globs(toml)).toEqual([".git", "env*", "pydantic/v1/*", "uv.lock"]);
  });

  it("reads a multi-line array", () => {
    const toml = [
      "[tool.ruff]",
      "extend-exclude = [",
      '  "generated/",',
      '  "vendor/",  # third party',
      "]",
    ].join("\n");
    expect(globs(toml)).toEqual(["generated/", "vendor/"]);
  });

  it("keeps one entry per table+key so provenance survives", () => {
    const toml = [
      "[tool.ruff]",
      "extend-exclude = ['a']",
      "[tool.pyright]",
      "exclude = ['b']",
      "[tool.coverage.run]",
      "omit = ['c']",
    ].join("\n");
    const entries = readPyprojectExcludes(toml);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => `${e.table}.${e.key}`).sort()).toEqual([
      "tool.coverage.run.omit",
      "tool.pyright.exclude",
      "tool.ruff.extend-exclude",
    ]);
  });

  it("does not let a later table leak into an earlier one's key", () => {
    const toml = [
      "[tool.ruff]",
      "line-length = 120",
      "[tool.hatch.build.targets.sdist]",
      'exclude = ["*"]',
    ].join("\n");
    expect(readPyprojectExcludes(toml)).toEqual([]);
  });

  it("ignores a commented-out exclusion", () => {
    const toml = ["[tool.ruff]", "# extend-exclude = ['everything']"].join("\n");
    expect(readPyprojectExcludes(toml)).toEqual([]);
  });

  it("drops empty strings rather than emitting a match-everything glob", () => {
    const toml = ["[tool.codespell]", "skip = 'a,,b'"].join("\n");
    expect(globs(toml)).toEqual(["a", "b"]);
  });
});

describe("the allowlist itself", () => {
  it("names only tables that describe source a repo does not maintain", () => {
    // A test on the *policy*, not the parser: adding a table here widens
    // a silent-suppression mechanism, so it should be a deliberate edit
    // that fails this assertion first.
    const tables = [...new Set(TOOLING_EXCLUDE_TABLES.map((t) => t.table))].sort();
    expect(tables).toEqual([
      "tool.codespell",
      "tool.coverage.run",
      "tool.pyright",
      "tool.ruff",
    ]);
  });

  it("does not contain any hatch or build-backend table", () => {
    for (const { table } of TOOLING_EXCLUDE_TABLES) {
      expect(table).not.toMatch(/hatch|setuptools|poetry\.build|flit/);
    }
  });
});

describe("corroboration — one tool is not enough", () => {
  const pydantic = [
    "[tool.ruff]",
    "extend-exclude = ['pydantic/v1', 'tests/mypy', 'tests/pydantic_core']",
    "[tool.coverage.run]",
    "omit = ['pydantic/deprecated/*', 'pydantic/v1/*']",
    "[tool.codespell]",
    "skip = '.git,env*,pydantic/v1/*,uv.lock'",
  ].join("\n");

  it("skips a path three independent tools exclude", () => {
    const out = corroborate(readPyprojectExcludes(pydantic));
    const v1 = out.find((e) => e.pattern === "pydantic/v1");
    expect(v1?.tools).toEqual(["codespell", "coverage", "ruff"]);
  });

  it("treats v1, v1/* and v1/** as one directory", () => {
    // Without normalisation these corroborate at 1 each and the real
    // case is missed entirely.
    expect(normaliseExcludePattern("pydantic/v1/*")).toBe("pydantic/v1");
    expect(normaliseExcludePattern("pydantic/v1/**")).toBe("pydantic/v1");
    expect(normaliseExcludePattern("pydantic/v1/")).toBe("pydantic/v1");
  });

  it("leaves a path only one tool excludes alone", () => {
    const out = corroborate(readPyprojectExcludes(pydantic)).map((e) => e.pattern);
    // ruff alone says tests/mypy; coverage alone says pydantic/deprecated.
    expect(out).not.toContain("tests/mypy");
    expect(out).not.toContain("pydantic/deprecated");
  });

  it("does not let one tool corroborate with itself across two keys", () => {
    const toml = [
      "[tool.ruff]",
      "exclude = ['legacy']",
      "extend-exclude = ['legacy']",
    ].join("\n");
    expect(corroborate(readPyprojectExcludes(toml))).toEqual([]);
  });

  it("never produces a match-everything pattern", () => {
    const toml = [
      "[tool.ruff]",
      "exclude = ['*']",
      "[tool.coverage.run]",
      "omit = ['**']",
    ].join("\n");
    expect(corroborate(readPyprojectExcludes(toml))).toEqual([]);
  });

  it("records the exact authorities so a warning can cite them", () => {
    const [entry] = corroborate(readPyprojectExcludes(pydantic));
    expect(entry?.authorities).toEqual([
      "tool.codespell.skip",
      "tool.coverage.run.omit",
      "tool.ruff.extend-exclude",
    ]);
  });
});
