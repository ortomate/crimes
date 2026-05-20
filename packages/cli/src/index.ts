import { Command } from "commander";
import { maybeRunAutoInit } from "./auto-init.js";
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
  .option(
    "--init",
    "force the first-run auto-init prompt even if config exists",
  )
  .hook("preAction", async (_thisCommand, actionCommand) => {
    const name = actionCommand.name();
    const opts = program.opts<{ init?: boolean; noInit?: boolean }>();
    await maybeRunAutoInit(name, {
      cwd: process.cwd(),
      flags: { init: opts.init === true, noInit: opts.noInit === true },
    });
  })
  .addHelpText(
    "after",
    "\nTips:\n  run `crimes init --agents` once so coding agents auto-discover crimes.\n  run `crimes context <file>` before editing — it concentrates findings + likely tests + agent notes for one file.",
  )
  .action(() => {
    // Bare `crimes` (no subcommand) prints a welcome banner pointing at
    // the three first-step commands. The postinstall message says the
    // same thing, but npm 7+ swallows postinstall stdout/stderr by
    // default — so this CLI path is the reliable surface.
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
registerHookCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`crimes: ${message}\n`);
  process.exit(1);
});
