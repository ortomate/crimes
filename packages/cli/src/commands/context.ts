import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  applySuppressionsToContext,
  context,
  countEntriesByDetector,
  countResurfacedByPinnedMinor,
  findNearestPackageRoot,
  loadConfig,
  loadSuppressionsForRoot,
  readFeedback,
  resolveFeedbackPath,
} from "@crimes/core";
import { formatContextHumanReport, formatContextJsonReport } from "@crimes/reporter";
import type { Command } from "commander";
import {
  emitDetectorsDisabledBreadcrumb,
  emitFuturePinnedSuppressionsWarnings,
  emitResurfacedSuppressionsBreadcrumb,
  resolveNoColor,
} from "../breadcrumb.js";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

declare const __CRIMES_VERSION__: string;

interface ContextCommandOptions {
  format: "human" | "json";
  noColor: boolean;
  root?: string;
  showSuppressed: boolean;
}

export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description(
      "Inspect a single file: known crimes, likely tests, and agent-safe editing notes.",
    )
    .argument("<file>", "file to inspect (repo-relative or absolute)")
    .option(
      "--root <path>",
      "repo root used for discovery (defaults to current directory)",
    )
    .option("--format <format>", "output format: human | json", "human")
    .option("--no-color", "disable ANSI colour output")
    .option(
      "--show-suppressed",
      "include findings filtered by .crimes/suppressions.json, annotated as suppressed",
      false,
    )
    .action(async (file: string, options: ContextCommandOptions) => {
      const format = options.format;
      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      // Existence check uses the explicit root if set, otherwise cwd —
      // this is just so we fail fast on a typo'd path. The real scan-root
      // selection (nearest enclosing package.json) happens inside
      // `context()` so the JSON paths line up with that scan scope.
      const lookupRoot = resolve(options.root ?? process.cwd());
      const absoluteFile = isAbsolute(file) ? file : resolve(lookupRoot, file);

      if (!existsSync(absoluteFile)) {
        process.stderr.write(`crimes: file not found: ${file}\n`);
        process.exit(2);
        return;
      }

      // Forward `--root` only when the user explicitly set it. Passing
      // `undefined` lets core's auto package-root detection win — that's
      // what makes `crimes context examples/pkg/src/foo.ts` from a
      // monorepo root produce the same findings as running it from
      // inside `examples/pkg`.
      //
      // Suppressions must be passed to context() in the same call (not
      // applied after) so that clues.suppressions is populated in the
      // report. We pre-resolve the scan root here so we can load
      // suppressions before calling context() — mirroring the same walk
      // that context() does internally (nearest enclosing package.json).
      let report: Awaited<ReturnType<typeof context>>;
      try {
        const noColor = resolveNoColor(options);
        // Pre-resolve root so we can load suppressions before context().
        const earlyRoot =
          options.root !== undefined
            ? resolve(options.root)
            : ((await findNearestPackageRoot(dirname(absoluteFile))) ?? lookupRoot);
        const config = loadConfig(earlyRoot);
        emitDetectorsDisabledBreadcrumb(config, { noColor });
        const suppressions = loadSuppressionsForRoot(earlyRoot, config);
        emitFuturePinnedSuppressionsWarnings(suppressions.entries, __CRIMES_VERSION__, {
          noColor,
        });
        report = await context({
          ...(options.root !== undefined ? { root: options.root } : {}),
          file: absoluteFile,
          suppressionsEntries: suppressions.entries,
        });
        report = applySuppressionsToContext(report, suppressions.entries, {
          showSuppressed: options.showSuppressed,
          crimesVersion: __CRIMES_VERSION__,
        });
        emitResurfacedSuppressionsBreadcrumb(
          countResurfacedByPinnedMinor(report.findings),
          { noColor },
        );
      } catch (error) {
        if (isUserSetupError(error)) {
          fatalUserError(error);
          return;
        }
        throw error;
      }

      if (format === "json") {
        process.stdout.write(formatContextJsonReport(report) + "\n");
      } else {
        const effectiveNoColor = options.noColor || !process.stdout.isTTY;
        const feedbackEntries = effectiveNoColor
          ? []
          : (await readFeedback(resolveFeedbackPath(report.repo.root))).entries;
        process.stdout.write(
          formatContextHumanReport(report, {
            noColor: effectiveNoColor,
            feedbackHints: {
              entriesByDetector: countEntriesByDetector(feedbackEntries),
            },
          }) + "\n",
        );
      }
    });
}
