import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  emptyTriage,
  feedbackEntryFromTriage,
  fingerprintFinding,
  loadConfig,
  loadTriage,
  parseTriageInput,
  resolveFeedbackPath,
  resolveTriagePath,
  saveTriage,
  scan,
  upsertTriageEntry,
  verdictForDisposition,
  WONT_FIX_FALLBACK_VERDICT,
  writeFeedbackEntry,
  type FeedbackVerdict,
  type Finding,
  type Triage,
  type TriageDisposition,
  type TriageEntry,
} from "@crimes/core";
import type { Command } from "commander";
// picomatch is a CommonJS module; the bundled CLI dist resolves it via
// tsup's noExternal. Static import (not require()) keeps the source
// ESM-pure so anything that consumes packages/cli/src directly — tests,
// future consumers — doesn't depend on tsup's bundling.
//
// Hand-declared shape — picomatch ships no .d.ts and we don't carry
// @types/picomatch as a direct dep. The runtime returns a matcher
// function; that's all we use.
// @ts-expect-error -- picomatch ships no types
import picomatch from "picomatch";
type PicomatchFactory = (pattern: string) => (str: string) => boolean;

// Injected at build time by tsup from the CLI package's package.json. Shared
// with `index.ts` via the same `define` block — re-declared here because each
// TS file compiles independently against the ambient declaration.
declare const __CRIMES_VERSION__: string;

interface TriageOptions {
  apply?: string;
  list: boolean;
  clear?: string;
  retriage?: string;
  format: "human" | "json";
  owner?: string;
  noColor: boolean;
  all: boolean;
}

const DISPOSITION_BY_KEY: Record<string, TriageDisposition> = {
  f: "fix-now",
  p: "fix-this-PR",
  d: "needs-design",
  w: "wont-fix",
  s: "scaffolding",
};

export function registerTriageCommand(program: Command): void {
  program
    .command("triage")
    .description(
      "Walk findings and assign per-finding dispositions (fix-now / fix-this-PR / needs-design / wont-fix / scaffolding).",
    )
    .argument("[path]", "directory to scan (defaults to current directory)")
    .option("--apply <file>", "non-interactive: merge triage entries from a JSON file")
    .option("--list", "show existing triage entries and exit", false)
    .option("--clear <fingerprint>", "remove one entry by fingerprint")
    .option(
      "--retriage <target>",
      "re-prompt entries matching a fingerprint, file, or glob",
    )
    .option("--format <format>", "summary output format: human | json", "human")
    .option("--owner <handle>", "default owner for new dispositions this run")
    .option("--no-color", "disable ANSI colour output")
    .option("--all", "include non-domain tier findings in the walk", false)
    .action(async (path: string | undefined, options: TriageOptions) => {
      const root = resolve(path ?? process.cwd());

      if (options.format !== "human" && options.format !== "json") {
        process.stderr.write(
          `crimes: unknown --format "${String(options.format)}". Expected "human" or "json".\n`,
        );
        process.exit(2);
        return;
      }

      if (options.list) {
        await runList(root, options);
        return;
      }
      if (options.clear !== undefined) {
        await runClear(root, options.clear);
        return;
      }
      if (options.apply !== undefined) {
        await runApply(root, options.apply, options);
        return;
      }

      // Interactive walk requires a TTY. The CI heuristic mirrors npm's
      // `is-ci` shape but accepts the standard "I'm not in CI" override
      // strings — `CI=`, `CI=false`, `CI=0` — so a developer who clears
      // the var locally still gets the prompt.
      if (!process.stdout.isTTY || isCiEnv(process.env)) {
        process.stderr.write(
          "crimes: refusing to start interactive triage in a non-TTY/CI environment. " +
            "Use --apply <file>.\n",
        );
        process.exit(2);
        return;
      }

      await runInteractive(root, options);
    });
}

/**
 * Return true when the environment looks like CI. Treats common
 * "explicitly not CI" overrides (empty / "false" / "0") as not-CI so a
 * developer who clears CI in their shell still gets the interactive
 * prompt locally.
 */
export function isCiEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CI;
  if (typeof raw !== "string") return false;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "" || normalised === "false" || normalised === "0") {
    return false;
  }
  return true;
}

async function runList(root: string, options: TriageOptions): Promise<void> {
  const path = resolveTriagePath(root);
  const triage = await loadTriage(path);
  if (options.format === "json") {
    process.stdout.write(JSON.stringify({ entries: triage.entries }, null, 2) + "\n");
    return;
  }
  if (triage.entries.length === 0) {
    process.stdout.write("No triage entries.\n");
    return;
  }
  for (const e of triage.entries) {
    process.stdout.write(
      `${e.disposition.padEnd(13)}  ${e.fingerprint}\n` +
        `              ${e.reason}\n` +
        `              owner: ${e.owner || "(none)"} · date: ${e.date}\n\n`,
    );
  }
}

async function runClear(root: string, fingerprint: string): Promise<void> {
  const path = resolveTriagePath(root);
  const triage = await loadTriage(path);
  const before = triage.entries.length;
  const baseDoc: Triage =
    triage.document ?? emptyTriage({ crimesVersion: __CRIMES_VERSION__ });
  const next: Triage = {
    schema_version: baseDoc.schema_version,
    report_type: "triage",
    created_at: baseDoc.created_at,
    updated_at: new Date().toISOString(),
    entries: triage.entries.filter((e) => e.fingerprint !== fingerprint),
  };
  if (baseDoc.crimes_version) next.crimes_version = baseDoc.crimes_version;
  if (next.entries.length === before) {
    process.stderr.write(`crimes: no triage entry matched ${fingerprint}.\n`);
    process.exit(1);
    return;
  }
  await saveTriage(path, next, { crimesVersion: __CRIMES_VERSION__ });
  process.stdout.write(`Cleared ${fingerprint}.\n`);
}

async function runApply(
  root: string,
  applyPath: string,
  options: TriageOptions,
): Promise<void> {
  const absoluteApply = isAbsolute(applyPath)
    ? applyPath
    : resolve(process.cwd(), applyPath);
  if (!existsSync(absoluteApply)) {
    process.stderr.write(`crimes: --apply file not found: ${applyPath}\n`);
    process.exit(2);
    return;
  }

  const raw = readFileSync(absoluteApply, "utf8");
  let appliedEntries: TriageEntry[];
  try {
    // The INPUT schema, not the on-disk one: a caller writing
    // dispositions should not have to supply `created_at` or restate a
    // `type` the fingerprint already carries. See `parseTriageInput`.
    appliedEntries = parseTriageInput(raw, applyPath);
  } catch (err) {
    process.stderr.write(
      `crimes: --apply file is malformed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
    return;
  }

  const triagePath = resolveTriagePath(root);
  const existing = await loadTriage(triagePath);
  let doc: Triage =
    existing.document ?? emptyTriage({ crimesVersion: __CRIMES_VERSION__ });
  for (const entry of appliedEntries) {
    doc = upsertTriageEntry(doc, entry);
    // Nothing to ask in the non-interactive path, so `wont-fix` takes
    // the conservative fallback: it records that a human looked and
    // declined to act, without asserting the detector was wrong.
    await recordTriageFeedback({
      root,
      triage: entry,
      explicitVerdict: WONT_FIX_FALLBACK_VERDICT,
    });
  }
  await saveTriage(triagePath, doc, { crimesVersion: __CRIMES_VERSION__ });

  if (options.format === "json") {
    process.stdout.write(JSON.stringify({ applied: appliedEntries.length }) + "\n");
  } else {
    process.stdout.write(
      `Applied ${appliedEntries.length} entries to .crimes/triage.json.\n`,
    );
  }
}

async function runInteractive(root: string, options: TriageOptions): Promise<void> {
  const config = loadConfig(root);
  const report = await scan({ root, config });

  // Filter to tier === "domain" unless --all.
  const findings = options.all
    ? report.findings
    : report.findings.filter((f) => f.tier !== "nonDomain");

  // Drop findings already in triage unless --retriage matches.
  const triagePath = resolveTriagePath(root);
  const existing = await loadTriage(triagePath);
  const existingPrints = new Set(existing.entries.map((e) => e.fingerprint));
  const retriageMatcher = buildRetriageMatcher(options.retriage, existing.entries);

  const queue = findings.filter((f) => {
    const print = fingerprintFinding(f);
    if (!existingPrints.has(print)) return true;
    const existingEntry = existing.entries.find((e) => e.fingerprint === print);
    return retriageMatcher(f, existingEntry);
  });

  if (queue.length === 0) {
    process.stdout.write(
      "No findings to triage. Run `crimes scan` to see what's left.\n",
    );
    return;
  }

  let doc: Triage =
    existing.document ?? emptyTriage({ crimesVersion: __CRIMES_VERSION__ });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let defaultOwner = options.owner ?? gitConfigEmail() ?? "";

  // Walk claim-group by claim-group rather than in rank order. A
  // reviewer builds a judgement from the first few findings they see and
  // applies it to the rest; if the queue interleaves "this test asserts
  // nothing" with "this test asserts weakly", that judgement is being
  // formed across two different questions. Grouping makes the run of
  // findings a reviewer generalises over a homogeneous one, and the
  // banner names what they are generalising about.
  const groups = groupByClaim(queue);
  process.stdout.write(
    `Triaging ${queue.length} findings against ${triagePath}.\n` +
      `${groups.length} claim group${groups.length === 1 ? "" : "s"} — each is one ` +
      "statement, judged on its own.\n" +
      "Keys: f fix-now · p fix-this-PR · d needs-design · w wont-fix · s scaffolding · k skip · q quit\n\n",
  );

  const ordered = groups.flatMap((g) => g.findings);
  const groupOf = new Map<Finding, ClaimGroup>();
  for (const g of groups) for (const f of g.findings) groupOf.set(f, g);
  let announced: ClaimGroup | undefined;

  try {
    for (let i = 0; i < ordered.length; i++) {
      const finding = ordered[i]!;
      const group = groupOf.get(finding)!;
      if (group !== announced) {
        announced = group;
        renderClaimBanner(group, groups.indexOf(group) + 1, groups.length);
      }
      renderFindingHeader(finding, i + 1, ordered.length);

      const key = (await rl.question("  Disposition? ")).trim().toLowerCase();
      if (key === "q") break;
      if (key === "k") {
        process.stdout.write("  · skipped\n\n");
        continue;
      }
      const disposition = DISPOSITION_BY_KEY[key];
      if (!disposition) {
        process.stdout.write(`  · unrecognised key '${key}' — skipping\n\n`);
        continue;
      }

      const reason = (await rl.question("  Reason (one line): ")).trim();
      if (reason === "") {
        process.stdout.write("  · empty reason — skipping (no entry written)\n\n");
        continue;
      }
      const ownerPrompt = defaultOwner
        ? `  Owner [${defaultOwner}]: `
        : "  Owner (optional): ";
      const ownerInput = (await rl.question(ownerPrompt)).trim();
      const owner = ownerInput === "" ? defaultOwner : ownerInput;
      if (ownerInput !== "") defaultOwner = ownerInput;

      const entry = triageEntryFor({ finding, disposition, reason, owner });
      doc = upsertTriageEntry(doc, entry);
      await saveTriage(triagePath, doc, { crimesVersion: __CRIMES_VERSION__ });

      // `wont-fix` is the one disposition that doesn't imply a verdict:
      // it conflates "crimes was wrong" with "crimes was right and we
      // accept it". Ask rather than guess — this is also where the
      // most valuable calibration signal lives.
      let explicitVerdict: FeedbackVerdict | undefined;
      if (verdictForDisposition(disposition) === null) {
        const answer = (await rl.question("  Was crimes wrong here? [y/N]: "))
          .trim()
          .toLowerCase();
        explicitVerdict =
          answer === "y" || answer === "yes" ? "fp" : WONT_FIX_FALLBACK_VERDICT;
      }

      const recorded = await recordTriageFeedback({
        root,
        triage: entry,
        explicitVerdict,
      });
      process.stdout.write(
        `  ✓ ${disposition} · saved.${recorded ? ` feedback: ${recorded}.` : ""}\n\n`,
      );
    }
  } finally {
    rl.close();
  }

  if (options.format === "json") {
    process.stdout.write(JSON.stringify({ entries: doc.entries.length }) + "\n");
  } else {
    process.stdout.write(
      `\nSaved ${doc.entries.length} total entries to .crimes/triage.json.\n`,
    );
  }
}

// ---- helpers (exported for testability) ----

export function buildRetriageMatcher(
  target: string | undefined,
  entries: TriageEntry[],
): (f: Finding, e: TriageEntry | undefined) => boolean {
  if (!target) return () => false;
  if (entries.some((e) => e.fingerprint === target)) {
    return (_f, e) => e?.fingerprint === target;
  }
  const factory = picomatch as unknown as PicomatchFactory;
  const isMatch = factory(target);
  return (f, _e) => f.file === target || isMatch(f.file);
}

export function todayYmd(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${day}`;
}

/**
 * Build the triage entry for one judged finding.
 *
 * Extracted from the interactive walk so it can be tested: the walk
 * itself requires a TTY, so everything it derived was unreachable from
 * the suite and `claim` could have been dropped here without a single
 * test noticing.
 */
export function triageEntryFor(args: {
  finding: Finding;
  disposition: TriageDisposition;
  reason: string;
  owner: string;
  date?: string;
}): TriageEntry {
  const { finding, disposition, reason, owner } = args;
  return {
    fingerprint: fingerprintFinding(finding),
    type: finding.type,
    // Denormalised alongside `type` so a reviewer reading the triage
    // file can tell which of a detector's statements was judged.
    ...(finding.claim ? { claim: finding.claim } : {}),
    file: finding.file,
    ...(finding.symbol ? { symbol: finding.symbol } : {}),
    disposition,
    reason,
    owner,
    date: args.date ?? todayYmd(),
  };
}

interface ClaimGroup {
  type: string;
  claim?: string;
  findings: Finding[];
}

/**
 * Partition the queue into one group per `(type, claim)`, preserving the
 * rank order the scan produced both between groups and inside them.
 *
 * Grouping by `type` alone is what this exists to stop: `weak_test_signal`
 * makes two statements and a reviewer who samples the first and carries
 * the verdict to the rest is answering the wrong question 67 times.
 */
export function groupByClaim(findings: Finding[]): ClaimGroup[] {
  const groups = new Map<string, ClaimGroup>();
  for (const f of findings) {
    const key = `${f.type}/${f.claim ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { type: f.type, ...(f.claim ? { claim: f.claim } : {}), findings: [] };
      groups.set(key, group);
    }
    group.findings.push(f);
  }
  return [...groups.values()];
}

function renderClaimBanner(group: ClaimGroup, index: number, total: number): void {
  const label = group.claim ? `${group.type}/${group.claim}` : group.type;
  const n = group.findings.length;
  process.stdout.write(
    `── claim group ${index}/${total} · ${label} · ${n} finding${n === 1 ? "" : "s"}\n` +
      `   ${group.findings[0]!.summary}\n` +
      (group.claim
        ? "   Every finding below makes this same statement. Other statements " +
          `from ${group.type} are judged in their own group.\n`
        : "") +
      "\n",
  );
}

function renderFindingHeader(f: Finding, index: number, total: number): void {
  const glyph = f.severity === "high" ? "🚨" : f.severity === "medium" ? "⚠️" : "🔎";
  process.stdout.write(
    `[${index}/${total}] ${glyph} ${f.file}\n` +
      `  ${f.charge}${f.symbol ? ` · ${f.symbol}()` : ""}\n` +
      `  ${f.evidence.slice(0, 2).join(" · ")}\n` +
      `  Fix shape: ${f.fix_shape}\n` +
      `  Effort: ${f.effort}\n`,
  );
}

function gitConfigEmail(): string | undefined {
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      encoding: "utf8",
    }).trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the calibration verdict a triage disposition implies.
 *
 * Triage already makes the user look at a finding and commit to a
 * judgement, so the verdict costs nothing extra to capture — it simply
 * wasn't being recorded. `crimes feedback` shipped in 0.11 and had
 * collected nothing in months of real use because it required copying a
 * fingerprint and hand-writing a note.
 *
 * Unlike `crimes feedback --verdict fp`, this deliberately does NOT
 * write a suppression. A triage entry already hides the finding from
 * default output; adding a suppression on top would silence it twice
 * through two different mechanisms, and unpicking that later is worse
 * than the duplication it saves.
 *
 * Best-effort: a feedback write failure must never lose the triage
 * entry, which is the thing the user actually asked for. Returns the
 * verdict recorded, or null when nothing was written.
 */
async function recordTriageFeedback(args: {
  root: string;
  triage: TriageEntry;
  explicitVerdict?: FeedbackVerdict | undefined;
}): Promise<FeedbackVerdict | null> {
  const entry = feedbackEntryFromTriage({
    triage: args.triage,
    crimesVersion: __CRIMES_VERSION__,
    ...(args.explicitVerdict ? { explicitVerdict: args.explicitVerdict } : {}),
  });
  if (!entry) return null;
  try {
    await writeFeedbackEntry(resolveFeedbackPath(args.root), entry);
    return entry.verdict;
  } catch {
    return null;
  }
}
