import ts from "typescript";
import type { EnclosingFunction, ParsedFunction, SyncIoCall } from "./types.js";

/**
 * Synchronous Node.js I/O API surface. Coverage is intentionally
 * conservative: the names below are the ones that show up in real
 * codebases and that have natural async counterparts the user can
 * reach for. Adding more later is additive (no schema change).
 *
 * Two families:
 *   - `node:fs` `*Sync` methods — file existence, reads, writes,
 *     stats, directory ops.
 *   - synchronous process spawning — `execSync`, `spawnSync`,
 *     `execFileSync`. These block the event loop just like fs sync
 *     calls do, often for far longer.
 */
const SYNC_IO_METHODS: ReadonlySet<string> = new Set([
  // node:fs read / inspect
  "readFileSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "fstatSync",
  "readdirSync",
  "realpathSync",
  "accessSync",
  // node:fs write / mutate
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "mkdtempSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "copyFileSync",
  "renameSync",
  "truncateSync",
  "chmodSync",
  "chownSync",
  "symlinkSync",
  "linkSync",
  "utimesSync",
  // node:fs descriptors
  "openSync",
  "closeSync",
  "readSync",
  "writeSync",
  // child_process sync
  "execSync",
  "spawnSync",
  "execFileSync",
]);

interface CalleeInfo {
  callee: string;
  method: string;
  receiver?: string;
}

/**
 * Identify a sync-I/O call from a CallExpression's `expression`. Returns
 * `undefined` when the call is not in the recognised surface. Accepts
 * two call forms:
 *
 *   - `fs.readFileSync(...)` — property access whose receiver is a bare
 *     identifier. Member chains (`config.fs.readFileSync`) are not
 *     captured because they almost always denote user code, not the
 *     stdlib.
 *   - `readFileSync(...)` — bare identifier, after
 *     `import { readFileSync } from "node:fs"`. The parser cannot tell
 *     a named-import from a same-named local function, so the detector
 *     accepts the false-positive surface from same-named locals.
 */
function extractCallee(expr: ts.Expression): CalleeInfo | undefined {
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const method = expr.name.text;
    if (!SYNC_IO_METHODS.has(method)) return undefined;
    return {
      callee: `${expr.expression.text}.${method}`,
      method,
      receiver: expr.expression.text,
    };
  }
  if (ts.isIdentifier(expr)) {
    const method = expr.text;
    if (!SYNC_IO_METHODS.has(method)) return undefined;
    return { callee: method, method };
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Walk up the AST from a call site, collecting every function-like
 * ancestor. The {@link ParsedFunction} for each is looked up by line
 * range — `collectFunction` was invoked on parents earlier in the
 * depth-first visit, so the entry is always present by the time we
 * reach a child call.
 */
function buildEnclosingChain(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): EnclosingFunction[] {
  const chain: EnclosingFunction[] = [];
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLike(cur)) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(cur.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(cur.getEnd()).line + 1;
      const match = functions.find(
        (f) => f.startLine === startLine && f.endLine === endLine,
      );
      if (match) {
        const entry: EnclosingFunction = {
          shape: match.shape,
          startLine: match.startLine,
          endLine: match.endLine,
        };
        if (match.name !== undefined) entry.name = match.name;
        chain.push(entry);
      }
    }
    cur = cur.parent;
  }
  return chain;
}

export function collectSyncIoCall(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: SyncIoCall[],
): void {
  if (!ts.isCallExpression(node)) return;
  const calleeInfo = extractCallee(node.expression);
  if (!calleeInfo) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const call: SyncIoCall = {
    callee: calleeInfo.callee,
    method: calleeInfo.method,
    line: line + 1,
    enclosingFunctions: buildEnclosingChain(node, sourceFile, functions),
  };
  if (calleeInfo.receiver !== undefined) call.receiver = calleeInfo.receiver;
  out.push(call);
}
