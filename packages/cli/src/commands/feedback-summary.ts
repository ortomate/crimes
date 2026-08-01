import { resolve } from "node:path";
import {
  buildFeedbackSummary,
  readFeedback,
  resolveFeedbackPath,
  resolveGlobalRollupPath,
} from "@crimes/core";
import type { FeedbackSummary } from "@crimes/core";
import type { Command } from "commander";

interface FeedbackSummaryOptions {
  format: "human" | "json";
  global: boolean;
}

export function registerFeedbackSummarySubcommand(parent: Command): void {
  parent
    .command("summary")
    .description(
      "Aggregate feedback into a quick-read table (by verdict, detector, version, repo).",
    )
    .option("--format <format>", "output format: human | json", "human")
    .option(
      "--global",
      "read from ~/.crimes/feedback-rollup.jsonl instead of the local repo",
      false,
    )
    .action(async function (this: Command, _options: FeedbackSummaryOptions) {
      const options = this.optsWithGlobals() as FeedbackSummaryOptions;
      if (options.format !== "human" && options.format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(options.format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      const path = options.global
        ? resolveGlobalRollupPath()
        : resolveFeedbackPath(resolve(process.cwd()));
      const read = await readFeedback(path);
      const summary = buildFeedbackSummary(read.entries);

      if (options.format === "json") {
        process.stdout.write(
          JSON.stringify(
            {
              schema_version: "0.1.0",
              report_type: "feedback",
              scope: options.global ? "global" : "repo",
              source_file: path,
              entries: read.entries,
              summary,
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }

      process.stdout.write(
        formatFeedbackSummary(summary, path, read.loaded, options.global),
      );
    });
}

function formatFeedbackSummary(
  summary: FeedbackSummary,
  path: string,
  loaded: boolean,
  isGlobal: boolean,
): string {
  if (!loaded) {
    return `No feedback recorded yet (${path} does not exist).\n`;
  }
  const lines: string[] = [];
  const scope = isGlobal ? "Global rollup" : "Local repo";
  lines.push(
    `${scope}: ${path}  (${summary.total} ${summary.total === 1 ? "entry" : "entries"} after latest-per-fingerprint)`,
    "",
    "By verdict:",
  );
  const totalForPct = summary.total === 0 ? 1 : summary.total;
  for (const v of ["tp", "fp", "known"] as const) {
    const n = summary.by_verdict[v];
    const pct = Math.round((n / totalForPct) * 100);
    lines.push(`  ${v.padEnd(5)} ${String(n).padStart(4)} (${pct}%)`);
  }

  const byDetectorByFp = Object.entries(summary.by_detector)
    .map(([type, counts]) => ({
      type,
      fp: counts.fp,
      total: counts.tp + counts.fp + counts.known,
    }))
    .filter((d) => d.fp > 0)
    .sort((a, b) => b.fp - a.fp)
    .slice(0, 5);
  if (byDetectorByFp.length > 0) {
    lines.push("", "By detector (top 5 by fp count):");
    for (const d of byDetectorByFp) {
      lines.push(`  ${d.type.padEnd(28)} ${String(d.fp).padStart(3)} fp`);
    }
  }

  const versionEntries = Object.entries(summary.by_version).sort(([a], [b]) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  if (versionEntries.length > 0) {
    lines.push("", "By crimes_version:");
    for (const [v, n] of versionEntries) {
      lines.push(`  ${v.padEnd(8)} ${String(n).padStart(4)}`);
    }
  }

  if (summary.by_repo) {
    const repoEntries = Object.entries(summary.by_repo).sort(([, a], [, b]) => b - a);
    if (repoEntries.length > 0) {
      lines.push("", "By repo:");
      for (const [r, n] of repoEntries) {
        lines.push(`  ${r.padEnd(40)} ${String(n).padStart(4)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
