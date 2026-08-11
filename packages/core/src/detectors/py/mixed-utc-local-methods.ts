import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, lineList, severityScore } from "./shared.js";

/**
 * Python's version of the JS `mixed_utc_local_methods` charge.
 *
 * The JS detector looks for `get*UTC*` and `get*` on the same receiver.
 * Python has no such method pairs — the equivalent hazard is a module
 * that reads the clock through **both** `utcnow()`/`utcnow`-family calls
 * and local `now()`/`today()` calls, producing naive datetimes that
 * represent two different zones and are then compared, subtracted, or
 * stored in the same column as if they were the same kind of value.
 *
 * The tell is the mixture, not either call alone — which is why
 * `direct_date.py` charges the individual reads and this charges the
 * inconsistency.
 *
 * ## Why a project's `timezone.utcnow()` wrapper is deliberately not matched
 *
 * The receiver must resolve to `datetime`. That looks like an obvious
 * gap — airflow writes `timezone.utcnow()` 728 times and this detector
 * reports nothing on the whole repo — and it was filed as one. It is
 * not.
 *
 * `airflow_shared.timezones.timezone.utcnow()` is
 * `dt.datetime.now(tz=utc)`: a timezone-**aware** datetime. It is not
 * the naive-UTC trap this detector exists to charge; it is the fix this
 * detector *recommends*. Matching any `<something>.utcnow()` would have
 * turned the single most common correct idiom in the corpus into ~728
 * high-confidence false positives.
 *
 * Airflow's whole tree contains exactly one `datetime.datetime.utcnow()`
 * and it is inside a comment. Zero findings there is the right answer,
 * arrived at for the right reason.
 *
 * Resolving what a wrapper actually returns needs a cross-file Python
 * symbol index, which does not exist. Until it does, requiring the
 * `datetime` receiver is the honest boundary: it charges what it can
 * prove and stays silent about what it would have to guess.
 */
export const mixedUtcLocalMethodsPyDetector: LanguagePyDetector = {
  id: "mixed_utc_local_methods.py",
  name: "Mixed UTC and local clock reads (Python)",
  description:
    "Flags modules that read the clock through both a UTC-naive call (utcnow) and a " +
    "local call (now / today) without timezone arguments.",
  whyItMatters:
    "`datetime.utcnow()` and `datetime.now()` both return naive datetimes — objects " +
    "with no timezone attached — but they hold values from two different zones. " +
    "Nothing at the type level stops you subtracting one from the other, and the " +
    "result is silently wrong by the host's UTC offset. It passes every test on a CI " +
    "runner set to UTC and drifts by hours in production. An agent editing one call " +
    "site has no way to see which convention the rest of the module assumed, because " +
    "both produce the same type.",

  pack: "language-py",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];

    const naive = ctx.parsed.dateCalls.filter((c) => !c.timezoneAware);
    const utc = naive.filter((c) => c.kind === "utcnow");
    const local = naive.filter((c) => c.kind === "now" || c.kind === "today");

    // The charge is the mixture. Either family alone is `direct_date.py`.
    if (utc.length === 0 || local.length === 0) return [];

    const offenders = utc.length + local.length;
    const severity: Severity = offenders >= 5 ? "high" : "medium";
    const all = [...utc, ...local].sort((a, b) => a.line - b.line);

    const finding: Finding = {
      id: "",
      type: "mixed_utc_local_methods",
      charge: "Two Clocks, One Module",
      severity,
      confidence: 0.85,
      file: ctx.file,
      lines: [all[0]!.line, all[all.length - 1]!.line],
      summary:
        `This module reads the clock ${utc.length}× through utcnow() and ` +
        `${local.length}× through now()/today(), all without timezone arguments. ` +
        "Both produce naive datetimes holding values from different zones, so any " +
        "comparison between them is wrong by the host's UTC offset.",
      evidence: [
        `UTC-naive reads: ${utc.map((c) => `${c.callee}() line ${c.line}`).join(", ")}`,
        `local-naive reads: ${local.map((c) => `${c.callee}() line ${c.line}`).join(", ")}`,
        lineList(all.map((c) => c.line)),
        "both families return naive datetimes — the type system cannot tell them apart",
        "a UTC-configured CI runner makes the two agree, so tests pass and production drifts",
      ],
      effort: "small",
      fix_shape: "pick one convention: timezone-aware UTC everywhere",
      scores: {
        severity: severityScore(severity),
        confidence: 0.85,
        // Rises with the number of offending call sites, matching the
        // JS detector's behaviour of scaling on offender count.
        // Base reconciled with the universal detector in 0.25.5: 0.65 is
        // the value `detector-defaults.ts` publishes for this charge, and
        // a judgement about the charge does not change with the language.
        //
        // The **step** deliberately stays at 0.06 against the universal
        // 0.10, because the two sides do not count the same thing. JS
        // counts UTC/local method calls on one receiver; Python has no
        // such method pairs, so this counts naive/aware mixes instead.
        // Same charge, different unit of evidence — a shared base with a
        // different ramp is the correct shape, not an oversight.
        agent_risk: intrinsicFor({
          count: offenders,
          base: 0.65,
          step: 0.06,
          cap: 0.9,
        }),
      },
      suggested_actions: [
        {
          kind: "unify_timezone_handling",
          description:
            "Replace both families with `datetime.now(timezone.utc)` so every value is " +
            "timezone-aware, then convert to local only at the presentation boundary.",
          risk: "medium",
        },
      ],
    };

    return [finding];
  },
};
