import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ignore from "ignore";

/**
 * `.gitattributes` `linguist-generated`, as an input to the
 * never-reportable policy.
 *
 * ## Why this one and not the other three
 *
 * `0.25.3` measured the JavaScript equivalents of `honourToolingExcludes`
 * on hono, cal.com, n8n and posthog and closed them:
 * `.eslintignore` no longer exists (ESLint 9 moved to flat-config
 * `ignores`), root `tsconfig.exclude` names nothing crimes does not
 * already skip, and **zero patterns corroborated on any repo**. See
 * `docs/dogfooding/2026-08-11-tooling-excludes-js.md`.
 *
 * `linguist-generated` came out of that measurement as the one JS signal
 * worth reading, and as a *different kind* of signal:
 *
 * > `.eslintignore`, `.prettierignore` and `tsconfig.exclude` express a
 * > tool's **preferences**. `linguist-generated` is a **provenance
 * > claim** the repository makes about its own file.
 *
 * Preferences need corroborating — n8n's `.prettierignore` ends with a
 * `# Handled by biome` comment followed by a glob covering every `.ts`
 * file, and reading that as a maintenance claim would drop all 18,783
 * of its TypeScript files. Provenance does
 * not: `util/scope-class.ts` already trusts an `@generated` banner or a
 * `DO NOT EDIT` header from a single source, and this is the same
 * assertion written in a different file. **So there is no corroboration
 * rule here, deliberately.**
 *
 * ## What it feeds, and what it deliberately does not
 *
 * The patterns join `isNeverReportable` — the same policy that already
 * drops findings in `__generated__/` and `*_pb2.py`. One policy, one
 * behaviour, no new schema surface.
 *
 * In particular this emits **no `coverage.warnings[]` entry**, matching
 * the existing generated-code policy and unlike `files_excluded_by_tooling`.
 * The distinction is whether the file was read: a tooling-excluded path
 * is never analysed, so silence about it would be a gap the user cannot
 * see past. A generated file *is* analysed and its findings are simply
 * not the team's to fix. `scan.ts` makes the same argument at the filter
 * site — conflating deliberate policy with an accidental skip would make
 * the field that exists to expose silent gaps report an intended one.
 *
 * `linguist-vendored` is **not** read. It appears once across the four
 * corpus repos (`/.yarn/**` in cal.com) against thirty
 * `linguist-generated` entries, and it is a display hint for GitHub's
 * language bar rather than a claim about who wrote the file.
 */

/** One `linguist-generated` path pattern, with the line that declared it. */
export interface GeneratedDeclaration {
  /** The pattern exactly as `.gitattributes` wrote it. */
  pattern: string;
  /** 1-based line in `.gitattributes`, so a reader can find it. */
  line: number;
}

/**
 * Parse `linguist-generated` declarations out of `.gitattributes` text.
 *
 * Git's format is `<pattern> <attr>...`, where an attribute may be
 * negated (`-linguist-generated`) or valued (`linguist-generated=false`).
 * Both of those mean "not generated" and are skipped — honouring a
 * negation as an assertion would invert the file's meaning.
 */
export function parseGeneratedDeclarations(text: string): GeneratedDeclaration[] {
  const out: GeneratedDeclaration[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.split("#")[0]!.trim();
    if (line === "") return;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (!pattern || attrs.length === 0) return;
    const generated = attrs.some(
      (a) => a === "linguist-generated" || a === "linguist-generated=true",
    );
    if (!generated) return;
    out.push({ pattern, line: i + 1 });
  });
  return out;
}

/**
 * A predicate over repo-relative paths for the scan root's
 * `.gitattributes`. Returns a predicate that is always `false` when the
 * file is absent, unreadable, or declares nothing generated — so the
 * caller has no special case.
 *
 * Patterns are matched with the same `ignore` engine the tooling-exclude
 * reader uses, which implements gitignore semantics. `.gitattributes`
 * patterns are close enough to the same grammar for the cases that occur
 * (`dir/**`, `path/to/file.ts`, `*_pb2*.py`); a leading `/` is stripped
 * because it anchors to the repo root, which is where these paths are
 * already relative to.
 */
export function generatedMatcherFor(root: string): (repoPath: string) => boolean {
  let text: string;
  try {
    text = readFileSync(resolve(root, ".gitattributes"), "utf8");
  } catch {
    return () => false;
  }
  const declared = parseGeneratedDeclarations(text);
  if (declared.length === 0) return () => false;

  const ig = ignore();
  for (const d of declared) ig.add(d.pattern.replace(/^\/+/, ""));
  return (repoPath: string): boolean => {
    // `ignore` rejects absolute and parent-relative paths; anything
    // outside the root is not ours to judge.
    if (repoPath === "" || repoPath.startsWith("..") || repoPath.startsWith("/")) {
      return false;
    }
    return ig.ignores(repoPath);
  };
}
