import { describe, expect, it } from "vitest";
import { duplicatedPolicyDetector } from "./duplicated-policy.js";
import {
  configWithOptions,
  jsContext,
  makeRepo,
  type TestRepo,
} from "../risk/test-harness.js";
import type { PreFinding } from "../finding.js";
import type { CrimesConfig } from "../config.js";

/**
 * `duplicated_policy` is cross-file: it emits once, at the
 * lexicographically first file of each clone group. `runOn` scans every
 * file so a test never has to know which file that is.
 */
async function runOn(repo: TestRepo, config?: CrimesConfig): Promise<PreFinding[]> {
  const out: PreFinding[] = [];
  for (const absolutePath of repo.files) {
    const file = absolutePath.slice(repo.root.length + 1);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const ctx = await jsContext(repo, file, config);
    out.push(...(await duplicatedPolicyDetector.run(ctx)));
  }
  return out;
}

const ROUTE_ADMIN_CHECK = `
import { loadBilling } from "../services/billing.js";

export async function exportBilling(user, res) {
  if (user.role === "admin" && user.plan !== "free") {
    return res.send(await loadBilling(user.id));
  }
  return res.status(403).end();
}
`;

const SERVICE_ADMIN_CHECK = `
export function canExportBilling(member) {
  if (member.role === "admin" && member.plan !== "free") {
    return true;
  }
  return false;
}
`;

describe("duplicated_policy — positive cases", () => {
  it("reports one authorization rule implemented in two files", async () => {
    const repo = await makeRepo({
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    });
    const findings = await runOn(repo);
    expect(findings).toHaveLength(1);

    const finding = findings[0]!;
    expect(finding.type).toBe("duplicated_policy");
    expect(finding.charge).toBe("Policy Doppelgänger");
    // Anchored at the lexicographically first file of the group.
    expect(finding.file).toBe("src/routes/export.ts");
    expect(finding.related_files).toEqual(["src/services/billing.ts"]);
  });

  it("cites both locations, the normalised rule, and why they are independent", async () => {
    const repo = await makeRepo({
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    });
    const [finding] = await runOn(repo);
    const evidence = finding!.evidence.join("\n");
    const rationale = finding!.score_rationale!.join("\n");

    expect(evidence).toMatch(/normalised rule: .+\.role/);
    expect(evidence).toContain("src/routes/export.ts:5 in exportBilling()");
    expect(evidence).toContain("src/services/billing.ts:3 in canExportBilling()");
    // The "why does this matter" line — a duplicate report without it is
    // just a diff.
    expect(evidence).toMatch(/no call site links them|nothing links the sites/);
    // Meaningful similarities.
    expect(evidence).toContain('shared literal value(s): "admin", "free"');
    expect(evidence).toMatch(/shared property path\(s\): user\.role/);
    expect(evidence).toContain("domain vocabulary:");
    // Confidence arithmetic is reconstructable.
    expect(rationale).toMatch(/confidence 0\.\d+ = 0\.60 base/);
  });

  it("normalises away local names, so two spellings of one rule collide", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export function f(actor) { if (actor.role === "admin" && actor.plan !== "free") return 1; return 0; }`,
      "src/b.ts": `export function g(principal) { if (principal.role === "admin" && principal.plan !== "free") return 1; return 0; }`,
    });
    expect(await runOn(repo)).toHaveLength(1);
  });

  it("reports a near-clone family as one finding, not one per pair", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export function a(u) { if (u.role === "admin" && u.status === "active") return 1; return 0; }`,
      "src/b.ts": `export function b(u) { if (u.role === "owner" && u.status === "active") return 1; return 0; }`,
      "src/c.ts": `export function c(u) { if (u.role === "member" && u.status === "active") return 1; return 0; }`,
    });
    const findings = await runOn(repo);
    // Three variants → three pairs. One family → one finding.
    expect(findings).toHaveLength(1);

    const evidence = findings[0]!.evidence.join("\n");
    expect(evidence).toContain("3 variants of one rule shape");
    expect(evidence).toMatch(
      /difference: one side tests "admin", the other tests "member"/,
    );
    expect(findings[0]!.related_files).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("escalates severity for authorization and billing concepts", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export function a(u) { if (u.role === "admin" && u.subscription !== "free") return 1; return 0; }`,
      "src/b.ts": `export function b(m) { if (m.role === "admin" && m.subscription !== "free") return 1; return 0; }`,
    });
    const [finding] = await runOn(repo);
    expect(finding!.score_rationale!.join("\n")).toMatch(
      /severity raised by:.*authorization rule/,
    );
  });
});

describe("duplicated_policy — false-positive boundaries", () => {
  it("ignores structural predicates however often they repeat", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) {
      files[`src/f${i}.ts`] =
        `export function f${i}(items) { if (items.length > 0) return 1; return 0; }`;
    }
    expect(await runOn(await makeRepo(files))).toHaveLength(0);
  });

  it("ignores rules with no business vocabulary even across many files", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`src/f${i}.ts`] =
        `export function f${i}(d) { if (d.pack === "language-py" && d.kind === "x") return 1; return 0; }`;
    }
    expect(await runOn(await makeRepo(files))).toHaveLength(0);
  });

  it("ignores trivial null and truthiness guards", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export function a(user) { if (!user) return 0; if (user == null) return 0; return 1; }`,
      "src/b.ts": `export function b(user) { if (!user) return 0; if (user == null) return 0; return 1; }`,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("does not report a rule that appears twice in one file", async () => {
    const repo = await makeRepo({
      "src/a.ts": `
        export function a(u) { if (u.role === "admin" && u.plan !== "free") return 1; return 0; }
        export function b(u) { if (u.role === "admin" && u.plan !== "free") return 2; return 0; }
      `,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("ignores clones in tests, fixtures, migrations, and generated code", async () => {
    const repo = await makeRepo({
      "src/a.test.ts": SERVICE_ADMIN_CHECK,
      "test/fixtures/b.ts": SERVICE_ADMIN_CHECK,
      "db/migrations/001_x.ts": SERVICE_ADMIN_CHECK,
      "src/__generated__/c.ts": SERVICE_ADMIN_CHECK,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("ignores a file carrying an @generated banner regardless of path", async () => {
    const repo = await makeRepo({
      "src/a.ts": `/** @generated */\n${SERVICE_ADMIN_CHECK}`,
      "src/b.ts": SERVICE_ADMIN_CHECK,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("leaves the bare role-comparison divergence to duplicated_role_status_plan_check", async () => {
    // Three files, two expression shapes, a bare comparison on a policy
    // name — the exact conditions of the 0.6.0 detector.
    const repo = await makeRepo({
      "src/a.ts": `export function a(u) { if (u.role === "admin") return 1; return 0; }`,
      "src/b.ts": `export function b(u) { if (u.role === "owner") return 1; return 0; }`,
      "src/c.ts": `export function c(u) { if (u.role === "admin") return 1; return 0; }`,
    });
    const findings = await runOn(repo);
    // The exact clone (a + c) is still ours — the older detector needs two
    // distinct shapes and cannot report it. The near-clone family is not.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join("\n")).toContain("normalised rule:");
    expect(findings[0]!.evidence.join("\n")).not.toContain("variants of one rule shape");
  });
});

describe("duplicated_policy — configuration", () => {
  it("honours minFiles", async () => {
    const repo = await makeRepo({
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    });
    expect(await runOn(repo)).toHaveLength(1);
    const config = configWithOptions("duplicated_policy", { minFiles: 3 });
    expect(await runOn(repo, config)).toHaveLength(0);
  });

  it("honours minTokens", async () => {
    const repo = await makeRepo({
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    });
    const config = configWithOptions("duplicated_policy", { minTokens: 50 });
    expect(await runOn(repo, config)).toHaveLength(0);
  });

  it("honours reportNearClones: false", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export function a(u) { if (u.role === "admin" && u.status === "active") return 1; return 0; }`,
      "src/b.ts": `export function b(u) { if (u.role === "owner" && u.status === "active") return 1; return 0; }`,
    });
    expect(await runOn(repo)).toHaveLength(1);
    const config = configWithOptions("duplicated_policy", { reportNearClones: false });
    expect(await runOn(repo, config)).toHaveLength(0);
  });

  it("honours ignorePaths", async () => {
    const repo = await makeRepo({
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    });
    const config = configWithOptions("duplicated_policy", { ignorePaths: ["role"] });
    expect(await runOn(repo, config)).toHaveLength(0);
  });

  it("validates its options schema", () => {
    const schema = duplicatedPolicyDetector.optionsSchema;
    expect(schema).toBeDefined();
    expect(schema!.safeParse({ minFiles: 3 }).success).toBe(true);
    expect(schema!.safeParse({ minFiles: 1 }).success).toBe(false);
    expect(schema!.safeParse({ unknownKey: true }).success).toBe(false);
    expect(schema!.safeParse({ minTokens: "many" }).success).toBe(false);
  });
});

describe("duplicated_policy — stability", () => {
  it("produces identical findings across repeated runs", async () => {
    const repo = await makeRepo({
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    });
    const first = JSON.stringify(await runOn(repo));
    const second = JSON.stringify(await runOn(repo));
    expect(first).toBe(second);
  });

  it("keeps the anchor and symbol stable when an unrelated file is added", async () => {
    const base = {
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    };
    const before = (await runOn(await makeRepo(base)))[0]!;
    const after = (
      await runOn(
        await makeRepo({ ...base, "src/aaa-unrelated.ts": "export const x = 1;\n" }),
      )
    )[0]!;
    expect(after.file).toBe(before.file);
    expect(after.symbol).toBe(before.symbol);
  });

  it("gives the finding a symbol derived from the rule, not the enclosing function", async () => {
    const repo = await makeRepo({
      "src/routes/export.ts": ROUTE_ADMIN_CHECK,
      "src/services/billing.ts": SERVICE_ADMIN_CHECK,
    });
    const [finding] = await runOn(repo);
    // Rule identity — built from the rule's own vocabulary and values —
    // so two different rules anchored in one function keep distinct
    // fingerprints, and a rename of the enclosing function does not
    // change the fingerprint.
    expect(finding!.symbol).toBe('admin plan "admin" "free" rule');
    expect(finding!.symbol).not.toBe("exportBilling");
  });
});

describe("duplicated_policy — fingerprint uniqueness", () => {
  it("separates two rules whose identity string is the same", async () => {
    // `ruleIdentity` is built from the rule's vocabulary and literals,
    // so two genuinely different rules over the same domain nouns
    // collapse to one symbol. Measured on n8n packages/cli: 5 findings
    // lost, four of them under
    // `duplicated_policy::…::credential rule`.
    const repo = await makeRepo({
      "src/a.ts": `
export function checkA(credential) {
  if (credential.type !== credential.expectedType) throw new Error("bad");
  if (!credential.scopes.includes(credential.type)) throw new Error("scope");
}
`,
      "src/b.ts": `
export function checkB(credential) {
  if (credential.type !== credential.expectedType) throw new Error("bad");
  if (!credential.scopes.includes(credential.type)) throw new Error("scope");
}
`,
    });
    const findings = await runOn(repo);
    const bySymbol = new Map<string, number>();
    for (const f of findings) {
      const key = `${f.file}::${f.symbol ?? ""}`;
      bySymbol.set(key, (bySymbol.get(key) ?? 0) + 1);
    }
    const ambiguous = [...bySymbol.values()].some((n) => n > 1);
    expect(ambiguous, "fixture must produce a symbol collision to be a real test").toBe(
      true,
    );

    const prints = findings.map(
      (f) => `${f.type}::${f.file}::${f.symbol ?? ""}::${f.discriminator ?? ""}`,
    );
    expect(new Set(prints).size).toBe(findings.length);
  });
});
