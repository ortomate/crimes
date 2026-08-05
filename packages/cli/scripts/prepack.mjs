// Runs automatically before `npm pack` / `npm publish`.
//
// Why: the published `crimes` package is fully self-contained (everything is
// bundled into dist/index.js by tsup), so devDependencies are dead weight in
// the published manifest — and worse, they contain `workspace:*` refs that
// npm cannot resolve. We strip them here and restore them in postpack.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "..", "package.json");
const backupPath = resolve(here, "..", ".package.json.original");

// If a previous pack failed between prepack and postpack, the backup will
// still exist. Restore from it so we strip from the original each time.
if (existsSync(backupPath)) {
  copyFileSync(backupPath, pkgPath);
}

copyFileSync(pkgPath, backupPath);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
delete pkg.devDependencies;
// Strip every script. None of them run for consumers of the published
// tarball, and the files they reference (./scripts/*.mjs, tsup, vitest, tsc)
// aren't shipped with the package.
//
// The packed manifest must declare *no lifecycle script at all*: npm >= 11.18
// blocks install scripts by default and asks the user to approve arbitrary
// code execution before installing. `crimes` used to spend that prompt on a
// seven-line welcome banner that npm swallowed anyway (see 0.19.0). The smoke
// test asserts this, so a script reintroduced here fails the release.
delete pkg.scripts;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Write to stderr so we don't pollute `npm pack --json` output.
console.error("prepack: stripped devDependencies and scripts from packed package.json");
