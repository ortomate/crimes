import type { Finding } from "../finding.js";

/**
 * Finding types whose subject is the **repository**, not the file they
 * happen to be anchored on.
 *
 * ## Why these need naming
 *
 * The default `crimes scan` view groups by file and shows the top few
 * files by risk. That is the right shape for file-local findings and
 * exactly the wrong shape for these: a repo-level finding is anchored on
 * whichever file a reader would open — `package.json`, `AGENTS.md` — and
 * those files carry one finding each, so they never place in a top-five
 * ranking and never appear at all.
 *
 * Measured on n8n `packages/cli`: `dependency_provenance_gap` on
 * `package.json` and `agent_permission_sprawl` on `AGENTS.md` are both
 * in the JSON and neither is in the default view. On cal.com the same
 * mechanism hid the highest-severity finding in the whole report.
 *
 * They are not *more* important than the file groups — they are a
 * different kind of thing, and a ranking that mixes them buries them by
 * construction rather than by judgement.
 */
const REPO_LEVEL_TYPES = new Set([
  "dependency_provenance_gap",
  "agent_permission_sprawl",
  "missing_agent_context",
  "config_drift",
  "command_drift_docs_code_drift",
  "finder_duplicate_filename",
]);

/** Is this finding about the repository rather than about its file? */
export function isRepoLevelFinding(finding: Pick<Finding, "type">): boolean {
  return REPO_LEVEL_TYPES.has(finding.type.replace(/\.(js|py|x)$/, ""));
}
