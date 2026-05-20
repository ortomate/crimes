import { resolve } from "node:path";
import { hotspots, type HotspotsReport } from "@crimes/core";
import {
  formatHotspotsJsonReport,
  formatHotspotsReport,
} from "@crimes/reporter";
import type { Command } from "commander";

interface HotspotsCommandOptions {
  format: "human" | "json";
  since: string;
  all: boolean;
  noColor: boolean;
}

const DEFAULT_JSON_TOP_N = 20;

export function registerHotspotsCommand(program: Command): void {
  program
    .command("hotspots")
    .description(
      "Rank files by change risk using Git churn and current scan findings.",
    )
    .argument("[path]", "directory to inspect (defaults to current directory)")
    .option(
      "--since <window>",
      "git history window: 90d, 2w, 6m, 1y, or any string git understands",
      "90d",
    )
    .option("--format <format>", "output format: human | json", "human")
    .option("--all", "show every hotspot instead of just the top ones", false)
    .option("--no-color", "disable ANSI colour output")
    .action(async (path: string | undefined, options: HotspotsCommandOptions) => {
      const root = resolve(path ?? process.cwd());
      const format = options.format;

      if (format !== "human" && format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      const report = await hotspots({ root, since: options.since });

      if (format === "json") {
        process.stdout.write(
          formatHotspotsJsonReport(capHotspotsReport(report, options.all)) +
            "\n",
        );
        return;
      }

      process.stdout.write(
        formatHotspotsReport(report, {
          showAll: options.all,
          noColor: options.noColor || !process.stdout.isTTY,
        }) + "\n",
      );
    });
}

function capHotspotsReport(
  report: HotspotsReport,
  isShowingAll: boolean,
): HotspotsReport {
  if (isShowingAll) {
    return {
      ...report,
      total_files: report.hotspots.length,
      shown_count: report.hotspots.length,
      hidden_count: 0,
    };
  }
  const shown = report.hotspots.slice(0, DEFAULT_JSON_TOP_N);
  return {
    ...report,
    total_files: report.hotspots.length,
    shown_count: shown.length,
    hidden_count: Math.max(0, report.hotspots.length - shown.length),
    hotspots: shown,
  };
}
