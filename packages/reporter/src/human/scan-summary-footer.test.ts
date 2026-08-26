import { describe, expect, it } from "vitest";
import type { Finding, ScanReport } from "@crimes/core";
import { formatHumanReport } from "./scan.js";

/**
 * The summary header is the most important line in the report and it is
 * the first thing lost.
 *
 * Field notes from choreograph.cc (2026-08-05): `scan --top 15` on a
 * 209-file repo emits 296 lines, so the header — line 6 — scrolls off
 * the terminal buffer. A second run at `--top 3` was needed *just to
 * read the totals*. Measured again against `main` before these tests
 * were written; it still reproduces.
 *
 * The fix is a repeat at the end, not a flag. A flag would have the same
 * discoverability problem as `--changed`: an agent only finds it by
 * reading `--help`, which it only does if it already suspects there is
 * something to find.
 *
 * **Where it goes is constrained by a prior decision.** The 0.10.0
 * front-door redesign moved the numeric summary behind `--show-summary`
 * on purpose and ended the report on the action-close (`→ Start with
 * crimes context <file>`), which is the most useful single line an agent
 * gets. That decision is not reversed here. The totals go *immediately
 * above* the action-close, so both survive in the last two lines and the
 * report still ends on something to do.
 */

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "crime_00001",
    fingerprint: "large_function::src/a.ts::foo",
    type: "large_function",
    pack: "language-js",
    detector_id: "large_function.js",
    charge: "God Function",
    severity: "medium",
    confidence: 0.8,
    file: "src/a.ts",
    summary: "summary",
    evidence: ["evidence"],
    effort: "small",
    fix_shape: "fix",
    scores: { severity: 0.5, confidence: 0.8 },
    ...overrides,
  };
}

function report(findings: Finding[]): ScanReport {
  return {
    schema_version: "0.8.0",
    report_type: "scan",
    repo: { name: "demo", root: "/demo" },
    summary: {
      total: findings.length,
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    },
    findings,
  } as ScanReport;
}

/** Many files, so the default view truncates and the report gets long. */
function manyFindings(count: number): Finding[] {
  return Array.from({ length: count }, (_, i) =>
    finding({
      id: `crime_${String(i + 1).padStart(5, "0")}`,
      fingerprint: `large_function::src/f${i}.ts::foo`,
      file: `src/f${i}.ts`,
      severity: i % 3 === 0 ? "high" : i % 3 === 1 ? "medium" : "low",
    }),
  );
}

/** Non-empty lines, so blank-line layout is not part of the contract. */
function tail(out: string, n: number): string[] {
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-n);
}

describe("scan report — the totals survive to the end", () => {
  it("repeats the finding total within the last two lines", () => {
    const out = formatHumanReport(report(manyFindings(40)), {
      noColor: true,
      topFiles: 15,
    });
    expect(tail(out, 2).join("\n")).toMatch(/40 findings/);
  });

  it("still ends on the action-close, per the 0.10.0 front-door design", () => {
    const out = formatHumanReport(report(manyFindings(40)), {
      noColor: true,
      topFiles: 15,
    });
    expect(tail(out, 1)[0]).toMatch(/^→ Start with/);
  });

  it("repeats the severity breakdown, not just the count", () => {
    const out = formatHumanReport(report(manyFindings(40)), {
      noColor: true,
      topFiles: 15,
    });
    const footer = tail(out, 2)[0] ?? "";
    expect(footer).toMatch(/14 high/);
    expect(footer).toMatch(/13 medium/);
    expect(footer).toMatch(/13 low/);
  });

  it("names the repo, so a footer read on its own is still attributable", () => {
    const out = formatHumanReport(report(manyFindings(40)), {
      noColor: true,
      topFiles: 15,
    });
    expect(tail(out, 2)[0]).toContain("demo");
  });

  it("phrases the repeat exactly like the header it repeats", () => {
    // Two different phrasings of the same fact read as two facts.
    const out = formatHumanReport(report(manyFindings(40)), {
      noColor: true,
      topFiles: 15,
    });
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    const header = lines.find((l) => l.startsWith("repo: "));
    expect(tail(out, 2)[0]).toBe(header);
  });

  it("does not repeat itself on a clean repo", () => {
    // "0 findings" already ends with the all-clear line, which is a
    // better last word than a zero.
    const out = formatHumanReport(report([]), { noColor: true });
    expect(tail(out, 1)[0]).toMatch(/No crimes detected/);
  });

  it("does not repeat itself when the whole report already fits", () => {
    // A report short enough to read in one screen does not need the
    // header said twice; the repeat exists to survive scrollback.
    const out = formatHumanReport(report([finding()]), { noColor: true });
    const headerCount = out
      .split("\n")
      .filter((l) => /1 finding across 1 file/.test(l)).length;
    expect(headerCount).toBe(1);
  });

  it("still repeats under --all, where the report is longest", () => {
    const out = formatHumanReport(report(manyFindings(40)), {
      noColor: true,
      showAll: true,
    });
    expect(tail(out, 3).join("\n")).toMatch(/40 findings/);
  });

  it("still repeats under --flat", () => {
    const out = formatHumanReport(report(manyFindings(40)), {
      noColor: true,
      flat: true,
    });
    expect(tail(out, 3).join("\n")).toMatch(/40 findings/);
  });
});

/**
 * The headline number must describe the report it heads.
 *
 * Field notes from choreograph.cc: "499 findings across 209 files … on a
 * working, shipping project reads as *your codebase is a crime scene*
 * when the codebase is in fact fine", and separately "roughly a third of
 * all findings live in `scripts/`".
 *
 * Re-measured on the same repo against `main`: the header said **491
 * findings across 208 files**, while the report body listed only the
 * **339 domain findings across 137 files**. The other 152 were already
 * classified `nonDomain` by `scopeTiers` — whose default first entry is
 * literally `scripts/**` — and already collapsed into a one-line "Also
 * flagged elsewhere" footer.
 *
 * So the mechanism the notes asked for (a config glob, applied at scan
 * time, that relegates scaffolding) **already shipped**. What was broken
 * is narrower and worse: the header was counting findings the report
 * then declined to show. The fix is to make the header agree with the
 * body, not to add a second way to say what `scopeTiers` already says.
 */
function mixedTierReport(): ScanReport {
  const domain = Array.from({ length: 6 }, (_, i) =>
    finding({
      id: `crime_d${i}`,
      fingerprint: `large_function::src/d${i}.ts::foo`,
      file: `src/d${i}.ts`,
      severity: i === 0 ? "high" : "medium",
    }),
  );
  const nonDomain = Array.from({ length: 4 }, (_, i) =>
    finding({
      id: `crime_n${i}`,
      fingerprint: `large_function::scripts/n${i}.ts::foo`,
      file: `scripts/n${i}.ts`,
      severity: "low",
      tier: "nonDomain",
    }),
  );
  return report([...domain, ...nonDomain]);
}

describe("the headline counts what the report shows", () => {
  function header(out: string): string {
    return out.split("\n").find((l) => l.startsWith("repo: ")) ?? "";
  }

  it("leads with the domain findings the body actually lists", () => {
    const out = formatHumanReport(mixedTierReport(), { noColor: true });
    expect(header(out)).toMatch(/6 findings across 6 files/);
  });

  it("breaks out the severity split for the domain findings only", () => {
    const out = formatHumanReport(mixedTierReport(), { noColor: true });
    expect(header(out)).toMatch(/1 high/);
    expect(header(out)).toMatch(/5 medium/);
    expect(header(out)).toMatch(/0 low/);
  });

  it("still states the non-domain remainder — nothing is hidden", () => {
    const out = formatHumanReport(mixedTierReport(), { noColor: true });
    expect(header(out)).toMatch(/\+4 in non-domain paths/);
  });

  it("says nothing about non-domain when there is none", () => {
    const out = formatHumanReport(report(manyFindings(3)), { noColor: true });
    expect(header(out)).not.toMatch(/non-domain/);
  });

  it("counts everything when every finding is non-domain", () => {
    // The report body falls back to listing them, so the header must too
    // — otherwise it reads "0 findings" above a page of findings.
    const all = Array.from({ length: 3 }, (_, i) =>
      finding({
        id: `crime_n${i}`,
        fingerprint: `large_function::scripts/n${i}.ts::foo`,
        file: `scripts/n${i}.ts`,
        tier: "nonDomain",
      }),
    );
    const out = formatHumanReport(report(all), { noColor: true });
    expect(header(out)).toMatch(/3 findings across 3 files/);
    expect(header(out)).not.toMatch(/non-domain paths/);
  });

  it("counts everything under --all, which lists everything", () => {
    const out = formatHumanReport(mixedTierReport(), { noColor: true, showAll: true });
    expect(header(out)).toMatch(/10 findings across 10 files/);
    expect(header(out)).not.toMatch(/non-domain paths/);
  });

  it("leaves summary.total alone — the JSON contract is unchanged", () => {
    // The renderer is a view. Teaching `summary` to withhold findings
    // would change the machine contract to fix a human-readability
    // problem.
    const r = mixedTierReport();
    formatHumanReport(r, { noColor: true });
    expect(r.summary.total).toBe(10);
  });
});
