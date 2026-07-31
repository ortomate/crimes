// Verify the website build produced HTML for every expected page, and
// that the landing page's advertised version matches what we publish.
// Used in CI to catch broken sync-docs / Astro-config drift and stale
// release metadata.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");
const repoRoot = resolve(here, "..", "..", "..");

const required = [
  "index.html",
  "docs/index.html",
  "docs/agent-usage/index.html",
  "docs/configuration/index.html",
  "docs/scoring/index.html",
  "docs/ci/index.html",
  "docs/suppressions/index.html",
  "docs/explain/index.html",
  "docs/json-schema/index.html",
  "docs/skills/index.html",
  "docs/releasing/index.html",
  "docs/feedback/index.html",
  "docs/evals/index.html",
  "docs/finding-types/ia/index.html",
  "docs/finding-types/petty/index.html",
  "docs/releases/v0.4.0/index.html",
  "docs/releases/v0.5.0/index.html",
  "docs/releases/v0.6.0/index.html",
  "docs/releases/v0.7.0/index.html",
];

const missing = required.filter((p) => !existsSync(resolve(distDir, p)));
if (missing.length > 0) {
  process.stderr.write(`verify-build: missing pages\n  ${missing.join("\n  ")}\n`);
  process.exit(1);
}
console.log(`verify-build: all ${required.length} expected docs pages present`);

// The landing page carries a JSON-LD SoftwareApplication block whose
// `softwareVersion` is what Google and AI answer surfaces read as "the
// current version of crimes". It is the one piece of release metadata
// on the site that is neither generated from `docs/` nor pulled live
// from npm, so nothing caught it drifting.
//
// It went stale for two consecutive releases — the site advertised
// 0.12.0 while npm served 0.14.0 — because the release checklist said
// no per-release `index.html` edit was needed. A checklist line that
// gets skipped twice is not a control; this is.
const landingHtml = readFileSync(resolve(distDir, "index.html"), "utf8");
const pkgVersion = JSON.parse(
  readFileSync(resolve(repoRoot, "packages", "cli", "package.json"), "utf8"),
).version;

const match = landingHtml.match(/"softwareVersion"\s*:\s*"([^"]+)"/);
if (!match) {
  process.stderr.write(
    'verify-build: landing page has no JSON-LD "softwareVersion" field.\n' +
      "  Expected it in the SoftwareApplication block in apps/website/landing/index.html.\n",
  );
  process.exit(1);
}
if (match[1] !== pkgVersion) {
  process.stderr.write(
    `verify-build: landing page advertises crimes ${match[1]}, ` +
      `but packages/cli/package.json is ${pkgVersion}.\n` +
      "  Update \"softwareVersion\" in apps/website/landing/index.html.\n" +
      "  See docs/releasing.md step 2 (website surfaces).\n",
  );
  process.exit(1);
}
console.log(`verify-build: landing page advertises crimes ${pkgVersion} (matches package.json)`);
