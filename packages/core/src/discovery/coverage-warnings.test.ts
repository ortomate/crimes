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

describe("files_partial_parse — the detail must be true of the pack it names", () => {
  // Found by scanning a throwaway repo with the published 0.22.0 and
  // reading the JSON, which is the only place this string is visible.
  // The sentence was written for `language-py`, where
  // `weak_test_signal.py` genuinely returns [] on a partial tree. The
  // JS pack was given the same warning in 0.22.0 and its detectors
  // deliberately keep running — so the shared copy told the user the
  // tool had declined to do work it had in fact done. A verdict
  // without receipts, in the field whose whole job is receipts.
  it("does not claim JS detectors declined to run", () => {
    const log = new CoverageWarningLog();
    log.record("files_partial_parse", "language-js", { file: "src/broken.ts" });
    const [warning] = log.build();
    expect(warning?.detail).not.toMatch(/declined/);
    expect(warning?.detail).toMatch(/parsed with syntax errors/);
    expect(warning?.detail).toMatch(/part(?:s)? that parsed/);
  });

  it("still says so for Python, where they do decline", () => {
    const log = new CoverageWarningLog();
    log.record("files_partial_parse", "language-py", { file: "app.py" });
    const [warning] = log.build();
    expect(warning?.detail).toMatch(/declined to (?:run|judge)/);
  });
});
