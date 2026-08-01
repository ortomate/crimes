import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeRisk, hotspots } from "./hotspots.js";

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolvePromise();
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
    });
  });
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crimes-hotspots-test-"));
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, path), content, "utf8");
  }
  return dir;
}

async function initGitRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@crimes.sh"]);
  await git(dir, ["config", "user.name", "Crimes Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
}

describe("computeRisk", () => {
  it("is 0 for a clean, untouched file", () => {
    expect(computeRisk({ changeCount: 0, highestSeverity: "none" })).toBe(0);
  });

  it("saturates churn at the configured cap", () => {
    const a = computeRisk({ changeCount: 20, highestSeverity: "none" });
    const b = computeRisk({ changeCount: 200, highestSeverity: "none" });
    expect(a).toBe(0.6);
    expect(b).toBe(0.6);
  });

  it("returns 1.0 when both axes are maxed", () => {
    expect(computeRisk({ changeCount: 20, highestSeverity: "high" })).toBe(1);
  });

  it("is monotonic in change_count", () => {
    const low = computeRisk({ changeCount: 1, highestSeverity: "medium" });
    const high = computeRisk({ changeCount: 10, highestSeverity: "medium" });
    expect(high).toBeGreaterThan(low);
  });

  it("is monotonic in severity", () => {
    const m = computeRisk({ changeCount: 5, highestSeverity: "medium" });
    const h = computeRisk({ changeCount: 5, highestSeverity: "high" });
    expect(h).toBeGreaterThan(m);
  });
});

describe("hotspots", () => {
  it("returns git_available=false for a non-git directory and falls back to severity", async () => {
    const big = Array.from({ length: 800 }, () => "// line").join("\n");
    const root = await makeRepo({ "big.ts": big });

    const report = await hotspots({ root });
    expect(report.git_available).toBe(false);
    expect(report.schema_version).toBe("0.3.0");
    expect(report.report_type).toBe("hotspots");
    expect(report.since).toBe("90d");
    // The huge file should still surface from scan findings.
    const big_row = report.hotspots.find((h) => h.file === "big.ts");
    expect(big_row).toBeDefined();
    expect(big_row!.change_count).toBe(0);
    expect(big_row!.finding_count).toBeGreaterThan(0);
    expect(big_row!.risk).toBeGreaterThan(0);
  });

  it("does not flag history_limited in a normal (non-shallow) git repo", {
    timeout: 30000,
  }, async () => {
    const root = await makeRepo({});
    await initGitRepo(root);
    await writeFile(join(root, "x.ts"), "export const x = 1;\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "init", "--no-verify"]);

    const report = await hotspots({ root });
    expect(report.git_available).toBe(true);
    expect(report.history_limited).toBeUndefined();
    expect(report.history_limited_reason).toBeUndefined();
  });

  it("annotates history_limited when the working tree is a shallow clone", {
    timeout: 60000,
  }, async () => {
    // Build an upstream repo with two commits, push it to a bare repo
    // alongside, then shallow-clone --depth=1 into a third dir. The
    // shallow clone is the directory under test.
    const upstream = await makeRepo({});
    await initGitRepo(upstream);
    await writeFile(join(upstream, "a.ts"), "export const a = 1;\n", "utf8");
    await git(upstream, ["add", "-A"]);
    await git(upstream, ["commit", "-m", "first", "--no-verify"]);
    await writeFile(join(upstream, "b.ts"), "export const b = 2;\n", "utf8");
    await git(upstream, ["add", "-A"]);
    await git(upstream, ["commit", "-m", "second", "--no-verify"]);

    const bare = await mkdtemp(join(tmpdir(), "crimes-hotspots-bare-"));
    await git(bare, ["clone", "--bare", upstream, "."]);

    const shallowDir = await mkdtemp(join(tmpdir(), "crimes-hotspots-shallow-"));
    await git(shallowDir, ["clone", "--depth=1", `file://${bare}`, "."]);
    // Configure the shallow clone so subsequent `git log` etc. work
    // without prompting for identity (the clone inherits no global config
    // in CI sandboxes).
    await git(shallowDir, ["config", "user.email", "test@crimes.sh"]);
    await git(shallowDir, ["config", "user.name", "Crimes Test"]);
    await git(shallowDir, ["config", "commit.gpgsign", "false"]);

    const report = await hotspots({ root: shallowDir });
    expect(report.git_available).toBe(true);
    expect(report.history_limited).toBe(true);
    expect(report.history_limited_reason).toMatch(/shallow clone/i);
  });

  it("uses git history to rank files when run inside a git repo", {
    timeout: 30000,
  }, async () => {
    const root = await makeRepo({});
    await initGitRepo(root);

    // hot.ts gets touched in 3 commits, calm.ts only once.
    await writeFile(join(root, "hot.ts"), "export const x = 1;\n", "utf8");
    await git(root, ["add", "hot.ts"]);
    await git(root, ["commit", "-m", "add hot", "--no-verify"]);

    await writeFile(join(root, "hot.ts"), "export const x = 2;\n", "utf8");
    await writeFile(join(root, "calm.ts"), "export const y = 1;\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "edit hot + add calm", "--no-verify"]);

    await writeFile(join(root, "hot.ts"), "export const x = 3;\n", "utf8");
    await git(root, ["add", "hot.ts"]);
    await git(root, ["commit", "-m", "edit hot again", "--no-verify"]);

    const report = await hotspots({ root });
    expect(report.git_available).toBe(true);

    const hot = report.hotspots.find((h) => h.file === "hot.ts");
    const calm = report.hotspots.find((h) => h.file === "calm.ts");
    expect(hot?.change_count).toBe(3);
    expect(calm?.change_count).toBe(1);
    expect(hot?.latest_change).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // hot.ts has more churn, so it should rank ahead of calm.ts.
    const hotIdx = report.hotspots.findIndex((h) => h.file === "hot.ts");
    const calmIdx = report.hotspots.findIndex((h) => h.file === "calm.ts");
    expect(hotIdx).toBeLessThan(calmIdx);
  });
});
