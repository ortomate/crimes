import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  FINGERPRINT_PATTERN,
  loadConfig,
  loadSuppressions,
  MalformedSuppressionsError,
  removeSuppression,
  resolveOverridePath,
  resolveSuppressionsPath,
} from "@crimes/core";
import type { Command } from "commander";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

declare const __CRIMES_VERSION__: string;

interface UnignoreCommandOptions {
  file?: string;
  dryRun: boolean;
}

export function registerUnignoreCommand(program: Command): void {
  program
    .command("unignore")
    .description(
      "Remove a suppression entry from .crimes/suppressions.json by stable fingerprint.",
    )
    .argument(
      "<fingerprint>",
      "the stable <type>::<file>::<symbol> fingerprint to remove",
    )
    .option(
      "--file <path>",
      "override the suppressions file path (defaults to config.suppressions.path or .crimes/suppressions.json)",
    )
    .option("--dry-run", "print the entry that would be removed without writing", false)
    .action(async (fingerprint: string, options: UnignoreCommandOptions) => {
      const root = resolve(process.cwd());

      if (!FINGERPRINT_PATTERN.test(fingerprint)) {
        process.stderr.write(
          `crimes: "${fingerprint}" is not a stable fingerprint ` +
            `(<type>::<file>::<symbol>[::<discriminator>]). Run ` +
            `\`crimes audit-suppressions\` ` +
            `to see the active fingerprints.\n`,
        );
        process.exit(2);
        return;
      }

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

      const path = options.file
        ? resolveOverridePath(root, options.file)
        : resolveSuppressionsPath(root, config);

      if (!existsSync(path)) {
        process.stderr.write(
          `crimes: no suppressions file at ${path}. Nothing to remove.\n`,
        );
        process.exit(2);
        return;
      }

      // Preview path: read-only lookup so --dry-run never writes and the
      // not-found error fires before any disk mutation in the live path.
      let loaded: ReturnType<typeof loadSuppressions>;
      try {
        loaded = loadSuppressions(path);
      } catch (error) {
        if (error instanceof MalformedSuppressionsError) {
          process.stderr.write(`crimes: ${error.message}\n`);
          process.exit(2);
          return;
        }
        throw error;
      }

      const match = loaded.entries.find((s) => s.fingerprint === fingerprint);
      if (!match) {
        process.stderr.write(
          `crimes: no suppression entry with fingerprint "${fingerprint}" in ${path}. ` +
            `Run \`crimes audit-suppressions\` to list current entries.\n`,
        );
        process.exit(2);
        return;
      }

      if (options.dryRun) {
        process.stdout.write(
          `Would remove from ${path}:\n${JSON.stringify(match, null, 2)}\n`,
        );
        return;
      }

      const result = await removeSuppression(path, fingerprint, {
        crimesVersion: __CRIMES_VERSION__,
      });

      if (!result.removed) {
        // Race: the entry vanished between load and remove. Surface as a
        // soft error rather than crashing.
        process.stderr.write(
          `crimes: suppression entry "${fingerprint}" was not present at write time. ` +
            `No changes written.\n`,
        );
        process.exit(2);
        return;
      }

      process.stdout.write(
        `Removed ${fingerprint} from ${path}. ` +
          `Commit the change so the removal survives review.\n`,
      );
    });
}
