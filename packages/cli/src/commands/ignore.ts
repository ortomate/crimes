import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  appendSuppression,
  FINGERPRINT_PATTERN,
  fingerprintFinding,
  loadConfig,
  resolveOverridePath,
  resolveSuppressionsPath,
  scan,
} from "@crimes/core";
import type { Command } from "commander";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

declare const __CRIMES_VERSION__: string;

const execFileAsync = promisify(execFile);

interface IgnoreCommandOptions {
  reason?: string;
  file?: string;
  dryRun: boolean;
  noVerify: boolean;
}

const ID_PATTERN = /^crime_\d+$/;

export function registerIgnoreCommand(program: Command): void {
  program
    .command("ignore")
    .description(
      "Suppress a specific finding by id or fingerprint. " +
        "Requires --reason and writes .crimes/suppressions.json.",
    )
    .argument(
      "<id-or-fingerprint>",
      "either a per-scan id (crime_00005) or a stable fingerprint " +
        "(<type>::<file>::<symbol>) — the latter is the durable form",
    )
    .option(
      "--reason <text>",
      "required: one-sentence justification recorded with the suppression",
    )
    .option(
      "--file <path>",
      "override the suppressions file path (defaults to config.suppressions.path or .crimes/suppressions.json)",
    )
    .option(
      "--dry-run",
      "print the entry that would be written and exit without touching the file",
      false,
    )
    .option(
      "--no-verify",
      "skip the fresh scan that confirms the id-or-fingerprint resolves to a real finding",
      false,
    )
    .action(async (idOrFingerprint: string, options: IgnoreCommandOptions) => {
      const root = resolve(process.cwd());

      if (
        options.reason === undefined ||
        typeof options.reason !== "string" ||
        options.reason.trim().length === 0
      ) {
        process.stderr.write(
          "crimes: --reason is required and must be a non-empty sentence.\n",
        );
        process.exit(2);
        return;
      }

      if (
        !ID_PATTERN.test(idOrFingerprint) &&
        !FINGERPRINT_PATTERN.test(idOrFingerprint)
      ) {
        process.stderr.write(
          `crimes: "${idOrFingerprint}" is neither a per-scan id (crime_00001) ` +
            `nor a stable fingerprint (<type>::<file>::<symbol>).\n`,
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

      let fingerprint: string;
      let type: string;
      let file: string | undefined;
      let symbol: string | undefined;

      if (ID_PATTERN.test(idOrFingerprint)) {
        // Resolve a per-scan id to its stable fingerprint by re-running
        // scan. Ids are reassigned every scan — they are useless on disk.
        let report: Awaited<ReturnType<typeof scan>>;
        try {
          report = await scan({ root, config });
        } catch (error) {
          if (isUserSetupError(error)) {
            fatalUserError(error);
            return;
          }
          throw error;
        }
        const match = report.findings.find((f) => f.id === idOrFingerprint);
        if (!match) {
          process.stderr.write(
            `crimes: no finding with id "${idOrFingerprint}" in the current scan. ` +
              "Re-run `crimes scan` and use the id from that output.\n",
          );
          process.exit(2);
          return;
        }
        // Must go through `fingerprintFinding` — a hand-rolled
        // `type::file::symbol` drops the discriminator, and the entry it
        // writes then matches nothing. The command still printed
        // "Suppressed …" and exited 0 while suppressing nothing.
        fingerprint = fingerprintFinding(match);
        type = match.type;
        file = match.file;
        symbol = match.symbol;
      } else {
        fingerprint = idOrFingerprint;
        const [typePart, filePart, symbolPart] = fingerprint.split("::");
        type = typePart!;
        if (filePart) file = filePart;
        if (symbolPart) symbol = symbolPart;

        // Verify the fingerprint resolves to a real finding when --no-verify
        // is off. Catches silent typos before they land in the file.
        if (!options.noVerify) {
          let report: Awaited<ReturnType<typeof scan>>;
          try {
            report = await scan({ root, config });
          } catch (error) {
            if (isUserSetupError(error)) {
              fatalUserError(error);
              return;
            }
            throw error;
          }
          const match = report.findings.find(
            (f) => fingerprintFinding(f) === fingerprint,
          );
          if (!match) {
            process.stderr.write(
              `crimes: fingerprint "${fingerprint}" did not match any finding ` +
                "in the current scan. Pass --no-verify to suppress it anyway, " +
                "or double-check the type/file/symbol parts.\n",
            );
            process.exit(2);
            return;
          }
        }
      }

      const createdBy = await readGitUserEmail(root);
      const entry = {
        fingerprint,
        type,
        ...(file !== undefined ? { file } : {}),
        ...(symbol !== undefined ? { symbol } : {}),
        reason: options.reason.trim(),
        ...(createdBy ? { created_by: createdBy } : {}),
      };

      if (options.dryRun) {
        process.stdout.write(
          `Would write to ${path}:\n${JSON.stringify(entry, null, 2)}\n`,
        );
        return;
      }

      const result = await appendSuppression(path, entry, {
        crimesVersion: __CRIMES_VERSION__,
      });

      const verb = result.updated ? "Updated" : "Suppressed";
      process.stdout.write(
        `${verb} ${fingerprint} in ${path}. ` +
          "Commit the file so the suppression survives review.\n",
      );
    });
}

async function readGitUserEmail(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "user.email"], {
      cwd: root,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
