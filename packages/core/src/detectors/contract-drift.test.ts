import { describe, expect, it } from "vitest";
import { contractDriftDetector } from "./contract-drift.js";
import {
  configWithOptions,
  jsContext,
  makeRepo,
  type TestRepo,
} from "../risk/test-harness.js";
import type { CrimesConfig } from "../config.js";
import type { PreFinding } from "../finding.js";

async function runOn(repo: TestRepo, config?: CrimesConfig): Promise<PreFinding[]> {
  const out: PreFinding[] = [];
  for (const absolutePath of repo.files) {
    const file = absolutePath.slice(repo.root.length + 1);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    out.push(...(await contractDriftDetector.run(await jsContext(repo, file, config))));
  }
  return out;
}

const API_USER = `
export interface User {
  id: string;
  email: string;
  role: "admin" | "member";
  createdAt: Date;
}
`;

const DB_USER_SCHEMA = `
export const UserSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  role: z.enum(["admin", "member", "owner"]),
  createdAt: z.string(),
});
`;

describe("contract_drift — positive cases", () => {
  it("reports an interface and a Zod schema that disagree", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    const findings = await runOn(repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("contract_drift");
    expect(findings[0]!.charge).toBe("Contract Split-Brain");
    expect(findings[0]!.file).toBe("src/api/user.ts");
    expect(findings[0]!.related_files).toEqual(["src/db/user.ts"]);
  });

  it("renders a field-level comparison naming both sides", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    const evidence = (await runOn(repo))[0]!.evidence.join("\n");

    expect(evidence).toContain("A: `User` (interface) — src/api/user.ts:2");
    expect(evidence).toContain("B: `UserSchema` (zod) — src/db/user.ts:2");
    // Requiredness.
    expect(evidence).toMatch(/email: A is required, B is optional \(requiredness\)/);
    // Value set.
    expect(evidence).toMatch(/role: A is .*admin.* B is .*owner.*\(value set\)/);
    // Type, with the critical-field annotation.
    expect(evidence).toMatch(
      /createdAt: A is Date, B is string \(type\) \[timestamp field\]/,
    );
  });

  it("states why the two were matched", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    const evidence = (await runOn(repo))[0]!.evidence.join("\n");
    expect(evidence).toContain(
      'matched because: both names reduce to the concept "user"',
    );
    expect(evidence).toMatch(/matched because: 4 shared field\(s\), 100% of the smaller/);
    expect(evidence).toContain(
      "declared in different forms (interface vs zod), so no type checker compares them",
    );
  });

  it("escalates severity for disagreements on critical fields", async () => {
    const repo = await makeRepo({
      "src/a/order.ts": `export interface Order { id: string; tenantId: string; total: number }`,
      "src/b/order.ts": `export interface OrderModel { id: number; tenantId: string; total: string }`,
    });
    const [finding] = await runOn(repo);
    expect(finding!.severity).toBe("high");
    expect(finding!.score_rationale!.join("\n")).toMatch(
      /severity raised by:.*disagreement on identifier field/,
    );
  });

  it("suggests deriving one side from the schema when one is Zod", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    const actions = (await runOn(repo))[0]!.suggested_actions ?? [];
    expect(actions[0]!.description).toContain("z.infer<typeof UserSchema>");
  });

  it("reads Valibot schemas too", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": `export interface User { id: string; email: string; role: string }`,
      "src/b/user.ts": `export const UserSchema = v.object({ id: v.string(), email: v.optional(v.string()), role: v.string() });`,
    });
    const [finding] = await runOn(repo);
    expect(finding!.evidence.join("\n")).toContain("(valibot)");
  });
});

describe("contract_drift — projection boundaries", () => {
  it("does not pair a summary with the full record", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": API_USER,
      "src/b/summary.ts": `export interface UserSummary { id: string; email?: string; role: string; createdAt: string }`,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("does not pair a create-input with the full record", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": API_USER,
      "src/b/input.ts": `export interface CreateUserInput { id?: string; email: string; role?: string; createdAt?: Date }`,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("does not pair a public view or a DB row with the full record", async () => {
    const publicView = await makeRepo({
      "src/a/user.ts": API_USER,
      "src/b/public.ts": `export interface PublicUser { id: string; email?: string; role: string; createdAt: string }`,
    });
    expect(await runOn(publicView)).toHaveLength(0);

    const row = await makeRepo({
      "src/a/user.ts": API_USER,
      "src/b/row.ts": `export interface UserRow { id: string; email?: string; role: string; createdAt: string }`,
    });
    expect(await runOn(row)).toHaveLength(0);
  });

  it("does pair two spellings that carry the same projection marker", async () => {
    const repo = await makeRepo({
      "src/a/summary.ts": `export interface UserSummary { id: string; email: string; role: string }`,
      "src/b/summary.ts": `export interface UserSummaryDTO { id: string; email?: string; role: string }`,
    });
    expect(await runOn(repo)).toHaveLength(1);
  });

  it("treats DTO / Model / Entity as the same concept", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": `export interface UserDTO { id: string; email: string; role: string }`,
      "src/b/user.ts": `export interface UserEntity { id: string; email?: string; role: string }`,
    });
    expect(await runOn(repo)).toHaveLength(1);
  });
});

describe("contract_drift — false-positive boundaries", () => {
  it("says nothing when the two declarations agree", async () => {
    const same = `export interface User { id: string; email: string; role: string }`;
    const repo = await makeRepo({ "src/a/user.ts": same, "src/b/user.ts": same });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("requires substantial field overlap", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": `export interface User { id: string; email: string; role: string; plan: string }`,
      "src/b/user.ts": `export interface UserModel { id: number; nickname: string; avatar: string; bio: string }`,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("never claims a field is missing from a partial declaration", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": `export interface User { id: string; email: string; tenantId: string }`,
      "src/b/user.ts": `export interface UserModel extends Base { id: string; email: string }`,
    });
    const findings = await runOn(repo);
    const evidence = findings.map((f) => f.evidence.join("\n")).join("\n");
    expect(evidence).not.toContain("tenantId: A is declared");
    if (findings.length > 0) {
      expect(evidence).toContain("extends or spreads a type this scan did not expand");
    }
  });

  it("honours an explicit .partial() rather than reporting it as drift", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": `export interface User { id: string; email: string; role: string }`,
      "src/b/user.ts": `export const UserSchema = z.object({ id: z.string(), email: z.string(), role: z.string() });`,
    });
    // Identical → nothing. Now make the schema `.partial()`: every field
    // becomes optional, which IS a disagreement and should be reported.
    expect(await runOn(repo)).toHaveLength(0);

    const partial = await makeRepo({
      "src/a/user.ts": `export interface User { id: string; email: string; role: string }`,
      "src/b/user.ts": `export const UserSchema = z.object({ id: z.string(), email: z.string(), role: z.string() }).partial();`,
    });
    const [finding] = await runOn(partial);
    expect(finding!.evidence.join("\n")).toMatch(/id: A is required, B is optional/);
  });

  it("ignores declarations in tests and fixtures", async () => {
    const repo = await makeRepo({
      "src/a/user.test.ts": API_USER,
      "test/fixtures/user.ts": DB_USER_SCHEMA,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("lowers confidence when both declarations live in one file", async () => {
    const together = await makeRepo({
      "src/user.ts": `${API_USER}\nexport interface UserModel { id: string; email?: string; role: string; createdAt: Date }`,
    });
    const apart = await makeRepo({
      "src/a/user.ts": API_USER,
      "src/b/user.ts": `export interface UserModel { id: string; email?: string; role: string; createdAt: Date }`,
    });
    const [inOneFile] = await runOn(together);
    const [acrossFiles] = await runOn(apart);
    expect(inOneFile!.confidence).toBeLessThan(acrossFiles!.confidence);
    expect(inOneFile!.score_rationale!.join("\n")).toContain(
      "same file (may be deliberate)",
    );
  });
});

describe("contract_drift — configuration", () => {
  it("honours minOverlap", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    expect(await runOn(repo)).toHaveLength(1);
    expect(
      await runOn(repo, configWithOptions("contract_drift", { minOverlap: 1 })),
    ).toHaveLength(1);
    // 4 shared fields out of 4 is 100% overlap, so raise the disagreement
    // floor instead to prove the knob works.
    expect(
      await runOn(repo, configWithOptions("contract_drift", { minDisagreements: 10 })),
    ).toHaveLength(0);
  });

  it("honours ignoreNames", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    expect(
      await runOn(
        repo,
        configWithOptions("contract_drift", { ignoreNames: ["UserSchema"] }),
      ),
    ).toHaveLength(0);
  });

  it("honours reportRequiredness: false", async () => {
    const repo = await makeRepo({
      "src/a/user.ts": `export interface User { id: string; email: string; role: string }`,
      "src/b/user.ts": `export interface UserModel { id: string; email?: string; role: string }`,
    });
    expect(await runOn(repo)).toHaveLength(1);
    expect(
      await runOn(
        repo,
        configWithOptions("contract_drift", { reportRequiredness: false }),
      ),
    ).toHaveLength(0);
  });

  it("validates its options schema", () => {
    const schema = contractDriftDetector.optionsSchema!;
    expect(schema.safeParse({ minOverlap: 0.8 }).success).toBe(true);
    expect(schema.safeParse({ minOverlap: 2 }).success).toBe(false);
    expect(schema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("contract_drift — stability", () => {
  it("produces identical output across runs", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    expect(JSON.stringify(await runOn(repo))).toBe(JSON.stringify(await runOn(repo)));
  });

  it("orders the pair deterministically regardless of which file is scanned first", async () => {
    const repo = await makeRepo({
      "src/zzz/user.ts": API_USER,
      "src/aaa/user.ts": DB_USER_SCHEMA,
    });
    const [finding] = await runOn(repo);
    expect(finding!.file).toBe("src/aaa/user.ts");
    expect(finding!.symbol).toBe("UserSchema");
  });

  it("separates two pairs anchored on the same declaration", async () => {
    // One declaration drifting against two others produces two findings
    // on the same (type, file, symbol) triple. The other side is what
    // makes them different.
    const repo = await makeRepo({
      "src/aaa/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
      "src/store/user.ts": `
        export interface UserModel {
          id: number;
          email: string;
          role: "admin" | "member";
          createdAt: Date;
        }
      `,
    });
    const findings = (await runOn(repo)).filter((f) => f.file === "src/aaa/user.ts");
    expect(findings.length).toBeGreaterThan(1);
    expect(new Set(findings.map((f) => f.symbol)).size).toBe(1);
    expect(new Set(findings.map((f) => f.discriminator)).size).toBe(findings.length);
  });

  it("leaves an unambiguous pair with no discriminator", async () => {
    const repo = await makeRepo({
      "src/api/user.ts": API_USER,
      "src/db/user.ts": DB_USER_SCHEMA,
    });
    const [finding] = await runOn(repo);
    expect(finding!.discriminator).toBeUndefined();
  });
});
