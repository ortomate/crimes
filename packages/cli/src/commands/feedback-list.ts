import { resolve } from "node:path";
import {
  latestPerFingerprint,
  readFeedback,
  resolveFeedbackPath,
  resolveGlobalRollupPath,
} from "@crimes/core";
import type { FeedbackEntry } from "@crimes/core";
import type { Command } from "commander";
import { isVerdict } from "./feedback-write.js";
import { currentEpochMs } from "../time.js";

interface FeedbackListOptions {
  format: "human" | "json";
  global: boolean;
  since?: string;
  verdict?: string;
}

export function registerFeedbackListSubcommand(parent: Command): void {
  parent
    .command("list")
    .description("List captured feedback entries (latest verdict per fingerprint).")
    .option("--format <format>", "output format: human | json", "human")
    .option(
      "--global",
      "read from the cross-project rollup at ~/.crimes/feedback-rollup.jsonl",
      false,
    )
    .option(
      "--since <duration>",
      "only show entries within the last duration (e.g. 30d, 2w, 6h)",
    )
    .option(
      "--verdict <verdict>",
      "filter to fingerprints whose current verdict is one of: tp, fp, known",
    )
    .action(async function (this: Command, _options: FeedbackListOptions) {
      // Commander parses parent-level options (--verdict, --note, --file)
      // onto the parent command even when the subcommand redeclares them,
      // so we read merged opts to pick up `--verdict fp` after the
      // subcommand name. See feedback.test.ts for the failing case.
      const options = this.optsWithGlobals() as FeedbackListOptions;
      if (options.format !== "human" && options.format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(options.format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }
      if (options.verdict !== undefined && !isVerdict(options.verdict)) {
        process.stderr.write('crimes: --verdict must be one of "tp", "fp", "known".\n');
        process.exit(2);
        return;
      }

      const path = options.global
        ? resolveGlobalRollupPath()
        : resolveFeedbackPath(resolve(process.cwd()));
      const read = await readFeedback(path);

      const sinceCutoff = options.since ? parseSinceDuration(options.since) : undefined;
      if (options.since !== undefined && sinceCutoff === undefined) {
        process.stderr.write(
          `crimes: --since "${options.since}" not understood. Use e.g. 30d, 2w, 6h, 90m.\n`,
        );
        process.exit(2);
        return;
      }

      const latest = latestPerFingerprint(read.entries);
      const sorted = Array.from(latest.values()).sort((a, b) =>
        a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
      );

      const filtered = sorted.filter((e) => {
        if (sinceCutoff && Date.parse(e.timestamp) < sinceCutoff) {
          return false;
        }
        if (options.verdict && e.verdict !== options.verdict) return false;
        return true;
      });

      if (options.format === "json") {
        process.stdout.write(
          JSON.stringify(
            {
              schema_version: "0.1.0",
              report_type: "feedback",
              scope: options.global ? "global" : "repo",
              source_file: path,
              entries: filtered,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }

      process.stdout.write(formatFeedbackList(filtered, path, read.loaded));
    });
}

function formatFeedbackList(
  entries: FeedbackEntry[],
  path: string,
  loaded: boolean,
): string {
  if (!loaded) {
    return `No feedback recorded yet (${path} does not exist).\n`;
  }
  if (entries.length === 0) {
    return `No matching feedback entries in ${path}.\n`;
  }
  const lines: string[] = [
    `${entries.length} feedback ${entries.length === 1 ? "entry" : "entries"} (latest verdict per fingerprint) — ${path}`,
    "",
  ];
  for (const e of entries) {
    const note = e.note ? ` "${e.note}"` : "";
    const resurfaced =
      e.resurfaced_from !== null ? ` [resurfaced from ${e.resurfaced_from}]` : "";
    lines.push(
      `  [${e.verdict.padEnd(5)}] ${e.timestamp}  ${e.fingerprint}${resurfaced}${note}`,
    );
  }
  return lines.join("\n") + "\n";
}

function parseSinceDuration(input: string): number | undefined {
  const match = input.trim().match(/^(\d+)([dwhms])$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const ms =
    unit === "d"
      ? value * 86_400_000
      : unit === "w"
        ? value * 7 * 86_400_000
        : unit === "h"
          ? value * 3_600_000
          : unit === "m"
            ? value * 60_000
            : unit === "s"
              ? value * 1000
              : undefined;
  if (ms === undefined) return undefined;
  return currentEpochMs() - ms;
}
