// Generate the public report declarations from TypeScript, including referenced
// data types. No second handwritten schema inventory to keep in sync.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(root, "packages/core/src/index.ts");
const configPath = resolve(root, "packages/core/tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error)
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  resolve(root, "packages/core"),
);
const program = ts.createProgram([entry], parsed.options);
const checker = program.getTypeChecker();
const exports = checker.getExportsOfModule(
  checker.getSymbolAtLocation(program.getSourceFile(entry)),
);
const reports = [
  "ScanReport",
  "Finding",
  "ContextReport",
  "HotspotsReport",
  "DiffReport",
  "Baseline",
  "BaselineCheckReport",
  "VerdictReport",
  "ExplainReport",
  "Suppressions",
  "Triage",
  "TriageListReport",
  "TriageApplyReport",
  "TriageClearReport",
  "AuditSuppressionsReport",
  "FeedbackReport",
  "FeedbackRecheckReport",
  "ResurfacedSuppression",
  "PinMigrationPlan",
  "PinMigrationRecoveryReport",
];
const declarations = new Map();
function collect(symbol) {
  if (!symbol) return;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol.declarations?.find(
    (node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
  );
  if (
    !declaration ||
    !declaration.getSourceFile().fileName.startsWith(resolve(root, "packages/core/src"))
  )
    return;
  if (declarations.has(symbol.name)) return;
  declarations.set(symbol.name, { symbol, declaration });
  function visit(node) {
    if (ts.isIdentifier(node)) collect(checker.getSymbolAtLocation(node));
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(declaration, visit);
}
for (const name of reports) {
  const symbol = exports.find((candidate) => candidate.name === name);
  if (!symbol) throw new Error(`Public report export missing: ${name}`);
  collect(symbol);
}
const printer = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});
const ordered = [
  ...reports,
  ...[...declarations.keys()].filter((name) => !reports.includes(name)).sort(),
];
const blocks = ordered.map((name) => {
  const { declaration, symbol } = declarations.get(name);
  const expanded = ts.transform(declaration, [
    (context) => {
      const visit = (node) =>
        ts.isTypeQueryNode(node)
          ? checker.typeToTypeNode(
              checker.getTypeFromTypeNode(node),
              undefined,
              ts.NodeBuilderFlags.NoTruncation,
            )
          : ts.visitEachChild(node, visit, context);
      return (node) => ts.visitNode(node, visit);
    },
  ]);
  const text = ts.isTypeAliasDeclaration(declaration)
    ? `export type ${name} = ${checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)};`
    : printer.printNode(
        ts.EmitHint.Unspecified,
        expanded.transformed[0],
        declaration.getSourceFile(),
      );
  expanded.dispose();
  return {
    name,
    source: relative(root, declaration.getSourceFile().fileName),
    code: text.replace(/import\("[^"]+"\)\./g, ""),
  };
});
// Check the assembled declarations independently: unresolved references or
// accidental runtime-only dependencies must fail docs generation.
const virtualFile = resolve(root, "__crimes_api_types__.ts");
const source = blocks.map((block) => block.code).join("\n");
const host = ts.createCompilerHost(parsed.options);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
  file === virtualFile
    ? ts.createSourceFile(file, source, languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreate);
const check = ts.createProgram(
  [virtualFile],
  { ...parsed.options, noEmit: true, rootDir: root },
  host,
);
const errors = ts.getPreEmitDiagnostics(check);
if (errors.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
const markdown = `# JSON report types

Generated from the public TypeScript declarations by \`pnpm docs:generate\`.
\`pnpm verify\` checks for drift and type-checks these declarations together.
Read [JSON interpretation and compatibility](./json-schema.md) before consuming
reports. This is a type reference, not a runtime validator or an npm TypeScript SDK.
Optional fields may be absent; saved decision files can accept older schema versions.

${blocks.map((block) => `## ${block.name}\n\n[Source](https://github.com/ortomate/crimes/blob/main/${block.source}).\n\n\`\`\`ts\n${block.code}\n\`\`\``).join("\n\n")}
`;
const target = resolve(root, "docs/api-types.md");
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8").catch(() => "")) !== markdown)
    throw new Error("docs/api-types.md is stale; run pnpm docs:generate");
} else await writeFile(target, markdown);
