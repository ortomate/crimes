import { extname } from "node:path";
import type { Pack } from "../pack.js";

/**
 * Default extensions claimed by the JS pack. Exported for reuse — the
 * scan orchestrator references the same list when computing the
 * `coverage` block in `ScanReport` (Task 7.2).
 */
export const JS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".cts",
  ".mts",
] as const;

/**
 * Router that answers "does pack P claim file F?" Built once per scan
 * and threaded through the orchestrator. Each language pack registers
 * its claimed extensions at module-load time; the universal pack
 * doesn't appear here because it claims every file unconditionally.
 */
export interface LanguagePackRouter {
  claims(pack: Pack, absolutePath: string): boolean;
  claimingPack(absolutePath: string): Pack | undefined;
  /**
   * Language packs registered for this scan, in registration order.
   * Excludes `universal` — the universal pack claims every file and
   * never registers extensions. Callers that report which packs *ran*
   * (e.g. `ScanReport.coverage.packs_loaded`) must add it back.
   */
  registeredPacks(): readonly Pack[];
}

const packExtensions = new Map<Pack, Set<string>>();

// Seed defaults — JS pack always present in core.
packExtensions.set("language-js", new Set<string>(JS_EXTENSIONS));

/**
 * Idempotently register a pack's extension claim list. Subsequent calls
 * with the same pack id replace the previous set (not merge) so a pack
 * can shrink its claim during testing.
 */
export function registerPackExtensions(pack: Pack, extensions: readonly string[]): void {
  packExtensions.set(pack, new Set(extensions.map((e) => e.toLowerCase())));
}

export function resolveLanguagePackRouter(): LanguagePackRouter {
  // Snapshot the current registration so the returned router is stable
  // for the duration of one scan even if a test re-registers mid-flight.
  const snapshot = new Map<Pack, Set<string>>();
  for (const [pack, exts] of packExtensions) {
    snapshot.set(pack, new Set(exts));
  }

  return {
    claims(pack, absolutePath) {
      const ext = extname(absolutePath).toLowerCase();
      return snapshot.get(pack)?.has(ext) ?? false;
    },
    claimingPack(absolutePath) {
      const ext = extname(absolutePath).toLowerCase();
      for (const [pack, exts] of snapshot) {
        if (exts.has(ext)) return pack;
      }
      return undefined;
    },
    registeredPacks() {
      return [...snapshot.keys()];
    },
  };
}
