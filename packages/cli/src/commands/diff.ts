import { resolve } from "node:path";
import {
  applyDiffFailOn,
  countEntriesByDetector,
  countResurfacedByPinnedMinor,
  diff,
  InvalidDiffRangeError,
  loadConfig,
  loadSuppressionsForRoot,
  NotAGitRepoError,
  parseDiffRange,
  readFeedback,
  resolveFeedbackPath,
  UnknownGitRefError,
} from "@crimes/core";
import type { DiffFailOn } from "@crimes/core";
import { formatDiffJsonReport, formatDiffReport } from "@crimes/reporter";
import type { Command } from "commander";
import {
  emitDetectorsDisabledBreadcrumb,
  emitFuturePinnedSuppressionsWarnings,
  emitResurfacedSuppressionsBreadcrumb,
  resolveNoColor,
} from "../breadcrumb.js";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

declare const __CRIMES_VERSION__: string;

interface DiffCommandOptions {
  format: "human" | "json";
  noColor: boolean;
  root?: string;
  showSuppressed: boolean;
  failOn?: string;
}

const VALID_DIFF_FAIL_ON = new Set<DiffFailOn>(["new-high", "new-medium"]);

function isDiffFailOn(value: string): value is DiffFailOn {
  return VALID_DIFF_FAIL_ON.has(value as DiffFailOn);
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Report new, fixed, and unchanged crimes between two Git refs.")
    .argument("<range>", "git range, e.g. main...HEAD or origin/main...HEAD (triple-dot)")
    .option("--format <format>", "output format: human | json", "human")
    .option("--no-color", "disable ANSI colour output")
    .option(
      "--root <path>",
      "repository root to run the diff in (defaults to current directory)",
    )
    .option(
      "--show-suppressed",
      "include new findings filtered by .crimes/suppressions.json, annotated as suppressed",
      false,
    )
    .option(
      "--fail-on <threshold>",
      "exit non-zero when threshold is hit on the new set: new-high | new-medium",
    )
    .action(async (range: string, options: DiffCommandOptions) => {
      const root = resolve(options.root ?? process.cwd());
      const format = options.format;

      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      if (options.failOn !== undefined && !isDiffFailOn(options.failOn)) {
        process.stderr.write(
          `crimes: unknown --fail-on "${options.failOn}". Expected "new-high" or "new-medium".\n`,
        );
        process.exit(2);
        return;
      }

      let parsed: { base: string; head: string };
      try {
        parsed = parseDiffRange(range);
      } catch (error) {
        if (error instanceof InvalidDiffRangeError) {
          process.stderr.write(`crimes: ${error.message}\n`);
          process.exit(2);
          return;
        }
        throw error;
      }

      const noColor = resolveNoColor(options);
      let report: Awaited<ReturnType<typeof diff>>;
      try {
        try {
          const config = loadConfig(root);
          emitDetectorsDisabledBreadcrumb(config, { noColor });
          // Future-pinned warnings before we run the diff — they're a
          // heads-up about file state, not about anything specific to
          // the new findings.
          const suppressions = loadSuppressionsForRoot(root, config);
          emitFuturePinnedSuppressionsWarnings(suppressions.entries, __CRIMES_VERSION__, {
            noColor,
          });
        } catch {
          // A bad config will surface a clearer error inside `diff()`;
          // the breadcrumb is best-effort and shouldn't mask that.
        }
        report = await diff({
          root,
          base: parsed.base,
          head: parsed.head,
          showSuppressed: options.showSuppressed,
          crimesVersion: __CRIMES_VERSION__,
        });
        emitResurfacedSuppressionsBreadcrumb(
          countResurfacedByPinnedMinor(report.new_findings),
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

      const failOn = options.failOn as DiffFailOn | undefined;
      const gatedReport = failOn !== undefined ? applyDiffFailOn(report, failOn) : report;

      if (format === "json") {
        process.stdout.write(formatDiffJsonReport(gatedReport) + "\n");
      } else {
        const effectiveNoColor = options.noColor || !process.stdout.isTTY;
        const feedbackEntries = effectiveNoColor
          ? []
          : (await readFeedback(resolveFeedbackPath(root))).entries;
        process.stdout.write(
          formatDiffReport(gatedReport, {
            noColor: effectiveNoColor,
            feedbackHints: {
              entriesByDetector: countEntriesByDetector(feedbackEntries),
            },
          }) + "\n",
        );
      }

      if (failOn !== undefined && gatedReport.failed === true) {
        process.exitCode = 1;
      }
    });
}
