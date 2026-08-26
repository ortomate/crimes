import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rejectBaseline, selectPinnedBaseline } from "./baseline.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "crimes-baseline-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function versionDir(version: string): string {
  const dir = resolve(root, version);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function addResult(version: string, agent = "claude"): void {
  const dir = resolve(versionDir(version), agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "scenario.json"), "{}", "utf8");
}

function addSummary(version: string): void {
  writeFileSync(resolve(versionDir(version), "summary.json"), "{}", "utf8");
}

function addRanking(version: string): void {
  writeFileSync(resolve(versionDir(version), "ranking.json"), "{}", "utf8");
}

describe("rejectBaseline", () => {
  it("accepts a directory with agent results and a summary", () => {
    addResult("0.25.1");
    addSummary("0.25.1");
    expect(rejectBaseline(resolve(root, "0.25.1"))).toBeUndefined();
  });

  it("rejects a ranking-only bump directory", () => {
    // What every patch bump has written since 0.25.4.
    addRanking("0.26.0");
    expect(rejectBaseline(resolve(root, "0.26.0"))).toBe("no-agent-results");
  });

  it("rejects a directory whose only JSON sits at the top level", () => {
    // summary.json is not a result file; results live under <agent>/.
    addSummary("0.26.0");
    expect(rejectBaseline(resolve(root, "0.26.0"))).toBe("no-agent-results");
  });

  it("rejects a run killed before it wrote its summary", () => {
    addResult("0.25.2");
    expect(rejectBaseline(resolve(root, "0.25.2"))).toBe("no-summary");
  });

  it("rejects a directory that is not there", () => {
    expect(rejectBaseline(resolve(root, "0.99.0"))).toBe("missing");
  });
});

describe("selectPinnedBaseline", () => {
  it("reaches past newer ranking-only directories", () => {
    // The real repo on 2026-08-26. Taking [0] here is the bug that made
    // both CI eval steps pass while measuring nothing.
    for (const v of ["0.26.0", "0.25.11", "0.25.9", "0.25.4"]) addRanking(v);
    addResult("0.25.1");
    addSummary("0.25.1");
    expect(selectPinnedBaseline(root)?.version).toBe("0.25.1");
  });

  it("prefers a re-run sample over the base version it supersedes", () => {
    for (const v of ["0.15.0", "0.15.0-r2"]) {
      addResult(v);
      addSummary(v);
    }
    expect(selectPinnedBaseline(root)?.version).toBe("0.15.0-r2");
  });

  it("returns undefined rather than falling back to the newest directory", () => {
    addRanking("0.26.0");
    addRanking("0.25.4");
    expect(selectPinnedBaseline(root)).toBeUndefined();
  });

  it("returns undefined when the results directory does not exist", () => {
    expect(selectPinnedBaseline(resolve(root, "absent"))).toBeUndefined();
  });
});
