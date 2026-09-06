// Sync `<repo>/docs/**/*.md` into `apps/website/src/content/docs/` for
// Starlight to consume. The source-of-truth files live at the repo root
// so agents can read them as raw markdown via GitHub; this script just
// duplicates them into the Astro routing tree at build time.
//
// Each source file is parsed for an existing top-level `# Title` so we
// can inject a Starlight `title:` frontmatter without humans needing to
// maintain it twice.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(here, "..");
const repoRoot = resolve(websiteDir, "..", "..");
const sourceDocs = resolve(repoRoot, "docs");
const targetDocs = resolve(websiteDir, "src", "content", "docs");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (extname(entry.name).toLowerCase() === ".md") {
      out.push(full);
    }
  }
  return out;
}

function escapeYamlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractTitle(source, fallback) {
  // The repo's docs follow a `# Title` first-line convention. If that's
  // missing fall back to the file's basename so Starlight still has
  // something to render in the sidebar.
  for (const line of source.split("\n")) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) return m[1]?.trim();
  }
  return fallback;
}

function hasFrontmatter(source) {
  return source.startsWith("---\n");
}

/**
 * Astro Content Layer normalises file paths into slugs by stripping
 * dots and lowercasing. That mangles release pages — `v0.4.0.md` ends
 * up as `v040`. Detect those and emit an explicit `slug:` frontmatter
 * so the URL plan in §11 (`/docs/releases/v0.4.0/`) lands intact.
 */
function explicitSlugFor(relPath) {
  const m = /^releases\/(v\d+\.\d+\.\d+)\.md$/i.exec(relPath);
  if (m) return `releases/${m[1].toLowerCase()}`;
  return undefined;
}

async function emit(sourcePath) {
  const rel = relative(sourceDocs, sourcePath);
  const dest = join(targetDocs, rel);
  await mkdir(dirname(dest), { recursive: true });
  const raw = await readFile(sourcePath, "utf8");
  const slug = explicitSlugFor(rel);
  if (hasFrontmatter(raw)) {
    await writeFile(dest, raw, "utf8");
    return;
  }
  const fallback = rel.replace(/\.md$/i, "").split("/").pop() ?? rel;
  const title = extractTitle(raw, fallback) ?? fallback;
  const lines = raw.split("\n");
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().length === 0) continue;
    if (/^#\s+/.test(lines[i].trim())) {
      bodyStart = i + 1;
      if (lines[bodyStart]?.trim().length === 0) bodyStart += 1;
    }
    break;
  }
  const body = lines.slice(bodyStart).join("\n");
  const frontmatterLines = [`title: "${escapeYamlString(title)}"`];
  if (slug !== undefined) frontmatterLines.push(`slug: "${slug}"`);
  const frontmatter = `---\n${frontmatterLines.join("\n")}\n---\n\n`;
  await writeFile(dest, frontmatter + body, "utf8");
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(sourceDocs))) {
    throw new Error(`sync-docs: source docs directory not found at ${sourceDocs}`);
  }
  await rm(targetDocs, { recursive: true, force: true });
  await mkdir(targetDocs, { recursive: true });
  const files = await walk(sourceDocs);
  for (const f of files) {
    if (relative(sourceDocs, f).startsWith("fixtures/")) continue;
    await emit(f);
  }
  await writeFile(
    join(targetDocs, "index.md"),
    [
      "---",
      'title: "crimes documentation"',
      'description: "How to use the `crimes` CLI: configuration, scoring, finding types, and CI integration."',
      "template: doc",
      "---",
      "",
      "`crimes` is an open-source CLI that scans TypeScript, JavaScript and Python repositories for **change risk** and **agent risk** — the failure modes that linters and security scanners don't cover.",
      "",
      "Pick a starting point:",
      "",
      "- [Command and detector reference](/docs/reference/) — generated from the build.",
      "- [Pin migration](/docs/pin-migration/) — preserve reviewed decisions across identity changes.",
      "- [Agent setup and updates](/docs/skills/) — install once; discover updates during normal use.",
      "- [JSON report types](/docs/api-types/) — generated from the public declarations.",
      "- [Triage](/docs/triage/) — record and revisit risk decisions.",
      "- [Agent usage](/docs/agent-usage/) — how an AI coding agent should invoke `crimes`.",
      "- [Configuration](/docs/configuration/) — `crimes.config.json` reference.",
      "- [Scoring](/docs/scoring/) — what each per-finding score means and how `agent_risk` is computed.",
      "- [CI integration](/docs/ci/) — `--fail-on`, `baseline`, and the diff workflow.",
      "",
      "Or browse by category — finding types are grouped under **Finding types** in the sidebar.",
      "",
      "The raw markdown sources live under [`docs/`](https://github.com/ortomate/crimes/tree/main/docs) so agents that read GitHub directly get the same content.",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`sync-docs: wrote ${files.length} pages to ${targetDocs}`);

  const publicDir = resolve(websiteDir, "public");
  await mkdir(publicDir, { recursive: true });
  await cp(resolve(websiteDir, "landing", "favicon.svg"), join(publicDir, "favicon.svg"));
}

main().catch((err) => {
  process.stderr.write(`sync-docs failed: ${err.message}\n`);
  process.exit(1);
});
