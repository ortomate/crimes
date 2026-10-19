/**
 * `@crimes/language-swift` — the Swift language pack.
 *
 * Registration follows `CONTRIBUTING.md` §"Adding a new language". The
 * parsed surface satisfies core's structured surface, so the shared
 * detectors serve Swift as they do Java and Kotlin. Cheap to import: the
 * grammar loads on the first parse.
 */

export const SWIFT_EXTENSIONS = [".swift"] as const;

export {
  createSwiftParser,
  ensureSwiftParser,
  parseSwiftFile,
  resolveSwiftGrammarPath,
  SwiftGrammarNotFoundError,
} from "./parse/index.js";

export type {
  ParsedSwiftFile,
  ParsedSwiftFunction,
  ParsedSwiftType,
  ParseSwiftInput,
  SwiftCatch,
  SwiftClockRead,
  SwiftFunctionShape,
  SwiftImport,
  SwiftTypeKind,
} from "./parse/types.js";
