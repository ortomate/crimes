import fg from "fast-glob";

/**
 * Locate `.env.example`-style variable inventories.
 *
 * These need their own discovery because the shared `discoverFiles`
 * runs with `dot: false`, and every filename here starts with a dot.
 *
 * ## What is and is not read
 *
 * Only *documented* inventories are globbed: `.env.example`,
 * `.env.sample`, `.env.template`, `.env.defaults`, and their per-package
 * equivalents. A real `.env` is **never** matched, even though it is
 * frequently present and would be the richest source of variable names —
 * because a real `.env` holds real secrets, and a tool that opens it is
 * one bug away from printing them. The exclusion is enforced here, at
 * discovery, rather than downstream where a later change could quietly
 * undo it.
 */

const INVENTORY_GLOBS: readonly string[] = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
  ".env.dist",
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
  "**/.env.defaults",
  "**/.env.dist",
  "env.example",
  "**/env.example",
];

const EXCLUDE: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
];

/**
 * Filenames that must never be read regardless of glob behaviour.
 * A second, independent guard on the same rule — cheap insurance against
 * a future glob edit widening the match.
 */
const FORBIDDEN = /(^|\/)\.env(\.local|\.development|\.production|\.test|\.staging)?$/;

export async function discoverEnvInventoryFiles(root: string): Promise<string[]> {
  const entries = await fg([...INVENTORY_GLOBS], {
    cwd: root,
    ignore: [...EXCLUDE],
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  return entries
    .filter((path) => !FORBIDDEN.test(path.replace(/\\/g, "/")))
    .sort();
}
