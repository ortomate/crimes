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
 * Parse the scan JSON and derive the lookup maps the scorer needs to
 * recognise findings referenced by id, charge name, or their own
 * evidence. Findings shape is the public crimes 0.1.0 contract —
 * `{ id, type, charge, evidence, ... }`.
 *
 * Silently skips malformed entries: a stray legacy result file that
 * doesn't conform shouldn't fail the whole run.
 */
export function buildScanContext(scanJson: string): ScanContext {
  const idByFinding: Record<string, string> = {};
  const idByCharge: Record<string, string> = {};
  const empty = (): ScanContext => ({
    detector_id_by_finding_id: idByFinding,
    detector_id_by_charge: idByCharge,
    detector_id_by_evidence: {},
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(scanJson);
  } catch {
    return empty();
  }
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return empty();

  const forEvidence: EvidenceSource[] = [];
  for (const entry of findings) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as {
      id?: unknown;
      type?: unknown;
      charge?: unknown;
      evidence?: unknown;
    };
    const type = typeof f.type === "string" ? f.type : null;
    if (!type) continue;
    if (typeof f.id === "string") idByFinding[f.id] = type;
    if (typeof f.charge === "string") idByCharge[f.charge] = type;
    if (Array.isArray(f.evidence)) {
      forEvidence.push({
        type,
        evidence: f.evidence.filter((e): e is string => typeof e === "string"),
      });
    }
  }
  return {
    detector_id_by_finding_id: idByFinding,
    detector_id_by_charge: idByCharge,
    detector_id_by_evidence: buildEvidenceIndex(forEvidence),
  };
}

export interface EvidenceSource {
  type: string;
  evidence: readonly string[];
}

/**
 * Map every string that identifies exactly one detector type back to
 * that type — each evidence line, plus each literal an evidence line
 * quotes.
 *
 * ## Why
 *
 * `CLAUDE.md` says evidence before judgement, and an agent that quotes
 * a finding's receipts has referenced it at least as unambiguously as
 * one that pastes its slug. The scorer only knew slugs, charges and
 * `crime_NNNNN` ids, so in the 0.18.1 run codex scored a hard 0 on two
 * `bugfix` scenarios while answering correctly:
 *
 *   bugfix-04-weak-tests    quoted `0 expect/assert calls` verbatim
 *   bugfix-01-timezone-parse  named the literal `"2026-12-20"`
 *
 * ## Why uniqueness is the whole design
 *
 * This is the `has()` rule from `2e9b2da` applied to measurement: a
 * token that identifies more than one thing identifies nothing. An
 * ambiguous string is **dropped entirely** rather than attributed to
 * the first type that claimed it, because the failure mode of guessing
 * is silent — the run reports an agent as having found a detector it
 * never mentioned, and a scorer that flatters is worse than one that
 * misses.
 *
 * Two further filters, for the same reason:
 *
 *  - Bare line references (`lines 537-548`) are dropped. They happen to
 *    be unique in a given scan and say nothing about which detector
 *    produced them.
 *  - Strings under {@link MIN_EVIDENCE_KEY} characters are dropped, as
 *    too small to be a deliberate quotation.
 *  - Pure prose is dropped. A key must carry at least one character
 *    that is not a letter or a space — a digit, quote, backtick,
 *    symbol, path separator — so that it reads as a citation rather
 *    than a phrase. `arrow declaration` is a real `large_function`
 *    evidence line and also something an agent can write about
 *    unrelated code; `0 expect/assert calls` is not.
 */
const MIN_EVIDENCE_KEY = 12;
const BARE_LINE_REFERENCE = /^lines?\b[\s:]*[\d,\s–—-]+$/i;
const PURE_PROSE = /^[A-Za-z ]+$/;
const QUOTED_LITERAL = /"[^"]{4,}"/g;

export function buildEvidenceIndex(
  findings: readonly EvidenceSource[],
): Record<string, string> {
  const typesByKey = new Map<string, Set<string>>();
  const note = (key: string, type: string): void => {
    const trimmed = key.trim();
    if (trimmed.length < MIN_EVIDENCE_KEY) return;
    if (BARE_LINE_REFERENCE.test(trimmed)) return;
    if (PURE_PROSE.test(trimmed)) return;
    let types = typesByKey.get(trimmed);
    if (!types) {
      types = new Set();
      typesByKey.set(trimmed, types);
    }
    types.add(type);
  };

  for (const finding of findings) {
    for (const line of finding.evidence) {
      note(line, finding.type);
      for (const literal of line.match(QUOTED_LITERAL) ?? []) {
        note(literal, finding.type);
      }
    }
  }

  const index: Record<string, string> = {};
  for (const [key, types] of typesByKey) {
    if (types.size !== 1) continue;
    const [only] = types;
    if (only) index[key] = only;
  }
  return index;
}
