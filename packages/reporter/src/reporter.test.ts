import type {
  Baseline,
  BaselineCheckReport,
  ContextReport,
  DiffReport,
  Finding,
  FindingScores,
  HotspotsReport,
  ScanReport,
  VerdictReport,
} from "@crimes/core";
import { describe, expect, it } from "vitest";
import { pc, plainColour, renderRiskProfileLine } from "./human/shared.js";
import {
  formatBaselineCheckReport,
  formatBaselineSaveReport,
  formatContextHumanReport,
  formatDiffReport,
  formatHotspotsReport,
  formatHumanReport,
  formatScanFailOnLine,
  formatVerdictReport,
} from "./human/index.js";
import {
  formatBaselineCheckJsonReport,
  formatBaselineJsonReport,
  formatContextJsonReport,
  formatDiffJsonReport,
  formatHotspotsJsonReport,
  formatJsonReport,
  formatVerdictJsonReport,
} from "./json.js";

const sampleReport: ScanReport = {
  schema_version: "0.2.0",
  report_type: "scan",
  repo: { name: "demo", root: "/tmp/demo" },
  summary: { total: 2, high: 1, medium: 1, low: 0 },
  findings: [
    {
      id: "crime_00001",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      confidence: 0.9,
      file: "src/billing.ts",
      symbol: "generateInvoice",
      lines: [10, 250],
      summary: "Function is 241 lines long.",
      evidence: ["241 lines", "4× threshold"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.9, confidence: 0.9 },
    },
    {
      id: "crime_00002",
      type: "todo_density",
      charge: "Unfinished Business",
      severity: "medium",
      confidence: 0.95,
      file: "src/todo.ts",
      summary: "12 markers (387 per 1k LOC).",
      evidence: ["8× TODO", "4× FIXME"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.5, confidence: 0.95 },
    },
  ],
};

describe("formatHumanReport", () => {
  it("includes charge, summary, and evidence", () => {
    const out = formatHumanReport(sampleReport, { noColor: true });
    expect(out).toContain("CRIME SCENE REPORT");
    expect(out).toContain("God Function");
    expect(out).toContain("generateInvoice");
    expect(out).toContain("241 lines");
    expect(out).toContain("crime_00001");
  });

  it("shows a 'no crimes' message for empty reports", () => {
    const empty: ScanReport = {
      ...sampleReport,
      summary: { total: 0, high: 0, medium: 0, low: 0 },
      findings: [],
    };
    const out = formatHumanReport(empty, { noColor: true });
    expect(out).toContain("No crimes detected");
  });

  it("does not render an 'Also touches' block when related_files is absent or empty", () => {
    const out = formatHumanReport(sampleReport, { noColor: true });
    expect(out).not.toContain("Also touches");

    const empty: ScanReport = {
      ...sampleReport,
      findings: [
        {
          ...sampleReport.findings[0]!,
          related_files: [],
        },
        sampleReport.findings[1]!,
      ],
    };
    const outEmpty = formatHumanReport(empty, { noColor: true });
    expect(outEmpty).not.toContain("Also touches");
  });

  it("renders 'Also touches' for findings with related_files", () => {
    const withRelated: ScanReport = {
      ...sampleReport,
      findings: [
        {
          ...sampleReport.findings[0]!,
          related_files: ["src/nav/registry.ts", "src/nav/sidebar.ts"],
        },
        sampleReport.findings[1]!,
      ],
    };
    // `Also touches:` is part of the rich per-finding render — the
    // default file-grouped layout collapses each finding to a compact
    // one-line entry. Use --all (or --flat) when you need the full
    // per-finding block.
    const out = formatHumanReport(withRelated, { noColor: true, showAll: true });
    expect(out).toContain("Also touches:");
    expect(out).toContain("src/nav/registry.ts");
    expect(out).toContain("src/nav/sidebar.ts");
    expect(out).not.toContain("more (see JSON output)");
  });

  it("caps the 'Also touches' block at 5 entries and notes overflow", () => {
    const many = [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/g.ts",
    ];
    const withRelated: ScanReport = {
      ...sampleReport,
      findings: [
        {
          ...sampleReport.findings[0]!,
          related_files: many,
        },
        sampleReport.findings[1]!,
      ],
    };
    // Use --all so the rich per-finding render (which is where
    // related_files is rendered) is exercised.
    const out = formatHumanReport(withRelated, { noColor: true, showAll: true });
    expect(out).toContain("Also touches:");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/e.ts");
    expect(out).not.toContain("src/f.ts");
    expect(out).not.toContain("src/g.ts");
    expect(out).toContain("and 2 more (see JSON output)");
  });

  it("renders the resurface block above 'Top files by risk' for previously_triaged findings", () => {
    const report: ScanReport = {
      ...sampleReport,
      findings: [
        {
          ...sampleReport.findings[0]!,
          previously_triaged: true,
          previous_triage: {
            disposition: "wont-fix",
            reason: "legacy billing, rewrite Q3",
            owner: "@amayfield",
            date: "2026-04-12",
          },
        },
        sampleReport.findings[1]!,
      ],
    };
    const out = formatHumanReport(report, { noColor: true });
    const resurfaceHeader = out.indexOf(
      "You're editing files you previously triaged",
    );
    const topFiles = out.indexOf("Top files by risk");
    expect(resurfaceHeader).toBeGreaterThan(-1);
    expect(topFiles).toBeGreaterThan(-1);
    expect(resurfaceHeader).toBeLessThan(topFiles);
    expect(out).toContain("wont-fix");
    expect(out).toContain("legacy billing, rewrite Q3");
    expect(out).toContain("@amayfield");
    expect(out).toContain("2026-04-12");
    expect(out).toContain("crimes triage --retriage src/billing.ts");
  });

  it("renders a ▶ <disposition> prefix on findings with a triaged annotation", () => {
    const report: ScanReport = {
      ...sampleReport,
      findings: [
        {
          ...sampleReport.findings[0]!,
          triaged: {
            disposition: "fix-now",
            reason: "this PR",
            owner: "@me",
            date: "2026-05-20",
          },
        },
        sampleReport.findings[1]!,
      ],
    };
    const out = formatHumanReport(report, { noColor: true });
    expect(out).toContain("▶ fix-now");
    // The plain `God Function` row should still be there — the prefix
    // appears before the charge name.
    expect(out).toMatch(/▶ fix-now · God Function/);
  });

  it("omits the resurface block when no findings are resurfaced", () => {
    const out = formatHumanReport(sampleReport, { noColor: true });
    expect(out).not.toContain("previously triaged");
  });
});

describe("formatJsonReport", () => {
  it("round-trips through JSON.parse", () => {
    const out = formatJsonReport(sampleReport);
    const parsed = JSON.parse(out) as ScanReport;
    expect(parsed.schema_version).toBe("0.2.0");
    expect(parsed.report_type).toBe("scan");
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]!.id).toBe("crime_00001");
  });

  it("includes top-level discriminator keys agents rely on", () => {
    const parsed = JSON.parse(formatJsonReport(sampleReport)) as Record<
      string,
      unknown
    >;
    for (const key of [
      "schema_version",
      "report_type",
      "repo",
      "summary",
      "findings",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.report_type).toBe("scan");
  });

  it("preserves related_files exactly when present on a finding", () => {
    const withRelated: ScanReport = {
      ...sampleReport,
      findings: [
        {
          ...sampleReport.findings[0]!,
          related_files: ["src/nav/registry.ts", "src/nav/sidebar.ts"],
        },
        sampleReport.findings[1]!,
      ],
    };
    const parsed = JSON.parse(formatJsonReport(withRelated)) as ScanReport;
    expect(parsed.findings[0]!.related_files).toEqual([
      "src/nav/registry.ts",
      "src/nav/sidebar.ts",
    ]);
    expect(parsed.findings[1]!.related_files).toBeUndefined();
  });
});

const sampleContext: ContextReport = {
  schema_version: "0.2.0",
  report_type: "context",
  repo: { name: "demo", root: "/tmp/demo" },
  file: "src/billing.ts",
  risk: { level: "high", high: 1, medium: 1, low: 0, total: 2 },
  agent_guidance: [
    "Prefer extracting pure helpers before adding more branches.",
    "Review TODOs before relying on comments as current intent.",
  ],
  related_files: [],
  likely_tests: ["src/billing.test.ts", "src/__tests__/billing.test.ts"],
  findings: [
    {
      id: "crime_00001",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      confidence: 0.95,
      file: "src/billing.ts",
      symbol: "generateInvoice",
      lines: [37, 240],
      summary: "generateInvoice spans 204 lines.",
      evidence: ["lines 37–240 (204 lines)"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.9, confidence: 0.95 },
    },
    {
      id: "crime_00002",
      type: "todo_density",
      charge: "Unfinished Business",
      severity: "medium",
      confidence: 0.7,
      file: "src/billing.ts",
      lines: [5, 200],
      summary: "10 TODO/FIXME markers.",
      evidence: ["10× TODO"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.4, confidence: 0.7 },
    },
  ],
};

describe("formatContextJsonReport", () => {
  it("includes every required key", () => {
    const out = formatContextJsonReport(sampleContext);
    const parsed = JSON.parse(out) as Record<string, unknown>;

    for (const key of [
      "schema_version",
      "report_type",
      "repo",
      "file",
      "risk",
      "agent_guidance",
      "related_files",
      "likely_tests",
      "findings",
    ]) {
      expect(parsed).toHaveProperty(key);
    }

    expect(parsed.schema_version).toBe("0.2.0");
    expect(parsed.report_type).toBe("context");
    expect(parsed.file).toBe("src/billing.ts");
  });

  it("preserves arrays exactly", () => {
    const out = formatContextJsonReport(sampleContext);
    const parsed = JSON.parse(out) as ContextReport;
    expect(parsed.likely_tests).toEqual([
      "src/billing.test.ts",
      "src/__tests__/billing.test.ts",
    ]);
    expect(parsed.agent_guidance).toHaveLength(2);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.related_files).toEqual([]);
  });

  it("places agent_guidance before findings in the serialised JSON", () => {
    const out = formatContextJsonReport(sampleContext);
    const guidanceIdx = out.indexOf('"agent_guidance"');
    const findingsIdx = out.indexOf('"findings"');
    const relatedIdx = out.indexOf('"related_files"');
    const testsIdx = out.indexOf('"likely_tests"');
    expect(guidanceIdx).toBeGreaterThan(-1);
    expect(relatedIdx).toBeGreaterThan(guidanceIdx);
    expect(testsIdx).toBeGreaterThan(relatedIdx);
    expect(findingsIdx).toBeGreaterThan(testsIdx);
  });

  it("serialises related_files entries with file/reason/score", () => {
    const withRelated: ContextReport = {
      ...sampleContext,
      related_files: [
        {
          file: "src/nav/sidebar.ts",
          reason: 'related to Route Metadata Drift; shares domain token "billing"',
          score: 0.6,
        },
      ],
    };
    const parsed = JSON.parse(
      formatContextJsonReport(withRelated),
    ) as ContextReport;
    expect(parsed.related_files).toHaveLength(1);
    expect(parsed.related_files[0]!.file).toBe("src/nav/sidebar.ts");
    expect(parsed.related_files[0]!.reason).toContain("Route Metadata Drift");
    expect(parsed.related_files[0]!.score).toBe(0.6);
  });

  it("emits *_reason fields only when their array is empty", () => {
    const clean: ContextReport = {
      ...sampleContext,
      risk: { level: "none", high: 0, medium: 0, low: 0, total: 0 },
      findings: [],
      agent_guidance: [],
      related_files: [],
      likely_tests: [],
      agent_guidance_reason: "no findings on this file and no deterministic related files",
      related_files_reason: "no neighbourhood signal: no IA finding related_files, no shared domain tokens, no domain-prefix filenames, no same-directory siblings",
      likely_tests_reason: "no sibling, __tests__, .test, .spec, _test, or _spec files matched the target basename",
    };
    const parsed = JSON.parse(
      formatContextJsonReport(clean),
    ) as ContextReport;
    expect(parsed.agent_guidance_reason).toMatch(/no findings/);
    expect(parsed.related_files_reason).toMatch(/no neighbourhood signal/);
    expect(parsed.likely_tests_reason).toMatch(/no sibling/);

    const populated = JSON.parse(
      formatContextJsonReport(sampleContext),
    ) as ContextReport & Record<string, unknown>;
    expect(populated.agent_guidance_reason).toBeUndefined();
    expect(populated.related_files_reason).toBeUndefined();
    expect(populated.likely_tests_reason).toBeUndefined();
  });
});

describe("formatContextHumanReport", () => {
  it("renders the file, risk level, findings, guidance, and tests", () => {
    const out = formatContextHumanReport(sampleContext, { noColor: true });

    expect(out).toContain("src/billing.ts");
    expect(out).toContain("HIGH");
    expect(out).toContain("God Function");
    expect(out).toContain("generateInvoice");
    expect(out).toContain("crime_00001");
    expect(out).toContain("Prefer extracting pure helpers");
    expect(out).toContain("src/billing.test.ts");
    expect(out).toContain("src/__tests__/billing.test.ts");
  });

  it("places Agent guidance before Findings in the human report", () => {
    const out = formatContextHumanReport(sampleContext, { noColor: true });
    const guidanceIdx = out.indexOf("Agent guidance");
    const findingsIdx = out.indexOf("Findings");
    expect(guidanceIdx).toBeGreaterThan(-1);
    expect(findingsIdx).toBeGreaterThan(guidanceIdx);
  });

  it("renders a Related files block when related_files is populated", () => {
    const withRelated: ContextReport = {
      ...sampleContext,
      related_files: [
        {
          file: "src/nav/sidebar.ts",
          reason: "related to Route Metadata Drift",
          score: 0.4,
        },
        {
          file: "src/nav/registry.ts",
          reason: 'shares domain token "billing"',
          score: 0.2,
        },
      ],
    };
    const out = formatContextHumanReport(withRelated, { noColor: true });
    expect(out).toContain("Related files");
    expect(out).toContain("src/nav/sidebar.ts");
    expect(out).toContain("Route Metadata Drift");
    expect(out).toContain("src/nav/registry.ts");
    expect(out).toContain("billing");
  });

  it("renders the related_files_reason when the array is empty", () => {
    const clean: ContextReport = {
      ...sampleContext,
      risk: { level: "none", high: 0, medium: 0, low: 0, total: 0 },
      findings: [],
      likely_tests: [],
      agent_guidance: [],
      related_files: [],
      agent_guidance_reason: "no findings on this file and no deterministic related files",
      related_files_reason: "no neighbourhood signal found",
      likely_tests_reason: "no sibling, __tests__, .test, .spec, _test, or _spec files matched the target basename",
    };
    const out = formatContextHumanReport(clean, { noColor: true });
    expect(out).toContain("Related files");
    expect(out).toContain("no neighbourhood signal found");
    expect(out).toContain("no sibling");
  });

  it("caps the Related files block at 5 entries and notes overflow", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      file: `src/x${i}.ts`,
      reason: "same directory",
      score: 0.2,
    }));
    const out = formatContextHumanReport(
      { ...sampleContext, related_files: many },
      { noColor: true },
    );
    expect(out).toContain("src/x0.ts");
    expect(out).toContain("src/x4.ts");
    expect(out).not.toContain("src/x5.ts");
    expect(out).toContain("and 3 more (see JSON output)");
  });

  it("handles a clean file with no findings or tests", () => {
    const clean: ContextReport = {
      ...sampleContext,
      risk: { level: "none", high: 0, medium: 0, low: 0, total: 0 },
      findings: [],
      likely_tests: [],
      agent_guidance: [],
      related_files: [],
    };
    const out = formatContextHumanReport(clean, { noColor: true });
    expect(out).toContain("src/billing.ts");
    expect(out).toMatch(/no findings|clean|none/i);
    expect(out).toMatch(/no .*test|tests: none|no likely tests/i);
  });
});

const sampleDiff: DiffReport = {
  schema_version: "0.2.0",
  report_type: "diff",
  repo: { name: "demo", root: "/tmp/demo" },
  base: "main",
  head: "HEAD",
  summary: { new: 2, fixed: 1, unchanged: 8 },
  new_findings: [
    {
      id: "crime_00001",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      confidence: 0.9,
      file: "src/new.ts",
      symbol: "fresh",
      lines: [1, 90],
      summary: "...",
      evidence: ["90 lines"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.9, confidence: 0.9 },
    },
    {
      id: "crime_00002",
      type: "todo_density",
      charge: "Unfinished Business",
      severity: "medium",
      confidence: 0.8,
      file: "src/new.ts",
      lines: [1, 30],
      summary: "...",
      evidence: ["6× TODO"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.5, confidence: 0.8 },
    },
  ],
  fixed_findings: [
    {
      id: "crime_00003",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      confidence: 0.95,
      file: "src/deleted.ts",
      symbol: "removed",
      lines: [1, 90],
      summary: "...",
      evidence: ["90 lines"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.9, confidence: 0.95 },
    },
  ],
  unchanged_findings: [],
};

describe("formatDiffReport", () => {
  it("renders the concise CRIMES DIFF block", () => {
    const out = formatDiffReport(sampleDiff, { noColor: true });
    expect(out).toContain("CRIMES DIFF");
    expect(out).toContain("base: main");
    expect(out).toContain("head: HEAD");
    expect(out).toContain("New crimes: 2");
    expect(out).toContain("Fixed crimes: 1");
    expect(out).toContain("Unchanged crimes: 8");
  });

  it("uses the literal counts from the report summary", () => {
    const zero: DiffReport = {
      ...sampleDiff,
      summary: { new: 0, fixed: 0, unchanged: 0 },
      new_findings: [],
      fixed_findings: [],
    };
    const out = formatDiffReport(zero, { noColor: true });
    expect(out).toContain("New crimes: 0");
    expect(out).toContain("Fixed crimes: 0");
    expect(out).toContain("Unchanged crimes: 0");
  });
});

describe("formatDiffJsonReport", () => {
  it("includes every required key", () => {
    const parsed = JSON.parse(formatDiffJsonReport(sampleDiff)) as Record<
      string,
      unknown
    >;
    for (const key of [
      "schema_version",
      "report_type",
      "repo",
      "base",
      "head",
      "summary",
      "new_findings",
      "fixed_findings",
      "unchanged_findings",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.schema_version).toBe("0.2.0");
    expect(parsed.report_type).toBe("diff");
  });

  it("preserves finding groups as arrays of the same Finding shape", () => {
    const parsed = JSON.parse(formatDiffJsonReport(sampleDiff)) as DiffReport;
    expect(parsed.new_findings).toHaveLength(2);
    expect(parsed.fixed_findings).toHaveLength(1);
    expect(parsed.new_findings[0]!.charge).toBe("God Function");
    expect(parsed.fixed_findings[0]!.file).toBe("src/deleted.ts");
  });
});

const sampleVerdict: VerdictReport = {
  schema_version: "0.2.0",
  report_type: "verdict",
  repo: { name: "demo", root: "/tmp/demo" },
  base: "origin/main",
  head: "HEAD",
  verdict: "worse",
  summary: {
    new: 2,
    fixed: 1,
    unchanged: 8,
    new_by_severity: { high: 1, medium: 1, low: 0 },
    fixed_by_severity: { high: 0, medium: 1, low: 0 },
    new_weighted: 5,
    fixed_weighted: 2,
  },
  reasons: ["introduced 1 high-severity crime"],
  recommended_actions: ["fix new high-severity findings before merging."],
  new_findings: sampleDiff.new_findings,
  fixed_findings: sampleDiff.fixed_findings,
};

describe("formatVerdictReport", () => {
  it("renders the headline CRIMES VERDICT block", () => {
    const out = formatVerdictReport(sampleVerdict, { noColor: true });
    expect(out).toContain("CRIMES VERDICT");
    expect(out).toContain("base: origin/main");
    expect(out).toContain("head: HEAD");
    expect(out).toContain("Verdict: WORSE");
    expect(out).toContain("New: 2");
    expect(out).toContain("Fixed: 1");
    expect(out).toContain("Reason: introduced 1 high-severity crime");
    expect(out).toContain(
      "Recommended next action: fix new high-severity findings before merging.",
    );
  });

  it("uppercases each verdict label distinctly", () => {
    for (const v of ["cleaner", "unchanged", "mixed"] as const) {
      const out = formatVerdictReport(
        { ...sampleVerdict, verdict: v, reasons: [], recommended_actions: [] },
        { noColor: true },
      );
      expect(out).toContain(`Verdict: ${v.toUpperCase()}`);
    }
  });
});

describe("formatVerdictJsonReport", () => {
  it("includes every required key", () => {
    const parsed = JSON.parse(formatVerdictJsonReport(sampleVerdict)) as Record<
      string,
      unknown
    >;
    for (const key of [
      "schema_version",
      "report_type",
      "repo",
      "base",
      "head",
      "verdict",
      "summary",
      "reasons",
      "recommended_actions",
      "new_findings",
      "fixed_findings",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.schema_version).toBe("0.2.0");
    expect(parsed.report_type).toBe("verdict");
    expect(parsed.verdict).toBe("worse");
  });

  it("round-trips the summary with severity buckets", () => {
    const parsed = JSON.parse(
      formatVerdictJsonReport(sampleVerdict),
    ) as VerdictReport;
    expect(parsed.summary.new_by_severity).toEqual({
      high: 1,
      medium: 1,
      low: 0,
    });
    expect(parsed.summary.fixed_by_severity).toEqual({
      high: 0,
      medium: 1,
      low: 0,
    });
    expect(parsed.summary.new_weighted).toBe(5);
    expect(parsed.summary.fixed_weighted).toBe(2);
  });
});

describe("formatScanFailOnLine", () => {
  it("emits an OK line when the gate passes", () => {
    const report: ScanReport = {
      ...sampleReport,
      fail_on: "high",
      failed: false,
    };
    const out = formatScanFailOnLine(report, { noColor: true });
    expect(out).toContain("OK");
    expect(out).toContain('"high"');
    expect(out).not.toContain("FAILED");
  });

  it("emits a FAILED line when the gate trips", () => {
    const report: ScanReport = {
      ...sampleReport,
      fail_on: "medium",
      failed: true,
    };
    const out = formatScanFailOnLine(report, { noColor: true });
    expect(out).toContain("FAILED");
    expect(out).toContain('"medium"');
    expect(out).not.toMatch(/^OK/);
  });

  it("prefixes OK with ✅ when colour is on", () => {
    const report: ScanReport = { ...sampleReport, fail_on: "high", failed: false };
    const out = formatScanFailOnLine(report, { noColor: false });
    expect(out).toContain("✅");
  });

  it("prefixes FAILED with ❌ when colour is on", () => {
    const report: ScanReport = { ...sampleReport, fail_on: "medium", failed: true };
    const out = formatScanFailOnLine(report, { noColor: false });
    expect(out).toContain("❌");
  });
});

describe("severity glyphs in human report", () => {
  it("prefixes severity heading and each finding when colour is on", () => {
    const out = formatHumanReport(sampleReport, { noColor: false });
    expect(out).toContain("🚨");
    expect(out).toContain("⚠️");
  });

  it("omits glyphs entirely when noColor is true", () => {
    const out = formatHumanReport(sampleReport, { noColor: true });
    expect(out).not.toContain("🚨");
    expect(out).not.toContain("⚠️");
    expect(out).not.toContain("🔎");
    expect(out).not.toContain("✨");
  });

  it("prefixes the 'no crimes' line with ✨ when colour is on", () => {
    const empty: ScanReport = {
      ...sampleReport,
      summary: { total: 0, high: 0, medium: 0, low: 0 },
      findings: [],
    };
    const out = formatHumanReport(empty, { noColor: false });
    expect(out).toContain("✨");
    expect(out).toContain("No crimes detected");
  });
});

const sampleHotspots: HotspotsReport = {
  schema_version: "0.2.0",
  report_type: "hotspots",
  repo: { name: "demo", root: "/tmp/demo" },
  since: "90d",
  git_available: true,
  hotspots: [
    {
      file: "src/billing.ts",
      change_count: 14,
      latest_change: "2026-05-12T14:30:00+00:00",
      finding_count: 3,
      highest_severity: "high",
      risk: 0.82,
    },
    {
      file: "src/clean.ts",
      change_count: 1,
      finding_count: 0,
      highest_severity: "none",
      risk: 0.03,
    },
  ],
};

describe("formatHotspotsReport", () => {
  it("renders the CRIMES HOTSPOTS header, since window, and per-file rows", () => {
    const out = formatHotspotsReport(sampleHotspots, { noColor: true });
    expect(out).toContain("CRIMES HOTSPOTS");
    expect(out).toContain("since 90d");
    expect(out).toContain("src/billing.ts");
    expect(out).toContain("14 changes");
    expect(out).toContain("highest high");
  });

  it("warns when git is unavailable", () => {
    const out = formatHotspotsReport(
      { ...sampleHotspots, git_available: false },
      { noColor: true },
    );
    expect(out).toContain("not a git repo");
  });

  it("warns when history is limited (shallow clone)", () => {
    const out = formatHotspotsReport(
      {
        ...sampleHotspots,
        history_limited: true,
        history_limited_reason:
          "repository is a shallow clone; older commits are unavailable",
      },
      { noColor: true },
    );
    expect(out).toContain("history limited");
    expect(out).toContain("shallow clone");
  });

  it("does not warn about history when git is available and history is not limited", () => {
    const out = formatHotspotsReport(sampleHotspots, { noColor: true });
    expect(out).not.toContain("history limited");
    expect(out).not.toContain("not a git repo");
  });

  it("shows an empty-state line when no hotspots are returned", () => {
    const out = formatHotspotsReport(
      { ...sampleHotspots, hotspots: [] },
      { noColor: true },
    );
    expect(out).toContain("No hotspots");
  });
});

describe("formatHotspotsJsonReport", () => {
  it("includes every required key", () => {
    const parsed = JSON.parse(
      formatHotspotsJsonReport(sampleHotspots),
    ) as Record<string, unknown>;
    for (const key of [
      "schema_version",
      "report_type",
      "repo",
      "since",
      "git_available",
      "hotspots",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.schema_version).toBe("0.2.0");
    expect(parsed.report_type).toBe("hotspots");
  });

  it("round-trips hotspot rows", () => {
    const parsed = JSON.parse(
      formatHotspotsJsonReport(sampleHotspots),
    ) as HotspotsReport;
    expect(parsed.hotspots).toHaveLength(2);
    expect(parsed.hotspots[0]!.risk).toBe(0.82);
    expect(parsed.hotspots[0]!.latest_change).toBe(
      "2026-05-12T14:30:00+00:00",
    );
  });
});

const sampleBaseline: Baseline = {
  schema_version: "0.2.0",
  report_type: "baseline",
  created_at: "2026-05-16T12:00:00.000Z",
  crimes_version: "0.2.0",
  repo: { name: "demo", root: "/tmp/demo" },
  summary: { total: 2, high: 1, medium: 1, low: 0 },
  findings: [
    {
      fingerprint: "large_function::src/billing.ts::generateInvoice",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      file: "src/billing.ts",
      symbol: "generateInvoice",
    },
    {
      fingerprint: "todo_density::src/todo.ts::",
      type: "todo_density",
      charge: "Unfinished Business",
      severity: "medium",
      file: "src/todo.ts",
    },
  ],
};

describe("formatBaselineSaveReport", () => {
  it("renders the save header and the recorded counts", () => {
    const out = formatBaselineSaveReport(
      sampleBaseline,
      "/abs/path/to/.crimes/baseline.json",
      { noColor: true },
    );
    expect(out).toContain("CRIMES BASELINE SAVED");
    expect(out).toContain("/abs/path/to/.crimes/baseline.json");
    expect(out).toContain("Recorded 2 findings");
    expect(out).toContain("high 1");
    expect(out).toContain("medium 1");
  });
});

describe("formatBaselineJsonReport", () => {
  it("includes the baseline discriminator keys", () => {
    const parsed = JSON.parse(
      formatBaselineJsonReport(sampleBaseline),
    ) as Record<string, unknown>;
    for (const key of [
      "schema_version",
      "report_type",
      "created_at",
      "summary",
      "findings",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.report_type).toBe("baseline");
  });
});

const sampleBaselineCheck: BaselineCheckReport = {
  schema_version: "0.2.0",
  report_type: "baseline_check",
  repo: { name: "demo", root: "/tmp/demo" },
  baseline_path: "/abs/path/to/.crimes/baseline.json",
  fail_on: "medium",
  failed: true,
  summary: {
    total_baseline: 2,
    total_current: 3,
    new: 1,
    fixed: 0,
    unchanged: 2,
    new_by_severity: { high: 1, medium: 0, low: 0 },
  },
  new_findings: [
    {
      id: "crime_00001",
      type: "large_function",
      charge: "God Function",
      severity: "high",
      confidence: 0.9,
      file: "src/new.ts",
      symbol: "huge",
      lines: [1, 90],
      summary: "huge spans 90 lines.",
      evidence: ["90 lines"],
      effort: "medium",
      fix_shape: "stub",
      scores: { severity: 0.9, confidence: 0.9 },
    },
  ],
  fixed_findings: [],
  unchanged_findings: [],
};

describe("formatBaselineCheckReport", () => {
  it("renders headers, severity buckets, and a FAILED gate line", () => {
    const out = formatBaselineCheckReport(sampleBaselineCheck, {
      noColor: true,
    });
    expect(out).toContain("CRIMES BASELINE CHECK");
    expect(out).toContain("fail-on: medium");
    expect(out).toContain("New crimes: 1");
    expect(out).toContain("Fixed crimes: 0");
    expect(out).toContain("Unchanged crimes: 2");
    expect(out).toContain("FAILED:");
    expect(out).toContain('"medium"');
  });

  it("renders an OK gate line when no new findings meet the threshold", () => {
    const out = formatBaselineCheckReport(
      {
        ...sampleBaselineCheck,
        failed: false,
        new_findings: [],
        summary: {
          ...sampleBaselineCheck.summary,
          new: 0,
          new_by_severity: { high: 0, medium: 0, low: 0 },
        },
      },
      { noColor: true },
    );
    expect(out).toContain("OK:");
    expect(out).not.toContain("FAILED:");
  });
});

describe("formatBaselineCheckJsonReport", () => {
  it("includes every required key and the gate fields", () => {
    const parsed = JSON.parse(
      formatBaselineCheckJsonReport(sampleBaselineCheck),
    ) as Record<string, unknown>;
    for (const key of [
      "schema_version",
      "report_type",
      "repo",
      "baseline_path",
      "fail_on",
      "failed",
      "summary",
      "new_findings",
      "fixed_findings",
      "unchanged_findings",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.report_type).toBe("baseline_check");
    expect(parsed.fail_on).toBe("medium");
    expect(parsed.failed).toBe(true);
  });
});

function stubContextReport(
  overrides: Partial<ContextReport>,
): ContextReport {
  return {
    schema_version: "0.2.0",
    report_type: "context",
    repo: { name: "demo", root: "/tmp/demo" },
    file: "src/billing.ts",
    risk: { level: "none", high: 0, medium: 0, low: 0, total: 0 },
    agent_guidance: [],
    related_files: [],
    likely_tests: [],
    findings: [],
    ...overrides,
  };
}

describe("formatContextHumanReport — clues block", () => {
  it("renders a Clues section with churn / suppressions / test_gap when present", () => {
    const report: ContextReport = stubContextReport({
      clues: {
        churn: { commits_90d: 14, last_commit_at: "2026-05-18T12:30:00Z", unique_authors_90d: 3 },
        suppressions: [
          { fingerprint: "abc", detector: "large_function", reason: "legacy", pinned_version: "0.9.x", matches_current_finding: false },
        ],
        test_gap: { raw: 1, percentile: 0.85, label: "top-quartile" },
        related_signals: [],
      },
    });
    const out = formatContextHumanReport(report, { noColor: true });
    expect(out).toContain("Clues");
    expect(out).toContain("churn: 14 commits / 3 authors (last 2026-05-18)");
    expect(out).toContain("test gap: top-quartile");
    expect(out).toContain("known suppressions: 1");
  });

  it("omits the Clues section when report.clues is absent", () => {
    const report = stubContextReport({});
    const out = formatContextHumanReport(report, { noColor: true });
    expect(out).not.toContain("Clues");
  });
});

describe("formatHumanReport — file-grouped layout", () => {
  it("groups by file, caps at topFiles, renders Also-flagged footer + action-close", () => {
    const report = stubReport({
      findings: [
        domainFinding({
          file: "src/a.ts",
          agent_risk: 0.9,
          recency: 1,
          severity: "high",
        }),
        domainFinding({
          file: "src/a.ts",
          agent_risk: 0.8,
          recency: 1,
          severity: "medium",
        }),
        domainFinding({
          file: "src/b.ts",
          agent_risk: 0.7,
          recency: 0,
          severity: "high",
        }),
        nonDomainFinding({
          file: "scripts/x.ts",
          agent_risk: 0.6,
          severity: "medium",
        }),
        nonDomainFinding({
          file: "tests/y.test.ts",
          agent_risk: 0.5,
          severity: "low",
        }),
      ],
    });
    const out = formatHumanReport(report, { noColor: true });
    expect(out).toContain("Top files by risk");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("2 findings");
    expect(out).toContain("1 high");
    expect(out).toContain("Also flagged elsewhere");
    expect(out).toContain("scripts/");
    expect(out).toContain("tests/");
    expect(out).toContain("→ Start with `crimes context src/a.ts`");
  });

  it("--flat reverts to today's severity-grouped layout", () => {
    const report = stubReport({
      findings: [
        domainFinding({
          file: "src/a.ts",
          agent_risk: 0.9,
          recency: 1,
          severity: "high",
        }),
        domainFinding({
          file: "src/b.ts",
          agent_risk: 0.7,
          recency: 0,
          severity: "medium",
        }),
      ],
    });
    const out = formatHumanReport(report, { flat: true, noColor: true });
    expect(out).toContain("HIGH severity");
    expect(out).not.toContain("Top files by risk");
  });

  it("--all flattens both tiers", () => {
    const report = stubReport({
      findings: [
        domainFinding({
          file: "src/a.ts",
          agent_risk: 0.9,
          recency: 1,
          severity: "high",
        }),
        domainFinding({
          file: "src/a.ts",
          agent_risk: 0.8,
          recency: 1,
          severity: "medium",
        }),
        domainFinding({
          file: "src/b.ts",
          agent_risk: 0.7,
          recency: 0,
          severity: "high",
        }),
        nonDomainFinding({
          file: "scripts/x.ts",
          agent_risk: 0.6,
          severity: "medium",
        }),
        nonDomainFinding({
          file: "tests/y.test.ts",
          agent_risk: 0.5,
          severity: "low",
        }),
      ],
    });
    const out = formatHumanReport(report, { showAll: true, noColor: true });
    expect(out).not.toContain("Also flagged elsewhere");
    expect(out).toContain("scripts/x.ts");
  });

  it("falls back to top non-domain file when no domain findings exist", () => {
    const report = stubReport({
      findings: [
        nonDomainFinding({
          file: "scripts/x.ts",
          agent_risk: 0.6,
        }),
      ],
    });
    const out = formatHumanReport(report, { noColor: true });
    expect(out).toContain("every finding is in non-domain folders");
    expect(out).toContain("crimes context scripts/x.ts");
  });

  it("keeps the green sparkle line when there are no findings", () => {
    const report = stubReport({ findings: [] });
    const out = formatHumanReport(report, { noColor: true });
    expect(out).toContain("No crimes detected");
  });
});

let nextStubFindingIndex = 1;
function nextStubFindingId(): string {
  const idx = nextStubFindingIndex++;
  return `crime_${String(idx).padStart(5, "0")}`;
}

interface StubFindingOptions {
  file: string;
  agent_risk?: number;
  recency?: number;
  severity?: "low" | "medium" | "high";
  charge?: string;
  symbol?: string;
  evidence?: string[];
  churn?: number;
  test_gap?: number;
  blast_radius?: number;
  type?: string;
}

function domainFinding(opts: StubFindingOptions): Finding {
  return buildStubFinding(opts, "domain");
}

function nonDomainFinding(opts: StubFindingOptions): Finding {
  return buildStubFinding(opts, "nonDomain");
}

function buildStubFinding(
  opts: StubFindingOptions,
  tier: "domain" | "nonDomain",
): Finding {
  const severity = opts.severity ?? "medium";
  return {
    id: nextStubFindingId(),
    type: opts.type ?? "large_function",
    charge: opts.charge ?? "God Function",
    severity,
    confidence: 0.9,
    file: opts.file,
    symbol: opts.symbol,
    summary: `Stub finding in ${opts.file}.`,
    evidence: opts.evidence ?? [],
    effort: "medium",
    fix_shape: "stub",
    scores: {
      severity: severityToScore(severity),
      confidence: 0.9,
      agent_risk: opts.agent_risk,
      recency: opts.recency,
      churn: opts.churn,
      test_gap: opts.test_gap,
      blast_radius: opts.blast_radius,
    },
    tier,
  };
}

function severityToScore(severity: "low" | "medium" | "high"): number {
  switch (severity) {
    case "high":
      return 0.9;
    case "medium":
      return 0.5;
    case "low":
      return 0.2;
  }
}

function stubReport({ findings }: { findings: Finding[] }): ScanReport {
  const summary = findings.reduce(
    (acc, f) => {
      acc.total += 1;
      acc[f.severity] += 1;
      return acc;
    },
    { total: 0, high: 0, medium: 0, low: 0 },
  );
  return {
    schema_version: "0.2.0",
    report_type: "scan",
    repo: { name: "acme-app", root: "/tmp/acme-app" },
    summary,
    findings,
  };
}

describe("renderRiskProfileLine — test_gap quartile label", () => {
  it("renders 'top-quartile' for scores >= 0.75", () => {
    const f = stubFinding({ test_gap: 0.75 });
    const line = renderRiskProfileLine(f, pc, { alwaysShowRiskProfile: true });
    expect(line).toContain("test gap top-quartile");
    expect(line).not.toContain("0.75");
  });

  it("renders 'bottom-quartile' for scores <= 0.25", () => {
    const f = stubFinding({ test_gap: 0.25 });
    const line = renderRiskProfileLine(f, pc, { alwaysShowRiskProfile: true });
    expect(line).toContain("test gap bottom-quartile");
  });

  it("renders '~median' for scores in (0.25, 0.75)", () => {
    const f = stubFinding({ test_gap: 0.5 });
    const line = renderRiskProfileLine(f, pc, { alwaysShowRiskProfile: true });
    expect(line).toContain("test gap ~median");
  });
});

function stubFinding(scores: Partial<FindingScores>): Finding {
  return {
    id: "x",
    type: "t",
    charge: "C",
    severity: "low",
    confidence: 0.5,
    file: "a.ts",
    summary: "",
    evidence: [],
    effort: "medium",
    fix_shape: "stub",
    scores: { severity: 0.5, confidence: 0.5, ...scores },
  };
}

describe("inline feedback hints (0.7.0)", () => {
  // Feedback hints live inside the rich per-finding block, which is
  // emitted by `--all` (and `--flat`). The default file-grouped layout
  // (release A) collapses each finding to a one-line compact entry and
  // does not surface hints inline — they will be re-introduced as a
  // single summary line in a later task. Tests retain their original
  // intent by running through `--all`.
  it("appends 'Give feedback: ...' under each finding when enabled", () => {
    const out = formatHumanReport(sampleReport, {
      noColor: false, // hints require colour mode to fire
      showAll: true,
      feedbackHints: { entriesByDetector: {} },
    });
    expect(out).toContain("Give feedback: crimes feedback large_function::src/billing.ts::generateInvoice --verdict {tp|fp}");
    expect(out).toContain("Give feedback: crimes feedback todo_density::src/todo.ts:: --verdict {tp|fp}");
  });

  it("is suppressed when noColor is true (piped / --no-color path)", () => {
    const out = formatHumanReport(sampleReport, {
      noColor: true,
      showAll: true,
      feedbackHints: { entriesByDetector: {} },
    });
    expect(out).not.toContain("Give feedback:");
  });

  it("is omitted entirely when feedbackHints is unset", () => {
    const out = formatHumanReport(sampleReport, {
      noColor: false,
      showAll: true,
    });
    expect(out).not.toContain("Give feedback:");
  });

  it("is suppressed for detectors at or above the per-detector cap (default 5)", () => {
    const out = formatHumanReport(sampleReport, {
      noColor: false,
      showAll: true,
      feedbackHints: {
        entriesByDetector: { large_function: 5, todo_density: 4 },
      },
    });
    // large_function hit cap → no hint
    expect(out).not.toContain("Give feedback: crimes feedback large_function");
    // todo_density still below cap → hint stays
    expect(out).toContain("Give feedback: crimes feedback todo_density");
  });

  it("honours a custom capPerDetector", () => {
    const out = formatHumanReport(sampleReport, {
      noColor: false,
      showAll: true,
      feedbackHints: {
        entriesByDetector: { large_function: 2 },
        capPerDetector: 2,
      },
    });
    expect(out).not.toContain("Give feedback: crimes feedback large_function");
  });

  it("uses the resurfaced variant for previously_suppressed findings", () => {
    const report: ScanReport = {
      ...sampleReport,
      findings: [
        {
          ...sampleReport.findings[0]!,
          previously_suppressed: true,
          previous_suppression: {
            pinned_version: "0.6",
            reason: "Commander DSL chain",
          },
        },
      ],
      summary: { total: 1, high: 1, medium: 0, low: 0 },
    };
    const out = formatHumanReport(report, {
      noColor: false,
      showAll: true,
      feedbackHints: { entriesByDetector: {} },
    });
    expect(out).toContain("⚠ Previously marked fp in 0.6");
    expect(out).toContain("Re-confirm: crimes feedback large_function");
    expect(out).toContain("crimes feedback recheck");
  });
});
