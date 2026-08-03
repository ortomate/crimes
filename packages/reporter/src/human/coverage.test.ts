import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ScanReport } from "@crimes/core";
import {
  buildCoverageBanner,
  buildCoverageWarningNotice,
  renderCoverageExplain,
} from "./coverage.js";

/** Collect everything written to a stream as one string. */
function capture(fn: (out: Writable) => void): string {
  let buf = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      cb();
    },
  });
  fn(out);
  return buf;
}

function coverage(
  filesTotal: number,
  universalOnly: number,
  packs: string[] = ["universal", "language-js"],
): ScanReport["coverage"] {
  return {
    files_total: filesTotal,
    files_by_language: { js: filesTotal - universalOnly },
    files_universal_only: universalOnly,
    packs_loaded: packs,
  };
}

describe("buildCoverageBanner", () => {
  it("returns null when most files are pack-covered", () => {
    expect(buildCoverageBanner(coverage(100, 10))).toBeNull();
  });

  it("returns a banner when >50% of files are universal-only", () => {
    const banner = buildCoverageBanner(coverage(100, 80));
    expect(banner).toContain("coverage:");
    expect(banner).toContain("100 files");
    expect(banner).toContain("20% covered");
    expect(banner).toContain("--explain-coverage");
  });

  it("returns null when coverage is undefined", () => {
    expect(buildCoverageBanner(undefined)).toBeNull();
  });

  it("returns null on an empty repo", () => {
    expect(buildCoverageBanner(coverage(0, 0))).toBeNull();
  });

  it("triggers at exactly the 50% boundary (>50%, not >=50%)", () => {
    expect(buildCoverageBanner(coverage(100, 50))).toBeNull();
    expect(buildCoverageBanner(coverage(100, 51))).not.toBeNull();
  });

  it("labels the no-pack case explicitly", () => {
    const banner = buildCoverageBanner(coverage(100, 100, []));
    expect(banner).toContain("(no language packs loaded)");
  });

  it("renders the universal-only histogram largest-first", () => {
    const cov = {
      ...coverage(100, 40)!,
      universal_only_by_extension: { ".md": 5, ".py": 30, ".json": 5 },
    };
    const out = capture((s) => renderCoverageExplain(cov, s));
    expect(out).toContain(".py: 30");
    expect(out).toContain(".md: 5");
    // Largest bucket first — it answers "which pack buys the most?"
    expect(out.indexOf(".py")).toBeLessThan(out.indexOf(".md"));
  });

  it("collapses the long tail of extensions into one 'other' line", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 10; i += 1) many[`.e${i}`] = 10 - i;
    const cov = { ...coverage(100, 55)!, universal_only_by_extension: many };
    const out = capture((s) => renderCoverageExplain(cov, s));
    expect(out).toContain(".e0: 10");
    expect(out).toContain("other (4 extensions): 10"); // .e6+.e7+.e8+.e9 = 4+3+2+1
  });

  it("omits the histogram entirely when the field is absent", () => {
    const out = capture((s) => renderCoverageExplain(coverage(100, 40), s));
    expect(out).toContain("files with only universal coverage: 40");
    expect(out).not.toContain("other (");
  });

  it("treats a universal-only run as having no language packs", () => {
    // `packs_loaded` always contains "universal", so the banner must
    // filter it out rather than reporting it as language coverage.
    const banner = buildCoverageBanner(coverage(100, 100, ["universal"]));
    expect(banner).toContain("(no language packs loaded)");
    expect(banner).not.toContain("universal");
  });
});

describe("coverage warnings", () => {
  const warned: ScanReport["coverage"] = {
    ...coverage(340, 12)!,
    warnings: [
      {
        kind: "files_not_discovered",
        subject: ".vue",
        files: 1226,
        examples: ["packages/editor-ui/src/App.vue"],
        detail:
          "1226 files of type .vue are in the repo but no include pattern matched them.",
        remedy: 'Add a glob covering .vue to "include".',
      },
      {
        kind: "files_unreadable",
        subject: "EMFILE",
        files: 4,
        detail: "4 files could not be read (EMFILE).",
        remedy: "Raise the open-file limit (ulimit -n) and re-run.",
      },
    ],
  };

  it("prints a notice naming the biggest gap and its size", () => {
    const notice = buildCoverageWarningNotice(warned);
    expect(notice).not.toBeNull();
    expect(notice).toContain("1226");
    expect(notice).toContain(".vue");
    expect(notice).toContain("--explain-coverage");
  });

  it("returns null when nothing was skipped", () => {
    expect(buildCoverageWarningNotice(coverage(100, 10))).toBeNull();
    expect(buildCoverageWarningNotice(undefined)).toBeNull();
  });

  it("renders every warning with its detail and remedy under --explain-coverage", () => {
    const out = capture((s) => renderCoverageExplain(warned, s));
    expect(out).toContain("skipped work (2)");
    expect(out).toContain("files_not_discovered");
    expect(out).toContain("EMFILE");
    expect(out).toContain("ulimit -n");
    expect(out).toContain("packages/editor-ui/src/App.vue");
  });

  it("says nothing about warnings when there are none", () => {
    const out = capture((s) => renderCoverageExplain(coverage(100, 10), s));
    expect(out).not.toContain("skipped work");
  });
});
