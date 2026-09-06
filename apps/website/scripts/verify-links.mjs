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
for (const [file, html] of contents) {
  // Astro's generated 404 canonical points to a virtual route, not an output file.
  if (file.endsWith("/404.html")) continue;
  const page = "/" + relative(dist, file).replace(/index\.html$/, "");
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
if (failures.size) {
  process.stderr.write(
    `verify-links: ${failures.size} broken internal links\n${[...failures].join("\n")}\n`,
  );
  process.exit(1);
}
console.log(
  `verify-links: internal destinations and anchors verified across ${files.length} pages`,
);
