import { resolve } from "node:path";
import {
  appendToGlobalRollup,
  buildFeedbackSummary,
  latestPerFingerprint,
  readFeedback,
  resolveFeedbackPath,
  resolveGlobalRollupPath,
} from "@crimes/core";
import type { FeedbackEntry } from "@crimes/core";
import type { Command } from "commander";

interface FeedbackExportOptions {
  format: "jsonl" | "md" | "json";
  appendGlobal: boolean;
}

export function registerFeedbackExportSubcommand(parent: Command): void {
  parent
    .command("export")
    .description("Print the local feedback JSONL or append it to the global rollup.")
    .option(
      "--format <format>",
      "output format: jsonl (default, one entry per line) | md (Markdown report) | json (FeedbackReport)",
      "jsonl",
    )
    .option(
      "--append-global",
      "append local entries to ~/.crimes/feedback-rollup.jsonl (deduplicated; safe to run repeatedly)",
      false,
    )
    .action(async function (this: Command, _options: FeedbackExportOptions) {
      const options = this.optsWithGlobals() as FeedbackExportOptions;
      if (
        options.format !== "jsonl" &&
        options.format !== "md" &&
        options.format !== "json"
      ) {
        process.stderr.write(
          `crimes: unknown --format "${String(options.format)}". Expected "jsonl", "md", or "json".\n`,
        );
        process.exit(2);
        return;
      }

      const root = resolve(process.cwd());
      const localPath = resolveFeedbackPath(root);

      if (options.appendGlobal) {
        const globalPath = resolveGlobalRollupPath();
        const result = await appendToGlobalRollup({
          localPath,
          globalPath,
          repo: root,
        });
        process.stdout.write(
          `Appended ${result.appended} new ${result.appended === 1 ? "entry" : "entries"} from ${localPath}\n` +
            `  → ${globalPath}\n` +
            `  (${result.skipped} ${result.skipped === 1 ? "entry was" : "entries were"} already present and skipped)\n`,
        );
        return;
      }

      const read = await readFeedback(localPath);
      if (options.format === "jsonl") {
        for (const e of read.entries) {
          process.stdout.write(JSON.stringify(e) + "\n");
        }
        return;
      }
      if (options.format === "json") {
        process.stdout.write(
          JSON.stringify(
            {
              schema_version: "0.1.0",
              report_type: "feedback",
              scope: "repo",
              source_file: localPath,
              entries: read.entries,
              summary: buildFeedbackSummary(read.entries),
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }
      // md
      process.stdout.write(formatFeedbackMarkdown(read.entries, localPath, read.loaded));
    });
}

function formatFeedbackMarkdown(
  entries: FeedbackEntry[],
  path: string,
  loaded: boolean,
): string {
  if (!loaded || entries.length === 0) {
    return `# crimes feedback\n\nNo entries recorded (${path}).\n`;
  }
  const latest = latestPerFingerprint(entries);
  const byDetector = new Map<string, FeedbackEntry[]>();
  for (const e of latest.values()) {
    const list = byDetector.get(e.finding_type) ?? [];
    list.push(e);
    byDetector.set(e.finding_type, list);
  }
  const sortedDetectors = Array.from(byDetector.keys()).sort();
  const lines: string[] = [
    "# crimes feedback",
    "",
    `Source: \`${path}\``,
    `Entries (latest per fingerprint): ${latest.size}`,
    "",
  ];
  for (const detector of sortedDetectors) {
    const list = byDetector.get(detector)!;
    lines.push(`## ${detector} (${list.length})`, "");
    for (const e of list) {
      const note = e.note ? ` — "${e.note}"` : "";
      lines.push(`- **[${e.verdict}]** \`${e.fingerprint}\`${note}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
