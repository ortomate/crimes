import { type Stats, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyScanFailOn,
  applySuppressionsToScan,
  applyTriageToScan,
  countEntriesByDetector,
  countResurfacedByPinnedMinor,
  loadConfig,
  loadSuppressionsForRoot,
  loadTriage,
  NotAGitRepoError,
  readFeedback,
  resolveFeedbackPath,
  resolveTriagePath,
  scan,
  UnknownGitRefError,
} from "@crimes/core";
import type { FailOn } from "@crimes/core";
import {
  buildCoverageBanner,
  buildCoverageWarningNotice,
  formatHumanReport,
  formatJsonReport,
  formatScanFailOnLine,
  renderCoverageExplain,
} from "@crimes/reporter";
import type { Command } from "commander";
import {
  emitDetectorsDisabledBreadcrumb,
  emitFuturePinnedSuppressionsWarnings,
  emitResurfacedSuppressionsBreadcrumb,
  resolveNoColor,
} from "../breadcrumb.js";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

declare const __CRIMES_VERSION__: string;

interface ScanCommandOptions {
  format: "human" | "json";
  all: boolean;
  noColor: boolean;
  changed: boolean;
  base?: string;
  failOn?: string;
  showSuppressed: boolean;
  showTriaged: boolean;
  gateNeedsDesign: boolean;
  gateResurfaced: boolean;
  top?: number;
  flat: boolean;
  recency: boolean; // Commander gives this as `true` by default with --no-recency
  explainCoverage: boolean;
}

const VALID_FAIL_ON = new Set<FailOn>(["low", "medium", "high"]);

/**
 * Flags that shape the *terminal* report and nothing else.
 *
 * `--format json` already emits every finding — the human renderer is a
 * view over the same array, and it is the view that truncates. So these
 * are not merely ignored under `--format json`, they are meaningless
 * there, and teaching JSON to honour them would mean teaching the
 * machine contract to withhold findings by default. That is the wrong
 * direction: JSON is the product contract (`PRD.md` §9) and a consumer
 * that has to pass a flag to be given the whole answer is a worse
 * contract than one that always gives it.
 *
 * What was actually wrong is that `--all` looked like it did something.
 * It parsed, it exited 0, and stdout came back byte-identical. The fix
 * is to say so on stderr, which leaves stdout untouched — so this
 * changes no finding and moves no baseline.
 */
function warnIgnoredPresentationFlags(options: ScanCommandOptions): void {
  const ignored: string[] = [];
  if (options.all) ignored.push("--all");
  if (options.flat) ignored.push("--flat");
  if (options.top !== undefined) ignored.push("--top");
  if (ignored.length === 0) return;
  const list = ignored.join(", ");
  process.stderr.write(
    `crimes: ${list} ${ignored.length === 1 ? "shapes" : "shape"} the terminal ` +
      "report only and had no effect here — --format json always emits every " +
      "finding.\n",
  );
}

function isFailOn(value: string): value is FailOn {
  return VALID_FAIL_ON.has(value as FailOn);
}

export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .description("Scan a repository for maintainability crimes.")
    .argument("[path]", "directory to scan (defaults to current directory)")
    .option("--format <format>", "output format: human | json", "human")
    .option(
      "--all",
      "show every finding instead of just the top ones (human format only; json always emits all)",
      false,
    )
    .option("--no-color", "disable ANSI colour output")
    .option(
      "--changed",
      "only scan files changed in the working tree (and vs --base when set)",
      false,
    )
    .option(
      "--base <ref>",
      "Git ref to compare against when --changed is set, e.g. main or origin/main",
    )
    .option(
      "--fail-on <severity>",
      "with --changed, exit non-zero when a finding meets this severity: low | medium | high",
    )
    .option(
      "--show-suppressed",
      "include findings filtered by .crimes/suppressions.json, annotated as suppressed",
      false,
    )
    .option(
      "--show-triaged",
      "include silenced triage dispositions in output, annotated with disposition + reason + owner + date",
      false,
    )
    .option(
      "--gate-needs-design",
      "with --fail-on, count needs-design dispositions toward the gate (requires --show-triaged)",
      false,
    )
    .option(
      "--gate-resurfaced",
      "with --fail-on, count resurfaced findings (previously_triaged / previously_baselined) toward the gate",
      false,
    )
    .option(
      "--top <n>",
      "show only the top N files (default 5; human format only)",
      (v) => Number.parseInt(v, 10),
    )
    .option("--flat", "use the legacy flat-by-severity layout (human format only)", false)
    .option("--no-recency", "disable the recency multiplier on rank_score")
    .option(
      "--explain-coverage",
      "print a per-language coverage breakdown after the scan",
      false,
    )
    .action(async (path: string | undefined, options: ScanCommandOptions) => {
      const root = resolve(path ?? process.cwd());
      const format = options.format;

      // A path typo used to produce a well-formed, empty, exit-0 report:
      // "No crimes detected. Suspiciously clean." That makes a mistyped
      // CI path a permanently green gate. Fail loudly instead.
      let rootStat: Stats;
      try {
        rootStat = statSync(root);
      } catch {
        process.stderr.write(`crimes: path does not exist: ${root}\n`);
        process.exit(2);
        return;
      }
      if (!rootStat.isDirectory()) {
        process.stderr.write(`crimes: not a directory: ${root}\n`);
        process.exit(2);
        return;
      }

      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      if (options.base && !options.changed) {
        process.stderr.write(`crimes: --base only applies when --changed is set.\n`);
        process.exit(2);
        return;
      }

      if (options.failOn !== undefined && !options.changed) {
        process.stderr.write(`crimes: --fail-on only applies when --changed is set.\n`);
        process.exit(2);
        return;
      }

      if (options.failOn !== undefined && !isFailOn(options.failOn)) {
        process.stderr.write(
          `crimes: unknown --fail-on "${options.failOn}". Expected "low", "medium", or "high".\n`,
        );
        process.exit(2);
        return;
      }

      let report: Awaited<ReturnType<typeof scan>>;
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(root);
        const noColor = resolveNoColor(options);
        emitDetectorsDisabledBreadcrumb(config, { noColor });
        report = await scan({
          root,
          config,
          changed: options.changed,
          base: options.base,
          recencyEnabled: options.recency, // Commander: true unless --no-recency
        });
        const suppressions = loadSuppressionsForRoot(root, config);
        // Future-pinned warnings can fire even when nothing resurfaces
        // (the entry might not match any current finding).
        emitFuturePinnedSuppressionsWarnings(suppressions.entries, __CRIMES_VERSION__, {
          noColor,
        });
        // Triage filter applies BEFORE suppressions so the renderer can
        // distinguish "user triaged this" from "suppression hit".
        const triage = await loadTriage(resolveTriagePath(root));
        report = applyTriageToScan(report, triage.entries, {
          showTriaged: options.showTriaged,
        });
        report = applySuppressionsToScan(report, suppressions.entries, {
          showSuppressed: options.showSuppressed,
          crimesVersion: __CRIMES_VERSION__,
        });
        emitResurfacedSuppressionsBreadcrumb(
          countResurfacedByPinnedMinor(report.findings),
          { noColor },
        );
      } catch (error) {
        if (error instanceof NotAGitRepoError || error instanceof UnknownGitRefError) {
          process.stderr.write(`crimes: ${error.message}\n`);
          process.exit(2);
          return;
        }
        if (isUserSetupError(error)) {
          fatalUserError(error);
          return;
        }
        throw error;
      }

      const failOn =
        options.failOn !== undefined && options.changed
          ? (options.failOn as FailOn)
          : undefined;
      const gatedReport =
        failOn !== undefined
          ? applyScanFailOn(report, failOn, {
              gateNeedsDesign: options.gateNeedsDesign,
              gateResurfaced: options.gateResurfaced,
            })
          : report;

      if (format === "json") {
        warnIgnoredPresentationFlags(options);
        process.stdout.write(formatJsonReport(gatedReport) + "\n");
      } else {
        const effectiveNoColor = options.noColor || !process.stdout.isTTY;
        const feedbackEntries = effectiveNoColor
          ? []
          : (await readFeedback(resolveFeedbackPath(root))).entries;
        const banner = buildCoverageBanner(gatedReport.coverage);
        if (banner && !effectiveNoColor) {
          process.stdout.write(banner + "\n\n");
        }
        // Skipped work is reported unconditionally — unlike the banner
        // it is not decoration, and suppressing it when stdout is a pipe
        // is how a partial scan reads as a complete one in CI logs.
        const skipped = buildCoverageWarningNotice(gatedReport.coverage);
        if (skipped) {
          process.stdout.write(skipped + "\n\n");
        }
        process.stdout.write(
          formatHumanReport(gatedReport, {
            showAll: options.all,
            topFiles: options.top ?? config.scan.topFiles,
            flat: options.flat,
            noColor: effectiveNoColor,
            feedbackHints: {
              entriesByDetector: countEntriesByDetector(feedbackEntries),
            },
          }) + "\n",
        );
        if (failOn !== undefined) {
          process.stdout.write(
            formatScanFailOnLine(gatedReport, {
              noColor: effectiveNoColor,
            }) + "\n",
          );
        }
        if (options.explainCoverage) {
          renderCoverageExplain(gatedReport.coverage, process.stdout);
        }
      }

      // Default `crimes scan` keeps the always-exit-0 behaviour; the gate
      // only fires when the user opted in with --changed --fail-on.
      if (failOn !== undefined && gatedReport.failed === true) {
        process.exit(1);
      }
    });
}
