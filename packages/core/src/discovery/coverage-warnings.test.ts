import { describe, expect, it } from "vitest";
import { CoverageWarningLog, EXAMPLE_LIMIT } from "./coverage-warnings.js";

describe("CoverageWarningLog", () => {
  it("aggregates a whole extension into one warning, not one per file", () => {
    const log = new CoverageWarningLog();
    for (let i = 0; i < 1226; i += 1) {
      log.record("files_not_discovered", ".vue", { file: `src/c${i}.vue` });
    }
    const warnings = log.build();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("files_not_discovered");
    expect(warnings[0]?.subject).toBe(".vue");
    expect(warnings[0]?.files).toBe(1226);
  });

  it("caps examples so a warning never becomes a file list", () => {
    const log = new CoverageWarningLog();
    for (let i = 0; i < 50; i += 1) {
      log.record("files_unreadable", "EMFILE", { file: `src/c${i}.ts` });
    }
    expect(log.build()[0]?.examples).toHaveLength(EXAMPLE_LIMIT);
  });

  it("keeps buckets separate per kind and per subject", () => {
    const log = new CoverageWarningLog();
    log.record("files_unparsed", "language-js", { file: "a.ts" });
    log.record("files_unparsed", "language-py", { file: "b.py" });
    log.record("files_partial_parse", "language-py", { file: "b.py" });
    const warnings = log.build();
    expect(warnings.map((w) => `${w.kind}:${w.subject}`).sort()).toEqual([
      "files_partial_parse:language-py",
      "files_unparsed:language-js",
      "files_unparsed:language-py",
    ]);
  });

  it("accepts a bulk count for paths that only know a total", () => {
    const log = new CoverageWarningLog();
    log.record("index_truncated", "imports", { files: 3400 });
    const [warning] = log.build();
    expect(warning?.files).toBe(3400);
    expect(warning?.examples).toBeUndefined();
  });

  it("ranks the biggest gap first so the top line is the answer", () => {
    const log = new CoverageWarningLog();
    log.record("files_not_discovered", ".hbs", { files: 469 });
    log.record("files_not_discovered", ".html", { files: 224 });
    log.record("files_not_discovered", ".ipynb", { files: 42 });
    expect(log.build().map((w) => w.subject)).toEqual([".hbs", ".html", ".ipynb"]);
  });

  it("gives every warning a detail sentence and a stable machine subject", () => {
    const log = new CoverageWarningLog();
    log.record("files_unreadable", "EMFILE", { files: 12 });
    const [warning] = log.build();
    expect(warning?.detail).toContain("12");
    expect(warning?.remedy).toMatch(/ulimit/i);
  });

  it("reports empty when nothing was dropped", () => {
    expect(new CoverageWarningLog().build()).toEqual([]);
    expect(new CoverageWarningLog().isEmpty()).toBe(true);
  });
});
