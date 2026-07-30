import { builtInAssetDetectors, builtInDetectors } from "@crimes/core";
import type { ExpectedArtifacts, ScanContext, ScoreDetail } from "./types.js";

/**
 * Set of every known detector id at runtime. Built from @crimes/core's
 * exported lists so we don't have to mirror them. Includes both source
 * detectors and asset detectors — the 0.8.0 asset pass introduced
 * asset-only ids (`oversized_raster`, `raster_should_be_vector`,
 * `svg_with_embedded_raster`) that agents can reference exactly like
 * any source detector slug.
 */
const DETECTOR_IDS: ReadonlySet<string> = new Set([
  ...builtInDetectors.map((d) => d.id),
  ...builtInAssetDetectors.map((d) => d.id),
]);

export interface StructuralScoreResult {
  passed: number;
  failed: number;
  details: ScoreDetail[];
}

/**
 * Apply the structural rubric (per §5.5 of the calibration plan) to an
 * agent's response. Deterministic, cheap — runs on every CI replay.
 *
 * The scorer accepts three equivalent ways for an agent to reference a
 * finding: the detector slug (`direct_date`), the human charge name
 * (`Temporal Recklessness`), or the per-scan id (`crime_00004`).
 * Translation tables for the latter two come from the
 * {@link ScanContext} the runner derived from the same scan JSON the
 * agent was prompted with. When `scanContext` is omitted (replay
 * against legacy result files), only slug matching is available.
 */
export function scoreStructural(
  response: string,
  expected: ExpectedArtifacts,
  scanContext?: ScanContext,
  prompt?: string,
): StructuralScoreResult {
  const details: ScoreDetail[] = [];
  const referenced = extractReferencedDetectorIds(response, scanContext);

  pushReferencedFindingsChecks(details, expected, referenced);
  pushReferencedFilesChecks(details, expected, response, prompt);
  pushForbiddenActionsCheck(details, expected, response);
  pushPriorityCheck(details, expected, response, scanContext);

  const scored = details.filter((d) => d.skipped === undefined);
  const passed = scored.filter((d) => d.passed).length;
  const failed = scored.length - passed;
  return { passed, failed, details };
}

function pushReferencedFindingsChecks(
  details: ScoreDetail[],
  expected: ExpectedArtifacts,
  referenced: Set<string>,
): void {
  if (!expected.referenced_findings || expected.referenced_findings.length === 0) {
    return;
  }
  for (const expectedId of expected.referenced_findings) {
    const passed = referenced.has(expectedId);
    details.push({
      check: "referenced_findings",
      expected: expectedId,
      observed: passed ? expectedId : null,
      passed,
    });
  }
}

/**
 * Credit the agent for naming the files a reader should open next.
 *
 * Files the scenario prompt already names are recorded but NOT scored.
 * Restating a path handed to you in the question is evidence about
 * phrasing, not about whether crimes surfaced the right location — and
 * over half the expected files across the scenario set are of that
 * kind ("Use `crimes context src/date.ts`... which helper should you
 * not copy?"). Scoring them punished correct answers that named the
 * *function* the prompt actually asked for.
 */
function pushReferencedFilesChecks(
  details: ScoreDetail[],
  expected: ExpectedArtifacts,
  response: string,
  prompt: string | undefined,
): void {
  if (!expected.referenced_files || expected.referenced_files.length === 0) return;
  const matched = extractFilePaths(response);
  for (const expectedFile of expected.referenced_files) {
    const passed = matched.has(expectedFile);
    const detail: ScoreDetail = {
      check: "referenced_files",
      expected: expectedFile,
      observed: passed ? expectedFile : null,
      passed,
    };
    if (prompt?.includes(expectedFile)) {
      detail.skipped = "path supplied by the scenario prompt";
    }
    details.push(detail);
  }
}

function pushForbiddenActionsCheck(
  details: ScoreDetail[],
  expected: ExpectedArtifacts,
  response: string,
): void {
  if (!expected.forbidden_actions || expected.forbidden_actions.length === 0) return;
  const triggered: string[] = [];
  for (const pattern of expected.forbidden_actions) {
    if (new RegExp(pattern, "i").test(response)) triggered.push(pattern);
  }
  details.push({
    check: "forbidden_actions",
    expected: expected.forbidden_actions,
    observed: triggered,
    passed: triggered.length === 0,
  });
}

function pushPriorityCheck(
  details: ScoreDetail[],
  expected: ExpectedArtifacts,
  response: string,
  scanContext: ScanContext | undefined,
): void {
  if (expected.expected_priority === undefined) return;
  const priority = extractLeadingDetectorId(response, scanContext);
  const passed = priority === expected.expected_priority;
  details.push({
    check: "expected_priority",
    expected: expected.expected_priority,
    observed: priority,
    passed,
  });
}

/**
 * Set of every detector id the response references — by slug, by
 * charge name, or by `crime_NNNN` id. The two non-slug paths only fire
 * when the runner supplied a `scanContext`.
 */
function extractReferencedDetectorIds(
  response: string,
  scanContext: ScanContext | undefined,
): Set<string> {
  const found = new Set<string>();
  for (const id of DETECTOR_IDS) {
    if (matchesToken(response, id)) found.add(id);
  }
  if (scanContext) {
    for (const [charge, id] of Object.entries(scanContext.detector_id_by_charge)) {
      if (matchesToken(response, charge)) found.add(id);
    }
    for (const [findingId, id] of Object.entries(scanContext.detector_id_by_finding_id)) {
      if (matchesToken(response, findingId)) found.add(id);
    }
  }
  return found;
}

/**
 * Find file-path-shaped tokens (anything containing `/` plus a recognised
 * source/asset/text extension). Conservative — only counts paths that
 * look like actual files an agent would name. The asset extensions
 * (`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `svg`) landed
 * with the 0.8.0 asset pass: scenarios referencing image files would
 * otherwise score 0 on `referenced_files` even when the agent quoted
 * the path verbatim.
 */
function extractFilePaths(response: string): Set<string> {
  const found = new Set<string>();
  const re =
    /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|yml|yaml|css|scss|html|png|jpg|jpeg|gif|webp|avif|svg)\b/g;
  const matches = response.matchAll(re);
  for (const m of matches) found.add(m[0]);
  return found;
}

/**
 * Parse the leading section of `response` and return the FIRST
 * detector id that appears (in source order), considering slug, charge
 * name, and `crime_NNNN` id references when a {@link ScanContext} is
 * supplied. Used by the `expected_priority` check.
 *
 * The window is the first 1000 characters — long enough to cover an
 * intro paragraph, a section heading, and the first row of a triage
 * table for typical Claude / Codex responses. The previous 200-char
 * window missed agents that led with framing prose ("Triage plan —
 * top 10 findings") before reaching the priority row.
 */
const LEADING_WINDOW = 1000;

function extractLeadingDetectorId(
  response: string,
  scanContext: ScanContext | undefined,
): string | null {
  const head = response.slice(0, LEADING_WINDOW);
  const candidates: Array<{ id: string; token: string }> = [];
  for (const id of DETECTOR_IDS) candidates.push({ id, token: id });
  if (scanContext) {
    for (const [charge, id] of Object.entries(scanContext.detector_id_by_charge)) {
      candidates.push({ id, token: charge });
    }
    for (const [findingId, id] of Object.entries(scanContext.detector_id_by_finding_id)) {
      candidates.push({ id, token: findingId });
    }
  }
  let earliest: { id: string; index: number } | null = null;
  for (const c of candidates) {
    const idx = head.search(boundedTokenRegex(c.token));
    if (idx === -1) continue;
    if (!earliest || idx < earliest.index) earliest = { id: c.id, index: idx };
  }
  return earliest ? earliest.id : null;
}

function matchesToken(haystack: string, token: string): boolean {
  return boundedTokenRegex(token).test(haystack);
}

function boundedTokenRegex(token: string): RegExp {
  return new RegExp(`\\b${escapeRegex(token)}\\b`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
