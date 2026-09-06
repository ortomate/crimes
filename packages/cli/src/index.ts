import { registerMigratePinsCommand } from "./commands/migrate-pins.js";
import { Command } from "commander";
import { autoInitFlags, maybeRunAutoInit } from "./auto-init.js";
import { welcomeBanner as _welcomeBanner } from "./banner.js";
import { registerAuditSuppressionsCommand } from "./commands/audit-suppressions.js";
import { registerBaselineCommand } from "./commands/baseline.js";
import { registerContextCommand } from "./commands/context.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerFeedbackCommand } from "./commands/feedback.js";
import { registerHookCommand } from "./commands/hook.js";
import { registerHotspotsCommand } from "./commands/hotspots.js";
import { registerIgnoreCommand } from "./commands/ignore.js";
import { registerInitCommand } from "./commands/init.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerTriageCommand } from "./commands/triage.js";
import { registerUnignoreCommand } from "./commands/unignore.js";
import { registerVerdictCommand } from "./commands/verdict.js";

// Injected at build time by tsup from this package's package.json.
declare const __CRIMES_VERSION__: string;

const program = new Command();

program
  .name("crimes")
  .description(
    "A crime scene investigator for your codebase. Built for agents, readable by humans.",
  )
  .version(__CRIMES_VERSION__)
  .option("--no-init", "suppress the first-run auto-init prompt")
  .option("--init", "force the first-run auto-init prompt even if config exists")
  .hook("preAction", async (_thisCommand, actionCommand) => {
    const name = actionCommand.name();
    await maybeRunAutoInit(name, {
      cwd: process.cwd(),
      flags: autoInitFlags(program),
    });
  })
  .addHelpText(
    "after",
    // The tips block used to name `init --agents` and `context <file>`
    // and say nothing about scoping a scan. Field notes from
    // choreograph.cc: bare `scan` on a 209-file repo returned 499
    // findings, and the flags that would have cut that to a work list
    // were never reached for. Scoping leads now.
    "\nTips:\n" +
      "  scope the scan to what you're changing — that's the whole trick:\n" +
      "    crimes scan --files a.ts,b.ts     planning a change to known files\n" +
      "    crimes scan --related-to <file>   …and everything importing it, or imported by it\n" +
      "    crimes scan --changed --base main reviewing edits you already made\n" +
      "  bare `crimes scan` audits the whole repo — useful, but rarely what you want mid-task.\n" +
      "  run `crimes context <file>` before editing — findings + likely tests + agent notes for one file.\n" +
      "  run `crimes init --agents` to install agent skills; after upgrades, `crimes init --refresh-skills`.",
  )
  .action(() => {
    // Bare `crimes` (no subcommand) prints a welcome banner pointing at
    // the three first-step commands. This is the *only* onboarding
    // surface: 0.9.0 also shipped a postinstall banner, which npm 7+
    // swallowed and npm 11.18+ turned into an allow-scripts prompt. It
    // was removed in 0.19.0 — this path is what was always doing the work.
    process.stdout.write(welcomeBanner());
  });

export function welcomeBanner(): string {
  return _welcomeBanner(__CRIMES_VERSION__);
}

registerInitCommand(program);
registerIgnoreCommand(program);
registerUnignoreCommand(program);
registerAuditSuppressionsCommand(program);
registerExplainCommand(program);
registerScanCommand(program);
registerContextCommand(program);
registerHotspotsCommand(program);
registerDiffCommand(program);
registerBaselineCommand(program);
registerVerdictCommand(program);
registerFeedbackCommand(program);
registerTriageCommand(program);
registerMigratePinsCommand(program);
registerHookCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`crimes: ${message}\n`);
  process.exit(1);
});
