import type { Node } from "web-tree-sitter";
import type { PyFunctionShape } from "./types.js";
import { flatText, lastSegment } from "./utils.js";

/**
 * Route decorators across the three frameworks that matter for the
 * initial slate. Matched on the *method* segment plus a receiver that
 * looks like an app/router/blueprint, so a project-local
 * `@cache.get(...)` doesn't get mistaken for a route.
 */
const ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "route",
  "websocket",
]);

const ROUTE_RECEIVERS = /(^|[._])(app|router|api|bp|blueprint|mod|server)$/i;

/** Django REST Framework and Django's own function-view decorators. */
const BARE_ROUTE_DECORATORS = new Set([
  "api_view",
  "require_http_methods",
  "require_GET",
  "require_POST",
]);

const CLI_DECORATORS = /(^|\.)(command|group)$/;
const CLI_RECEIVERS = /(^|[._])(click|typer|app|cli)$/i;

const PYTEST_DECORATORS = /^pytest\.(fixture|mark)\b/;

const DJANGO_VIEW_BASES =
  /(^|\.)(View|TemplateView|ListView|DetailView|CreateView|UpdateView|DeleteView|FormView|RedirectView|APIView|ViewSet|ModelViewSet|GenericAPIView)$/;

const UNITTEST_BASES = /(^|\.)(TestCase|IsolatedAsyncioTestCase|SimpleTestCase|TransactionTestCase)$/;

export interface ShapeInput {
  name: string | undefined;
  decorators: string[];
  /** First positional parameter name, `self`/`cls` already stripped. */
  firstParam: string | undefined;
  className: string | undefined;
  classBases: string[];
  filePath: string;
}

export interface ShapeResult {
  shape: PyFunctionShape;
  evidence: string[];
}

/**
 * Classify a Python function into a {@link PyFunctionShape}.
 *
 * Order matters: a `test_` function inside a Click command file is a
 * test first. Framework shapes are checked before the `django_view`
 * positional-parameter heuristic because that heuristic is the weakest
 * signal here — plenty of non-view functions take a `request`.
 */
export function classifyShape(input: ShapeInput): ShapeResult {
  const { name, decorators, firstParam, className, classBases, filePath } =
    input;

  // 1. Tests. Both the pytest naming convention and unittest inheritance.
  if (name !== undefined && /^test_/.test(name)) {
    return { shape: "test_function", evidence: [`name starts with test_`] };
  }
  for (const dec of decorators) {
    if (PYTEST_DECORATORS.test(dec)) {
      return { shape: "test_function", evidence: [`decorated @${dec}`] };
    }
  }
  if (classBases.some((b) => UNITTEST_BASES.test(b))) {
    const base = classBases.find((b) => UNITTEST_BASES.test(b))!;
    return {
      shape: "test_function",
      evidence: [`method on ${className ?? "class"}(${base})`],
    };
  }
  if (isTestPath(filePath) && name !== undefined && /^(setUp|tearDown)/.test(name)) {
    return { shape: "test_function", evidence: ["unittest fixture method"] };
  }

  // 2. Route handlers — FastAPI / Flask / DRF.
  for (const dec of decorators) {
    const head = dec.split("(")[0] ?? dec;
    const method = lastSegment(head);
    const receiver = head.slice(0, Math.max(0, head.length - method.length - 1));
    if (ROUTE_METHODS.has(method.toLowerCase()) && ROUTE_RECEIVERS.test(receiver)) {
      return { shape: "route_handler", evidence: [`decorated @${head}`] };
    }
    if (BARE_ROUTE_DECORATORS.has(method)) {
      return { shape: "route_handler", evidence: [`decorated @${head}`] };
    }
  }

  // 3. CLI commands — Click / Typer.
  for (const dec of decorators) {
    const head = dec.split("(")[0] ?? dec;
    const method = lastSegment(head);
    const receiver = head.slice(0, Math.max(0, head.length - method.length - 1));
    if (CLI_DECORATORS.test(head) && (CLI_RECEIVERS.test(receiver) || receiver === "")) {
      return { shape: "cli_command", evidence: [`decorated @${head}`] };
    }
  }

  // 4. Django class-based views.
  if (classBases.some((b) => DJANGO_VIEW_BASES.test(b))) {
    const base = classBases.find((b) => DJANGO_VIEW_BASES.test(b))!;
    return {
      shape: "django_view",
      evidence: [`method on ${className ?? "class"}(${base})`],
    };
  }

  // 5. Dunder methods. Checked after the framework shapes so an
  //    `__init__` on a view is still measured as a view.
  if (name !== undefined && /^__\w+__$/.test(name)) {
    return { shape: "dunder", evidence: [`special method ${name}`] };
  }

  // 6. Django function views — weakest signal, so it goes last.
  if (firstParam === "request" && className === undefined) {
    return {
      shape: "django_view",
      evidence: ["first parameter named request"],
    };
  }

  if (name === undefined) return { shape: "unknown", evidence: [] };
  return { shape: "domain", evidence: [] };
}

function isTestPath(filePath: string): boolean {
  const normalised = filePath.split("\\").join("/");
  return (
    /(^|\/)tests?\//.test(normalised) ||
    /(^|\/)test_[^/]+\.py$/.test(normalised) ||
    /_test\.py$/.test(normalised)
  );
}

/** Decorator source text without the leading `@`. */
export function decoratorText(decoratorNode: Node): string {
  const text = flatText(decoratorNode);
  return text.startsWith("@") ? text.slice(1) : text;
}
