import { resolve } from "node:path";
import { auditSuppressions, loadConfig, MalformedSuppressionsError } from "@crimes/core";
import {
  formatAuditSuppressionsJsonReport,
  formatAuditSuppressionsReport,
} from "@crimes/reporter";
import type { Command } from "commander";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

interface AuditSuppressionsCommandOptions {
  format: "human" | "json";
  noColor: boolean;
}

export function registerAuditSuppressionsCommand(program: Command): void {
  program
    .command("audit-suppressions")
    .description(
      "List every entry in .crimes/suppressions.json with age and concerns " +
        "about stale or vague reasons.",
    )
    .argument(
      "[path]",
      "directory whose suppressions file to audit (defaults to current directory)",
    )
    .option("--format <format>", "output format: human | json", "human")
    .option("--no-color", "disable ANSI colour output")
    .action(
      async (path: string | undefined, options: AuditSuppressionsCommandOptions) => {
        const root = resolve(path ?? process.cwd());
        const format = options.format;

        if (format !== "human" && format !== "json") {
          process.stderr.write(
            `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
          );
          process.exit(2);
          return;
        }

        let config;
        try {
          config = loadConfig(root);
        } catch (error) {
          if (isUserSetupError(error)) {
            fatalUserError(error);
            return;
          }
          throw error;
        }

        let report;
        try {
          report = auditSuppressions({ root, config });
        } catch (error) {
          if (error instanceof MalformedSuppressionsError) {
            process.stderr.write(`crimes: ${error.message}\n`);
            process.exit(2);
            return;
          }
          throw error;
        }

        if (format === "json") {
          process.stdout.write(formatAuditSuppressionsJsonReport(report) + "\n");
        } else {
          process.stdout.write(
            formatAuditSuppressionsReport(report, {
              noColor: options.noColor || !process.stdout.isTTY,
            }) + "\n",
          );
        }
      },
    );
}
