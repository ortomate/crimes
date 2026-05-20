import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { NotAGitRepoError } from "./git/changed-files.js";
import { loadConfig } from "./config.js";
import { applyScanFailOn, scan } from "./scan.js";
import { tagTierAndSortByRankScore } from "./context-helpers.js";

const execFileAsync = promisify(execFile);

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-scan-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "crimes-test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "crimes-test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function bigSource(): string {
  // Past the default 300-line threshold so the file is flagged.
  return Array.from({ length: 400 }, () => "// line").join("\n");
}

describe("scan", () => {
  it("produces a schema-versioned, sorted report", async () => {
    const big = Array.from({ length: 800 }, () => "// line").join("\n");
    const root = await makeRepo({
      "big.ts": big,
      "small.ts": `export const x = 1;\n`,
    });

    const report = await scan({ root });

    expect(report.schema_version).toBe("0.2.0");
    expect(report.report_type).toBe("scan");
    expect(report.repo.root).toBe(root);
    expect(report.summary.total).toBe(report.findings.length);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings[0]!.id).toMatch(/^crime_\d{5}$/);

    // sorted: high before medium before low
    const order = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < report.findings.length; i++) {
      expect(order[report.findings[i]!.severity]).toBeGreaterThanOrEqual(
        order[report.findings[i - 1]!.severity],
      );
    }
  });

  it("ignores files under dist/ and node_modules/", async () => {
    const root = await makeRepo({});
    const report = await scan({ root });
    expect(report.findings).toEqual([]);
  });

  it("emits IA findings end-to-end when ctx.ia signal supports them", async () => {
    // A repo with two nav files that disagree on a destination label, and a
    // package.json declaring a bin but no AGENTS.md / CLAUDE.md / skill.
    const root = await makeRepo({
      "package.json": JSON.stringify({
        name: "drift-fixture",
        bin: { drift: "src/index.ts" },
      }),
      "src/index.ts": "export const ok = 1;\n",
      "src/nav/sidebar.ts": `
        export const sidebar = [
          { href: "/settings/billing", label: "Billing" },
          { href: "/team", label: "Team" },
        ];
      `,
      "src/nav/registry.ts": `
        export const registry = [
          { href: "/settings/billing", label: "Plans" },
          { href: "/team", label: "Team" },
        ];
      `,
    });
    const report = await scan({ root });
    const iaTypes = report.findings
      .map((f) => f.type)
      .filter(
        (t) =>
          t === "missing_agent_context" ||
          t === "duplicated_navigation_source" ||
          t === "route_metadata_drift" ||
          t === "concept_alias_drift" ||
          t === "docs_code_drift",
      );
    expect(iaTypes).toContain("missing_agent_context");
    expect(iaTypes).toContain("duplicated_navigation_source");
  });

  it("passes a populated IA index into detector contexts", async () => {
    const seen: { hasIa: boolean; routes: string[] }[] = [];
    const sniffer = {
      id: "ia_sniffer",
      name: "IA Sniffer",
      description: "test-only detector that captures ctx.ia state",
      whyItMatters: "",
      run(ctx: {
        ia?: { routes: { routePath: string }[] };
      }) {
        seen.push({
          hasIa: ctx.ia !== undefined,
          routes: (ctx.ia?.routes ?? []).map((r) => r.routePath),
        });
        return [];
      },
    } as const;
    const root = await makeRepo({
      "src/pages/settings/billing.tsx":
        `export default function PricingPage() { return null; }\n`,
    });
    await scan({ root, detectors: [sniffer] });
    expect(seen.length).toBe(1);
    expect(seen[0]!.hasIa).toBe(true);
    expect(seen[0]!.routes).toContain("/settings/billing");
  });

  it("flags the example messy patterns", async () => {
    const root = await makeRepo({
      "date.ts": `export const a = Date.now(); export const b = new Date();\n`,
      "todo.ts": [
        "// TODO: a",
        "// FIXME: b",
        "// TODO: c",
        "// HACK: d",
        "// XXX: e",
      ].join("\n"),
    });
    const report = await scan({ root });
    const types = new Set(report.findings.map((f) => f.type));
    expect(types.has("direct_date")).toBe(true);
    expect(types.has("todo_density")).toBe(true);
  });

  describe("--changed", () => {
    it("restricts the scan to working-tree changes when no base is given", async () => {
      const root = await makeRepo({
        "untouched.ts": bigSource(),
      });
      await git(root, "init", "--initial-branch=main", "--quiet");
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "init", "--quiet");

      // Add a second oversized file *after* the commit — only this one
      // should be scanned with --changed.
      await writeFile(join(root, "new-big.ts"), bigSource(), "utf8");

      const report = await scan({ root, changed: true });
      const files = report.findings.map((f) => f.file);
      expect(files).toContain("new-big.ts");
      expect(files).not.toContain("untouched.ts");
    });

    it("returns an empty report when nothing has changed", async () => {
      const root = await makeRepo({
        "big.ts": bigSource(),
      });
      await git(root, "init", "--initial-branch=main", "--quiet");
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "init", "--quiet");

      const report = await scan({ root, changed: true });
      expect(report.findings).toEqual([]);
      expect(report.summary.total).toBe(0);
    });

    it("uses <base>...HEAD when a base ref is provided", { timeout: 30000 }, async () => {
      const root = await makeRepo({
        "untouched.ts": bigSource(),
      });
      await git(root, "init", "--initial-branch=main", "--quiet");
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "init", "--quiet");

      await git(root, "checkout", "-b", "feature", "--quiet");
      await writeFile(join(root, "feature.ts"), bigSource(), "utf8");
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "feature commit", "--quiet");

      const report = await scan({ root, changed: true, base: "main" });
      const files = report.findings.map((f) => f.file);
      expect(files).toContain("feature.ts");
      expect(files).not.toContain("untouched.ts");
    });

    it("throws NotAGitRepoError outside a git repo", async () => {
      const root = await makeRepo({ "a.ts": bigSource() });
      await expect(scan({ root, changed: true })).rejects.toBeInstanceOf(
        NotAGitRepoError,
      );
    });

    it("respects include/exclude — non-JS/TS changed files are ignored", async () => {
      const root = await makeRepo({
        "kept.ts": "export const x = 1;\n",
      });
      await git(root, "init", "--initial-branch=main", "--quiet");
      await git(root, "add", "-A");
      await git(root, "commit", "-m", "init", "--quiet");

      // Touch a non-JS/TS file alongside a TS file.
      await writeFile(join(root, "README.md"), "# hi\n", "utf8");
      await writeFile(join(root, "new.ts"), bigSource(), "utf8");

      const report = await scan({ root, changed: true });
      const files = report.findings.map((f) => f.file);
      expect(files).toContain("new.ts");
      expect(files).not.toContain("README.md");
    });

    describe("changed_files", () => {
      it("is omitted on plain (non-changed) scans", async () => {
        const root = await makeRepo({ "x.ts": "export const x = 1;\n" });
        const report = await scan({ root });
        expect(report.changed_files).toBeUndefined();
      });

      it("lists every git-reported change, including files with no findings", async () => {
        const root = await makeRepo({ "untouched.ts": "// stable\n" });
        await git(root, "init", "--initial-branch=main", "--quiet");
        await git(root, "add", "-A");
        await git(root, "commit", "-m", "init", "--quiet");

        // Three new files: a TS source with findings, a TS source with
        // none, and a non-source file the scan would skip entirely.
        await writeFile(join(root, "new-big.ts"), bigSource(), "utf8");
        await writeFile(join(root, "clean.ts"), "export const k = 1;\n", "utf8");
        await writeFile(join(root, "README.md"), "# hi\n", "utf8");

        const report = await scan({ root, changed: true });
        expect(report.changed_files).toBeDefined();
        const changed = report.changed_files!;
        expect(changed).toContain("new-big.ts");
        expect(changed).toContain("clean.ts");
        expect(changed).toContain("README.md");
        // Sorted and deduplicated.
        expect([...changed]).toEqual([...changed].slice().sort());
        expect(new Set(changed).size).toBe(changed.length);
        // The clean.ts file produced no findings but still appears in
        // changed_files — that's the whole point of the field.
        const findingFiles = new Set(report.findings.map((f) => f.file));
        expect(findingFiles.has("clean.ts")).toBe(false);
      });

      it("is present and empty when the working tree is clean", async () => {
        const root = await makeRepo({ "x.ts": "export const x = 1;\n" });
        await git(root, "init", "--initial-branch=main", "--quiet");
        await git(root, "add", "-A");
        await git(root, "commit", "-m", "init", "--quiet");

        const report = await scan({ root, changed: true });
        expect(report.changed_files).toEqual([]);
      });

      it("includes commits unique to <base>...HEAD when --base is set", async () => {
        const root = await makeRepo({ "x.ts": "// initial\n" });
        await git(root, "init", "--initial-branch=main", "--quiet");
        await git(root, "add", "-A");
        await git(root, "commit", "-m", "init", "--quiet");

        await git(root, "checkout", "-b", "feature", "--quiet");
        await writeFile(join(root, "feature.ts"), "export const f = 1;\n", "utf8");
        await git(root, "add", "-A");
        await git(root, "commit", "-m", "feature", "--quiet");

        const report = await scan({ root, changed: true, base: "main" });
        expect(report.changed_files).toContain("feature.ts");
      });
    });
  });
});

function makeFinding(
  severity: Finding["severity"],
  i = 1,
): Finding {
  return {
    id: `crime_${String(i).padStart(5, "0")}`,
    type: "large_function",
    charge: "God Function",
    severity,
    confidence: 0.9,
    file: `src/file${i}.ts`,
    symbol: `fn${i}`,
    lines: [1, 100],
    summary: "spans 100 lines",
    evidence: [],
    scores: { severity: 0.9, confidence: 0.9 },
  };
}

function makeReport(findings: Finding[]): ScanReport {
  const summary = { total: findings.length, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return {
    schema_version: SCHEMA_VERSION,
    report_type: "scan",
    repo: { name: "fixture", root: "/tmp/fixture" },
    summary,
    findings,
  };
}

/** A large function body (81 lines) that fires the large_function detector. */
function longFunctionFixture(name: string): string {
  return `export function ${name}() {\n${"  console.log('x');\n".repeat(80)}}\n`;
}

/**
 * Initialise a bare git repo using a back-dated initial commit so that
 * recency for files committed here decays to 0 (>14 days old).
 */
async function initRepo(dir: string): Promise<void> {
  const pastDate = "2000-01-01T00:00:00+00:00";
  const baseEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "crimes-test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "crimes-test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  await execFileAsync("git", ["init", "--initial-branch=main", "--quiet"], {
    cwd: dir,
    env: baseEnv,
  });
  await execFileAsync("git", ["add", "-A"], { cwd: dir, env: baseEnv });
  await execFileAsync("git", ["commit", "-m", "init", "--quiet"], {
    cwd: dir,
    env: {
      ...baseEnv,
      GIT_AUTHOR_DATE: pastDate,
      GIT_COMMITTER_DATE: pastDate,
    },
  });
}

/**
 * Write `content` to `filename` and create a fresh commit (using current
 * time so recency = 1.0).
 */
async function commitFile(
  dir: string,
  filename: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(dir, filename), content, "utf8");
  await git(dir, "add", filename);
  await git(dir, "commit", "-m", message, "--quiet");
}

describe("scan — tier tagging and rank_score order", () => {
  it(
    "tags findings with tier based on scopeTiers and sorts by rank_score desc",
    { timeout: 30_000 },
    async () => {
      const dir = await makeRepo({
        "src/hot.ts": longFunctionFixture("hotFn"),
        "scripts/probe.ts": longFunctionFixture("probeFn"),
        "src/cold.ts": longFunctionFixture("coldFn"),
        "crimes.config.json": JSON.stringify({
          scopeTiers: { nonDomain: ["scripts/**"] },
        }),
      });
      await initRepo(dir);
      // Touch hot.ts with a fresh commit to bump its recency.
      await commitFile(
        dir,
        "src/hot.ts",
        longFunctionFixture("hotFn") + "\n// touch\n",
        "touch hot",
      );

      const config = loadConfig(dir);
      const report = await scan({ root: dir, config });

      const hot = report.findings.find((f) => f.file === "src/hot.ts");
      const probe = report.findings.find((f) => f.file === "scripts/probe.ts");
      const cold = report.findings.find((f) => f.file === "src/cold.ts");

      expect(hot?.tier).toBe("domain");
      expect(probe?.tier).toBe("nonDomain");
      expect(cold?.tier).toBe("domain");

      // hot.ts was committed recently → recency 1.0 → rank_score = agent_risk * 1.5
      // cold.ts was only in the back-dated init commit → recency 0 → rank_score = agent_risk * 1.0
      // Hot must appear before cold even if agent_risks were equal.
      const hotIdx = report.findings.findIndex((f) => f.file === "src/hot.ts");
      const coldIdx = report.findings.findIndex(
        (f) => f.file === "src/cold.ts",
      );
      expect(hotIdx).toBeGreaterThanOrEqual(0);
      expect(coldIdx).toBeGreaterThanOrEqual(0);
      expect(hotIdx).toBeLessThan(coldIdx);
    },
  );
});

describe("applyScanFailOn", () => {
  it("does not mutate the input report", () => {
    const original = makeReport([makeFinding("high")]);
    const snapshot = JSON.parse(JSON.stringify(original));
    applyScanFailOn(original, "high");
    expect(original).toEqual(snapshot);
  });

  it("sets fail_on and failed when findings meet the threshold", () => {
    const report = makeReport([makeFinding("high")]);
    const gated = applyScanFailOn(report, "high");
    expect(gated.fail_on).toBe("high");
    expect(gated.failed).toBe(true);
  });

  it("threshold 'low' fails on any finding", () => {
    const report = makeReport([makeFinding("low")]);
    expect(applyScanFailOn(report, "low").failed).toBe(true);
  });

  it("threshold 'medium' (default) fails on medium and high, not low", () => {
    expect(applyScanFailOn(makeReport([makeFinding("low")]), "medium").failed).toBe(
      false,
    );
    expect(
      applyScanFailOn(makeReport([makeFinding("medium")]), "medium").failed,
    ).toBe(true);
    expect(
      applyScanFailOn(makeReport([makeFinding("high")]), "medium").failed,
    ).toBe(true);
  });

  it("threshold 'high' only fails on high findings", () => {
    expect(
      applyScanFailOn(makeReport([makeFinding("medium")]), "high").failed,
    ).toBe(false);
    expect(
      applyScanFailOn(makeReport([makeFinding("high")]), "high").failed,
    ).toBe(true);
  });

  it("returns failed=false when the report has no findings", () => {
    const gated = applyScanFailOn(makeReport([]), "low");
    expect(gated.failed).toBe(false);
    expect(gated.fail_on).toBe("low");
  });

  it("preserves the rest of the report unchanged", () => {
    const findings = [makeFinding("high", 1), makeFinding("low", 2)];
    const report = makeReport(findings);
    const gated = applyScanFailOn(report, "medium");
    expect(gated.schema_version).toBe(report.schema_version);
    expect(gated.repo).toEqual(report.repo);
    expect(gated.summary).toEqual(report.summary);
    expect(gated.findings).toEqual(report.findings);
  });
});

describe("tagTierAndSortByRankScore — recencyEnabled: false", () => {
  /** Synthetic finding with explicit agent_risk and recency scores. */
  function makeScoredFinding(
    file: string,
    agentRisk: number,
    recency: number,
  ): Finding {
    return {
      id: "crime_00001",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      confidence: 0.9,
      file,
      symbol: "fn",
      lines: [1, 100],
      summary: "spans 100 lines",
      evidence: [],
      scores: {
        severity: 0.9,
        confidence: 0.9,
        agent_risk: agentRisk,
        recency,
      },
    };
  }

  const emptyConfig = loadConfig("/nonexistent/path");

  it("recencyEnabled: true (default) ranks high-recency finding above low-recency when agent_risk equal", () => {
    const hot = makeScoredFinding("hot.ts", 0.8, 1.0);  // rank = 0.8 * 1.5 = 1.2
    const cold = makeScoredFinding("cold.ts", 0.8, 0.0); // rank = 0.8 * 1.0 = 0.8
    const findings = [cold, hot];
    tagTierAndSortByRankScore(findings, emptyConfig, { recencyEnabled: true });
    expect(findings[0]!.file).toBe("hot.ts");
    expect(findings[1]!.file).toBe("cold.ts");
  });

  it("recencyEnabled: false collapses multiplier — findings with equal agent_risk sort by tiebreaker (file asc)", () => {
    const hot = makeScoredFinding("hot.ts", 0.8, 1.0);  // rank = 0.8 * 1.0 = 0.8
    const cold = makeScoredFinding("cold.ts", 0.8, 0.0); // rank = 0.8 * 1.0 = 0.8
    const findings = [hot, cold];
    tagTierAndSortByRankScore(findings, emptyConfig, { recencyEnabled: false });
    // Equal rank_score; tiebreaker is file asc → cold.ts < hot.ts
    expect(findings[0]!.file).toBe("cold.ts");
    expect(findings[1]!.file).toBe("hot.ts");
  });
});
