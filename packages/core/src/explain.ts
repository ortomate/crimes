import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import type { Detector } from "./detector.js";
import { builtInDetectors, filterDetectors } from "./detector-registry.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { Finding, ScanReport } from "./finding.js";
import { SCHEMA_VERSION } from "./finding.js";
import { applySuppressionsToScan, scan } from "./scan.js";
import { loadSuppressionsForRoot } from "./suppressions.js";

/**
 * Deterministic, evidence-backed long-form rationale for one finding.
 * Produced by {@link explain}. The schema additions are documented in
 * `docs/json-schema.md`.
 */
export interface ExplainReport {
  schema_version: typeof SCHEMA_VERSION;
  report_type: "explain";
  finding: Finding;
  detector: {
    type: string;
    charge: string;
    description: string;
  };
  why_it_matters: string;
  likely_remedies: string[];
  suggested_suppression_command: string;
}

export interface ExplainOptions {
  /** Absolute or relative path to the repo. Defaults to cwd. */
  root?: string;
  /**
   * Pre-loaded scan report — when set, `explain()` looks up the finding in
   * here instead of running a fresh scan. Mirrors the `--from <scan.json>`
   * CLI flag.
   */
  from?: ScanReport;
  /** Override detector set used during fresh scans. */
  detectors?: Detector[];
}

export class UnknownFindingError extends Error {
  identifier: string;
  constructor(identifier: string) {
    super(
      `no finding with id or fingerprint "${identifier}" — re-run ` +
        "`crimes scan` and check the output.",
    );
    this.name = "UnknownFindingError";
    this.identifier = identifier;
  }
}

export class UnknownDetectorTypeError extends Error {
  type: string;
  constructor(type: string) {
    super(`no detector registered for finding.type "${type}".`);
    this.name = "UnknownDetectorTypeError";
    this.type = type;
  }
}

const ID_PATTERN = /^crime_\d+$/;

/**
 * Resolve a finding by id or fingerprint and produce its explanation.
 *
 * Identifier formats accepted:
 * - per-scan id (`crime_00005`) — only meaningful when paired with the
 *   same scan that produced it, so `options.from` is the canonical path
 *   here; fresh-scan mode also works as long as the order is stable.
 * - stable fingerprint (`<type>::<file>::<symbol>`, with an optional
 *   trailing `::<discriminator>` for detectors that emit more than one
 *   finding per triple) — survives across scans; the preferred form for
 *   agent workflows.
 */
export async function explain(
  identifier: string,
  options: ExplainOptions = {},
): Promise<ExplainReport> {
  const root = resolve(options.root ?? process.cwd());

  let findings: Finding[];
  if (options.from) {
    findings = options.from.findings;
  } else {
    const config = loadConfig(root);
    const detectors = options.detectors ?? filterDetectors(builtInDetectors, config);
    let report = await scan({ root, config, detectors });
    const suppressions = loadSuppressionsForRoot(root, config);
    // Run with showSuppressed=true so a suppressed finding can still be
    // looked up by id/fingerprint — `crimes explain` is the right place
    // to read about a finding the team has already chosen to live with.
    report = applySuppressionsToScan(report, suppressions.entries, {
      showSuppressed: true,
    });
    findings = report.findings;
  }

  const match = findFinding(findings, identifier);
  if (!match) throw new UnknownFindingError(identifier);

  const detector = resolveDetectorFor(match);
  if (!detector) throw new UnknownDetectorTypeError(match.type);

  const fingerprint = fingerprintFinding(match);

  return {
    schema_version: SCHEMA_VERSION,
    report_type: "explain",
    finding: match,
    detector: {
      type: detector.id,
      charge: match.charge,
      description: detector.description,
    },
    why_it_matters: detector.whyItMatters,
    likely_remedies: likelyRemedies(match),
    suggested_suppression_command:
      `crimes ignore ${fingerprint} ` + `--reason "<one-sentence justification>"`,
  };
}

/**
 * Resolve the detector that produced a finding.
 *
 * Must match on `detector_id` first, not `type`. `type` is the abstract
 * charge and is deliberately shared across packs — a
 * `mixed_utc_local_methods` finding from `billing.py` and one from
 * `billing.ts` carry the same `type` — so a `type` lookup returns
 * whichever pack registered first. Before 0.14.0 that was harmless
 * because only one pack could produce any given type; now it means
 * `crimes explain` on a Python finding would describe "Date receivers
 * that mix `getUTCHours` with `getHours`", which is not a thing that
 * exists in Python.
 *
 * Falls back to `type` for universal-pack findings (whose `detector_id`
 * is unqualified and equal to their id) and for findings read from an
 * older `--from <scan.json>` that predates `detector_id`.
 */
function resolveDetectorFor(finding: Finding) {
  const qualified = (finding as Partial<Finding>).detector_id;
  if (typeof qualified === "string" && qualified.length > 0) {
    const exact = builtInDetectors.find((d) => d.id === qualified);
    if (exact) return exact;
    // A language-pack finding whose detector declares an unqualified id
    // (the JS pack's historical form): `large_function.js` → `large_function`.
    const unqualified = qualified.replace(/\.(js|py|x)$/, "");
    const byPack = builtInDetectors.find(
      (d) => d.id === unqualified && d.pack === finding.pack,
    );
    if (byPack) return byPack;
  }
  return builtInDetectors.find((d) => d.id === finding.type);
}

function likelyRemedies(finding: Finding): string[] {
  const actions = finding.suggested_actions?.map((action) => action.description) ?? [];
  const remedies = actions.slice(0, 3);
  remedies.push(
    "If this reflects a real project convention, configure the detector or record feedback instead of renaming code blindly.",
  );
  remedies.push(
    "If the team accepts the risk, suppress this exact fingerprint with a one-sentence reason.",
  );
  return [...new Set(remedies)];
}

function findFinding(findings: Finding[], identifier: string): Finding | undefined {
  if (ID_PATTERN.test(identifier)) {
    return findings.find((f) => f.id === identifier);
  }
  return findings.find((f) => fingerprintFinding(f) === identifier);
}
