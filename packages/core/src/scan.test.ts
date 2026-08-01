import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { NotAGitRepoError } from "./git/changed-files.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { applyScanFailOn, applyTriageToScan, scan } from "./scan.js";
import { tagTierAndSortByRankScore } from "./context-helpers.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { TriageEntry } from "./triage.js";

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

    expect(report.schema_version).toBe(SCHEMA_VERSION);
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
      pack: "language-js" as const,
      run(ctx: { ia?: { routes: { routePath: string }[] } }) {
        seen.push({
          hasIa: ctx.ia !== undefined,
          routes: (ctx.ia?.routes ?? []).map((r) => r.routePath),
        });
        return [];
      },
    } as const;
    const root = await makeRepo({
      "src/pages/settings/billing.tsx": `export default function PricingPage() { return null; }\n`,
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

function makeFinding(severity: Finding["severity"], i = 1): Finding {
  return {
    id: `crime_${String(i).padStart(5, "0")}`,
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity,
    confidence: 0.9,
    file: `src/file${i}.ts`,
    symbol: `fn${i}`,
    lines: [1, 100],
    summary: "spans 100 lines",
    evidence: [],
    effort: "small",
    fix_shape: "extract pure helpers; keep the orchestrator thin",
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
  it("tags findings with tier based on scopeTiers and sorts by rank_score desc", {
    timeout: 30_000,
  }, async () => {
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
    const coldIdx = report.findings.findIndex((f) => f.file === "src/cold.ts");
    expect(hotIdx).toBeGreaterThanOrEqual(0);
    expect(coldIdx).toBeGreaterThanOrEqual(0);
    expect(hotIdx).toBeLessThan(coldIdx);
  });
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
    expect(applyScanFailOn(makeReport([makeFinding("medium")]), "medium").failed).toBe(
      true,
    );
    expect(applyScanFailOn(makeReport([makeFinding("high")]), "medium").failed).toBe(
      true,
    );
  });

  it("threshold 'high' only fails on high findings", () => {
    expect(applyScanFailOn(makeReport([makeFinding("medium")]), "high").failed).toBe(
      false,
    );
    expect(applyScanFailOn(makeReport([makeFinding("high")]), "high").failed).toBe(true);
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
  function makeScoredFinding(file: string, agentRisk: number, recency: number): Finding {
    return {
      id: "crime_00001",
      type: "large_function",
      pack: "language-js",
      detector_id: "large_function.js",
      charge: "God Function",
      severity: "high",
      confidence: 0.9,
      file,
      symbol: "fn",
      lines: [1, 100],
      summary: "spans 100 lines",
      evidence: [],
      effort: "small",
      fix_shape: "extract pure helpers; keep the orchestrator thin",
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
    const hot = makeScoredFinding("hot.ts", 0.8, 1.0); // rank = 0.8 * 1.5 = 1.2
    const cold = makeScoredFinding("cold.ts", 0.8, 0.0); // rank = 0.8 * 1.0 = 0.8
    const findings = [cold, hot];
    tagTierAndSortByRankScore(findings, emptyConfig, { recencyEnabled: true });
    expect(findings[0]!.file).toBe("hot.ts");
    expect(findings[1]!.file).toBe("cold.ts");
  });

  it("recencyEnabled: false collapses multiplier — findings with equal agent_risk sort by tiebreaker (file asc)", () => {
    const hot = makeScoredFinding("hot.ts", 0.8, 1.0); // rank = 0.8 * 1.0 = 0.8
    const cold = makeScoredFinding("cold.ts", 0.8, 0.0); // rank = 0.8 * 1.0 = 0.8
    const findings = [hot, cold];
    tagTierAndSortByRankScore(findings, emptyConfig, { recencyEnabled: false });
    // Equal rank_score; tiebreaker is file asc → cold.ts < hot.ts
    expect(findings[0]!.file).toBe("cold.ts");
    expect(findings[1]!.file).toBe("hot.ts");
  });
});

describe("scan — resurfacing", () => {
  it("emits previously_triaged findings at the start of findings[] on a touched file", {
    timeout: 30_000,
  }, async () => {
    const root = await makeRepo({
      "src/big.ts": longFunctionFixture("doStuff"),
    });
    await git(root, "init", "--initial-branch=main", "--quiet");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "init", "--quiet");

    // Run a scan to find the fingerprint of the target finding.
    const initial = await scan({ root });
    const target = initial.findings.find(
      (f) => f.file === "src/big.ts" && f.symbol === "doStuff",
    );
    expect(target).toBeDefined();
    const print = `${target!.type}::${target!.file}::${target!.symbol ?? ""}`;

    // Write .crimes/triage.json with that fingerprint marked wont-fix.
    const triagePath = join(root, ".crimes", "triage.json");
    await mkdir(dirname(triagePath), { recursive: true });
    await writeFile(
      triagePath,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: print,
            type: target!.type,
            file: target!.file,
            symbol: target!.symbol,
            disposition: "wont-fix",
            reason: "legacy billing",
            owner: "@amayfield",
            date: "2026-04-12",
          },
        ],
      }),
      "utf8",
    );

    // Switch to a feature branch and touch the file (so it's in the diff).
    await git(root, "checkout", "-b", "feature", "--quiet");
    await writeFile(
      join(root, "src/big.ts"),
      longFunctionFixture("doStuff") + "\n// touched\n",
      "utf8",
    );

    const report = await scan({ root });
    expect(report.findings[0]!.previously_triaged).toBe(true);
    expect(report.findings[0]!.previous_triage?.disposition).toBe("wont-fix");
    expect(report.findings[0]!.previous_triage?.reason).toBe("legacy billing");
  });

  it("skips resurfacing silently when not in a git repo", {
    timeout: 15_000,
  }, async () => {
    const root = await makeRepo({
      "src/big.ts": longFunctionFixture("doStuff"),
    });
    // No git init — scan should still work and the report should NOT
    // contain previously_triaged annotations.
    const triagePath = join(root, ".crimes", "triage.json");
    await mkdir(dirname(triagePath), { recursive: true });
    await writeFile(
      triagePath,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [], // empty, but the file exists
      }),
      "utf8",
    );
    const report = await scan({ root });
    expect(report.findings.every((f) => !f.previously_triaged)).toBe(true);
  });

  it("skips resurfacing when config.triage.resurfaceBase is empty string", {
    timeout: 30_000,
  }, async () => {
    // Setup: git repo with a triage entry on a touched file, but
    // crimes.config.json explicitly sets triage.resurfaceBase = "".
    const root = await makeRepo({
      "src/big.ts": longFunctionFixture("doStuff"),
      "crimes.config.json": JSON.stringify({
        triage: { resurfaceBase: "" },
      }),
    });
    await git(root, "init", "--initial-branch=main", "--quiet");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "init", "--quiet");

    const initial = await scan({ root });
    const target = initial.findings[0]!;
    const print = `${target.type}::${target.file}::${target.symbol ?? ""}`;

    const triagePath = join(root, ".crimes", "triage.json");
    await mkdir(dirname(triagePath), { recursive: true });
    await writeFile(
      triagePath,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: print,
            type: target.type,
            file: target.file,
            ...(target.symbol ? { symbol: target.symbol } : {}),
            disposition: "wont-fix",
            reason: "ok",
            owner: "@a",
            date: "2026-05-20",
          },
        ],
      }),
      "utf8",
    );

    await git(root, "checkout", "-b", "feature", "--quiet");
    await writeFile(
      join(root, "src/big.ts"),
      longFunctionFixture("doStuff") + "\n// touched\n",
      "utf8",
    );

    const report = await scan({ root });
    expect(report.findings.every((f) => !f.previously_triaged)).toBe(true);
  });

  it("drops resurfaced entries whose re-detect produces no match", {
    timeout: 30_000,
  }, async () => {
    // Triage entry references a fingerprint that doesn't exist in the
    // file's current findings (e.g. symbol renamed). collectResurfaced
    // drops it silently — no annotation in the report.
    const root = await makeRepo({
      "src/big.ts": longFunctionFixture("renamedFunction"),
    });
    await git(root, "init", "--initial-branch=main", "--quiet");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "init", "--quiet");

    const triagePath = join(root, ".crimes", "triage.json");
    await mkdir(dirname(triagePath), { recursive: true });
    await writeFile(
      triagePath,
      JSON.stringify({
        schema_version: "0.2.0",
        report_type: "triage",
        created_at: "2026-05-20T14:00:00Z",
        updated_at: "2026-05-20T14:00:00Z",
        entries: [
          {
            fingerprint: "large_function::src/big.ts::oldFunctionName",
            type: "large_function",
            file: "src/big.ts",
            symbol: "oldFunctionName",
            disposition: "wont-fix",
            reason: "ok",
            owner: "@a",
            date: "2026-05-20",
          },
        ],
      }),
      "utf8",
    );

    await git(root, "checkout", "-b", "feature", "--quiet");
    await writeFile(
      join(root, "src/big.ts"),
      longFunctionFixture("renamedFunction") + "\n// touched\n",
      "utf8",
    );

    const report = await scan({ root });
    expect(report.findings.every((f) => !f.previously_triaged)).toBe(true);
  });
});

describe("applyTriageToScan", () => {
  function triageEntryFor(
    finding: Finding,
    disposition: TriageEntry["disposition"],
  ): TriageEntry {
    const entry: TriageEntry = {
      fingerprint: fingerprintFinding(finding),
      type: finding.type,
      file: finding.file,
      disposition,
      reason: "legacy",
      owner: "@me",
      date: "2026-05-20",
    };
    if (finding.symbol) entry.symbol = finding.symbol;
    return entry;
  }

  it("removes findings matched by a silencing disposition and decrements summary", {
    timeout: 30_000,
  }, async () => {
    const root = await makeRepo({
      "src/big.ts": longFunctionFixture("doStuff"),
    });
    const report = await scan({ root });
    expect(report.findings.length).toBeGreaterThan(0);

    const target = report.findings[0]!;
    const triage: TriageEntry[] = [triageEntryFor(target, "wont-fix")];

    const filtered = applyTriageToScan(report, triage, { showTriaged: false });
    const stillThere = filtered.findings.find(
      (f) => fingerprintFinding(f) === fingerprintFinding(target),
    );
    expect(stillThere).toBeUndefined();
    expect(filtered.summary.total).toBe(report.summary.total - 1);
    expect(filtered.triage_hidden_count).toBe(1);
  });

  it("showTriaged: true keeps silenced findings visible with hidden_triage and no count", {
    timeout: 30_000,
  }, async () => {
    const root = await makeRepo({
      "src/big.ts": longFunctionFixture("doStuff"),
    });
    const report = await scan({ root });
    expect(report.findings.length).toBeGreaterThan(0);

    const target = report.findings[0]!;
    const triage: TriageEntry[] = [triageEntryFor(target, "needs-design")];

    const filtered = applyTriageToScan(report, triage, { showTriaged: true });
    const stillThere = filtered.findings.find(
      (f) => fingerprintFinding(f) === fingerprintFinding(target),
    );
    expect(stillThere).toBeDefined();
    expect(stillThere!.hidden_triage?.disposition).toBe("needs-design");
    expect(filtered.summary.total).toBe(report.summary.total);
    // triage_hidden_count only set when entries were actually hidden;
    // showTriaged: true preserves them so the count stays absent.
    expect(filtered.triage_hidden_count).toBeUndefined();
  });

  it("keeps fix-now findings visible with the triaged annotation", {
    timeout: 30_000,
  }, async () => {
    const root = await makeRepo({
      "src/big.ts": longFunctionFixture("doStuff"),
    });
    const report = await scan({ root });
    expect(report.findings.length).toBeGreaterThan(0);

    const target = report.findings[0]!;
    const triage: TriageEntry[] = [triageEntryFor(target, "fix-now")];

    const filtered = applyTriageToScan(report, triage, { showTriaged: false });
    const annotated = filtered.findings.find(
      (f) => fingerprintFinding(f) === fingerprintFinding(target),
    );
    expect(annotated).toBeDefined();
    expect(annotated!.triaged?.disposition).toBe("fix-now");
    expect(filtered.summary.total).toBe(report.summary.total);
  });

  it("does not mutate the input report", () => {
    const report = makeReport([makeFinding("high")]);
    const snapshot = JSON.parse(JSON.stringify(report));
    applyTriageToScan(report, [], { showTriaged: false });
    expect(report).toEqual(snapshot);
  });
});

describe("scan — universal pack execution", () => {
  it("runs large_file on a Rust-only repo and fires on a 600-line file", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-uni-"));
    try {
      const big = Array.from({ length: 600 }, (_, i) => `// line ${i}`).join("\n");
      await writeFile(join(root, "main.rs"), big);
      const report = await scan({
        root,
        config: { ...DEFAULT_CONFIG, include: ["**/*.rs"] },
      });
      // large_file is now universal — a 600-line .rs file (2× the 300-line
      // default threshold) should produce exactly one high-severity finding.
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]!.type).toBe("large_file");
      expect(report.findings[0]!.severity).toBe("high");
      expect(report.findings[0]!.pack).toBe("universal");
      expect(report.findings[0]!.detector_id).toBe("large_file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("scan — ScanReport.coverage", () => {
  it("counts files under the pack that claims them, and the rest as universal-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-cov-"));
    try {
      await writeFile(join(root, "a.ts"), "const x = 1;\n");
      await writeFile(join(root, "b.tsx"), "const y = 2;\n");
      await writeFile(join(root, "c.py"), "x = 1\n");
      await writeFile(join(root, "d.rs"), "fn main() {}\n");
      await writeFile(join(root, "README.md"), "# hello\n");
      const report = await scan({
        root,
        config: {
          ...DEFAULT_CONFIG,
          include: ["**/*.{ts,tsx,py,rs,md}"],
        },
      });
      expect(report.coverage).toBeDefined();
      expect(report.coverage?.files_total).toBe(5);
      // `py: 1` from 0.14.0 — before the Python pack, `c.py` counted as
      // universal-only. This is the coverage block becoming meaningful
      // for a mixed-language repo, which is the point of the release.
      expect(report.coverage?.files_by_language).toEqual({ js: 2, py: 1 });
      expect(report.coverage?.files_universal_only).toBe(2);
      expect(report.coverage?.universal_only_by_extension).toEqual({
        ".rs": 1,
        ".md": 1,
      });
      expect(report.coverage?.packs_loaded).toEqual([
        "universal",
        "language-js",
        "language-py",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits an empty coverage shape when no files are discovered", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-cov-empty-"));
    try {
      const report = await scan({
        root,
        config: { ...DEFAULT_CONFIG, include: ["**/*.nonexistent"] },
      });
      expect(report.coverage?.files_total).toBe(0);
      expect(report.coverage?.files_by_language).toEqual({});
      expect(report.coverage?.files_universal_only).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
