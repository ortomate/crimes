import { describe, expect, it } from "vitest";
import {
  extractPermissions,
  extractReferencedCommands,
  parseMarkdown,
  routeFromFilePath,
} from "./extract.js";

describe("routeFromFilePath", () => {
  it("derives a Pages-router route", () => {
    expect(routeFromFilePath("src/pages/settings/billing.tsx")).toBe("/settings/billing");
  });

  it("strips /index for Pages-router", () => {
    expect(routeFromFilePath("src/pages/settings/index.tsx")).toBe("/settings");
  });

  it("returns / for the root index", () => {
    expect(routeFromFilePath("pages/index.tsx")).toBe("/");
  });

  it("derives an App-router route", () => {
    expect(routeFromFilePath("src/app/account/subscription/page.tsx")).toBe(
      "/account/subscription",
    );
  });

  it("strips App-router groups", () => {
    expect(routeFromFilePath("src/app/(marketing)/about/page.tsx")).toBe("/about");
  });

  it("converts dynamic segments", () => {
    expect(routeFromFilePath("src/app/teams/[id]/page.tsx")).toBe("/teams/:id");
  });

  it("converts catchall segments", () => {
    expect(routeFromFilePath("src/app/docs/[...slug]/page.tsx")).toBe("/docs/*");
  });

  it("handles Remix/React-Router routes/ directory", () => {
    expect(routeFromFilePath("src/routes/team/index.tsx")).toBe("/team");
  });

  it("returns undefined for non-route files", () => {
    expect(routeFromFilePath("src/billing/tax.ts")).toBeUndefined();
  });

  it("skips API routes", () => {
    expect(routeFromFilePath("src/pages/api/users.ts")).toBeUndefined();
  });
});

describe("extractPermissions", () => {
  it("captures bare role literals", () => {
    const sigs = extractPermissions(`const role = "owner"; const x = "admin";\n`);
    const values = sigs.map((s) => s.value).sort();
    expect(values).toEqual(["admin", "owner"]);
    expect(sigs.every((s) => s.kind === "role")).toBe(true);
  });

  it("captures dotted permission strings", () => {
    const sigs = extractPermissions(`const p = "billing.manage";\n`);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.value).toBe("billing.manage");
    expect(sigs[0]!.kind).toBe("dotted");
  });

  it("ignores translation keys", () => {
    const sigs = extractPermissions(`const t = "common.errors.required";\n`);
    expect(sigs).toEqual([]);
  });

  it("ignores dotted strings without a verb", () => {
    const sigs = extractPermissions(`const x = "foo.bar.baz";\n`);
    expect(sigs).toEqual([]);
  });

  it("records line numbers", () => {
    const src = `line1\n"owner"\nline3\n"billing.manage"\n`;
    const sigs = extractPermissions(src);
    const byValue = Object.fromEntries(sigs.map((s) => [s.value, s.line]));
    expect(byValue.owner).toBe(2);
    expect(byValue["billing.manage"]).toBe(4);
  });
});

describe("parseMarkdown", () => {
  it("extracts headings with levels", () => {
    const doc = parseMarkdown(`# Top\n\n## Mid\n\n### Bottom\n`, "x.md");
    expect(doc.headings).toEqual([
      { text: "Top", level: 1, line: 1 },
      { text: "Mid", level: 2, line: 3 },
      { text: "Bottom", level: 3, line: 5 },
    ]);
  });

  it("extracts local links and marks remote as non-local", () => {
    const doc = parseMarkdown(`[a](./a.md) [b](https://x.com) [c](#anchor)\n`, "x.md");
    expect(doc.links).toHaveLength(3);
    expect(doc.links[0]!.isLocal).toBe(true);
    expect(doc.links[1]!.isLocal).toBe(false);
    expect(doc.links[2]!.isLocal).toBe(false);
  });

  it("treats GitHub-relative URLs as non-local (issues, pulls, etc.)", () => {
    // These look like filesystem paths but are rewritten by GitHub when a
    // README is rendered on github.com. Flagging them as broken local
    // links would erode trust in docs_code_drift.
    const doc = parseMarkdown(
      [
        "[Issues](../../issues)",
        "[Open issue](../../issues/new?title=foo)",
        "[PR 42](../../pull/42)",
        "[Pull requests](../../pulls)",
        "[Wiki](../../wiki/Home)",
        "[Releases](../../releases/tag/v1.0.0)",
        "[Actions](../../actions/workflows/ci.yml)",
        "[Compare](../../compare/main...HEAD)",
        "[Blob link](../../blob/main/PRD.md)",
        "[Tree link](../../tree/main/docs)",
        "[Discussions](../../discussions/123)",
      ].join("\n") + "\n",
      "x.md",
    );
    expect(doc.links).toHaveLength(11);
    for (const link of doc.links) {
      expect(link.isLocal).toBe(false);
    }
  });

  it("does not mistake a real relative link starting with ../../ for a GitHub URL", () => {
    // `../../docs/foo.md` is a legitimate filesystem path two directories
    // up — the allowlist must only match the GitHub-specific path
    // segments (issues, pulls, wiki, …).
    const doc = parseMarkdown("[Local](../../docs/foo.md)\n", "x.md");
    expect(doc.links).toHaveLength(1);
    expect(doc.links[0]!.isLocal).toBe(true);
  });

  it("ignores link-shaped text inside inline backtick code spans", () => {
    const doc = parseMarkdown(
      "Example: `[label](path)` describes link syntax.\n",
      "x.md",
    );
    expect(doc.links).toEqual([]);
  });

  it("captures the first command line of a fenced block", () => {
    const doc = parseMarkdown(
      "```bash\n$ crimes scan\n# subsequent comment\n```\n",
      "x.md",
    );
    expect(doc.fencedCommands).toEqual([
      { command: "crimes scan", line: 2, deferred: false },
    ]);
  });

  it("flags fenced commands inside a deferred paragraph", () => {
    const doc = parseMarkdown(
      "Not yet implemented:\n\n```bash\ncrimes ask\n```\n",
      "x.md",
    );
    expect(doc.fencedCommands).toHaveLength(1);
    expect(doc.fencedCommands[0]!.deferred).toBe(true);
  });
});

describe("extractReferencedCommands", () => {
  it("returns [] when no bin names are declared", () => {
    const doc = parseMarkdown("```bash\ncrimes scan\n```\n", "x.md");
    expect(extractReferencedCommands(doc, [], "")).toEqual([]);
  });

  it("captures bin+subcommand pairs from fenced blocks", () => {
    const src = "```bash\ncrimes scan\n```\n```bash\ncrimes context foo\n```\n";
    const doc = parseMarkdown(src, "x.md");
    const cmds = extractReferencedCommands(doc, ["crimes"], src);
    expect(cmds.sort()).toEqual(["crimes context", "crimes scan"]);
  });

  it("captures inline backtick mentions outside fences", () => {
    const src = "Use `crimes scan` before editing.";
    const doc = parseMarkdown(src, "x.md");
    const cmds = extractReferencedCommands(doc, ["crimes"], src);
    expect(cmds).toContain("crimes scan");
  });

  it("ignores deferred-block commands", () => {
    const src = "Not implemented:\n```bash\ncrimes ask\n```\n";
    const doc = parseMarkdown(src, "x.md");
    const cmds = extractReferencedCommands(doc, ["crimes"], src);
    expect(cmds).toEqual([]);
  });
});
