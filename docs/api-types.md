# JSON report types

Generated from the public TypeScript declarations by `pnpm docs:generate`.
`pnpm verify` checks for drift and type-checks these declarations together.
Read [JSON interpretation and compatibility](./json-schema.md) before consuming
reports. This is a type reference, not a runtime validator or an npm TypeScript SDK.
Optional fields may be absent; saved decision files can accept older schema versions.

## ScanReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export interface ScanReport {
    ranking?: {
        recency_enabled: boolean;
    };
    schema_version: "0.8.0";
    report_type: "scan";
    repo: {
        name: string;
        root: string;
        git_ref?: string;
    };
    summary: ScanSummary;
    findings: Finding[];
    fail_on?: Severity;
    failed?: boolean;
    changed_files?: string[];
    working_set?: WorkingSet;
    suppressed_count?: number;
    triage_hidden_count?: number;
    coverage?: {
        detectors_default_off?: string[];
        files_total: number;
        files_by_language: Record<string, number>;
        files_universal_only: number;
        universal_only_by_extension?: Record<string, number>;
        packs_loaded: string[];
        by_package?: Array<{
            path: string;
            files_total: number;
            files_by_language: Record<string, number>;
            dominant_language: string | null;
        }>;
        warnings?: CoverageWarning[];
    };
}
```

## Finding

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export interface Finding {
    id: string;
    fingerprint: string;
    type: string;
    claim?: string;
    pack: Pack;
    detector_id: string;
    charge: string;
    severity: Severity;
    confidence: number;
    file: string;
    symbol?: string;
    discriminator?: string;
    lines?: [
        number,
        number
    ];
    summary: string;
    evidence: string[];
    effort: Effort;
    fix_shape: string;
    scores: FindingScores;
    score_rationale?: string[];
    suggested_actions?: SuggestedAction[];
    related_files?: string[];
    suppressed?: true;
    suppression_reason?: string;
    previously_suppressed?: true;
    previous_suppression?: {
        pinned_version: string;
        reason: string;
    };
    triaged?: {
        disposition: "fix-now" | "fix-this-PR";
        reason: string;
        owner: string;
        date: string;
    };
    hidden_triage?: {
        disposition: "needs-design" | "wont-fix" | "scaffolding";
        reason: string;
        owner: string;
        date: string;
    };
    previously_triaged?: true;
    previous_triage?: {
        disposition: "fix-now" | "fix-this-PR" | "needs-design" | "wont-fix" | "scaffolding";
        reason: string;
        owner: string;
        date: string;
    };
    previously_baselined?: true;
    previous_baseline?: {
        date?: string;
        reason?: string;
    };
    tier?: Tier;
}
```

## ContextReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/context.ts).

```ts
export interface ContextReport {
    schema_version: "0.8.0";
    report_type: "context";
    repo: {
        name: string;
        root: string;
    };
    file: string;
    risk: ContextRisk;
    analysis_status?: "complete" | "partial" | "not_analyzed";
    coverage?: NonNullable<ScanReport["coverage"]>;
    agent_guidance: string[];
    related_files: ContextRelatedFile[];
    likely_tests: string[];
    findings: Finding[];
    agent_guidance_reason?: string;
    related_files_reason?: string;
    likely_tests_reason?: string;
    suppressed_count?: number;
    clues?: ContextClues;
}
```

## HotspotsReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/hotspots.ts).

```ts
export interface HotspotsReport {
    schema_version: "0.8.0";
    report_type: "hotspots";
    repo: {
        name: string;
        root: string;
    };
    since: string;
    git_available: boolean;
    history_limited?: boolean;
    history_limited_reason?: string;
    ranking_note?: string;
    total_files?: number;
    shown_count?: number;
    hidden_count?: number;
    hotspots: Hotspot[];
}
```

## DiffReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/diff.ts).

```ts
export interface DiffReport {
    schema_version: "0.8.0";
    report_type: "diff";
    repo: {
        name: string;
        root: string;
    };
    base: string;
    head: string;
    summary: DiffSummary;
    new_findings: Finding[];
    fixed_findings: Finding[];
    unchanged_findings: Finding[];
    suppressed_count?: number;
    fail_on?: DiffFailOn;
    failed?: boolean;
}
```

## Baseline

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/baseline.ts).

```ts
export interface Baseline {
    schema_version: AcceptedBaselineSchemaVersion;
    report_type: "baseline";
    created_at: string;
    crimes_version?: string;
    repo?: {
        name: string;
        root: string;
    };
    summary: ScanSummary;
    findings: BaselineEntry[];
}
```

## BaselineCheckReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/baseline.ts).

```ts
export interface BaselineCheckReport {
    schema_version: "0.8.0";
    report_type: "baseline_check";
    repo: {
        name: string;
        root: string;
    };
    baseline_path: string;
    fail_on: FailOn;
    failed: boolean;
    summary: BaselineCheckSummary;
    new_findings: Finding[];
    fixed_findings: BaselineEntry[];
    unchanged_findings: Finding[];
    suppressed_count?: number;
}
```

## VerdictReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/verdict.ts).

```ts
export interface VerdictReport {
    schema_version: "0.8.0";
    report_type: "verdict";
    repo: {
        name: string;
        root: string;
    };
    base: string;
    head: string;
    verdict: Verdict;
    summary: VerdictSummary;
    reasons: string[];
    recommended_actions: string[];
    new_findings: Finding[];
    fixed_findings: Finding[];
    suppressed_count?: number;
}
```

## ExplainReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/explain.ts).

```ts
export interface ExplainReport {
    schema_version: "0.8.0";
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
```

## Suppressions

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/suppressions-schema.ts).

```ts
export interface Suppressions {
    schema_version: (readonly ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0", "0.8.0"])[number];
    report_type: "suppressions";
    created_at: string;
    updated_at: string;
    crimes_version?: string;
    suppressions: SuppressionEntry[];
}
```

## Triage

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/triage.ts).

```ts
export interface Triage {
    schema_version: (readonly ["0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0", "0.8.0"])[number];
    report_type: "triage";
    created_at: string;
    updated_at: string;
    crimes_version?: string;
    entries: TriageEntry[];
}
```

## TriageListReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/triage.ts).

```ts
export interface TriageListReport {
    schema_version: "0.8.0";
    report_type: "triage_list";
    entries: TriageEntry[];
}
```

## TriageApplyReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/triage.ts).

```ts
export interface TriageApplyReport {
    schema_version: "0.8.0";
    report_type: "triage_apply";
    applied: number;
}
```

## TriageClearReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/triage.ts).

```ts
export interface TriageClearReport {
    schema_version: "0.8.0";
    report_type: "triage_clear";
    fingerprint: string;
    removed: number;
}
```

## AuditSuppressionsReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/audit-suppressions.ts).

```ts
export interface AuditSuppressionsReport {
    schema_version: "0.8.0";
    report_type: "audit_suppressions";
    suppressions_path: string;
    loaded: boolean;
    generated_at: string;
    total: number;
    flagged_count: number;
    entries: AuditSuppressionEntry[];
}
```

## FeedbackReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/feedback/types.ts).

```ts
export interface FeedbackReport {
    schema_version: "0.8.0";
    report_type: "feedback";
    scope: "repo" | "global";
    source_file: string;
    entries: FeedbackEntry[];
    summary?: FeedbackSummary;
}
```

## FeedbackRecheckReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/feedback/types.ts).

```ts
export interface FeedbackRecheckReport {
    schema_version: "0.8.0";
    report_type: "feedback_recheck";
    current_version: string;
    current_minor: string;
    resurfaced: Array<ResurfacedSuppression & {
        commands: {
            reconfirm_fp: string;
            mark_resolved: string;
        };
    }>;
}
```

## ResurfacedSuppression

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/feedback/recheck.ts).

```ts
export interface ResurfacedSuppression {
    fingerprint: string;
    type: string;
    file?: string;
    symbol?: string;
    reason: string;
    crimes_version_pinned: string;
    hint: string;
}
```

## PinMigrationPlan

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/pin-migration.ts).

```ts
export type PinMigrationPlan = { schema_version: "0.8.0"; report_type: "pin_migration"; source_hashes: Record<string, string>; entries: { source: "triage.json" | "suppressions.json" | "baseline.json"; from: string; status: "unchanged" | "candidate" | "ambiguous" | "not_reported"; candidates: string[]; to?: string | undefined; }[]; };
```

## PinMigrationRecoveryReport

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/pin-migration.ts).

```ts
export interface PinMigrationRecoveryReport {
    schema_version: "0.8.0";
    report_type: "pin_migration_recovery";
    restored_files: number;
}
```

## AcceptedBaselineSchemaVersion

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/baseline.ts).

```ts
export type AcceptedBaselineSchemaVersion = "0.8.0" | "0.1.0" | "0.2.0" | "0.3.0" | "0.4.0" | "0.5.0" | "0.6.0" | "0.7.0";
```

## AuditConcern

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/audit-suppressions.ts).

```ts
export type AuditConcern = "stale" | "short_reason" | "vague_reason";
```

## AuditSuppressionEntry

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/audit-suppressions.ts).

```ts
export interface AuditSuppressionEntry extends SuppressionEntry {
    age_days: number;
    concerns: AuditConcern[];
}
```

## BaselineCheckSummary

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/baseline.ts).

```ts
export interface BaselineCheckSummary {
    total_baseline: number;
    total_current: number;
    new: number;
    fixed: number;
    unchanged: number;
    new_by_severity: {
        high: number;
        medium: number;
        low: number;
    };
}
```

## BaselineEntry

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/baseline.ts).

```ts
export interface BaselineEntry {
    fingerprint: string;
    type: string;
    charge: string;
    severity: Severity;
    file: string;
    symbol?: string;
}
```

## ContextClues

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/context.ts).

```ts
export interface ContextClues {
    churn?: {
        commits_90d: number;
        last_commit_at: string;
        unique_authors_90d: number;
    };
    suppressions?: SuppressionForFile[];
    test_gap?: {
        raw: number;
        percentile?: number;
        label: "top-quartile" | "median" | "bottom-quartile" | "unknown";
    };
    related_signals: unknown[];
}
```

## ContextRelatedFile

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/context-related-files.ts).

```ts
export interface ContextRelatedFile {
    file: string;
    reason: string;
    score?: number;
}
```

## ContextRisk

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/context.ts).

```ts
export interface ContextRisk {
    level: "none" | "low" | "medium" | "high";
    high: number;
    medium: number;
    low: number;
    total: number;
}
```

## CoverageWarning

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export interface CoverageWarning {
    kind: CoverageWarningKind;
    subject: string;
    files: number;
    examples?: string[];
    entries?: number;
    detail: string;
    remedy?: string;
}
```

## CoverageWarningKind

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export type CoverageWarningKind = "files_not_discovered" | "files_excluded" | "files_excluded_by_tooling" | "files_not_followed" | "files_in_hidden_path" | "files_unreadable" | "files_unparsed" | "files_partial_parse" | "index_truncated" | "index_unavailable" | "working_set_path_unmatched" | "triage_entries_unmatched" | "suppression_entries_unmatched";
```

## DiffFailOn

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/diff.ts).

```ts
export type DiffFailOn = "new-high" | "new-medium";
```

## DiffSummary

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/diff.ts).

```ts
export interface DiffSummary {
    new: number;
    fixed: number;
    unchanged: number;
}
```

## Effort

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export type Effort = "quick" | "small" | "medium" | "large";
```

## FailOn

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/baseline.ts).

```ts
export type FailOn = "medium" | "low" | "high";
```

## FeedbackEntry

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/feedback/types.ts).

```ts
export interface FeedbackEntry {
    timestamp: string;
    crimes_version: string;
    fingerprint: string;
    finding_type: string;
    verdict: "tp" | "fp" | "known";
    note: string | null;
    scan_hash: string | null;
    resurfaced_from: string | null;
    repo?: string;
}
```

## FeedbackSummary

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/feedback/types.ts).

```ts
export interface FeedbackSummary {
    total: number;
    by_verdict: {
        tp: number;
        fp: number;
        known: number;
    };
    by_detector: Record<string, {
        tp: number;
        fp: number;
        known: number;
    }>;
    by_version: Record<string, number>;
    by_repo?: Record<string, number>;
}
```

## FindingScores

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export interface FindingScores {
    severity: number;
    confidence: number;
    blast_radius?: number;
    blast_radius_transitive_importers?: number;
    blast_radius_direct_importers?: number;
    churn?: number;
    test_gap?: number;
    recency?: number;
    agent_risk?: number;
}
```

## HighestSeverity

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/hotspots.ts).

```ts
export type HighestSeverity = Severity | "none";
```

## Hotspot

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/hotspots.ts).

```ts
export interface Hotspot {
    file: string;
    change_count: number;
    latest_change?: string;
    finding_count: number;
    highest_severity: HighestSeverity;
    risk: number;
}
```

## Pack

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/pack.ts).

```ts
export type Pack = "universal" | "language-js" | "language-py" | "cross-language";
```

## ScanSummary

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export interface ScanSummary {
    total: number;
    high: number;
    medium: number;
    low: number;
}
```

## Severity

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export type Severity = "medium" | "low" | "high";
```

## SuggestedAction

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export interface SuggestedAction {
    kind: string;
    description: string;
    risk: "low" | "medium" | "high";
}
```

## SuppressionEntry

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/suppressions-schema.ts).

```ts
export interface SuppressionEntry {
    fingerprint: string;
    type: string;
    claim?: string;
    file?: string;
    symbol?: string;
    reason: string;
    created_at: string;
    created_by?: string;
    source?: "manual" | "feedback";
    crimes_version_pinned?: string;
}
```

## SuppressionForFile

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/suppressions.ts).

```ts
export interface SuppressionForFile {
    fingerprint: string;
    detector: string;
    reason: string;
    pinned_version: string;
    matches_current_finding: boolean;
}
```

## Tier

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/scoring/tier.ts).

```ts
export type Tier = "domain" | "nonDomain";
```

## TriageDisposition

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/triage.ts).

```ts
export type TriageDisposition = "fix-now" | "fix-this-PR" | "needs-design" | "wont-fix" | "scaffolding";
```

## TriageEntry

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/triage.ts).

```ts
export interface TriageEntry {
    fingerprint: string;
    type: string;
    claim?: string;
    file: string;
    symbol?: string;
    disposition: TriageDisposition;
    reason: string;
    owner: string;
    date: string;
}
```

## Verdict

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/verdict.ts).

```ts
export type Verdict = "unchanged" | "cleaner" | "worse" | "mixed";
```

## VerdictSummary

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/verdict.ts).

```ts
export interface VerdictSummary {
    new: number;
    fixed: number;
    unchanged: number;
    new_by_severity: {
        high: number;
        medium: number;
        low: number;
    };
    fixed_by_severity: {
        high: number;
        medium: number;
        low: number;
    };
    new_weighted: number;
    fixed_weighted: number;
}
```

## WorkingSet

[Source](https://github.com/ortomate/crimes/blob/main/packages/core/src/finding.ts).

```ts
export interface WorkingSet {
    selector: "files" | "related-to";
    seeds: string[];
    depth?: number;
    files: string[];
}
```
