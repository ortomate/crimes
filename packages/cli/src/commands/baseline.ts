import { resolve } from "node:path";
import {
  BaselineNotFoundError,
  checkBaseline,
  countEntriesByDetector,
  countResurfacedByPinnedMinor,
  loadConfig,
  loadSuppressionsForRoot,
  MalformedBaselineError,
  readFeedback,
  resolveFeedbackPath,
  saveBaseline,
} from "@crimes/core";
import type { FailOn } from "@crimes/core";
import {
  formatBaselineCheckJsonReport,
  formatBaselineCheckReport,
  formatBaselineJsonReport,
  formatBaselineSaveReport,
} from "@crimes/reporter";
import type { Command } from "commander";
import {
  emitFuturePinnedSuppressionsWarnings,
  emitResurfacedSuppressionsBreadcrumb,
  resolveNoColor,
} from "../breadcrumb.js";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

// Injected at build time by tsup from the CLI package's package.json. Shared
// with `index.ts` via the same `define` block — re-declared here because each
// TS file compiles independently against the ambient declaration.
declare const __CRIMES_VERSION__: string;

interface BaselineSaveOptions {
  format: "human" | "json";
  noColor: boolean;
}

interface BaselineCheckCommandOptions {
  format: "human" | "json";
  noColor: boolean;
  failOn: string;
  showSuppressed: boolean;
}

const VALID_FAIL_ON = new Set<FailOn>(["low", "medium", "high"]);

function isFailOn(value: string): value is FailOn {
  return VALID_FAIL_ON.has(value as FailOn);
}

export function registerBaselineCommand(program: Command): void {
  const baseline = program
    .command("baseline")
    .description(
      "Snapshot current findings to .crimes/baseline.json, or check against it.",
    );

  baseline
    .command("save")
    .description("Run a scan and write the current findings to .crimes/baseline.json.")
    .argument("[path]", "directory to scan (defaults to current directory)")
    .option("--format <format>", "output format: human | json", "human")
    .option("--no-color", "disable ANSI colour output")
    .action(async (path: string | undefined, options: BaselineSaveOptions) => {
      const root = resolve(path ?? process.cwd());
      const format = options.format;

      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      let result;
      try {
        result = await saveBaseline({
          root,
          crimesVersion: __CRIMES_VERSION__,
        });
      } catch (error) {
        if (isUserSetupError(error)) {
          fatalUserError(error);
          return;
        }
        throw error;
      }

      if (format === "json") {
        process.stdout.write(formatBaselineJsonReport(result.baseline) + "\n");
        return;
      }

      process.stdout.write(
        formatBaselineSaveReport(result.baseline, result.path, {
          noColor: options.noColor || !process.stdout.isTTY,
        }) + "\n",
      );
    });

  baseline
    .command("check")
    .description(
      "Compare the current scan against .crimes/baseline.json and fail on new findings.",
    )
    .argument("[path]", "directory to scan (defaults to current directory)")
    .option("--format <format>", "output format: human | json", "human")
    .option("--no-color", "disable ANSI colour output")
    .option(
      "--fail-on <severity>",
      "minimum severity that causes a non-zero exit code: low | medium | high",
      "medium",
    )
    .option(
      "--show-suppressed",
      "include findings filtered by .crimes/suppressions.json, annotated as suppressed",
      false,
    )
    .action(async (path: string | undefined, options: BaselineCheckCommandOptions) => {
      const root = resolve(path ?? process.cwd());
      const format = options.format;

      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      if (!isFailOn(options.failOn)) {
        process.stderr.write(
          `crimes: unknown --fail-on "${options.failOn}". Expected "low", "medium", or "high".\n`,
        );
        process.exit(2);
        return;
      }

      const noColor = resolveNoColor(options);
      try {
        const config = loadConfig(root);
        const suppressions = loadSuppressionsForRoot(root, config);
        emitFuturePinnedSuppressionsWarnings(suppressions.entries, __CRIMES_VERSION__, {
          noColor,
        });
      } catch {
        // Best-effort: a bad config will surface a clearer error
        // inside `checkBaseline()` below.
      }

      let report;
      try {
        report = await checkBaseline({
          root,
          failOn: options.failOn,
          showSuppressed: options.showSuppressed,
          crimesVersion: __CRIMES_VERSION__,
        });
        emitResurfacedSuppressionsBreadcrumb(
          countResurfacedByPinnedMinor(report.new_findings),
          { noColor },
        );
      } catch (error) {
        if (
          error instanceof BaselineNotFoundError ||
          error instanceof MalformedBaselineError
        ) {
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

      if (format === "json") {
        process.stdout.write(formatBaselineCheckJsonReport(report) + "\n");
      } else {
        const effectiveNoColor = options.noColor || !process.stdout.isTTY;
        const feedbackEntries = effectiveNoColor
          ? []
          : (await readFeedback(resolveFeedbackPath(root))).entries;
        process.stdout.write(
          formatBaselineCheckReport(report, {
            noColor: effectiveNoColor,
            feedbackHints: {
              entriesByDetector: countEntriesByDetector(feedbackEntries),
            },
          }) + "\n",
        );
      }

      if (report.failed) {
        process.exit(1);
      }
    });
}
