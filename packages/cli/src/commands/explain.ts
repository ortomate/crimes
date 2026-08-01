import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { explain, UnknownDetectorTypeError, UnknownFindingError } from "@crimes/core";
import type { ScanReport } from "@crimes/core";
import { formatExplainJsonReport, formatExplainReport } from "@crimes/reporter";
import type { Command } from "commander";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

interface ExplainCommandOptions {
  format: "human" | "json";
  noColor: boolean;
  from?: string;
}

export function registerExplainCommand(program: Command): void {
  program
    .command("explain")
    .description("Show a long-form rationale for one finding, by id or fingerprint.")
    .argument(
      "<id-or-fingerprint>",
      "either a per-scan id (crime_00005) or a stable fingerprint " +
        "(<type>::<file>::<symbol>)",
    )
    .option(
      "--from <path>",
      "read a saved `crimes scan --format json` file instead of re-scanning",
    )
    .option("--format <format>", "output format: human | json", "human")
    .option("--no-color", "disable ANSI colour output")
    .action(async (idOrFingerprint: string, options: ExplainCommandOptions) => {
      const format = options.format;
      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      const root = resolve(process.cwd());

      let from: ScanReport | undefined;
      if (options.from) {
        const fromPath = isAbsolute(options.from)
          ? options.from
          : resolve(root, options.from);
        if (!existsSync(fromPath)) {
          process.stderr.write(`crimes: --from file not found: ${options.from}\n`);
          process.exit(2);
          return;
        }
        let raw: string;
        try {
          raw = readFileSync(fromPath, "utf8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`crimes: unable to read --from file: ${msg}\n`);
          process.exit(2);
          return;
        }
        try {
          from = JSON.parse(raw) as ScanReport;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`crimes: --from file is not valid JSON: ${msg}\n`);
          process.exit(2);
          return;
        }
        if (from?.report_type !== "scan") {
          process.stderr.write(
            `crimes: --from file is not a scan report (report_type was ${JSON.stringify(
              from?.report_type ?? null,
            )}).\n`,
          );
          process.exit(2);
          return;
        }
      }

      let report;
      try {
        report = await explain(idOrFingerprint, {
          root,
          ...(from !== undefined ? { from } : {}),
        });
      } catch (error) {
        if (error instanceof UnknownFindingError) {
          process.stderr.write(`crimes: ${error.message}\n`);
          process.exit(2);
          return;
        }
        if (error instanceof UnknownDetectorTypeError) {
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
        process.stdout.write(formatExplainJsonReport(report) + "\n");
      } else {
        process.stdout.write(
          formatExplainReport(report, {
            noColor: options.noColor || !process.stdout.isTTY,
          }) + "\n",
        );
      }
    });
}
