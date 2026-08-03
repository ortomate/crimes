/**
 * Barrel for the split human renderer (0.7.0). The public API mirrors
 * the pre-split `human.ts` exactly; the consumers (reporter/src/index.ts
 * and any direct importers in tests) keep using the same import paths.
 */

export type { FeedbackHintOptions } from "./shared.js";
export {
  formatHumanReport,
  formatScanFailOnLine,
} from "./scan.js";
export type {
  HumanReportOptions,
  ScanFailOnLineOptions,
} from "./scan.js";
export { formatContextHumanReport } from "./context.js";
export type { ContextHumanReportOptions } from "./context.js";
export { formatHotspotsReport } from "./hotspots.js";
export type { HotspotsHumanReportOptions } from "./hotspots.js";
export { formatDiffReport } from "./diff.js";
export type { DiffHumanReportOptions } from "./diff.js";
export {
  formatBaselineCheckReport,
  formatBaselineSaveReport,
} from "./baseline.js";
export type { BaselineHumanReportOptions } from "./baseline.js";
export { formatVerdictReport } from "./verdict.js";
export type { VerdictHumanReportOptions } from "./verdict.js";
export { formatExplainReport } from "./explain.js";
export type { ExplainHumanReportOptions } from "./explain.js";
export { formatAuditSuppressionsReport } from "./audit.js";
export type { AuditSuppressionsHumanReportOptions } from "./audit.js";
export {
  buildCoverageBanner,
  buildCoverageWarningNotice,
  renderCoverageExplain,
} from "./coverage.js";
