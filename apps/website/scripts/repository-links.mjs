import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceDocs = resolve(repoRoot, "docs");
const contentDocs = resolve(repoRoot, "apps/website/src/content/docs");

/** Markdown sources work on GitHub; rendered links must target site routes. */
export function remarkRepositoryLinks() {
  return (tree, file) => {
    const source = resolve(sourceDocs, relative(contentDocs, file.path));
    function visit(node) {
      if (
        ["link", "image", "definition"].includes(node.type) &&
        typeof node.url === "string"
      ) {
        const url = node.url;
        if (url && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url)) {
          const [path, fragment] = url.split("#", 2);
          const target = resolve(dirname(source), decodeURIComponent(path));
          const docPath = relative(sourceDocs, target).split(sep).join("/");
          const suffix = fragment ? `#${fragment}` : "";
          if (
            !docPath.startsWith("../") &&
            docPath.endsWith(".md") &&
            !docPath.startsWith("fixtures/")
          ) {
            const stem = docPath.slice(0, -3);
            const slug = /^releases\/v\d+\.\d+\.\d+$/.test(stem)
              ? stem
              : stem.toLowerCase().replaceAll(".", "");
            node.url = `/docs/${slug === "index" ? "" : slug + "/"}${suffix}`;
          } else {
            const repositoryPath = relative(repoRoot, target).split(sep).join("/");
            if (!repositoryPath.startsWith("../")) {
              const kind =
                existsSync(target) && statSync(target).isDirectory() ? "tree" : "blob";
              node.url = `https://github.com/ortomate/crimes/${kind}/main/${repositoryPath}${suffix}`;
            }
          }
        }
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}
