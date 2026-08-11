import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scan } from "../scan.js";

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crimes-tooling-excl-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf8");
  }
  return root;
}

/** A file that reliably trips `todo_density`. */
function noisy(): string {
  return (
    "# TODO: one\n# TODO: two\n# TODO: three\n# TODO: four\n" +
    Array.from({ length: 20 }, (_, i) => `x_${i} = ${i}`).join("\n")
  );
}

const CORROBORATED = [
  "[tool.ruff]",
  "extend-exclude = ['legacy']",
  "[tool.coverage.run]",
  "omit = ['legacy/*']",
].join("\n");

describe("scan honours a repo's own tooling excludes", () => {
  it("skips a corroborated path and says so under coverage.warnings", async () => {
    const root = await repo({
      "pyproject.toml": CORROBORATED,
      "legacy/old.py": noisy(),
      "src/app.py": noisy(),
    });
    const report = await scan({ root });

    expect(report.findings.some((f) => f.file.startsWith("legacy/"))).toBe(false);
    expect(report.findings.some((f) => f.file.startsWith("src/"))).toBe(true);

    const warning = report.coverage?.warnings?.find(
      (w) => w.kind === "files_excluded_by_tooling",
    );
    expect(warning?.subject).toBe("legacy");
    expect(warning?.files).toBe(1);
    expect(warning?.examples).toContain("legacy/old.py");
    // The tool's value is being trustworthy about what it looked at, so
    // a skip that cannot be undone is not acceptable.
    expect(warning?.remedy).toMatch(/honourToolingExcludes/);
  });

  it("does not also report the skipped file as undiscovered", async () => {
    // Two reasons for one file, the second of them false ("no include
    // pattern matched it"), is worse than no reason at all.
    const root = await repo({
      "pyproject.toml": CORROBORATED,
      "legacy/old.py": noisy(),
      "src/app.py": noisy(),
    });
    const report = await scan({ root });
    const kinds = (report.coverage?.warnings ?? []).map((w) => w.kind);
    expect(kinds.filter((k) => k === "files_excluded_by_tooling")).toHaveLength(1);
    expect(kinds).not.toContain("files_not_discovered");
  });

  it("scans everything when only one tool excludes the path", async () => {
    const root = await repo({
      "pyproject.toml": ["[tool.ruff]", "extend-exclude = ['legacy']"].join("\n"),
      "legacy/old.py": noisy(),
    });
    const report = await scan({ root });
    expect(report.findings.some((f) => f.file.startsWith("legacy/"))).toBe(true);
    expect(
      report.coverage?.warnings?.some((w) => w.kind === "files_excluded_by_tooling"),
    ).toBeFalsy();
  });

  it("ignores a build-backend exclude that would blank the repo", async () => {
    // airflow's shape. The whole feature is unshippable if this fails.
    const root = await repo({
      "pyproject.toml": [
        "[tool.hatch.build.targets.sdist]",
        'exclude = ["*"]',
        "[tool.ruff]",
        "extend-exclude = ['legacy']",
      ].join("\n"),
      "legacy/old.py": noisy(),
      "src/app.py": noisy(),
    });
    const report = await scan({ root });
    expect(report.findings.some((f) => f.file.startsWith("src/"))).toBe(true);
    expect(report.findings.some((f) => f.file.startsWith("legacy/"))).toBe(true);
  });

  it("honourToolingExcludes:false scans the excluded path", async () => {
    const root = await repo({
      "pyproject.toml": CORROBORATED,
      "crimes.config.json": JSON.stringify({ honourToolingExcludes: false }),
      "legacy/old.py": noisy(),
    });
    const report = await scan({ root });
    expect(report.findings.some((f) => f.file.startsWith("legacy/"))).toBe(true);
    expect(
      report.coverage?.warnings?.some((w) => w.kind === "files_excluded_by_tooling"),
    ).toBeFalsy();
  });

  it("is inert in a repo with no pyproject.toml", async () => {
    const root = await repo({ "src/app.py": noisy() });
    const report = await scan({ root });
    expect(report.findings.some((f) => f.file.startsWith("src/"))).toBe(true);
    expect(
      report.coverage?.warnings?.some((w) => w.kind === "files_excluded_by_tooling"),
    ).toBeFalsy();
  });
});
