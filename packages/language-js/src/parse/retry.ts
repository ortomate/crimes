import ts from "typescript";
import {
  calleeLabel,
  calleeName,
  calleeTail,
  condenseSource,
  endLineOf,
  isFunctionLike,
  nearestEnclosingFunction,
  pathTail,
  propertyPath,
  startLineOf,
  stringLiteralText,
  unwrap,
} from "./ast-util.js";
import type {
  MutatingCall,
  ParsedFunction,
  RetrySafeguard,
  RetrySafeguardKind,
  RetrySite,
} from "./types.js";

/**
 * Retry-construct extraction — the parser half of `unsafe_retry`.
 *
 * Retrying a read is free. Retrying a write is a bet that the first
 * attempt didn't land, and when that bet is wrong the customer is charged
 * twice, the order ships twice, or the queue gets a duplicate message
 * nothing downstream is prepared for.
 *
 * The collector finds retry constructs, finds the potentially-mutating
 * work inside them, and inventories the safety controls that *are*
 * present. It does not decide the retry is unsafe — the detector does,
 * and only when the primary control (a stable idempotency or dedup key)
 * is absent.
 *
 * ## Recognised retry constructs
 *
 *  - **loop** — `for` / `while` / `do…while` whose header names an
 *    attempt counter, or whose body catches and `continue`s.
 *  - **helper** — a call to a retry-shaped function (`retry`,
 *    `withRetry`, `pRetry`, `backOff`, `promiseRetry`, `asyncRetry`).
 *  - **recursion** — a function that calls itself from inside a catch.
 *  - **sdk_config** — a `maxRetries` / `retries` / `retryStrategy`
 *    option in an object literal, which is how AWS, Stripe, and
 *    `got`-family clients are configured.
 *
 * A bare `for (const x of xs)` is *not* a retry, and the collector does
 * not pretend otherwise: without an attempt-shaped signal it is ordinary
 * iteration.
 */

const MAX_RETRY_SITES_PER_FILE = 24;

/** Function names that mean "run this again on failure". */
const RETRY_HELPERS: ReadonlySet<string> = new Set([
  "retry",
  "retries",
  "withretry",
  "withretries",
  "pretry",
  "promiseretry",
  "asyncretry",
  "retryable",
  "retrywithbackoff",
  "backoff",
  "backof",
  "exponentialbackoff",
  "retryasync",
  "trywithretry",
  "resilient",
]);

/** Identifier fragments that mark a loop as an attempt loop. */
const ATTEMPT_WORDS = /\b(attempt|attempts|retry|retries|tries|try_count|trycount|maxattempts|maxretries)\b/i;

/** Object-literal keys that configure SDK-level retrying. */
const RETRY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "maxretries",
  "retries",
  "retry",
  "retrystrategy",
  "retrycount",
  "retryconfig",
  "maxattempts",
  "numretries",
  "retrypolicy",
]);

/** HTTP verbs that are not safe to replay blindly. */
const MUTATING_HTTP_METHODS: ReadonlySet<string> = new Set([
  "post",
  "put",
  "patch",
  "delete",
]);

/**
 * Call-name words that mean "this writes something". Shared conceptually
 * with `core`'s domain vocabulary but kept here as a literal set: the
 * parser must not depend on `@crimes/core` (the dependency runs the other
 * way), and duplicating twenty words is cheaper than inverting the
 * layering.
 */
const MUTATING_WORDS: ReadonlySet<string> = new Set([
  "create",
  "insert",
  "update",
  "upsert",
  "delete",
  "destroy",
  "remove",
  "save",
  "write",
  "publish",
  "emit",
  "enqueue",
  "queue",
  "dispatch",
  "send",
  "submit",
  "charge",
  "capture",
  "refund",
  "transfer",
  "pay",
  "commit",
  "provision",
  "register",
  "revoke",
  "grant",
  "increment",
  "decrement",
  "execute",
  "mutate",
  "add",
  "put",
  "post",
  "patch",
  "set",
]);

/** Words that mean a stable de-duplication key is in play. */
const IDEMPOTENCY_WORDS =
  /\b(idempoten\w*|dedup\w*|de_dup\w*|deduplication|requestid|request_id|clienttoken|client_token|nonce|correlationid|correlation_id|messageid|message_id|transactionid|transaction_id|externalid|external_id)\b/i;

/** Header spellings of the same idea. */
const IDEMPOTENCY_HEADERS = /idempotency[-_]?key|x-request-id|x-idempotency/i;

const TRANSACTION_TAILS: ReadonlySet<string> = new Set([
  "transaction",
  "$transaction",
  "withtransaction",
  "runintransaction",
  "intransaction",
  "begintransaction",
  "atomic",
  "withlock",
]);

const DELAY_TAILS: ReadonlySet<string> = new Set([
  "sleep",
  "delay",
  "wait",
  "settimeout",
  "setinterval",
  "pause",
  "backoff",
]);

const DELAY_KEYS = /\b(delay|mintimeout|maxtimeout|waitms|backoff|interval|pause|initialdelay)\b/i;
const JITTER_KEYS = /\bjitter|randomize|randomise\b/i;
const TIMEOUT_KEYS = /\b(timeout|deadline|abortsignal|signal|abortcontroller)\b/i;
const CLASSIFY_KEYS = /\b(shouldretry|isretryable|retryable|retryif|retryon|iserrorretryable)\b/i;

export function collectRetrySite(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: RetrySite[],
): void {
  if (out.length >= MAX_RETRY_SITES_PER_FILE) return;

  if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    collectLoop(node, sourceFile, functions, out);
    return;
  }

  if (ts.isCallExpression(node)) {
    // Mutually exclusive. `withRetry(fn, { retries: 5 })` is *one*
    // construct that matches both shapes — the callee names a retry
    // helper and the options object carries a retry key. Recording it
    // twice would emit two findings at one line with one symbol, which
    // collide on a single fingerprint downstream.
    if (collectHelperCall(node, sourceFile, functions, out)) return;
    collectSdkConfig(node, sourceFile, functions, out);
    return;
  }

  // `new Stripe(key, { maxRetries: 3 })` — clients are usually
  // constructed, not called, so the `new` form is not optional here.
  if (ts.isNewExpression(node)) {
    collectSdkConfig(node, sourceFile, functions, out);
    return;
  }

  if (isFunctionLike(node)) {
    collectRecursiveRetry(node, sourceFile, functions, out);
  }
}

function collectLoop(
  node: ts.ForStatement | ts.WhileStatement | ts.DoStatement,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: RetrySite[],
): void {
  const header = loopHeaderText(node, sourceFile);
  const attemptNamed = ATTEMPT_WORDS.test(header);
  const catchesAndContinues = hasCatchWithContinue(node.statement);

  if (!attemptNamed && !catchesAndContinues) return;

  // A retry site is recorded whether or not the parser recognises a
  // mutation inside it. Deciding that a retry is *safe* is policy, and
  // policy lives in the detector — which also lets a project declare its
  // own mutating calls (`unsafe_retry`'s `mutatingCalls` option) against
  // the `calls` list. Dropping the site here would put that decision
  // out of reach.
  const mutations = collectMutations(node.statement, sourceFile);

  const safeguards = collectSafeguards(node, sourceFile);
  const bound = staticAttemptBound(node, sourceFile);
  if (bound !== undefined) {
    safeguards.push({
      kind: "bounded_attempts",
      evidence: `loop bounded at ${bound} attempt(s)`,
      line: startLineOf(node, sourceFile),
    });
  }

  push(out, {
    kind: "loop",
    construct: attemptNamed
      ? `attempt loop: ${header}`
      : `loop retries after catch: ${header}`,
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    mutations,
    calls: collectCallNames(node.statement),
    safeguards: dedupeSafeguards(safeguards),
    ...(bound !== undefined ? { maxAttempts: bound } : {}),
    ...enclosingName(node, sourceFile, functions),
  });
}

/** Returns true when the call was recognised as a retry helper. */
function collectHelperCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: RetrySite[],
): boolean {
  const rawTail = calleeTail(node);
  if (rawTail === undefined) return false;
  const tail = rawTail.toLowerCase();
  if (!RETRY_HELPERS.has(tail)) return false;

  // The retried work is the callback argument; the options object (when
  // present) is where the safeguards are declared.
  const mutations: MutatingCall[] = [];
  for (const arg of node.arguments) {
    if (isFunctionLike(unwrap(arg))) {
      mutations.push(...collectMutations(unwrap(arg), sourceFile));
    }
  }

  const safeguards = collectSafeguards(node, sourceFile);
  const bound = optionNumber(node, ["retries", "maxRetries", "attempts", "maxAttempts", "numOfAttempts"]);
  if (bound !== undefined) {
    safeguards.push({
      kind: "bounded_attempts",
      evidence: `retry helper bounded at ${bound} attempt(s)`,
      line: startLineOf(node, sourceFile),
    });
  }

  push(out, {
    kind: "helper",
    construct: `retry helper: ${rawTail}(…)`,
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    mutations,
    calls: collectCallNames(node),
    safeguards: dedupeSafeguards(safeguards),
    ...(bound !== undefined ? { maxAttempts: bound } : {}),
    ...enclosingName(node, sourceFile, functions),
  });
  return true;
}

/**
 * `new StripeClient({ maxNetworkRetries: 3 })` — the SDK will replay the
 * request for us. That is a retry the code did not write and cannot see,
 * which is exactly why it is worth recording.
 */
function collectSdkConfig(
  node: ts.CallExpression | ts.NewExpression,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: RetrySite[],
): void {
  for (const arg of node.arguments ?? []) {
    const obj = unwrap(arg);
    if (!ts.isObjectLiteralExpression(obj)) continue;

    let retryKey: string | undefined;
    let bound: number | undefined;
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const key = prop.name.text;
      if (!RETRY_CONFIG_KEYS.has(key.toLowerCase())) continue;
      retryKey = key;
      const init = unwrap(prop.initializer);
      if (ts.isNumericLiteral(init)) bound = Number(init.text);
    }
    if (retryKey === undefined) continue;
    // `retries: 0` disables retrying; nothing to report.
    if (bound === 0) continue;

    const clientName = constructedName(node, sourceFile) ?? "(anonymous)";
    const mutations = collectMutations(node, sourceFile);
    const safeguards = collectSafeguards(node, sourceFile);
    if (bound !== undefined) {
      safeguards.push({
        kind: "bounded_attempts",
        evidence: `${retryKey}: ${bound}`,
        line: startLineOf(node, sourceFile),
      });
    }

    push(out, {
      kind: "sdk_config",
      construct: `client configured with ${retryKey} on ${clientName}(…)`,
      line: startLineOf(node, sourceFile),
      endLine: endLineOf(node, sourceFile),
      mutations,
      calls: [clientName, ...collectCallNames(node)],
      safeguards: dedupeSafeguards(safeguards),
      ...(bound !== undefined ? { maxAttempts: bound } : {}),
      ...enclosingName(node, sourceFile, functions),
    });
    return;
  }
}

/**
 * A function that calls itself from inside a `catch` is a retry loop
 * written recursively — and one that usually forgets a bound.
 */
function collectRecursiveRetry(
  node: ts.SignatureDeclaration,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: RetrySite[],
): void {
  const name = functionName(node);
  if (name === undefined) return;

  const body = (node as { body?: ts.Node }).body;
  if (!body) return;

  let recursesInCatch = false;
  const visit = (n: ts.Node, insideCatch: boolean): void => {
    if (recursesInCatch) return;
    if (ts.isCatchClause(n)) {
      ts.forEachChild(n, (c) => visit(c, true));
      return;
    }
    if (insideCatch && ts.isCallExpression(n)) {
      if (calleeTail(n) === name) {
        recursesInCatch = true;
        return;
      }
    }
    ts.forEachChild(n, (c) => visit(c, insideCatch));
  };
  visit(body, false);
  if (!recursesInCatch) return;

  const mutations = collectMutations(body, sourceFile);
  const safeguards = collectSafeguards(node, sourceFile);
  push(out, {
    kind: "recursion",
    construct: `${name}() calls itself from its catch block`,
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    mutations,
    calls: collectCallNames(body),
    safeguards: dedupeSafeguards(safeguards),
    ...enclosingName(node, sourceFile, functions),
  });
}

/* ------------------------------------------------------------------ *
 * Mutating-call detection
 * ------------------------------------------------------------------ */

/**
 * Potentially-mutating calls inside a region.
 *
 * Two independent signals, both required to be *statically visible*:
 * an HTTP verb that isn't safe to replay, or a callee whose name carries
 * a write-shaped word. A call that matches neither is treated as a read,
 * which is the conservative default — over-reporting retries would make
 * this detector unusable in any codebase with a retry helper.
 */
function collectMutations(node: ts.Node, sourceFile: ts.SourceFile): MutatingCall[] {
  const out: MutatingCall[] = [];
  const seen = new Set<string>();

  const visit = (n: ts.Node): void => {
    if (out.length >= 12) return;
    if (ts.isCallExpression(n)) {
      const mutation = classifyCall(n, sourceFile);
      if (mutation) {
        const key = `${mutation.callee}:${mutation.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(mutation);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function classifyCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): MutatingCall | undefined {
  const callee = calleeLabel(call);
  const rawTail = calleeTail(call);
  if (callee === undefined || rawTail === undefined) return undefined;
  const line = startLineOf(call, sourceFile);
  const tail = rawTail.toLowerCase();

  // `fetch(url, { method: "POST" })`
  if (tail === "fetch") {
    const method = httpMethodFromOptions(call);
    if (method !== undefined && MUTATING_HTTP_METHODS.has(method)) {
      return { callee, line, via: "http", method: method.toUpperCase() };
    }
    return undefined;
  }

  // `axios.post(...)`, `client.put(...)`, `http.delete(...)`
  if (MUTATING_HTTP_METHODS.has(tail) && ts.isPropertyAccessExpression(call.expression)) {
    const receiver = propertyPath(call.expression.expression);
    if (receiver !== undefined && HTTP_RECEIVER_RE.test(pathTail(receiver))) {
      return { callee, line, via: "http", method: tail.toUpperCase() };
    }
  }

  // Name-shaped mutation: `db.orders.insert`, `queue.publish`, `repo.save`.
  for (const word of splitWords(tail)) {
    if (MUTATING_WORDS.has(word)) {
      return { callee, line, via: "call" };
    }
  }
  return undefined;
}

const HTTP_RECEIVER_RE = /^(axios|http|https|client|api|request|fetcher|got|ky|superagent|instance)$/i;

function httpMethodFromOptions(call: ts.CallExpression): string | undefined {
  const options = call.arguments[1];
  if (!options) return undefined;
  const obj = unwrap(options);
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) ? prop.name.text : undefined;
    if (key?.toLowerCase() !== "method") continue;
    const value = stringLiteralText(unwrap(prop.initializer));
    if (value !== undefined) return value.toLowerCase();
  }
  return undefined;
}

/**
 * Every callee invoked inside a region, deduplicated, sorted, and capped.
 * Facts only — no judgement about which of them write.
 */
function collectCallNames(node: ts.Node): string[] {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (names.size >= 32) return;
    if (ts.isCallExpression(n)) {
      const callee = calleeLabel(n);
      if (callee !== undefined) names.add(callee);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...names].sort();
}

/* ------------------------------------------------------------------ *
 * Safeguard detection
 * ------------------------------------------------------------------ */

/**
 * Inventory the safety controls visible at a retry site.
 *
 * "Visible" is the operative word. This is a static reader: a dedup key
 * computed three files away is invisible here, which is why the detector
 * phrases its finding as "no idempotency key is visible at this call
 * site" rather than "this retry is not idempotent".
 */
function collectSafeguards(node: ts.Node, sourceFile: ts.SourceFile): RetrySafeguard[] {
  const out: RetrySafeguard[] = [];

  const record = (kind: RetrySafeguardKind, evidence: string, line: number): void => {
    if (out.length >= 12) return;
    out.push({ kind, evidence, line });
  };

  const visit = (n: ts.Node): void => {
    if (out.length >= 12) return;

    if (ts.isIdentifier(n) && IDEMPOTENCY_WORDS.test(n.text)) {
      record("idempotency_key", `identifier \`${n.text}\``, startLineOf(n, sourceFile));
    }
    if (ts.isPropertyAssignment(n)) {
      const key = ts.isIdentifier(n.name)
        ? n.name.text
        : (stringLiteralText(n.name) ?? "");
      const line = startLineOf(n, sourceFile);
      if (IDEMPOTENCY_WORDS.test(key) || IDEMPOTENCY_HEADERS.test(key)) {
        record("idempotency_key", `option \`${key}\``, line);
      }
      if (DELAY_KEYS.test(key)) record("delay", `option \`${key}\``, line);
      if (JITTER_KEYS.test(key)) record("jitter", `option \`${key}\``, line);
      if (TIMEOUT_KEYS.test(key)) record("timeout", `option \`${key}\``, line);
      if (CLASSIFY_KEYS.test(key)) {
        record("error_classification", `option \`${key}\``, line);
      }
    }
    if (ts.isStringLiteral(n) && IDEMPOTENCY_HEADERS.test(n.text)) {
      record("idempotency_key", `header "${n.text}"`, startLineOf(n, sourceFile));
    }
    if (ts.isCallExpression(n)) {
      const rawTail = calleeTail(n);
      if (rawTail !== undefined) {
        const tail = rawTail.toLowerCase();
        const line = startLineOf(n, sourceFile);
        if (TRANSACTION_TAILS.has(tail)) {
          record("transaction", `\`${rawTail}(…)\``, line);
        }
        if (DELAY_TAILS.has(tail)) {
          record("delay", `\`${rawTail}(…)\``, line);
        }
        if (CLASSIFY_KEYS.test(tail)) {
          record("error_classification", `\`${rawTail}(…)\``, line);
        }
        if (tail === "random" || calleeName(n) === "Math.random") {
          record("jitter", "`Math.random()` in the delay computation", line);
        }
        if (tail === "abortcontroller" || tail === "timeout") {
          record("timeout", `\`${rawTail}(…)\``, line);
        }
      }
    }
    if (ts.isNewExpression(n)) {
      const callee = n.expression.getText(sourceFile);
      if (/AbortController/.test(callee)) {
        record("timeout", "`new AbortController()`", startLineOf(n, sourceFile));
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    ) {
      record(
        "error_classification",
        `\`${condenseSource(n, sourceFile, 60)}\``,
        startLineOf(n, sourceFile),
      );
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function dedupeSafeguards(list: RetrySafeguard[]): RetrySafeguard[] {
  const seen = new Set<string>();
  const out: RetrySafeguard[] = [];
  for (const item of list) {
    const key = `${item.kind}:${item.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  // Stable order so evidence lines don't shuffle between runs.
  return out.sort((a, b) =>
    a.kind === b.kind ? a.evidence.localeCompare(b.evidence) : a.kind.localeCompare(b.kind),
  );
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function push(out: RetrySite[], site: RetrySite): void {
  if (out.length >= MAX_RETRY_SITES_PER_FILE) return;
  out.push(site);
}

function enclosingName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): { enclosing?: string } {
  const fn = nearestEnclosingFunction(node, sourceFile, functions);
  return fn?.name !== undefined ? { enclosing: fn.name } : {};
}

function loopHeaderText(
  node: ts.ForStatement | ts.WhileStatement | ts.DoStatement,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isForStatement(node)) {
    const parts = [
      node.initializer?.getText(sourceFile) ?? "",
      node.condition?.getText(sourceFile) ?? "",
      node.incrementor?.getText(sourceFile) ?? "",
    ];
    return `for (${parts.join("; ").replace(/\s+/g, " ").trim()})`;
  }
  const cond = node.expression.getText(sourceFile).replace(/\s+/g, " ").trim();
  return ts.isWhileStatement(node) ? `while (${cond})` : `do … while (${cond})`;
}

/** Does the loop body catch an error and `continue`? */
function hasCatchWithContinue(body: ts.Statement): boolean {
  let found = false;
  const visit = (n: ts.Node, insideCatch: boolean): void => {
    if (found) return;
    if (ts.isCatchClause(n)) {
      ts.forEachChild(n, (c) => visit(c, true));
      return;
    }
    // A nested function body is a different control-flow scope.
    if (isFunctionLike(n)) return;
    if (insideCatch && ts.isContinueStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, (c) => visit(c, insideCatch));
  };
  visit(body, false);
  return found;
}

/**
 * A statically-known attempt bound: `for (let i = 0; i < 3; i++)` yields
 * 3. Returns `undefined` when the bound is a variable — the loop may
 * still be bounded, just not visibly so.
 */
function staticAttemptBound(
  node: ts.ForStatement | ts.WhileStatement | ts.DoStatement,
  sourceFile: ts.SourceFile,
): number | undefined {
  const condition = ts.isForStatement(node) ? node.condition : node.expression;
  if (!condition || !ts.isBinaryExpression(condition)) return undefined;
  const op = condition.operatorToken.kind;
  const isBoundOp =
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken;
  if (!isBoundOp) return undefined;

  for (const side of [condition.right, condition.left]) {
    const expr = unwrap(side);
    if (ts.isNumericLiteral(expr)) {
      const value = Number(expr.text);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  void sourceFile;
  return undefined;
}

/** Numeric value of the first matching option key across all arguments. */
function optionNumber(call: ts.CallExpression, keys: string[]): number | undefined {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  for (const arg of call.arguments) {
    const obj = unwrap(arg);
    if (!ts.isObjectLiteralExpression(obj)) continue;
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      if (!wanted.has(prop.name.text.toLowerCase())) continue;
      const init = unwrap(prop.initializer);
      if (ts.isNumericLiteral(init)) {
        const value = Number(init.text);
        if (Number.isFinite(value)) return value;
      }
    }
  }
  return undefined;
}

/**
 * Name of the thing being called or constructed, for evidence.
 * `new Stripe(…)` → `new Stripe`; `createClient(…)` → `createClient`.
 */
function constructedName(
  node: ts.CallExpression | ts.NewExpression,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (ts.isNewExpression(node)) {
    const text = node.expression.getText(sourceFile).replace(/\s+/g, " ").trim();
    return text.length > 0 && text.length <= 60 ? `new ${text}` : undefined;
  }
  return calleeLabel(node);
}

function functionName(node: ts.SignatureDeclaration): string | undefined {
  const named = node as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  // `const doThing = async () => {…}` — the name lives on the declaration.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}
