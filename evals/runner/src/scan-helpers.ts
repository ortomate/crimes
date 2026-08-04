import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ScanContext } from "./types.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI_DIST = resolve(REPO_ROOT, "packages", "cli", "dist", "index.js");

/**
 * Scan a fixture with the built CLI.
 *
 * `cliDist` overrides which build does the scanning. Only the
 * ranking metric passes it, and only to answer the question it exists
 * for: scanning the *same* fixture with an old and a new crimes is the
 * only way to attribute a ranking delta to the scanner rather than to
 * the fixture. It is a parameter rather than an environment variable
 * on purpose — a stray `CRIMES_EVAL_CLI` left exported would silently
 * measure a baseline against the wrong product, which is exactly the
 * failure that invalidated `0.18.0`.
 */
export async function runScan(fixtureDir: string, cliDist?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "node",
    [cliDist ?? CLI_DIST, "scan", fixtureDir, "--format", "json"],
    { maxBuffer: 1024 * 1024 * 32 },
  );
  return stdout;
}

/**
 * Parse the scan JSON and derive the two lookup maps the scorer needs
 * to recognise findings referenced by id or charge name. Findings shape
 * is the public crimes 0.1.0 contract — `{ id, type, charge, ... }`.
 *
 * Silently skips malformed entries: a stray legacy result file that
 * doesn't conform shouldn't fail the whole run.
 */
export function buildScanContext(scanJson: string): ScanContext {
  const idByFinding: Record<string, string> = {};
  const idByCharge: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(scanJson);
  } catch {
    return { detector_id_by_finding_id: idByFinding, detector_id_by_charge: idByCharge };
  }
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    return { detector_id_by_finding_id: idByFinding, detector_id_by_charge: idByCharge };
  }
  for (const entry of findings) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as { id?: unknown; type?: unknown; charge?: unknown };
    const type = typeof f.type === "string" ? f.type : null;
    if (!type) continue;
    if (typeof f.id === "string") idByFinding[f.id] = type;
    if (typeof f.charge === "string") idByCharge[f.charge] = type;
  }
  return { detector_id_by_finding_id: idByFinding, detector_id_by_charge: idByCharge };
}
