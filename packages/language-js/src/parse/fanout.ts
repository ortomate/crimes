import ts from "typescript";
import {
  calleeLabel,
  calleeName,
  calleeTail,
  condenseSource,
  endLineOf,
  isFunctionLike,
  nearestEnclosingFunction,
  propertyPath,
  resolveLocalBinding,
  startLineOf,
  unwrap,
} from "./ast-util.js";
import type { FanOutBound, FanOutSite, FanOutWork, ParsedFunction } from "./types.js";

/**
 * Concurrent fan-out extraction — the parser half of
 * `unbounded_async_fanout`.
 *
 * `await Promise.all(orders.map(chargeCustomer))` is the most natural
 * thing to write and one of the easiest ways to take down a dependency.
 * With ten orders it is fine. With the ten thousand a backfill produces
 * it opens ten thousand sockets, and the failure lands on whatever the
 * callback talks to rather than on the code that wrote it.
 *
 * The collector records three things per site: where the collection came
 * from, what the callback does per element, and which bounds are visible.
 * All three are needed — a fan-out over a literal three-element array is
 * not a finding no matter what the callback does, and a fan-out over a
 * database result set is not a finding if the callback is pure.
 */

const MAX_FANOUT_SITES_PER_FILE = 24;

/**
 * A statically-sized collection at or below this length is bounded by
 * construction. Chosen to comfortably cover the "kick off three
 * independent lookups" pattern that `Promise.all` exists for.
 */
const STATICALLY_SMALL = 8;

const CONCURRENCY_LIBRARIES: ReadonlySet<string> = new Set([
  "pmap",
  "pall",
  "plimit",
  "pqueue",
  "pmaplimit",
  "maplimit",
  "eachlimit",
  "parallellimit",
  "bottleneck",
  "semaphore",
  "withconcurrency",
  "asyncpool",
  "promisepool",
  "batchprocess",
  "chunked",
  "inbatches",
]);

const BATCH_TAILS: ReadonlySet<string> = new Set([
  "chunk",
  "chunks",
  "batch",
  "batches",
  "slice",
  "take",
  "partition",
  "paginate",
]);

const CONCURRENCY_OPTION_KEYS =
  /\b(concurrency|limit|maxconcurrency|parallel|poolsize|batchsize|chunksize)\b/i;

export function collectFanOutSite(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
  out: FanOutSite[],
): void {
  if (out.length >= MAX_FANOUT_SITES_PER_FILE) return;
  if (!ts.isCallExpression(node)) return;

  const callee = calleeName(node);
  if (callee !== "Promise.all" && callee !== "Promise.allSettled") return;

  const arg = node.arguments[0];
  if (!arg) return;
  const argument = unwrap(arg);

  const source = describeCollection(argument, sourceFile);
  if (source === undefined) return;

  // Bounds can live on the fan-out expression itself (`.slice(0, 10)`)
  // *or* on the statement that produced the collection
  // (`findMany({ take: 50 })`). Both are visible to a reader, so both
  // count — see `resolveLocalBinding` for why the second is a hint.
  const bounds = collectBounds(argument, sourceFile);
  if (source.producerNode !== undefined) {
    for (const bound of collectBounds(source.producerNode, sourceFile)) {
      if (!bounds.some((b) => b.kind === bound.kind && b.evidence === bound.evidence)) {
        bounds.push(bound);
      }
    }
  }

  const site: FanOutSite = {
    kind: callee === "Promise.all" ? "promise_all" : "promise_all_settled",
    line: startLineOf(node, sourceFile),
    endLine: endLineOf(node, sourceFile),
    collection: source.rendered,
    collectionSource: source.origin,
    staticallyBounded: source.staticallyBounded,
    work: source.callback ? collectWork(source.callback, sourceFile) : [],
    bounds: sortBounds(bounds),
    ...(source.staticSize !== undefined ? { staticSize: source.staticSize } : {}),
    ...(source.producer !== undefined ? { producer: source.producer } : {}),
    ...enclosingName(node, sourceFile, functions),
  };
  out.push(site);
}

interface CollectionInfo {
  rendered: string;
  origin: FanOutSite["collectionSource"];
  staticallyBounded: boolean;
  staticSize?: number;
  producer?: string;
  /** AST node that produced the collection, for bound scanning. */
  producerNode?: ts.Node;
  /** Callback node whose body is the per-element work. */
  callback?: ts.Node;
}

/**
 * Describe the argument handed to `Promise.all`.
 *
 * Three shapes matter:
 *  - `xs.map(fn)` — the classic. The receiver is the collection and `fn`
 *    is the per-element work.
 *  - `[a(), b(), c()]` — an array literal. Statically bounded; the size
 *    is recorded so the detector can skip it.
 *  - `promises` — an identifier. The collection is opaque here; the
 *    detector falls back to whatever the surrounding scope reveals.
 */
function describeCollection(
  argument: ts.Expression,
  sourceFile: ts.SourceFile,
): CollectionInfo | undefined {
  if (ts.isArrayLiteralExpression(argument)) {
    const hasSpread = argument.elements.some((e) => ts.isSpreadElement(e));
    return {
      rendered: `array literal with ${argument.elements.length} element(s)`,
      origin: "literal",
      // A spread (`[...xs]`) makes the literal's size a runtime property.
      staticallyBounded: !hasSpread && argument.elements.length <= STATICALLY_SMALL,
      ...(hasSpread ? {} : { staticSize: argument.elements.length }),
    };
  }

  if (ts.isCallExpression(argument)) {
    const tail = calleeTail(argument);
    if (tail === "map" || tail === "flatMap") {
      const receiver = ts.isPropertyAccessExpression(argument.expression)
        ? unwrap(argument.expression.expression)
        : undefined;
      const callback = argument.arguments[0] ? unwrap(argument.arguments[0]) : undefined;
      const receiverInfo = receiver
        ? describeReceiver(receiver, sourceFile)
        : { origin: "unknown" as const, rendered: "…", staticallyBounded: false };

      return {
        rendered: `${receiverInfo.rendered}.${tail}(…)`,
        origin: receiverInfo.origin,
        staticallyBounded: receiverInfo.staticallyBounded,
        ...(receiverInfo.staticSize !== undefined
          ? { staticSize: receiverInfo.staticSize }
          : {}),
        ...(receiverInfo.producer !== undefined
          ? { producer: receiverInfo.producer }
          : {}),
        ...(receiverInfo.producerNode !== undefined
          ? { producerNode: receiverInfo.producerNode }
          : {}),
        ...(callback && isFunctionLike(callback) ? { callback } : {}),
      };
    }
    return undefined;
  }

  if (ts.isIdentifier(argument)) {
    return {
      rendered: argument.text,
      origin: "unknown",
      staticallyBounded: false,
    };
  }

  return undefined;
}

interface ReceiverInfo {
  rendered: string;
  origin: NonNullable<FanOutSite["collectionSource"]>;
  staticallyBounded: boolean;
  staticSize?: number;
  producer?: string;
  producerNode?: ts.Node;
}

function describeReceiver(
  receiver: ts.Expression,
  sourceFile: ts.SourceFile,
): ReceiverInfo {
  if (ts.isArrayLiteralExpression(receiver)) {
    const hasSpread = receiver.elements.some((e) => ts.isSpreadElement(e));
    return {
      rendered: `[${receiver.elements.length} literal element(s)]`,
      origin: "literal",
      staticallyBounded: !hasSpread && receiver.elements.length <= STATICALLY_SMALL,
      ...(hasSpread ? {} : { staticSize: receiver.elements.length }),
    };
  }

  // `(await db.orders.findMany()).map(…)` — the strongest "runtime-sized"
  // signal there is: the collection came from outside the process.
  if (ts.isAwaitExpression(receiver)) {
    const inner = unwrap(receiver.expression);
    const producer = ts.isCallExpression(inner) ? calleeLabel(inner) : undefined;
    return {
      rendered: condenseSource(receiver, sourceFile, 60),
      origin: "await_call",
      staticallyBounded: false,
      producerNode: receiver,
      ...(producer !== undefined ? { producer } : {}),
    };
  }

  if (ts.isCallExpression(receiver)) {
    const producer = calleeLabel(receiver);
    // `xs.slice(0, 10).map(…)` — bounded by the slice, which
    // `collectBounds` records from the same subtree.
    return {
      rendered: condenseSource(receiver, sourceFile, 60),
      origin: "await_call",
      staticallyBounded: false,
      producerNode: receiver,
      ...(producer !== undefined ? { producer } : {}),
    };
  }

  // A bare identifier: look one hop back for what it was bound to. The
  // canonical shape is `const orders = await db.orders.findMany()`
  // followed by `Promise.all(orders.map(…))`, and refusing to look would
  // classify the most common real-world fan-out as "unknown".
  if (ts.isIdentifier(receiver)) {
    const bound = resolveLocalBinding(receiver.text, receiver);
    if (bound !== undefined) {
      const resolved = describeReceiver(unwrap(bound), sourceFile);
      return {
        ...resolved,
        rendered: `${receiver.text} (← ${resolved.rendered})`,
      };
    }
    return {
      rendered: receiver.text,
      origin: "parameter",
      staticallyBounded: false,
    };
  }

  const path = propertyPath(receiver);
  if (path !== undefined) {
    return {
      rendered: path,
      origin: "property",
      staticallyBounded: false,
    };
  }

  return {
    rendered: condenseSource(receiver, sourceFile, 40),
    origin: "unknown",
    staticallyBounded: false,
  };
}

/* ------------------------------------------------------------------ *
 * Per-element work classification
 * ------------------------------------------------------------------ */

const NETWORK_TAILS =
  /^(fetch|request|get|post|put|patch|del|delete|head|send|query|graphql|call|invoke)$/i;
const NETWORK_RECEIVERS =
  /^(axios|http|https|client|api|fetcher|got|ky|superagent|gql|apollo)$/i;
const DATABASE_TAILS =
  /^(find|findone|findmany|findunique|findfirst|create|createmany|update|updatemany|upsert|delete|deletemany|insert|select|aggregate|count|exec|raw|transaction|save)$/i;
const DATABASE_RECEIVERS =
  /^(db|prisma|knex|sequelize|mongoose|pool|conn|connection|client|repo|repository|collection|model|table)$/i;
const FILESYSTEM_TAILS =
  /^(readfile|writefile|appendfile|readdir|stat|lstat|mkdir|rm|rmdir|unlink|copyfile|rename|open|createreadstream|createwritestream)$/i;
const SUBPROCESS_TAILS = /^(exec|execfile|spawn|fork|execa|run)$/i;
/**
 * Subprocess callees unambiguous enough to classify without a receiver.
 * `exec` and `run` are deliberately absent — a bare `run(x)` is far more
 * often a domain function than a shell.
 */
const BARE_SUBPROCESS_TAILS =
  /^(execa|execaSync|execaCommand|spawnSync|execSync|execFileSync)$/;
const QUEUE_TAILS = /^(publish|enqueue|send|sendmessage|produce|emit|dispatch|push)$/i;
const QUEUE_RECEIVERS =
  /^(queue|kafka|sqs|sns|pubsub|producer|bus|broker|rabbit|redis|stream)$/i;

/**
 * What does the callback do per element?
 *
 * Only calls are inspected. An expensive pure transform is real but not
 * something a static reader can identify without guessing, and guessing
 * here would put "you mapped over an array" findings in front of users.
 */
function collectWork(callback: ts.Node, sourceFile: ts.SourceFile): FanOutWork[] {
  const out: FanOutWork[] = [];
  const seen = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (out.length >= 10) return;
    if (ts.isCallExpression(node)) {
      const kind = classifyWork(node);
      if (kind !== undefined) {
        const callee = calleeName(node) ?? "(anonymous call)";
        const key = `${kind}:${callee}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ kind, callee, line: startLineOf(node, sourceFile) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return out;
}

function classifyWork(call: ts.CallExpression): FanOutWork["kind"] | undefined {
  const tail = calleeTail(call);
  if (tail === undefined) return undefined;

  // Every segment of the receiver is a candidate: `db.orders.findUnique`
  // has the meaningful word at the *root* (`db`), while `queue.publish`
  // has it adjacent. Testing only the nearest segment misses the first
  // shape, which is the one every ORM produces.
  const path = calleeName(call);
  const receiverSegments =
    path !== undefined && path.includes(".")
      ? path.slice(0, path.lastIndexOf(".")).split(".")
      : [];
  const receiverMatches = (re: RegExp): boolean =>
    receiverSegments.some((segment) => re.test(segment));

  if (tail === "fetch") return "network";
  if (BARE_SUBPROCESS_TAILS.test(tail)) return "subprocess";
  if (FILESYSTEM_TAILS.test(tail)) return "filesystem";
  if (
    SUBPROCESS_TAILS.test(tail) &&
    receiverMatches(/^(child_process|cp|execa|shell)$/i)
  ) {
    return "subprocess";
  }
  if (QUEUE_TAILS.test(tail) && receiverMatches(QUEUE_RECEIVERS)) return "queue";
  if (DATABASE_TAILS.test(tail) && receiverMatches(DATABASE_RECEIVERS)) return "database";
  if (NETWORK_TAILS.test(tail) && receiverMatches(NETWORK_RECEIVERS)) return "network";
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Bound detection
 * ------------------------------------------------------------------ */

/**
 * Concurrency bounds visible at the fan-out site: an explicit slice, a
 * batching helper, a concurrency-limit library, or a `concurrency:`
 * option.
 */
function collectBounds(argument: ts.Node, sourceFile: ts.SourceFile): FanOutBound[] {
  const out: FanOutBound[] = [];
  const record = (kind: FanOutBound["kind"], evidence: string, line: number): void => {
    if (out.length >= 6) return;
    if (out.some((b) => b.kind === kind && b.evidence === evidence)) return;
    out.push({ kind, evidence, line });
  };

  const visit = (node: ts.Node): void => {
    if (out.length >= 6) return;

    if (ts.isCallExpression(node)) {
      const tail = calleeTail(node);
      if (tail !== undefined) {
        const line = startLineOf(node, sourceFile);
        if (tail === "slice" || tail === "take") {
          record("slice", `\`.${tail}(…)\` caps the collection`, line);
        } else if (BATCH_TAILS.has(tail.toLowerCase())) {
          record("batch", `\`${tail}(…)\` batches the collection`, line);
        } else if (CONCURRENCY_LIBRARIES.has(tail.toLowerCase().replace(/[-_]/g, ""))) {
          record("library", `\`${tail}(…)\` bounds concurrency`, line);
        }
      }
      // `findMany({ take: 100 })` / `list({ limit: 50 })`
      for (const arg of node.arguments) {
        const obj = unwrap(arg);
        if (!ts.isObjectLiteralExpression(obj)) continue;
        for (const prop of obj.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          const key = prop.name.text;
          if (/^(take|limit|first|pagesize|maxresults|top)$/i.test(key)) {
            record(
              "limit_option",
              `\`${key}\` bounds the source query`,
              startLineOf(prop, sourceFile),
            );
          } else if (CONCURRENCY_OPTION_KEYS.test(key)) {
            record(
              "semaphore",
              `\`${key}\` bounds concurrency`,
              startLineOf(prop, sourceFile),
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(argument);
  return sortBounds(out);
}

/** Stable ordering so evidence lines don't shuffle between runs. */
function sortBounds(bounds: FanOutBound[]): FanOutBound[] {
  return [...bounds].sort((a, b) =>
    a.kind === b.kind
      ? a.evidence.localeCompare(b.evidence)
      : a.kind.localeCompare(b.kind),
  );
}

function enclosingName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functions: readonly ParsedFunction[],
): { enclosing?: string } {
  const fn = nearestEnclosingFunction(node, sourceFile, functions);
  return fn?.name !== undefined ? { enclosing: fn.name } : {};
}
