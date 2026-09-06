import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyPinMigration,
  previewPinMigration,
  scan,
  SCHEMA_VERSION,
} from "@crimes/core";
import type { Command } from "commander";

export function registerMigratePinsCommand(program: Command): void {
  program
    .command("migrate-pins")
    .description(
      "Preview fingerprint migrations for triage, suppressions and baseline; apply a reviewed JSON plan.",
    )
    .argument("[path]", "repository root", ".")
    .option("--apply <plan.json>", "apply selected migrations from a reviewed preview")
    .option("--format <format>", "output format: human | json", "human")
    .action(async (path: string, options: { apply?: string; format: string }) => {
      try {
        if (!["human", "json"].includes(options.format))
          throw new Error("Expected --format human or json.");
        const root = resolve(path);
        const report = await scan({ root });
        if (options.apply) {
          const plan: unknown = JSON.parse(
            await readFile(resolve(options.apply), "utf8"),
          );
          const migrated = await applyPinMigration(root, plan, report.findings);
          process.stdout.write(
            options.format === "json"
              ? JSON.stringify({
                  schema_version: SCHEMA_VERSION,
                  report_type: "pin_migration_apply",
                  migrated,
                }) + "\n"
              : `Migrated ${migrated} pins. Reasons, dates, owners and expiry pins were preserved.\n`,
          );
          return;
        }
        const plan = await previewPinMigration(root, report.findings);
        if (options.format === "json") {
          process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
          return;
        }
        for (const entry of plan.entries.filter(
          (entry) => entry.status !== "unchanged",
        )) {
          process.stdout.write(`${entry.status}: ${entry.source} · ${entry.from}\n`);
          for (const candidate of entry.candidates)
            process.stdout.write(`  → ${candidate}\n`);
        }
        process.stdout.write(
          "No files changed. Save --format json, review the proposed `to` fields, then use --apply <plan.json>. Ambiguous and unreported pins are kept unless explicitly selected.\n",
        );
      } catch (error) {
        process.stderr.write(
          `crimes: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 2;
      }
    });
}
