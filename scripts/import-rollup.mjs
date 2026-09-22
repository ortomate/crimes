// Fold the per-machine feedback rollup into a dated calibration note.
//
// `~/.crimes/feedback-rollup.jsonl` accumulates verdicts recorded in
// every repo on this machine (see `~/.crimes/export-rollup.sh`). It is
// deliberately never committed anywhere, which means the calibration
// signal in it never reaches the repo where detectors are changed. This
// script is that return path: it writes what is *new* since the last
// import into `docs/dogfooding/<date>-rollup-import.md` and leaves the
// file uncommitted for a human to triage.
//
// It does not judge. Every entry is a verdict someone else's session
// recorded, usually with a reason attached, and the reason is the
// signal — a run of `fp` notes that all say the same thing is a detector
// to look at, not a set of findings to suppress.
//
// Usage: node scripts/import-rollup.mjs [--check]
//   --check  report what would be imported; write nothing.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkOnly = process.argv.includes("--check");

// Same precedence as `resolveGlobalRollupPath` in packages/core.
const home = process.env.CRIMES_HOME?.length ? process.env.CRIMES_HOME : homedir();
const rollupPath = resolve(home, ".crimes/feedback-rollup.jsonl");
const statePath = resolve(root, ".crimes/rollup-import.json");

if (!existsSync(rollupPath)) {
  process.stdout.write(`No rollup at ${rollupPath} — nothing to import.\n`);
  process.exit(0);
}

const entries = (await readFile(rollupPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim() !== "")
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      // A truncated final line is expected if a write was interrupted.
      return [];
    }
  });

const state = existsSync(statePath)
  ? JSON.parse(await readFile(statePath, "utf8"))
  : { imported_through: null, imports: [] };

const fresh = entries
  .filter((e) => state.imported_through === null || e.timestamp > state.imported_through)
  .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

if (fresh.length === 0) {
  process.stdout.write(
    `Rollup holds ${entries.length} entries; none newer than ${state.imported_through}.\n`,
  );
  process.exit(0);
}

const byKey = (rows, pick) => {
  const map = new Map();
  for (const row of rows) {
    const key = pick(row);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const shortRepo = (path) => path.split("/").filter(Boolean).at(-1) ?? path;
// Local date, not UTC: these notes are filed alongside hand-written ones
// that use the author's own calendar day.
const now = new Date();
const date = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-");
const versions = byKey(fresh, (e) => e.crimes_version ?? "unknown");
const repos = byKey(fresh, (e) => shortRepo(e.repo ?? "unknown"));
const detectors = byKey(fresh, (e) => e.finding_type ?? "unknown");
const verdicts = byKey(fresh, (e) => e.verdict ?? "unknown");

const lines = [];
lines.push(`# Rollup import: ${date}`);
lines.push("");
lines.push(`**Entries:** ${fresh.length} new of ${entries.length} in the rollup`);
lines.push(`**Recorded by:** ${repos.map(([r, c]) => `${r} (${c})`).join(", ")}`);
lines.push(
  `**Produced by crimes:** ${versions.map(([v, c]) => `${v} (${c})`).join(", ")}`,
);
lines.push(`**Verdicts:** ${verdicts.map(([v, c]) => `${v} (${c})`).join(", ")}`);
lines.push("");
lines.push(
  "Untriaged. These are verdicts other sessions recorded in their own",
  "repos, imported mechanically. A verdict is one reader's judgement, not",
  "an established fact about the detector — read the reasons before acting.",
  "A run of `fp` notes that all say the same thing is the signal worth",
  "chasing; a single `fp` usually is not.",
);
lines.push("");
lines.push("## By detector");
lines.push("");
lines.push("| Detector | Entries | Repos |");
lines.push("| --- | --- | --- |");
for (const [detector, count] of detectors) {
  const seen = new Set(
    fresh.filter((e) => e.finding_type === detector).map((e) => shortRepo(e.repo ?? "")),
  );
  lines.push(`| \`${detector}\` | ${count} | ${seen.size} |`);
}
lines.push("");
lines.push("## The reasons");
lines.push("");
for (const [detector] of detectors) {
  lines.push(`### \`${detector}\``);
  lines.push("");
  for (const entry of fresh.filter((e) => e.finding_type === detector)) {
    const repo = shortRepo(entry.repo ?? "unknown");
    lines.push(`- **${entry.verdict}** · ${repo} · \`${entry.fingerprint}\``);
    if (entry.note) lines.push(`  - ${entry.note}`);
    if (entry.resurfaced_from)
      lines.push(`  - resurfaced from a pin on ${entry.resurfaced_from}`);
  }
  lines.push("");
}

const outPath = resolve(root, `docs/dogfooding/${date}-rollup-import.md`);
const summary =
  `${fresh.length} new entries from ${repos.length} repos, ` +
  `${detectors.length} detectors, produced by crimes ${versions.map(([v]) => v).join("/")}`;

if (checkOnly) {
  process.stdout.write(`Would write ${outPath}\n  ${summary}\n`);
  process.exit(0);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, lines.join("\n") + "\n");
state.imported_through = fresh.at(-1).timestamp;
state.imports = [
  ...(state.imports ?? []),
  { date, file: `docs/dogfooding/${date}-rollup-import.md`, entries: fresh.length },
];
await mkdir(dirname(statePath), { recursive: true });
await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
process.stdout.write(`Wrote ${outPath}\n  ${summary}\n`);
