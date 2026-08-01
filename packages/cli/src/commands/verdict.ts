import { resolve } from "node:path";
import {
  NoDefaultBaseError,
  NotAGitRepoError,
  shouldFailVerdict,
  UnknownGitRefError,
  verdict,
} from "@crimes/core";
import type { VerdictFailOn } from "@crimes/core";
import { formatVerdictJsonReport, formatVerdictReport } from "@crimes/reporter";
import type { Command } from "commander";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

interface VerdictCommandOptions {
  format: "human" | "json";
  noColor: boolean;
  base?: string;
  failOn?: string;
  root?: string;
  showSuppressed: boolean;
}

const VALID_FAIL_ON = new Set<VerdictFailOn>(["worse", "new-high", "new-medium"]);

function isFailOn(value: string): value is VerdictFailOn {
  return VALID_FAIL_ON.has(value as VerdictFailOn);
}

export function registerVerdictCommand(program: Command): void {
  program
    .command("verdict")
    .description(
      "Summarise whether this branch makes the repo cleaner, worse, unchanged, or mixed.",
    )
    .option(
      "--base <ref>",
      "base ref to compare against (defaults to origin/main, then main)",
    )
    .option("--format <format>", "output format: human | json", "human")
    .option("--no-color", "disable ANSI colour output")
    .option(
      "--fail-on <threshold>",
      "exit non-zero when threshold is hit: worse | new-high | new-medium",
    )
    .option(
      "--root <path>",
      "repository root to run the verdict in (defaults to current directory)",
    )
    .option(
      "--show-suppressed",
      "include new findings filtered by .crimes/suppressions.json, annotated as suppressed",
      false,
    )
    .action(async (options: VerdictCommandOptions) => {
      const root = resolve(options.root ?? process.cwd());
      const format = options.format;

      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      if (options.failOn !== undefined && !isFailOn(options.failOn)) {
        process.stderr.write(
          `crimes: unknown --fail-on "${options.failOn}". Expected "worse", "new-high", or "new-medium".\n`,
        );
        process.exit(2);
        return;
      }

      let report;
      try {
        report = await verdict({
          root,
          base: options.base,
          showSuppressed: options.showSuppressed,
        });
      } catch (error) {
        if (
          error instanceof NotAGitRepoError ||
          error instanceof NoDefaultBaseError ||
          error instanceof UnknownGitRefError
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
        process.stdout.write(formatVerdictJsonReport(report) + "\n");
      } else {
        process.stdout.write(
          formatVerdictReport(report, {
            noColor: options.noColor || !process.stdout.isTTY,
          }) + "\n",
        );
      }

      if (options.failOn !== undefined) {
        const failOn = options.failOn as VerdictFailOn;
        if (shouldFailVerdict(report, failOn)) {
          process.exit(1);
        }
      }
    });
}
