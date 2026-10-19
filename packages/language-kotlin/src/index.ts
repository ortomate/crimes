/**
 * `@crimes/language-kotlin` — the Kotlin language pack.
 *
 * Registration follows `CONTRIBUTING.md` §"Adding a new language". The
 * parsed surface matches the Java pack's, so core's shared detectors and
 * the JVM type resolver serve both languages, including Kotlin calling
 * Java and back. Cheap to import: the grammar loads on the first parse.
 */

export const KOTLIN_EXTENSIONS = [".kt", ".kts"] as const;

export {
  createKotlinParser,
  ensureKotlinParser,
  KotlinGrammarNotFoundError,
  parseKotlinFile,
  resolveKotlinGrammarPath,
} from "./parse/index.js";

export type {
  KotlinCatch,
  KotlinClockRead,
  KotlinFunctionShape,
  KotlinImport,
  KotlinTypeKind,
  ParsedKotlinFile,
  ParsedKotlinFunction,
  ParsedKotlinType,
  ParseKotlinInput,
} from "./parse/types.js";
