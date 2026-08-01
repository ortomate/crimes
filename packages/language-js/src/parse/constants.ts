export const DESTINATION_KEYS = new Set(["href", "path", "to", "url", "route"]);

export const LABEL_KEYS = new Set(["label", "title", "name", "text"]);

export const UI_LABEL_TAGS =
  /^(Breadcrumb|Breadcrumbs|Nav|NavItem|NavLink|Sidebar|SidebarItem|Menu|MenuItem|Tab|TabItem)/;

export const TITLE_HOOK_CALLEES = new Set([
  "useTitle",
  "setTitle",
  "setPageTitle",
  "setDocumentTitle",
]);

/**
 * Test-framework callees whose argument functions should be classified as
 * `test_callback`. Includes Mocha/Jest/Vitest equivalents, focus / skip
 * variants, and hooks (`beforeAll`, etc.).
 */
export const TEST_CALLEES: ReadonlySet<string> = new Set([
  "describe",
  "fdescribe",
  "xdescribe",
  "it",
  "fit",
  "xit",
  "test",
  "ftest",
  "xtest",
  "suite",
  "context",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
  "before",
  "after",
]);

/**
 * HTTP verbs that an App Router route handler may export. Matched
 * case-sensitively because the framework expects exactly these casings.
 */
export const HTTP_VERBS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);

/**
 * Matches an App Router file under `app/` or `src/app/`. Used to gate
 * the `route_handler` and `page_export` shapes — the AST patterns alone
 * (named export with HTTP-verb name, default export with a component
 * body) aren't enough to distinguish framework files from coincidental
 * matches in normal source code.
 */
export const APP_ROUTER_DIR_RE = /(?:^|[\\/])(?:src[\\/])?app[\\/]/;

/**
 * Matches an App Router conventional file: `page.tsx`, `layout.tsx`,
 * `template.tsx`, `default.tsx`, `error.tsx`, `loading.tsx`,
 * `not-found.tsx`, with `.ts` / `.jsx` / `.js` variants accepted.
 */
export const APP_ROUTER_PAGE_FILE_RE =
  /(?:^|[\\/])(page|layout|template|default|error|loading|not-found)\.(?:tsx|ts|jsx|js|mjs|cjs)$/i;

/**
 * Matches a Pages Router file: any `.{tsx,jsx}` under `pages/` or
 * `src/pages/` that isn't under `pages/api/` (API routes use a default
 * export but render no JSX). Excludes `_app.tsx` / `_document.tsx` too —
 * they are page exports but commonly tiny, so classification doesn't
 * help; they fall through to `domain`.
 */
export const PAGES_ROUTER_PAGE_RE =
  /(?:^|[\\/])(?:src[\\/])?pages[\\/](?!api[\\/])[^\s]*\.(?:tsx|jsx|ts|js)$/i;

export const PAGES_ROUTER_API_RE =
  /(?:^|[\\/])(?:src[\\/])?pages[\\/]api[\\/].*\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * Matches the `registerXCommand` / `registerXSubcommand` naming
 * convention used by Commander builder DSL wrappers (e.g.
 * `registerScanCommand`, `registerFeedbackListSubcommand`). Conservative:
 * requires the literal `register` prefix, a PascalCase tail, and either
 * `Command` or `Subcommand` as the suffix. `Subcommand` covers
 * composed CLIs that register sub-trees on a parent command.
 */
export const COMMANDER_REGISTRAR_NAME_RE =
  /^register[A-Z][A-Za-z0-9]*(?:Command|Subcommand)$/;
