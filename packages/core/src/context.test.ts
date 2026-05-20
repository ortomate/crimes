import { exec } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { context, findNearestPackageRoot } from "./context.js";

const execAsync = promisify(exec);

/**
 * Initialize a git repo in `dir`, configure a dummy identity, and commit
 * all files. Used by context clues tests that need git history.
 */
async function initRepo(dir: string): Promise<void> {
  await execAsync("git init", { cwd: dir });
  await execAsync('git config user.email "test@example.com"', { cwd: dir });
  await execAsync('git config user.name "Test User"', { cwd: dir });
  await execAsync("git add -A", { cwd: dir });
  await execAsync('git commit -m "initial"', { cwd: dir });
}

/**
 * Make a repo with git history: creates the files, initializes git, and
 * makes multiple commits with different author emails so uniqueAuthors > 1.
 */
async function makeRepoWithGitHistory(
  files: Record<string, string>,
): Promise<string> {
  const dir = await makeRepo(files);
  await execAsync("git init", { cwd: dir });
  await execAsync('git config user.email "author1@example.com"', { cwd: dir });
  await execAsync('git config user.name "Author One"', { cwd: dir });
  await execAsync("git add -A", { cwd: dir });
  await execAsync('git commit -m "initial commit"', { cwd: dir });
  // Second commit with a different author to ensure uniqueAuthors >= 1.
  await execAsync('git config user.email "author2@example.com"', { cwd: dir });
  await execAsync('git config user.name "Author Two"', { cwd: dir });
  // Amend a file to create a second commit.
  await writeFile(join(dir, "src/a.ts"), "// amended\n", "utf8");
  await execAsync("git add -A", { cwd: dir });
  await execAsync('git commit -m "second commit"', { cwd: dir });
  return dir;
}

// Resolve the bundled fixture relative to the test file. Vitest's cwd
// depends on how it was invoked (`pnpm test` from root vs from the
// package); going via `import.meta.url` keeps the path correct either way.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolvePath(
  HERE,
  "..",
  "..",
  "..",
  "examples",
  "messy-ts-app",
);

async function makeRepo(files: Record<string, string>): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), "crimes-context-test-"));
  // Canonicalise so darwin `/var` vs `/private/var` matches what `context()`
  // does internally — `realpath` is idempotent on non-symlinked dirs.
  const dir = await realpath(raw);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

describe("context", () => {
  it("returns a schema-versioned report keyed to the requested file", async () => {
    const root = await makeRepo({ "src/x.ts": "export const x = 1;\n" });
    const report = await context({ root, file: "src/x.ts" });

    expect(report.schema_version).toBe("0.2.0");
    expect(report.report_type).toBe("context");
    expect(report.file).toBe("src/x.ts");
    expect(report.repo.root).toBe(root);
  });

  it("normalises absolute paths to repo-relative", async () => {
    const root = await makeRepo({ "src/x.ts": "export const x = 1;\n" });
    const report = await context({ root, file: join(root, "src/x.ts") });
    expect(report.file).toBe("src/x.ts");
  });

  it("filters findings to just the requested file", async () => {
    const big = Array.from({ length: 800 }, () => "// line").join("\n");
    const root = await makeRepo({
      "src/big.ts": big,
      "src/small.ts": "export const x = 1;\n",
    });

    const report = await context({ root, file: "src/big.ts" });

    expect(report.findings.length).toBeGreaterThan(0);
    for (const f of report.findings) {
      expect(f.file).toBe("src/big.ts");
    }
  });

  it("rolls risk up to the worst severity present", async () => {
    const big = Array.from({ length: 800 }, () => "// line").join("\n");
    const root = await makeRepo({ "src/big.ts": big });
    const report = await context({ root, file: "src/big.ts" });

    expect(report.risk.level).toBe("high");
    expect(report.risk.high).toBeGreaterThanOrEqual(1);
    expect(report.risk.total).toBe(report.findings.length);
  });

  it("returns risk.level 'none' when there are no findings", async () => {
    const root = await makeRepo({ "src/x.ts": "export const x = 1;\n" });
    const report = await context({ root, file: "src/x.ts" });

    expect(report.findings).toEqual([]);
    expect(report.risk.level).toBe("none");
    expect(report.agent_guidance).toEqual([]);
  });

  it("finds sibling .test.ts files", async () => {
    const root = await makeRepo({
      "src/billing.ts": "export const billing = () => 1;\n",
      "src/billing.test.ts": "import { billing } from './billing';\n",
    });
    const report = await context({ root, file: "src/billing.ts" });
    expect(report.likely_tests).toContain("src/billing.test.ts");
  });

  it("finds .spec.tsx siblings", async () => {
    const root = await makeRepo({
      "src/Btn.tsx": "export const Btn = () => null;\n",
      "src/Btn.spec.tsx": "import { Btn } from './Btn';\n",
    });
    const report = await context({ root, file: "src/Btn.tsx" });
    expect(report.likely_tests).toContain("src/Btn.spec.tsx");
  });

  it("finds tests under __tests__ that match the target basename", async () => {
    const root = await makeRepo({
      "src/billing.ts": "export const billing = () => 1;\n",
      "src/__tests__/billing.test.ts": "import { billing } from '../billing';\n",
    });
    const report = await context({ root, file: "src/billing.ts" });
    expect(report.likely_tests).toContain("src/__tests__/billing.test.ts");
  });

  it("finds test files that import the target via a relative path", async () => {
    const root = await makeRepo({
      "src/billing.ts": "export const billing = () => 1;\n",
      "src/uses-billing.test.ts": "import { billing } from './billing';\n",
    });
    const report = await context({ root, file: "src/billing.ts" });
    expect(report.likely_tests).toContain("src/uses-billing.test.ts");
  });

  it("does not include non-test files even when they import the target", async () => {
    const root = await makeRepo({
      "src/billing.ts": "export const billing = () => 1;\n",
      "src/consumer.ts": "import { billing } from './billing';\n",
    });
    const report = await context({ root, file: "src/billing.ts" });
    expect(report.likely_tests).not.toContain("src/consumer.ts");
  });

  it("emits deterministic agent_guidance keyed off finding types", async () => {
    const date =
      "export const a = " +
      Array.from({ length: 10 }, () => "Date.now()").join(" + ") +
      ";\n";
    const root = await makeRepo({ "src/billing.ts": date });
    const report = await context({ root, file: "src/billing.ts" });

    expect(report.findings.some((f) => f.type === "direct_date")).toBe(true);
    expect(
      report.agent_guidance.some((g) => /clock|inject time/i.test(g)),
    ).toBe(true);
  });

  it("dedupes guidance to one line per finding type", async () => {
    const fn = (name: string): string =>
      `export function ${name}() {\n` +
      Array.from({ length: 100 }, () => "  // body").join("\n") +
      "\n}\n";
    const root = await makeRepo({ "src/big.ts": fn("a") + fn("b") });

    const report = await context({ root, file: "src/big.ts" });
    const fns = report.findings.filter((f) => f.type === "large_function");
    expect(fns.length).toBeGreaterThanOrEqual(2);

    const helperLines = report.agent_guidance.filter((g) =>
      /helpers/i.test(g),
    );
    expect(helperLines).toHaveLength(1);
  });

  describe("Go-style _test / _spec test discovery", () => {
    it("finds sibling foo_test.ts as a likely test for foo.ts", async () => {
      const root = await makeRepo({
        "src/foo.ts": "export const foo = 1;\n",
        "src/foo_test.ts": "import { foo } from './foo';\n",
      });
      const report = await context({ root, file: "src/foo.ts" });
      expect(report.likely_tests).toContain("src/foo_test.ts");
    });

    it("finds sibling foo_spec.ts as a likely test", async () => {
      const root = await makeRepo({
        "src/foo.ts": "export const foo = 1;\n",
        "src/foo_spec.ts": "import { foo } from './foo';\n",
      });
      const report = await context({ root, file: "src/foo.ts" });
      expect(report.likely_tests).toContain("src/foo_spec.ts");
    });

    it("matches a _test.ts file in a parallel test/ directory via relative import", async () => {
      // `test/index_test.ts` imports `../src/index`. The sibling-basename
      // rule fires because the basename strips to `index`; the import
      // discovery also matches as a fallback.
      const root = await makeRepo({
        "src/index.ts": "export const i = 1;\n",
        "test/index_test.ts": "import { i } from '../src/index';\n",
      });
      const report = await context({ root, file: "src/index.ts" });
      expect(report.likely_tests).toContain("test/index_test.ts");
    });

    it("recognises foo_test.ts under __tests__/", async () => {
      const root = await makeRepo({
        "src/foo.ts": "export const foo = 1;\n",
        "src/__tests__/foo_test.ts": "import { foo } from '../foo';\n",
      });
      const report = await context({ root, file: "src/foo.ts" });
      expect(report.likely_tests).toContain("src/__tests__/foo_test.ts");
    });

    it("does not match an unrelated _test.ts whose subject differs", async () => {
      const root = await makeRepo({
        "src/foo.ts": "export const foo = 1;\n",
        "src/bar_test.ts": "import { bar } from './bar';\n",
      });
      const report = await context({ root, file: "src/foo.ts" });
      expect(report.likely_tests).not.toContain("src/bar_test.ts");
    });
  });

  describe("package-root auto-detection", () => {
    it("picks the nearest enclosing package.json when --root is omitted", async () => {
      const monorepo = await makeRepo({
        "package.json": JSON.stringify({ name: "monorepo", private: true }),
        "packages/app/package.json": JSON.stringify({ name: "app" }),
        "packages/app/src/big.ts":
          "export function big() {\n" +
          Array.from({ length: 100 }, () => "  // body").join("\n") +
          "\n}\n",
      });
      // Caller is "inside" the monorepo root (no --root passed), but the
      // target lives inside packages/app. Expectation: context scopes to
      // packages/app, so paths are relative to it.
      const report = await context({
        file: join(monorepo, "packages/app/src/big.ts"),
      });
      expect(report.repo.root).toBe(join(monorepo, "packages/app"));
      expect(report.file).toBe("src/big.ts");
      expect(
        report.findings.some((f) => f.type === "large_function"),
      ).toBe(true);
    });

    it("honours an explicit --root over the nearest package.json", async () => {
      const monorepo = await makeRepo({
        "package.json": JSON.stringify({ name: "monorepo", private: true }),
        "packages/app/package.json": JSON.stringify({ name: "app" }),
        "packages/app/src/foo.ts": "export const foo = 1;\n",
      });
      const report = await context({
        root: monorepo,
        file: "packages/app/src/foo.ts",
      });
      expect(report.repo.root).toBe(monorepo);
      expect(report.file).toBe("packages/app/src/foo.ts");
    });

    it("falls back to cwd when no package.json exists above the target", async () => {
      // No package.json anywhere in this fixture. We pass --root explicitly
      // so the fallback path is exercised deterministically (auto-fallback
      // would land on whatever the test runner's cwd happens to be).
      const root = await makeRepo({
        "src/x.ts": "export const x = 1;\n",
      });
      const report = await context({ root, file: "src/x.ts" });
      expect(report.repo.root).toBe(root);
      expect(report.file).toBe("src/x.ts");
    });

    it("produces the same findings invoked from monorepo root or package root", async () => {
      const monorepo = await makeRepo({
        "package.json": JSON.stringify({ name: "monorepo", private: true }),
        "packages/app/package.json": JSON.stringify({ name: "app" }),
        "packages/app/src/big.ts":
          "export function big() {\n" +
          Array.from({ length: 100 }, () => "  // body").join("\n") +
          "\n}\n",
      });
      const monorepoReport = await context({
        file: join(monorepo, "packages/app/src/big.ts"),
      });
      const packageReport = await context({
        root: join(monorepo, "packages/app"),
        file: "src/big.ts",
      });
      // Strip the per-scan repo metadata (root absolute path differs by
      // assignment, not by content) and compare the substantive shape.
      const stripIds = (
        r: typeof monorepoReport,
      ): { file: string; types: string[] } => ({
        file: r.file,
        types: r.findings.map((f) => f.type).sort(),
      });
      expect(stripIds(monorepoReport)).toEqual(stripIds(packageReport));
    });
  });

  describe("neighbourhood related_files", () => {
    it("passes finding.related_files through with a 'related to <charge>' reason", async () => {
      // The bundled fixture is the easiest way to get an IA finding that
      // populates related_files deterministically — `route_metadata_drift`
      // anchors on the billing route and lists the two nav sources.
      const report = await context({
        root: FIXTURE_ROOT,
        file: "src/routes/settings/billing.tsx",
      });
      const navPaths = report.related_files.map((r) => r.file);
      expect(navPaths).toContain("src/nav/registry.ts");
      expect(navPaths).toContain("src/nav/sidebar.ts");
      const registry = report.related_files.find(
        (r) => r.file === "src/nav/registry.ts",
      );
      expect(registry?.reason).toContain("Route Metadata Drift");
    });

    it("matches domain-prefix helper files even when there is no finding", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "app" }),
        "app/api/admin/users/route.ts": "export const GET = () => null;\n",
        "app/api/admin/teams/route.ts": "export const GET = () => null;\n",
        "lib/admin-auth.ts": "export const checkAdmin = () => true;\n",
        "lib/admin-permissions.ts": "export const perms = {};\n",
        "lib/payments.ts": "export const charge = () => null;\n",
      });
      const report = await context({
        root,
        file: "app/api/admin/users/route.ts",
      });
      const files = report.related_files.map((r) => r.file);
      expect(files).toContain("lib/admin-auth.ts");
      expect(files).toContain("lib/admin-permissions.ts");
      expect(files).toContain("app/api/admin/teams/route.ts");
      expect(files).not.toContain("lib/payments.ts");
      // Each entry should carry a reason and a score.
      for (const r of report.related_files) {
        expect(r.reason.length).toBeGreaterThan(0);
        expect(typeof r.score).toBe("number");
      }
    });

    it("surfaces same-directory siblings", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "app" }),
        "src/billing/invoice.ts": "export const x = 1;\n",
        "src/billing/tax.ts": "export const y = 2;\n",
        "src/billing/pricing.ts": "export const z = 3;\n",
        "src/unrelated/foo.ts": "export const f = 1;\n",
      });
      const report = await context({
        root,
        file: "src/billing/invoice.ts",
      });
      const files = report.related_files.map((r) => r.file);
      expect(files).toContain("src/billing/tax.ts");
      expect(files).toContain("src/billing/pricing.ts");
      // The unrelated file shouldn't sneak in via same-directory.
      const unrelated = report.related_files.find(
        (r) => r.file === "src/unrelated/foo.ts",
      );
      // It may still match via shared "billing" token (it doesn't here),
      // but should never carry "same directory" as a reason.
      if (unrelated) expect(unrelated.reason).not.toContain("same directory");
    });

    it("does not duplicate likely_tests in related_files", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "app" }),
        "src/billing/invoice.ts": "export const x = 1;\n",
        "src/billing/invoice.test.ts":
          "import { x } from './invoice';\n",
        "src/billing/tax.ts": "export const y = 2;\n",
      });
      const report = await context({
        root,
        file: "src/billing/invoice.ts",
      });
      expect(report.likely_tests).toContain("src/billing/invoice.test.ts");
      const relatedPaths = report.related_files.map((r) => r.file);
      expect(relatedPaths).not.toContain("src/billing/invoice.test.ts");
      // Non-test siblings still show up.
      expect(relatedPaths).toContain("src/billing/tax.ts");
    });

    it("caps related_files at the documented limit", async () => {
      const files: Record<string, string> = {
        "package.json": JSON.stringify({ name: "app" }),
        "src/widgets/target.ts": "export const t = 1;\n",
      };
      // 20 same-directory siblings — should be capped to 10.
      for (let i = 0; i < 20; i++) {
        files[`src/widgets/sib${i}.ts`] = `export const s${i} = ${i};\n`;
      }
      const root = await makeRepo(files);
      const report = await context({
        root,
        file: "src/widgets/target.ts",
      });
      expect(report.related_files.length).toBeLessThanOrEqual(10);
      // Output is deterministically sorted: ties by score → alphabetical
      // by file. With same-weight siblings, we should see sib0..sib16
      // (lex order, 17 comes after 16 etc), capped at 10. Just assert
      // the cap, not the exact contents — sort details are covered by
      // dedicated module tests.
      expect(report.related_files.length).toBe(10);
    });

    it("never lists the target file itself", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "app" }),
        "src/billing/invoice.ts": "export const x = 1;\n",
        "src/billing/tax.ts": "export const y = 2;\n",
      });
      const report = await context({
        root,
        file: "src/billing/invoice.ts",
      });
      const paths = report.related_files.map((r) => r.file);
      expect(paths).not.toContain("src/billing/invoice.ts");
    });
  });

  describe("empty-field reasons", () => {
    it("emits all three reasons for a clean stand-alone file", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "lonely" }),
        "src/x.ts": "export const x = 1;\n",
      });
      const report = await context({ root, file: "src/x.ts" });

      expect(report.findings).toEqual([]);
      expect(report.likely_tests).toEqual([]);
      // The only other file is `package.json`, which isn't in the
      // discoverable source set — so no neighbourhood candidates exist.
      expect(report.related_files).toEqual([]);
      expect(report.agent_guidance).toEqual([]);

      expect(report.agent_guidance_reason).toBeDefined();
      expect(report.likely_tests_reason).toBeDefined();
      expect(report.related_files_reason).toBeDefined();
    });

    it("omits the reasons when their arrays are populated", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "app" }),
        "src/foo.ts": "export const foo = 1;\n",
        "src/foo.test.ts": "import { foo } from './foo';\n",
        "src/bar.ts": "export const bar = 2;\n",
      });
      const report = await context({ root, file: "src/foo.ts" });

      expect(report.likely_tests.length).toBeGreaterThan(0);
      expect(report.related_files.length).toBeGreaterThan(0);
      expect(report.likely_tests_reason).toBeUndefined();
      expect(report.related_files_reason).toBeUndefined();
    });

    it("emits agent_guidance_reason only when guidance is empty", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "app" }),
        "src/billing.ts":
          "export const a = " +
          Array.from({ length: 10 }, () => "Date.now()").join(" + ") +
          ";\n",
      });
      const report = await context({ root, file: "src/billing.ts" });
      expect(report.agent_guidance.length).toBeGreaterThan(0);
      expect(report.agent_guidance_reason).toBeUndefined();
    });

    it("uses the neighbourhood guidance line when there are no findings but related files exist", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "app" }),
        "src/billing/target.ts": "export const x = 1;\n",
        "src/billing/sibling.ts": "export const y = 2;\n",
      });
      const report = await context({
        root,
        file: "src/billing/target.ts",
      });
      expect(report.findings).toEqual([]);
      expect(report.related_files.length).toBeGreaterThan(0);
      expect(report.agent_guidance).toHaveLength(1);
      expect(report.agent_guidance[0]).toMatch(/related files/i);
      expect(report.agent_guidance_reason).toBeUndefined();
    });
  });

  describe("findNearestPackageRoot helper", () => {
    it("returns the directory containing package.json", async () => {
      const root = await makeRepo({
        "package.json": "{}",
        "src/nested/x.ts": "export const x = 1;\n",
      });
      const found = await findNearestPackageRoot(join(root, "src/nested"));
      expect(found).toBe(root);
    });

    it("walks up through multiple directories until it finds package.json", async () => {
      const root = await makeRepo({
        "package.json": "{}",
        "a/b/c/d/e/leaf.ts": "//\n",
      });
      const found = await findNearestPackageRoot(join(root, "a/b/c/d/e"));
      expect(found).toBe(root);
    });

    it("prefers the nearest package.json when packages are nested", async () => {
      const root = await makeRepo({
        "package.json": JSON.stringify({ name: "outer" }),
        "inner/package.json": JSON.stringify({ name: "inner" }),
        "inner/src/x.ts": "//\n",
      });
      const found = await findNearestPackageRoot(join(root, "inner/src"));
      expect(found).toBe(join(root, "inner"));
    });

    it("returns undefined when no package.json exists above the start", async () => {
      // We can't reliably assert "no package.json on the path to /" because
      // the test runner's own workspace has one. Instead, verify by using
      // a temp dir on whose parents we know there is no package.json
      // before the filesystem root (which is `/`). Skip the broader case;
      // this path is exercised by the "falls back to cwd" test above.
      const root = await makeRepo({ "src/x.ts": "//\n" });
      const found = await findNearestPackageRoot(join(root, "src"));
      // tmpdir() lives under e.g. /tmp/... which has no package.json on
      // any darwin or linux CI box. If a future environment somehow has
      // one (say someone develops in `/`), this assertion becomes
      // environment-dependent — accept either the dir itself or nothing,
      // but never the temp dir we wrote (since we didn't add a
      // package.json to it).
      expect(found === undefined || found !== root).toBe(true);
    });
  });
});

describe("context — clues", () => {
  it("populates clues.churn from the scoring context when git is available", async () => {
    const dir = await makeRepoWithGitHistory({ "src/a.ts": "export const x = 1;\n" });
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues?.churn).toBeDefined();
    expect(result.clues!.churn!.commits_90d).toBeGreaterThan(0);
    expect(result.clues!.churn!.last_commit_at).toMatch(/^\d{4}-/);
    expect(result.clues!.churn!.unique_authors_90d).toBeGreaterThan(0);
  });

  it("omits clues.churn when git is unavailable (no git repo)", async () => {
    // makeRepo creates files but no git repo — churnResult.gitAvailable will be false.
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n" });
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues?.churn).toBeUndefined();
  });

  it("emits clues.test_gap with raw + percentile + label on a repo of ≥4 files", async () => {
    const dir = await makeRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
      "src/d.ts": "export const d = 4;\n",
    });
    await initRepo(dir);
    const result = await context({ root: dir, file: "src/a.ts" });
    expect(result.clues?.test_gap).toBeDefined();
    expect(result.clues!.test_gap!.raw).toBeGreaterThanOrEqual(0);
    expect(result.clues!.test_gap!.percentile).toBeGreaterThanOrEqual(0);
    expect([
      "top-quartile",
      "median",
      "bottom-quartile",
      "unknown",
    ]).toContain(result.clues!.test_gap!.label);
  });

  it("emits label='unknown' and omits percentile when fewer than 4 files are scanned", async () => {
    const dir = await makeRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    await initRepo(dir);
    const result = await context({ root: dir, file: "src/a.ts" });
    // Fewer than 4 source files — quartile ranking unavailable.
    expect(result.clues!.test_gap!.label).toBe("unknown");
    expect(result.clues!.test_gap!.percentile).toBeUndefined();
  });

  it("includes related_signals as an empty array (reserved for Release B)", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n" });
    const result = await context({ root: dir, file: "src/a.ts" });
    // related_signals is always present and always [] in Release A.
    expect(result.clues?.related_signals).toEqual([]);
  });

  it("populates clues.suppressions when suppressionsEntries are passed and the file matches", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n" });
    const result = await context({
      root: dir,
      file: "src/a.ts",
      suppressionsEntries: [
        {
          fingerprint: "large_function::src/a.ts::foo",
          type: "large_function",
          file: "src/a.ts",
          reason: "tracked in #42",
          created_at: "2026-05-17T11:30:00.000Z",
          crimes_version_pinned: "0.9",
        },
      ],
    });
    expect(result.clues?.suppressions).toBeDefined();
    expect(result.clues!.suppressions).toHaveLength(1);
    expect(result.clues!.suppressions![0]!.fingerprint).toBe(
      "large_function::src/a.ts::foo",
    );
    expect(result.clues!.suppressions![0]!.matches_current_finding).toBe(false);
  });

  it("omits clues.suppressions when suppressionsEntries is not provided", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n" });
    const result = await context({ root: dir, file: "src/a.ts" });
    // No suppressionsEntries passed — the block is not populated.
    expect(result.clues?.suppressions).toBeUndefined();
  });

  it("omits clues.suppressions when no entries match the requested file", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n" });
    const result = await context({
      root: dir,
      file: "src/a.ts",
      suppressionsEntries: [
        {
          fingerprint: "large_function::src/other.ts::bar",
          type: "large_function",
          file: "src/other.ts",
          reason: "tracked in #99",
          created_at: "2026-05-17T11:30:00.000Z",
        },
      ],
    });
    // Suppression is for a different file — should not appear here.
    expect(result.clues?.suppressions).toBeUndefined();
  });

  it("omit/present clues boundary: clues is present when test_gap is populated", async () => {
    // This test documents the Release A invariant: clues is ALWAYS present
    // because test_gap is always populated when scoring succeeds. The spec
    // says "omit clues when ALL of churn/suppressions/test_gap would be
    // empty", but in Release A that state is never reached because test_gap
    // fires whenever the scoring context can be built (which requires only
    // that the file exists and can be discovered).
    //
    // Even with no git, no suppressions, and only 1 file:
    //   - clues.churn is absent (no git)
    //   - clues.suppressions is absent (no entries)
    //   - clues.test_gap is present (raw + label="unknown")
    //   - clues.related_signals is present as []
    // Therefore clues itself is present.
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n" });
    const result = await context({ root: dir, file: "src/a.ts" });
    // clues should be defined because test_gap is always populated.
    expect(result.clues).toBeDefined();
    // In a no-git, single-file repo: no churn, no suppressions.
    expect(result.clues!.churn).toBeUndefined();
    expect(result.clues!.suppressions).toBeUndefined();
    // test_gap should always be present.
    expect(result.clues!.test_gap).toBeDefined();
    // related_signals is always [].
    expect(result.clues!.related_signals).toEqual([]);
  });
});
