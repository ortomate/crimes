import { describe, expect, it } from "vitest";
import { type RankedFinding, scoreRanking } from "./ranking.js";

/** `n` findings of `type`, so a ranked list is cheap to write. */
function run(type: string, n: number): RankedFinding[] {
  return Array.from({ length: n }, (_, i) => ({ type, file: `f${i}.ts` }));
}

describe("scoreRanking — nDCG over the scan's own order", () => {
  it("scores a perfect ranking 1.0", () => {
    const findings = [...run("direct_date", 3), ...run("large_file", 20)];
    const r = scoreRanking(findings, { referenced_findings: ["direct_date"] });
    expect(r.ndcg).toBe(1);
    expect(r.first_relevant_rank).toBe(1);
  });

  it("scores the same findings buried at the bottom far lower", () => {
    const findings = [...run("large_file", 20), ...run("direct_date", 3)];
    const r = scoreRanking(findings, { referenced_findings: ["direct_date"] });
    expect(r.ndcg).toBeLessThan(0.5);
    expect(r.first_relevant_rank).toBe(21);
  });

  it("ranks the expected_priority type above a merely-expected one", () => {
    // Same two types, same positions — only which one the scenario
    // calls the priority differs. A metric that cannot tell these
    // apart cannot see a re-ranking.
    const findings = [...run("direct_date", 1), ...run("large_file", 1)];
    const priorityFirst = scoreRanking(findings, {
      referenced_findings: ["direct_date", "large_file"],
      expected_priority: "direct_date",
    });
    const priorityLast = scoreRanking(findings, {
      referenced_findings: ["direct_date", "large_file"],
      expected_priority: "large_file",
    });
    expect(priorityFirst.ndcg ?? 0).toBeGreaterThan(priorityLast.ndcg ?? 0);
    expect(priorityFirst.priority_rank).toBe(1);
    expect(priorityLast.priority_rank).toBe(2);
  });

  it("is monotonic — promoting a relevant finding never lowers the score", () => {
    const buried = [...run("noise", 10), ...run("direct_date", 1)];
    const mid = [...run("noise", 5), ...run("direct_date", 1), ...run("noise", 5)];
    const top = [...run("direct_date", 1), ...run("noise", 10)];
    const of = (f: RankedFinding[]) =>
      scoreRanking(f, { referenced_findings: ["direct_date"] }).ndcg ?? 0;
    expect(of(buried)).toBeLessThan(of(mid));
    expect(of(mid)).toBeLessThan(of(top));
  });

  it("skips a scenario with no expected findings rather than scoring it 0", () => {
    // `context-09-clean-tiny` expects nothing. A 0 here would drag the
    // aggregate down for a control fixture that is behaving correctly.
    const r = scoreRanking(run("noise", 3), {});
    expect(r.ndcg).toBeNull();
    expect(r.skipped).toBe("scenario declares no expected findings");
  });

  it("skips — and says so — when no expected type fired at all", () => {
    // Nothing to rank. This is a detection failure, which
    // `evals:verify-scenarios` already gates; folding it in as a 0
    // would report it as a ranking regression.
    const r = scoreRanking(run("noise", 5), {
      referenced_findings: ["direct_date"],
    });
    expect(r.ndcg).toBeNull();
    expect(r.relevant_findings).toBe(0);
    expect(r.skipped).toBe("no finding of an expected type fired");
  });

  it("reports the ranking depth it had to work with", () => {
    // A fixture emitting 3 findings cannot demonstrate a ranking
    // change. The consumer needs the denominator to know that.
    const r = scoreRanking([...run("direct_date", 1), ...run("noise", 2)], {
      referenced_findings: ["direct_date"],
    });
    expect(r.total_findings).toBe(3);
    expect(r.relevant_findings).toBe(1);
  });
});

describe("scoreRanking — concentration", () => {
  it("reports the top-20 monoculture share", () => {
    // zulip's top 20 went from 18/20 `large_function` to 16/20
    // `sync_io_in_hotpath`. Both are monocultures; the number is the
    // only way to say so without reading the list.
    const findings = [...run("sync_io_in_hotpath", 16), ...run("other", 4)];
    const r = scoreRanking(findings, { referenced_findings: ["other"] });
    expect(r.top20_dominant_type).toBe("sync_io_in_hotpath");
    expect(r.top20_dominant_share).toBe(0.8);
    expect(r.top20_distinct_types).toBe(2);
  });
});
