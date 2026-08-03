import { resolve } from "node:path";
import {
  loadConfig,
  loadSuppressionsForRoot,
  minorKey,
  resurfacedSuppressions,
  shellQuote,
} from "@crimes/core";
import type { ResurfacedSuppression } from "@crimes/core";
import type { Command } from "commander";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

declare const __CRIMES_VERSION__: string;

interface FeedbackRecheckOptions {
  format: "human" | "json";
  detector?: string;
}

export function registerFeedbackRecheckSubcommand(parent: Command): void {
  parent
    .command("recheck")
    .description(
      "Walk feedback-sourced suppressions whose pinned minor differs from the " +
        "current crimes minor — the per-release review surface.",
    )
    .option("--format <format>", "output format: human | json", "human")
    .option(
      "--detector <type>",
      "only show resurfaced suppressions of this detector type (e.g. large_function)",
    )
    .action(async function (this: Command, _options: FeedbackRecheckOptions) {
      // Same parent-options bleed-through as the list subcommand —
      // merge global opts so `--detector` after the subcommand name
      // is honoured.
      const options = this.optsWithGlobals() as FeedbackRecheckOptions;
      if (options.format !== "human" && options.format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(options.format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      const root = resolve(process.cwd());
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(root);
      } catch (error) {
        if (isUserSetupError(error)) {
          fatalUserError(error);
          return;
        }
        throw error;
      }
      const suppressions = loadSuppressionsForRoot(root, config);
      const resurfaced = resurfacedSuppressions(
        suppressions.entries,
        __CRIMES_VERSION__,
        options.detector ? { detector: options.detector } : {},
      );

      const currentMinor = minorKey(__CRIMES_VERSION__);

      if (options.format === "json") {
        process.stdout.write(
          JSON.stringify(
            {
              schema_version: "0.1.0",
              report_type: "feedback_recheck",
              current_version: __CRIMES_VERSION__,
              current_minor: currentMinor,
              resurfaced: resurfaced.map((r) => ({
                ...r,
                commands: {
                  reconfirm_fp: `crimes feedback ${shellQuote(r.fingerprint)} --verdict fp`,
                  mark_resolved: `crimes feedback ${shellQuote(r.fingerprint)} --verdict tp`,
                },
              })),
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }

      process.stdout.write(formatRecheck(resurfaced, currentMinor));
    });
}

function formatRecheck(
  resurfaced: ResurfacedSuppression[],
  currentMinor: string,
): string {
  if (resurfaced.length === 0) {
    return "No resurfaced feedback suppressions. Either every prior `fp` was confirmed on this minor, or none have been recorded yet.\n";
  }
  const lines: string[] = [
    `${resurfaced.length} ${resurfaced.length === 1 ? "finding" : "findings"} previously marked fp (resurface for crimes ${currentMinor}):`,
    "",
  ];
  resurfaced.forEach((r, i) => {
    const location =
      r.file !== undefined
        ? r.symbol
          ? `${r.file}:${r.symbol}`
          : r.file
        : r.fingerprint;
    lines.push(
      `[${i + 1}/${resurfaced.length}] ${r.type} — ${location}`,
      `      Marked fp in ${r.crimes_version_pinned}: "${r.reason}"`,
      `      In ${currentMinor}: ${r.hint}`,
      `        Re-confirm fp: crimes feedback ${r.fingerprint} --verdict fp --note '<reason>'`,
      `        Mark resolved: crimes feedback ${r.fingerprint} --verdict tp`,
      "",
    );
  });
  return lines.join("\n");
}
