/**
 * `@crimes/language-java` — the Java language pack.
 *
 * Third pack after `language-js` and `language-py`. Registration follows
 * `CONTRIBUTING.md` §"Adding a new language": core seeds the router from
 * {@link JAVA_EXTENSIONS}, and coverage picks the pack up from there.
 *
 * Cheap to import. The tree-sitter runtime and grammar load only when the
 * first `.java` file is parsed, so a repo with no Java pays nothing.
 */

export const JAVA_EXTENSIONS = [".java"] as const;

export {
  ensureJavaParser,
  JavaGrammarNotFoundError,
  parseJavaFile,
  resolveJavaGrammarPath,
} from "./parse/index.js";
export {
  buildJavaTypeIndex,
  resolveJavaReferences,
  type JavaFileTypesInput,
  type JavaResolvedEdge,
  type JavaTypeIndex,
} from "./imports/resolve.js";

export type {
  JavaCatch,
  JavaClockRead,
  JavaImport,
  JavaMethodShape,
  JavaTypeKind,
  ParsedJavaFile,
  ParsedJavaMethod,
  ParsedJavaType,
  ParseJavaInput,
} from "./parse/types.js";
