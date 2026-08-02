// Verify the website build produced HTML for every expected page, and
// that the landing page still describes the tool that exists.
// Used in CI to catch broken sync-docs / Astro-config drift and stale
// release metadata.
//
// Two classes of check live here, and the second is the interesting one:
//
//   1. Release metadata — the advertised version.
//   2. Capability claims — what the page says crimes can *do*.
//
// (1) was added after the version went stale for two consecutive
// releases. It worked: the version has been correct ever since. But it
// guards one field, and by 0.17.0 everything around that field had
// rotted anyway — the hero still said "scans a TypeScript or JavaScript
// repository" three releases after the Python pack shipped, and "what
// it detects today" listed two detector families out of ten.
//
// The lesson is that a version number is the *easiest* thing to
// remember and therefore the least valuable thing to check. So the
// capability checks below derive their expectations from the repo
// itself — the detector registry, the finding-type docs, the language
// packages on disk — and fail when the product grows and the page does
// not. Adding a detector family or a language pack now breaks the
// build until someone writes the sentence that says so.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");
const repoRoot = resolve(here, "..", "..", "..");

/** Collected failures, so one run reports every problem rather than the first. */
const failures = [];
const fail = (message) => failures.push(message);

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
      '  Update "softwareVersion" in apps/website/landing/index.html.\n' +
      "  See docs/releasing.md step 2 (website surfaces).\n",
  );
  process.exit(1);
}
console.log(
  `verify-build: landing page advertises crimes ${pkgVersion} (matches package.json)`,
);

/* ------------------------------------------------------------------ *
 * Capability claims
 * ------------------------------------------------------------------ */

// The hero pill is the first thing on the page and carries its own
// version plus a release-notes link. `softwareVersion` is invisible
// metadata; the pill is what a human reads, and it is the one that sat
// at v0.12.0 while npm served 0.16.0.
const pill = landingHtml.match(
  /<span class="pill">v([0-9]+\.[0-9]+\.[0-9]+)([\s\S]*?)<\/span>/,
);
if (!pill) {
  fail(
    'the hero pill is missing or no longer starts with "v<version>".\n' +
      '  Expected `<span class="pill">v0.0.0 · …</span>` in apps/website/landing/index.html.\n' +
      "  If the hero was redesigned, update this check to match — do not delete it.",
  );
} else {
  if (pill[1] !== pkgVersion) {
    fail(
      `the hero pill reads v${pill[1]}, but packages/cli/package.json is ${pkgVersion}.\n` +
        "  It is the first thing a visitor sees. Update the pill in apps/website/landing/index.html.",
    );
  }
  // A pill that links to five-release-old notes is worse than no link.
  const href = pill[2].match(/href="(\/docs\/releases\/v[^"]+)"/);
  if (href) {
    const page = resolve(distDir, `${href[1].replace(/^\/|\/$/g, "")}/index.html`);
    if (!existsSync(page)) {
      fail(
        `the hero pill links to ${href[1]}, which the build did not produce.\n` +
          "  Add docs/releases/vX.Y.Z.md, or point the pill at notes that exist.",
      );
    } else if (!href[1].includes(`v${pkgVersion}`)) {
      fail(
        `the hero pill links to ${href[1]}, but the current release is v${pkgVersion}.\n` +
          "  Point it at this release's notes.",
      );
    }
  }
}

// Detector families. `docs/finding-types/*.md` is the canonical list —
// a family without a reference page does not exist as far as users are
// concerned. Every one of them must be reachable from the landing
// page, so shipping a family silently is impossible.
const familyDir = resolve(repoRoot, "docs", "finding-types");
const families = readdirSync(familyDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""))
  .sort();

const unlinkedFamilies = families.filter(
  (f) => !landingHtml.includes(`docs/finding-types/${f}.md`),
);
if (unlinkedFamilies.length > 0) {
  fail(
    `${unlinkedFamilies.length} detector famil(y/ies) have a reference page that the ` +
      `landing page never links to:\n    ${unlinkedFamilies.join(", ")}\n` +
      '  Add a row to the family table in the "What it detects today" section naming\n' +
      "  the question that family answers, linking to docs/finding-types/<family>.md.",
  );
}

// The count claim. This is the claim most likely to rot, because it is
// wrong the moment anyone lands a detector — which is exactly why it is
// worth asserting rather than softening to "dozens of detectors".
const core = await import(
  resolve(repoRoot, "packages", "core", "dist", "index.js")
).catch(() => null);
if (!core) {
  fail(
    "could not import packages/core/dist — run `pnpm build` before the website build.\n" +
      "  The detector-count check needs the built registry.",
  );
} else {
  const registered = [...core.builtInDetectors, ...core.builtInAssetDetectors];
  // Distinct *types* is the user-facing number: `commented_out_code`
  // ships in two packs but is one thing a reader sees in `findings[]`.
  const detectorCount = new Set(registered.map((d) => d.id)).size;

  const claim = landingHtml.match(
    /<strong>([0-9]+) detectors across ([a-z]+|[0-9]+) families\.<\/strong>/,
  );
  if (!claim) {
    fail(
      'the landing page no longer carries an "<N> detectors across <M> families" claim.\n' +
        "  That sentence is the anchor for this check. Restore it, or update the check\n" +
        "  to assert whatever replaced it — do not leave the count unguarded.",
    );
  } else {
    const WORDS = {
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      eleven: 11,
      twelve: 12,
      thirteen: 13,
      fourteen: 14,
      fifteen: 15,
    };
    const claimedFamilies = WORDS[claim[2]] ?? Number(claim[2]);
    if (Number(claim[1]) !== detectorCount) {
      fail(
        `the landing page claims ${claim[1]} detectors, but the registry has ` +
          `${detectorCount} distinct types.\n` +
          "  Update the count in apps/website/landing/index.html.",
      );
    }
    if (claimedFamilies !== families.length) {
      fail(
        `the landing page claims ${claim[2]} detector families, but ` +
          `docs/finding-types/ has ${families.length}.\n` +
          "  Update the count in apps/website/landing/index.html.",
      );
    }
  }
}

// Language support. This is the claim that broke worst: the hero said
// "TypeScript or JavaScript" for three releases after `language-py`
// shipped, while the FAQ on the same page said Python. Derived from the
// packages on disk so a new pack cannot land quietly.
//
// A pack with no entry here fails deliberately: adding a language means
// touching this map *and* the page, which is the point.
const LANGUAGE_NAMES = {
  "language-js": ["JavaScript", "TypeScript"],
  "language-py": ["Python"],
};
const packDirs = readdirSync(resolve(repoRoot, "packages")).filter((d) =>
  d.startsWith("language-"),
);
for (const pack of packDirs) {
  const names = LANGUAGE_NAMES[pack];
  if (!names) {
    fail(
      `packages/${pack} is a language pack this check does not know about.\n` +
        "  Add it to LANGUAGE_NAMES in this script, and make sure the landing page\n" +
        "  says crimes supports that language — hero lede, FAQ, and JSON-LD description.",
    );
    continue;
  }
  const unmentioned = names.filter((n) => !landingHtml.includes(n));
  if (unmentioned.length > 0) {
    fail(
      `packages/${pack} ships, but the landing page never mentions ` +
        `${unmentioned.join(" / ")}.\n` +
        "  Update the hero lede and the FAQ so the page claims the languages it supports.",
    );
  }
  // The open-source section lists the packages by name; a language pack
  // missing there reads as "this project is JS-only" to a contributor.
  if (!landingHtml.includes(`packages/${pack}`)) {
    fail(
      `the "Local, open-source, no cloud" section does not list packages/${pack}.\n` +
        "  It enumerates where the code lives; omitting a language pack understates the project.",
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `verify-build: ${failures.length} stale capability claim(s) on the landing page.\n\n` +
      failures.map((f) => `  ✗ ${f}`).join("\n\n") +
      "\n\n  The landing page is a product claim, not decoration. See docs/releasing.md\n" +
      "  step 2 — the website surfaces are part of the release, and these checks exist\n" +
      "  because the checklist line asking for them got skipped.\n",
  );
  process.exit(1);
}
console.log(
  `verify-build: landing page claims match the repo — ` +
    `${families.length} detector families, ${packDirs.length} language pack(s)`,
);
