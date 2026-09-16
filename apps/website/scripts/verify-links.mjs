import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory()
      ? htmlFiles(path)
      : entry.name.endsWith(".html")
        ? [path]
        : [];
  });
}
const files = htmlFiles(dist);
const contents = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
const failures = new Set();
const hosting = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
);
const canonicals = new Set();
for (const [file, html] of contents) {
  // Astro's generated 404 canonical points to a virtual route, not an output file.
  if (file.endsWith("/404.html")) continue;
  const page = "/" + relative(dist, file).replace(/index\.html$/, "");
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/);
  const expected = `https://crimes.sh${page}`;
  if (canonical?.[1] !== expected) {
    failures.add(`${page} (canonical must be ${expected})`);
  } else {
    canonicals.add(expected);
  }
  // Static directory pages, their canonicals and the host must agree.
  // Otherwise Vercel redirects every URL advertised by the sitemap.
  if (page !== "/" && hosting.trailingSlash !== page.endsWith("/")) {
    failures.add(`${page} (canonical conflicts with Vercel trailingSlash)`);
  }
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1].replaceAll("&amp;", "&");
    const url = new URL(href, `https://crimes.sh${page}`);
    if (url.origin !== "https://crimes.sh") continue;
    const path = resolve(dist, "." + decodeURIComponent(url.pathname));
    const target =
      existsSync(path) && statSync(path).isDirectory()
        ? resolve(path, "index.html")
        : path;
    if (!existsSync(target)) {
      failures.add(`${page} → ${href} (missing page/file)`);
    } else if (url.hash && target.endsWith(".html")) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!(contents.get(target) ?? "").includes(`id="${id}"`))
        failures.add(`${page} → ${href} (missing anchor)`);
    }
  }
}

// Follow exactly the sitemap tree advertised to crawlers in robots.txt.
const robots = readFileSync(resolve(dist, "robots.txt"), "utf8");
const pending = [...robots.matchAll(/^Sitemap:\s*(\S+)/gm)].map((m) => m[1]);
const visited = new Set();
const listed = new Set();
if (!pending.length) failures.add("robots.txt has no sitemap declarations");
while (pending.length) {
  const location = pending.pop();
  if (visited.has(location)) continue;
  visited.add(location);
  const url = new URL(location);
  const path = resolve(dist, "." + decodeURIComponent(url.pathname));
  if (url.origin !== "https://crimes.sh" || !existsSync(path)) {
    failures.add(`${location} (missing or external sitemap)`);
    continue;
  }
  const xml = readFileSync(path, "utf8");
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (!locations.length) failures.add(`${location} (empty sitemap)`);
  if (xml.includes("<sitemapindex")) {
    pending.push(...locations);
  } else {
    for (const entry of locations) {
      listed.add(entry);
      if (!canonicals.has(entry))
        failures.add(`${entry} (sitemap URL has no matching canonical page)`);
    }
  }
}
for (const canonical of canonicals) {
  if (!listed.has(canonical)) failures.add(`${canonical} (missing from sitemaps)`);
}
if (failures.size) {
  process.stderr.write(
    `verify-links: ${failures.size} link/indexing failures\n${[...failures].join("\n")}\n`,
  );
  process.exit(1);
}
console.log(
  `verify-links: destinations and anchors verified across ${files.length} pages; ` +
    `${canonicals.size} canonical URLs match hosting and advertised sitemaps`,
);
