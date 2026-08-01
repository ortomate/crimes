import type ts from "typescript";
import {
  APP_ROUTER_DIR_RE,
  APP_ROUTER_PAGE_FILE_RE,
  HTTP_VERBS,
  PAGES_ROUTER_API_RE,
  PAGES_ROUTER_PAGE_RE,
} from "./constants.js";
import {
  bodyContainsCommanderChain,
  isCommanderActionCallbackArg,
  isCommanderRegistrarName,
} from "./shape-commander.js";
import {
  bodyContainsJsx,
  hasDefaultModifierOnDeclaration,
  hasExportModifier,
  isDefaultExportFunction,
  isPascalCase,
  testCalleeOfParent,
} from "./shape-predicates.js";
import type { FunctionKind, FunctionShape } from "./types.js";

interface ClassifyArgs {
  node: ts.Node;
  kind: FunctionKind;
  name: string | undefined;
  absolutePath: string;
}

interface ClassifyResult {
  shape: FunctionShape;
  shapeEvidence: string[];
}

/**
 * Decide the {@link FunctionShape} for a parsed function. Rules are
 * evaluated in priority order — first match wins. The classification is
 * conservative: anything ambiguous falls through to `"domain"` (named) or
 * `"unknown"` (anonymous), so we never miss a real god-function that
 * happens to share AST shape with a test callback.
 */
export function classifyShape(args: ClassifyArgs): ClassifyResult {
  return (
    tryTestCallback(args) ??
    tryCliCommandRegistrar(args) ??
    tryRouteHandler(args) ??
    tryPageExport(args) ??
    tryReactComponent(args) ??
    fallbackShape(args)
  );
}

/**
 * 1. test_callback: the function is an argument to a known test-framework
 *    call. Arrow / function_expression only — a named declaration isn't a
 *    callback. Hooks (`beforeAll`, …) and focus/skip variants are all
 *    treated equally.
 */
function tryTestCallback({ node }: ClassifyArgs): ClassifyResult | null {
  const testCallee = testCalleeOfParent(node);
  if (!testCallee) return null;
  return {
    shape: "test_callback",
    shapeEvidence: [`callback passed to ${testCallee}(...)`],
  };
}

/**
 * 1b. cli_command_registrar — Commander.js DSL. Recognised as either
 *     the outer `registerXCommand(program)` wrapper, OR the anonymous
 *     callback passed to `.action(...)` on a `program.command(...)`
 *     chain. The chain is registration syntax, not branching logic, so
 *     it shouldn't be charged at domain thresholds.
 */
function tryCliCommandRegistrar({
  node,
  kind,
  name,
}: ClassifyArgs): ClassifyResult | null {
  if (
    name &&
    isCommanderRegistrarName(name) &&
    (kind === "function" || kind === "function_expression" || kind === "arrow") &&
    bodyContainsCommanderChain(node)
  ) {
    return {
      shape: "cli_command_registrar",
      shapeEvidence: [
        `name matches register*Command`,
        `body contains Commander DSL chain`,
      ],
    };
  }
  if (
    (kind === "arrow" || kind === "function_expression") &&
    isCommanderActionCallbackArg(node)
  ) {
    return {
      shape: "cli_command_registrar",
      shapeEvidence: [`callback passed to Commander .action(...)`],
    };
  }
  return null;
}

/**
 * 2. route_handler — two flavours:
 *    (a) App Router: named export with HTTP-verb name under
 *        `(src/)?app/**` (typically `route.ts`).
 *    (b) Pages Router API: default export under `(src/)?pages/api/**`.
 */
function tryRouteHandler({
  node,
  name,
  absolutePath,
}: ClassifyArgs): ClassifyResult | null {
  if (
    name &&
    HTTP_VERBS.has(name) &&
    hasExportModifier(node) &&
    !hasDefaultModifierOnDeclaration(node) &&
    APP_ROUTER_DIR_RE.test(absolutePath)
  ) {
    return {
      shape: "route_handler",
      shapeEvidence: [`named export "${name}"`, `App Router route file`],
    };
  }
  if (isDefaultExportFunction(node) && PAGES_ROUTER_API_RE.test(absolutePath)) {
    return {
      shape: "route_handler",
      shapeEvidence: ["default export", "Pages Router API route"],
    };
  }
  return null;
}

/**
 * 3. page_export: default export under a conventional page file —
 *    App Router (`app/**\/page.tsx` etc.) or Pages Router (`pages/**`
 *    excluding `pages/api/`).
 */
function tryPageExport({ node, absolutePath }: ClassifyArgs): ClassifyResult | null {
  if (!isDefaultExportFunction(node)) return null;
  if (
    APP_ROUTER_DIR_RE.test(absolutePath) &&
    APP_ROUTER_PAGE_FILE_RE.test(absolutePath)
  ) {
    return {
      shape: "page_export",
      shapeEvidence: ["default export", "App Router page file"],
    };
  }
  if (PAGES_ROUTER_PAGE_RE.test(absolutePath)) {
    return {
      shape: "page_export",
      shapeEvidence: ["default export", "Pages Router page file"],
    };
  }
  return null;
}

/**
 * 4. react_component: PascalCase name AND body contains JSX. Live
 *    outside route directories (page_export already handled). Methods
 *    and constructors can't be React components.
 */
function tryReactComponent({ node, kind, name }: ClassifyArgs): ClassifyResult | null {
  if (
    name &&
    isPascalCase(name) &&
    (kind === "function" || kind === "arrow" || kind === "function_expression") &&
    bodyContainsJsx(node)
  ) {
    return {
      shape: "react_component",
      shapeEvidence: [`PascalCase name "${name}"`, "body returns JSX"],
    };
  }
  return null;
}

/**
 * 5/6. Fallback. `domain` for anything with a name (default bucket,
 *      including methods, constructors, accessors). `unknown` for
 *      anonymous arrow / function_expression that didn't match a more
 *      specific rule — falls back to a slightly relaxed threshold so
 *      god-functions hiding inside callbacks still surface, but
 *      ordinary inline anonymous helpers don't.
 */
function fallbackShape({ name }: ClassifyArgs): ClassifyResult {
  if (name) return { shape: "domain", shapeEvidence: [] };
  return { shape: "unknown", shapeEvidence: [] };
}
