import { readFile, stat } from "node:fs/promises";
import { extname, relative, sep } from "node:path";

/**
 * File the universal pack reasons about. Carries metadata that is cheap
 * (path, extension, byte size from `stat`) eagerly, and source bytes
 * lazily-cached behind `readSource()` so detectors that only need
 * filename or stat info never open the file.
 *
 * Mirrors the shape of `AssetDetectorContext` (lazy `read()` and
 * pre-stat'd size) — asset detectors fold into the universal pack in
 * 0.12.0.
 */
export interface UniversalFile {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Lowercase extension including the leading dot (e.g. `".ts"`, `""` if none). */
  extension: string;
  /** Byte size from `fs.stat().size`. */
  byteSize: number;
  /** Lazy, per-file-cached source read. Subsequent calls return the same buffer. */
  readSource(): Promise<string>;
  /**
   * Newline-counted line count. Reads the cached source — call
   * `readSource()` at least once before accessing, otherwise throws.
   */
  readonly lineCount: number;
}

export async function buildUniversalFile(args: {
  root: string;
  absolutePath: string;
}): Promise<UniversalFile> {
  const stats = await stat(args.absolutePath);
  const file = relative(args.root, args.absolutePath).split(sep).join("/");
  const extension = extname(args.absolutePath).toLowerCase();

  let cached: string | undefined;
  let cachedLines: number | undefined;
  const readSource = async (): Promise<string> => {
    if (cached !== undefined) return cached;
    cached = await readFile(args.absolutePath, "utf8");
    return cached;
  };

  return {
    file,
    absolutePath: args.absolutePath,
    extension,
    byteSize: stats.size,
    readSource,
    get lineCount(): number {
      if (cachedLines !== undefined) return cachedLines;
      if (cached === undefined) {
        throw new Error(
          "UniversalFile.lineCount accessed before readSource() — " +
            "await uf.readSource() before reading lineCount.",
        );
      }
      cachedLines = cached.split("\n").length;
      return cachedLines;
    },
  };
}
