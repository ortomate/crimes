import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkBaseline,
  saveBaseline,
  toBaselineEntry,
  BASELINE_RELATIVE_PATH,
} from "../baseline.js";
import { diff } from "../diff.js";
import { fingerprintFinding } from "../fingerprint.js";
import { SCHEMA_VERSION, type Finding, type ScanReport } from "../finding.js";
import { hotspots } from "../hotspots.js";
import { applyScanFailOn, applySuppressionsToScan, applyTriageToScan, scan } from "../scan.js";
import type { SuppressionEntry } from "../suppressions.js";
import type { TriageEntry } from "../triage.js";
import { verdict } from "../verdict.js";

const execFileAsync = promisify(execFile);

/**
 * End-to-end coverage for the 0.16.0 detector slate.
 *
 * The detector unit tests prove each detector's logic. This file proves
 * the findings survive the pipeline every consumer depends on: ids and
 * fingerprints, the JSON contract, baselines, suppressions, triage,
 * diff, verdict, and hotspots. A detector that emits a perfect finding
 * which the baseline cannot round-trip is not shipped.
 */

/** A small service carrying one instance of most of the new crimes. */
const RISKY_REPO: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "risky",
      version: "1.0.0",
      dependencies: { zod: "^3.22.4", "anything-goes": "*" },
    },
    null,
    2,
  ),
  ".env.example": "PORT=\nREQUEST_TIMEOUT_MS=\n",
  ".claude/settings.json": JSON.stringify({
    permissions: { allow: ["Bash(*)", "Bash(pnpm test)"] },
  }),
  "src/routes/export.ts": `
import { load } from "../services/billing.js";
export async function exportBilling(user, res) {
  if (user.role === "admin" && user.plan !== "free") {
    return res.send(await load(user.tenantId));
  }
  return res.status(403).end();
}
`,
  "src/services/entitlements.ts": `
export function canExport(member) {
  if (member.role === "admin" && member.plan !== "free") {
    return true;
  }
  return false;
}
`,
  "src/services/billing.ts": `
export async function load(tenantId) {
  return db.invoices.findMany({ where: { tenantId }, take: 50 });
}
`,
  "src/repo/orders.ts": `
export async function persistOrder(order) {
  try {
    await db.orders.insert(order);
  } catch (e) {}
}
`,
  "src/services/payments.ts": `
export async function submitPayment(order) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.post("/charges", { amount: order.total });
    } catch (e) {
      continue;
    }
  }
}
`,
  "src/config/index.ts": `
export const port = Number(process.env.PORT ?? "3000");
export const timeout = Number(process.env.REQUEST_TIMEOUT_MS ?? "5000");
export const url = process.env.DATABASE_URL!;
`,
  "src/jobs/notify.ts": `
const timeout = process.env.REQUEST_TIMEOUT_MS === "true" ? 1 : 2;
export async function notifyEveryone() {
  const orders = await db.orders.findMany();
  return Promise.all(orders.map((o) => api.post("/notify", { o, timeout })));
}
`,
};

const NEW_TYPES = new Set([
  "duplicated_policy",
  "contract_drift",
  "mock_saturation",
  "swallowed_error",
  "unsafe_retry",
  "config_drift",
  "unbounded_async_fanout",
  "dependency_provenance_gap",
  "pass_through_abstraction",
  "agent_permission_sprawl",
]);

async function makeRepo(
  files: Record<string, string>,
  prefix = "crimes-integration-",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "crimes-test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "crimes-test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function newFindings(report: ScanReport): Finding[] {
  return report.findings.filter((f) => NEW_TYPES.has(f.type));
}

describe("0.16.0 slate — scan integration", () => {
  it("emits findings from the new detectors through the public scan API", async () => {
    const root = await makeRepo(RISKY_REPO);
    const report = await scan({ root });
    const types = new Set(newFindings(report).map((f) => f.type));

    for (const expected of [
      "duplicated_policy",
      "swallowed_error",
      "unsafe_retry",
      "config_drift",
      "unbounded_async_fanout",
      "dependency_provenance_gap",
      "agent_permission_sprawl",
    ]) {
      expect(types, `expected ${expected}`).toContain(expected);
    }
  });

  it("populates every required field of the finding contract", async () => {
    const root = await makeRepo(RISKY_REPO);
    const report = await scan({ root });

    expect(report.schema_version).toBe(SCHEMA_VERSION);
    for (const finding of newFindings(report)) {
      const where = `${finding.type} @ ${finding.file}`;
      expect(finding.id, where).toMatch(/^crime_\d+$/);
      expect(finding.pack, where).toBeTruthy();
      expect(finding.detector_id, where).toBeTruthy();
      expect(finding.charge, where).toBeTruthy();
      expect(["low", "medium", "high"], where).toContain(finding.severity);
      expect(finding.confidence, where).toBeGreaterThan(0);
      expect(finding.confidence, where).toBeLessThanOrEqual(1);
      expect(finding.file, where).toBeTruthy();
      expect(finding.summary.length, where).toBeGreaterThan(20);
      expect(finding.evidence.length, where).toBeGreaterThan(1);
      expect(["quick", "small", "medium", "large"], where).toContain(finding.effort);
      expect(finding.fix_shape.length, where).toBeGreaterThan(5);
      expect(finding.fix_shape.length, where).toBeLessThanOrEqual(120);
      expect(finding.scores.severity, where).toBeGreaterThan(0);
      expect(finding.scores.agent_risk, where).toBeGreaterThanOrEqual(0);
      expect((finding.suggested_actions ?? []).length, where).toBeGreaterThan(0);
    }
  });

  it("keeps `severity` and `scores.severity` in the same band", async () => {
    const root = await makeRepo(RISKY_REPO);
    for (const finding of newFindings(await scan({ root }))) {
      const band =
        finding.scores.severity >= 0.7
          ? "high"
          : finding.scores.severity >= 0.4
            ? "medium"
            : "low";
      expect(band, `${finding.type} @ ${finding.file}`).toBe(finding.severity);
    }
  });

  it("serialises cleanly to JSON with no undefined or circular values", async () => {
    const root = await makeRepo(RISKY_REPO);
    const report = await scan({ root });
    const json = JSON.stringify(report);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain('"undefined"');
    // Related files are always repo-relative POSIX paths.
    for (const finding of newFindings(report)) {
      for (const related of finding.related_files ?? []) {
        expect(related).not.toContain("\\");
        expect(related.startsWith("/")).toBe(false);
      }
    }
  });

  it("gives every finding a unique fingerprint", async () => {
    const root = await makeRepo(RISKY_REPO);
    const fingerprints = newFindings(await scan({ root })).map(fingerprintFinding);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("is deterministic — three scans of one tree agree exactly", async () => {
    const root = await makeRepo(RISKY_REPO);
    const runs = [await scan({ root }), await scan({ root }), await scan({ root })];
    const serialised = runs.map((r) =>
      JSON.stringify(newFindings(r).map((f) => ({ ...f, id: f.id }))),
    );
    expect(serialised[1]).toBe(serialised[0]);
    expect(serialised[2]).toBe(serialised[0]);
  });

  it("normalises paths to POSIX regardless of platform separators", async () => {
    const root = await makeRepo(RISKY_REPO);
    for (const finding of newFindings(await scan({ root }))) {
      expect(finding.file).not.toContain("\\");
    }
  });
});

describe("0.16.0 slate — baseline", () => {
  it("round-trips new findings through save and check", async () => {
    const root = await makeRepo(RISKY_REPO);
    const report = await scan({ root });
    const before = newFindings(report);
    expect(before.length).toBeGreaterThan(3);

    await saveBaseline({ root });
    const check = await checkBaseline({
      root,
      path: join(root, BASELINE_RELATIVE_PATH),
      failOn: "low",
    });
    // Everything was baselined, so nothing is new and the gate passes.
    expect(check.summary.new).toBe(0);
    expect(check.failed).toBe(false);
  });

  it("classifies a newly-introduced crime as new against the baseline", async () => {
    const root = await makeRepo(RISKY_REPO);
    await saveBaseline({ root });

    await writeFile(
      join(root, "src/repo/invoices.ts"),
      `
export async function persistInvoice(invoice) {
  try {
    await db.invoices.insert(invoice);
  } catch (e) {}
}
`,
      "utf8",
    );

    const check = await checkBaseline({
      root,
      path: join(root, BASELINE_RELATIVE_PATH),
      failOn: "medium",
    });
    expect(check.summary.new).toBeGreaterThan(0);
    expect(
      check.new_findings.some(
        (f) => f.type === "swallowed_error" && f.file === "src/repo/invoices.ts",
      ),
    ).toBe(true);
  });

  it("produces baseline entries that survive a serialise/parse cycle", async () => {
    const root = await makeRepo(RISKY_REPO);
    for (const finding of newFindings(await scan({ root }))) {
      const entry = toBaselineEntry(finding);
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
      expect(entry.fingerprint).toBe(fingerprintFinding(finding));
    }
  });
});

describe("0.16.0 slate — suppressions and triage", () => {
  it("hides a suppressed finding and counts it", async () => {
    const root = await makeRepo(RISKY_REPO);
    const report = await scan({ root });
    const target = newFindings(report).find((f) => f.type === "swallowed_error")!;
    const suppressions: SuppressionEntry[] = [
      {
        fingerprint: fingerprintFinding(target),
        type: target.type,
        file: target.file,
        reason: "deliberate best-effort path",
        created_at: "2026-01-01",
      },
    ];

    const filtered = applySuppressionsToScan(report, suppressions, {
      showSuppressed: false,
    });
    expect(filtered.suppressed_count).toBe(1);
    expect(
      filtered.findings.some((f) => fingerprintFinding(f) === suppressions[0]!.fingerprint),
    ).toBe(false);
    expect(filtered.summary.total).toBe(report.summary.total - 1);
  });

  it("annotates a triaged finding and hides a silenced one", async () => {
    const root = await makeRepo(RISKY_REPO);
    const report = await scan({ root });
    const target = newFindings(report).find((f) => f.type === "unsafe_retry")!;

    const fixNow: TriageEntry[] = [
      {
        fingerprint: fingerprintFinding(target),
        type: target.type,
        file: target.file,
        disposition: "fix-this-PR",
        reason: "adding an idempotency key",
        owner: "billing",
        date: "2026-01-01",
      },
    ];
    const annotated = applyTriageToScan(report, fixNow, { showTriaged: false });
    const kept = annotated.findings.find(
      (f) => fingerprintFinding(f) === fixNow[0]!.fingerprint,
    );
    expect(kept?.triaged?.disposition).toBe("fix-this-PR");

    const silenced: TriageEntry[] = [{ ...fixNow[0]!, disposition: "wont-fix" }];
    const hidden = applyTriageToScan(report, silenced, { showTriaged: false });
    expect(hidden.triage_hidden_count).toBe(1);
    expect(
      hidden.findings.some((f) => fingerprintFinding(f) === silenced[0]!.fingerprint),
    ).toBe(false);
  });

  it("never lets a suppressed finding trip the CI gate", async () => {
    const root = await makeRepo(RISKY_REPO);
    const report = await scan({ root });
    const highs = report.findings.filter((f) => f.severity === "high");
    expect(highs.length).toBeGreaterThan(0);

    const suppressions: SuppressionEntry[] = highs.map((f) => ({
      fingerprint: fingerprintFinding(f),
      type: f.type,
      file: f.file,
      reason: "accepted",
      created_at: "2026-01-01",
    }));
    const filtered = applySuppressionsToScan(report, suppressions, {
      showSuppressed: true,
    });
    const gated = applyScanFailOn(filtered, "high");
    expect(gated.failed).toBe(false);
  });
});

describe("0.16.0 slate — diff, verdict, hotspots", () => {
  it("reports a newly-added crime through diff and verdict", async () => {
    const root = await makeRepo(RISKY_REPO, "crimes-integration-git-");
    await git(root, "init", "-q", "-b", "main");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "initial");

    await git(root, "checkout", "-q", "-b", "feature");
    await writeFile(
      join(root, "src/jobs/backfill.ts"),
      `
export async function backfill() {
  const rows = await db.orders.findMany();
  return Promise.all(rows.map((r) => api.post("/reindex", r)));
}
`,
      "utf8",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "add backfill");

    const diffReport = await diff({ root, base: "main", head: "HEAD" });
    expect(
      diffReport.new_findings.some(
        (f) => f.type === "unbounded_async_fanout" && f.file === "src/jobs/backfill.ts",
      ),
    ).toBe(true);

    const verdictReport = await verdict({ root, base: "main" });
    expect(["worse", "mixed"]).toContain(verdictReport.verdict);
  });

  it("reports a fixed crime through diff", async () => {
    const root = await makeRepo(RISKY_REPO, "crimes-integration-fix-");
    await git(root, "init", "-q", "-b", "main");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "initial");

    await git(root, "checkout", "-q", "-b", "fix");
    await writeFile(
      join(root, "src/repo/orders.ts"),
      `
export async function persistOrder(order) {
  try {
    await db.orders.insert(order);
  } catch (e) {
    logger.error("could not persist order", e);
    throw e;
  }
}
`,
      "utf8",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "propagate the failure");

    const diffReport = await diff({ root, base: "main", head: "HEAD" });
    expect(
      diffReport.fixed_findings.some(
        (f) => f.type === "swallowed_error" && f.file === "src/repo/orders.ts",
      ),
    ).toBe(true);
  });

  it("surfaces files carrying new-detector findings in hotspots", async () => {
    const root = await makeRepo(RISKY_REPO, "crimes-integration-hot-");
    await git(root, "init", "-q", "-b", "main");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "initial");

    const report = await hotspots({ root });
    const files = new Set(report.hotspots.map((h) => h.file));
    expect(files.has("src/repo/orders.ts") || files.has("src/services/payments.ts")).toBe(
      true,
    );
  });
});

describe("0.16.0 slate — resilience", () => {
  it("does not crash on a repo of malformed sources", async () => {
    const root = await makeRepo({
      "package.json": "{ not json",
      ".claude/settings.json": "{{{",
      "pnpm-lock.yaml": "  garbage",
      "src/a.ts": "export function ( { if (x === ) { return",
      "src/b.ts": "",
    });
    const report = await scan({ root });
    expect(report.schema_version).toBe(SCHEMA_VERSION);
    expect(Array.isArray(report.findings)).toBe(true);
  });

  it("does not crash on an empty repo", async () => {
    const root = await makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const report = await scan({ root });
    expect(report.findings.filter((f) => NEW_TYPES.has(f.type))).toHaveLength(0);
  });

  it("respects detectors.disable for every new detector", async () => {
    const root = await makeRepo(RISKY_REPO);
    await writeFile(
      join(root, "crimes.config.json"),
      JSON.stringify({ detectors: { disable: [...NEW_TYPES] } }),
      "utf8",
    );
    const report = await scan({ root });
    expect(newFindings(report)).toHaveLength(0);
  });

  it("rejects an invalid option value for a new detector at config load", async () => {
    const root = await makeRepo(RISKY_REPO);
    await writeFile(
      join(root, "crimes.config.json"),
      JSON.stringify({
        detectors: { options: { duplicated_policy: { minFiles: "three" } } },
      }),
      "utf8",
    );
    await expect(scan({ root })).rejects.toThrow(/duplicated_policy/);
  });
});
