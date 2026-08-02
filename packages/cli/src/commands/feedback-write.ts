import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appendSuppression,
  FINGERPRINT_PATTERN,
  fingerprintFinding,
  loadConfig,
  loadSuppressions,
  minorKey,
  removeSuppression,
  resolveFeedbackPath,
  resolveSuppressionsPath,
  writeFeedbackEntry,
} from "@crimes/core";
import { fatalUserError, isUserSetupError } from "../runtime-errors.js";

// Injected at build time by tsup (same pattern as ignore.ts / baseline.ts).
declare const __CRIMES_VERSION__: string;

export interface FeedbackCommandOptions {
  verdict?: string;
  note?: string;
  file?: string;
}

export const ID_PATTERN = /^crime_\d+$/;
export { FINGERPRINT_PATTERN };
export const VALID_VERDICTS = new Set(["tp", "fp", "known"] as const);
export type Verdict = "tp" | "fp" | "known";

export function isVerdict(value: string): value is Verdict {
  return VALID_VERDICTS.has(value as Verdict);
}

/**
 * Top-level handler for `crimes feedback <fingerprint-or-id>
 * --verdict ...`. Extracted from `registerFeedbackCommand` so the
 * command-registration body stays under the large_function threshold
 * and the write path is independently readable / testable.
 */
export async function handleFeedbackWrite(
  idOrFingerprint: string | undefined,
  options: FeedbackCommandOptions,
): Promise<void> {
  const verdict = validateInputs(idOrFingerprint, options);
  // validateInputs exits on failure, so reaching here means inputs are
  // sound — re-narrow `idOrFingerprint` for the rest of the function.
  const targetRef = idOrFingerprint!;

  const root = resolve(process.cwd());
  const resolved = await resolveFingerprintTarget(targetRef, options);

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

  const suppressionsPath = resolveSuppressionsPath(root, config);
  const existingSuppressions = loadSuppressions(suppressionsPath);
  const priorEntry = existingSuppressions.entries.find(
    (e) => e.fingerprint === resolved.fingerprint,
  );

  // resurfaced_from is set when we're re-confirming or resolving
  // a feedback `fp` from a different minor than the current one.
  let resurfacedFrom: string | null = null;
  if (
    priorEntry &&
    priorEntry.source === "feedback" &&
    priorEntry.crimes_version_pinned !== undefined
  ) {
    const priorMinor = minorKey(priorEntry.crimes_version_pinned);
    const currentMinor = minorKey(__CRIMES_VERSION__);
    if (priorMinor !== currentMinor) resurfacedFrom = priorMinor;
  }

  const feedbackPath = resolveFeedbackPath(root);
  const writeResult = await writeFeedbackEntry(feedbackPath, {
    crimes_version: __CRIMES_VERSION__,
    fingerprint: resolved.fingerprint,
    finding_type: resolved.findingType,
    verdict,
    note: verdict === "fp" ? options.note!.trim() : (options.note?.trim() ?? null),
    scan_hash: resolved.scanHash,
    resurfaced_from: resurfacedFrom,
  });

  await applySuppressionSideEffect({
    verdict,
    resolved,
    options,
    suppressionsPath,
    priorEntry,
  });

  printFeedbackOutcome({
    verdict,
    fingerprint: resolved.fingerprint,
    feedbackPath: writeResult.path,
    suppressionsPath,
    priorEntry,
  });
}

function validateInputs(
  idOrFingerprint: string | undefined,
  options: FeedbackCommandOptions,
): Verdict {
  if (idOrFingerprint === undefined) {
    process.stderr.write(
      "crimes: feedback requires <fingerprint-or-id>. " +
        "Use a subcommand for read paths: list, summary, export, recheck.\n",
    );
    process.exit(2);
  }
  if (options.verdict === undefined || !isVerdict(options.verdict)) {
    process.stderr.write(
      'crimes: --verdict is required and must be one of "tp", "fp", "known".\n',
    );
    process.exit(2);
  }
  const verdict = options.verdict as Verdict;
  if (verdict === "fp") {
    if (options.note === undefined || options.note.trim().length === 0) {
      process.stderr.write(
        "crimes: --note is required when --verdict is fp " +
          "(the note becomes the suppression reason).\n",
      );
      process.exit(2);
    }
  }
  if (!ID_PATTERN.test(idOrFingerprint!) && !FINGERPRINT_PATTERN.test(idOrFingerprint!)) {
    process.stderr.write(
      `crimes: "${idOrFingerprint!}" is neither a per-scan id (crime_00001) ` +
        `nor a stable fingerprint (<type>::<file>::<symbol>[::<discriminator>]).\n`,
    );
    process.exit(2);
  }
  return verdict;
}

interface ResolvedTarget {
  fingerprint: string;
  findingType: string;
  file: string | undefined;
  symbol: string | undefined;
  scanHash: string | null;
}

async function resolveFingerprintTarget(
  idOrFingerprint: string,
  options: FeedbackCommandOptions,
): Promise<ResolvedTarget> {
  if (ID_PATTERN.test(idOrFingerprint)) {
    if (options.file === undefined) {
      process.stderr.write(
        "crimes: --file <scan.json> is required when passing a crime_NNNNN id " +
          "(per-scan ids are ephemeral — only fingerprints work without --file).\n",
      );
      process.exit(2);
    }
    let raw: string;
    try {
      raw = await readFile(options.file!, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `crimes: unable to read --file ${options.file} — ${message}\n`,
      );
      process.exit(2);
      throw err; // unreachable; keeps narrowing happy
    }
    const scanHash = "sha256:" + createHash("sha256").update(raw).digest("hex");
    let scanJson: {
      findings?: Array<{
        id: string;
        type: string;
        file: string;
        symbol?: string;
        discriminator?: string;
      }>;
    };
    try {
      scanJson = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `crimes: --file ${options.file} is not valid JSON — ${message}\n`,
      );
      process.exit(2);
      throw err;
    }
    const match = scanJson.findings?.find((f) => f.id === idOrFingerprint);
    if (!match) {
      process.stderr.write(
        `crimes: no finding with id "${idOrFingerprint}" in ${options.file}. ` +
          "Pass the fingerprint directly to avoid needing --file.\n",
      );
      process.exit(2);
      throw new Error("unreachable");
    }
    return {
      // Via `fingerprintFinding`, not by hand — see the same note in
      // `ignore.ts`. A reconstructed three-part fingerprint drops the
      // discriminator and records feedback against nothing.
      fingerprint: fingerprintFinding(match),
      findingType: match.type,
      file: match.file,
      symbol: match.symbol,
      scanHash,
    };
  }

  // Fingerprint path
  const fingerprint = idOrFingerprint;
  const [typePart, filePart, symbolPart] = fingerprint.split("::");
  let scanHash: string | null = null;
  if (options.file !== undefined) {
    try {
      const raw = await readFile(options.file, "utf8");
      scanHash = "sha256:" + createHash("sha256").update(raw).digest("hex");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `crimes: unable to read --file ${options.file} — ${message}\n`,
      );
      process.exit(2);
    }
  }
  return {
    fingerprint,
    findingType: typePart!,
    file: filePart || undefined,
    symbol: symbolPart || undefined,
    scanHash,
  };
}

interface SuppressionSideEffectArgs {
  verdict: Verdict;
  resolved: ResolvedTarget;
  options: FeedbackCommandOptions;
  suppressionsPath: string;
  priorEntry: { source?: string } | undefined;
}

async function applySuppressionSideEffect(
  args: SuppressionSideEffectArgs,
): Promise<void> {
  const { verdict, resolved, options, suppressionsPath, priorEntry } = args;
  if (verdict === "fp") {
    const reason = options.note!.trim();
    await appendSuppression(
      suppressionsPath,
      {
        fingerprint: resolved.fingerprint,
        type: resolved.findingType,
        ...(resolved.file !== undefined ? { file: resolved.file } : {}),
        ...(resolved.symbol !== undefined ? { symbol: resolved.symbol } : {}),
        reason,
        source: "feedback",
        crimes_version_pinned: minorKey(__CRIMES_VERSION__),
      },
      { crimesVersion: __CRIMES_VERSION__ },
    );
  } else if (verdict === "tp") {
    // Delete any feedback-sourced suppression. Manual ones survive
    // (a separate `crimes unignore` would remove those).
    if (priorEntry && priorEntry.source === "feedback") {
      await removeSuppression(suppressionsPath, resolved.fingerprint, {
        crimesVersion: __CRIMES_VERSION__,
      });
    }
  }
  // "known": neither writes nor deletes a suppression.
}

interface PrintOutcomeArgs {
  verdict: Verdict;
  fingerprint: string;
  feedbackPath: string;
  suppressionsPath: string;
  priorEntry: { source?: string } | undefined;
}

function printFeedbackOutcome(args: PrintOutcomeArgs): void {
  const { verdict, fingerprint, feedbackPath, suppressionsPath, priorEntry } = args;
  const verbCopy =
    verdict === "fp"
      ? "Recorded fp + wrote suppression"
      : verdict === "tp"
        ? priorEntry && priorEntry.source === "feedback"
          ? "Recorded tp + removed prior feedback suppression"
          : "Recorded tp"
        : "Recorded known";

  process.stdout.write(
    `${verbCopy} for ${fingerprint}\n` +
      `  feedback:     ${feedbackPath}\n` +
      (verdict === "fp"
        ? `  suppression:  ${suppressionsPath} (pinned to ${minorKey(__CRIMES_VERSION__)})\n`
        : ""),
  );
}
