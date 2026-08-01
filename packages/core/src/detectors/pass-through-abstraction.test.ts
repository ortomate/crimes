import { describe, expect, it } from "vitest";
import { passThroughAbstractionDetector } from "./pass-through-abstraction.js";
import {
  configWithOptions,
  jsContext,
  makeRepo,
  type TestRepo,
} from "../risk/test-harness.js";
import type { CrimesConfig } from "../config.js";
import type { PreFinding } from "../finding.js";

async function runOn(
  repo: TestRepo,
  config?: CrimesConfig,
): Promise<PreFinding[]> {
  const out: PreFinding[] = [];
  for (const absolutePath of repo.files) {
    const file = absolutePath.slice(repo.root.length + 1);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    out.push(
      ...(await passThroughAbstractionDetector.run(await jsContext(repo, file, config))),
    );
  }
  return out;
}

/** Four layers, four files, nothing added by any of them. */
const CHAIN = {
  "src/api/users.ts": `
    import { saveUser } from "../services/users.js";
    export function createUser(user) { return saveUser(user); }
  `,
  "src/services/users.ts": `
    import { persistUser } from "../repo/users.js";
    export function saveUser(user) { return persistUser(user); }
  `,
  "src/repo/users.ts": `
    import { writeUser } from "../db/users.js";
    export function persistUser(user) { return writeUser(user); }
  `,
  "src/db/users.ts": `
    export function writeUser(user) { return db.users.insert(user); }
  `,
};

describe("pass_through_abstraction — chains", () => {
  it("reports a chain of empty layers spanning several files", async () => {
    const findings = await runOn(await makeRepo(CHAIN));
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.type).toBe("pass_through_abstraction");
    expect(finding.charge).toBe("Abstraction Laundering");
    expect(finding.file).toBe("src/api/users.ts");
    expect(finding.symbol).toBe("createUser");
  });

  it("renders the call chain and says what each layer adds", async () => {
    const evidence = (await runOn(await makeRepo(CHAIN)))[0]!.evidence.join("\n");
    expect(evidence).toContain("call chain, 4 layers across 4 files:");
    expect(evidence).toContain("src/api/users.ts:3 `createUser(…)` → `saveUser(…)` — adds nothing");
    expect(evidence).toContain("`persistUser(…)` → `writeUser(…)` — adds nothing");
    expect(evidence).toContain("⇒ db.users.insert(…)");
    expect(evidence).toContain(
      "no layer performs a transformation, applies a default, narrows a type, or adds instrumentation",
    );
  });

  it("stays low severity for a short chain and rises for a long one", async () => {
    const short = await makeRepo({
      "src/a/one.ts": `import { two } from "../b/two.js";\nexport function one(x) { return two(x); }`,
      "src/b/two.ts": `import { three } from "../c/three.js";\nexport function two(x) { return three(x); }`,
      "src/c/three.ts": `export function three(x) { return db.write(x); }`,
    });
    const [shortFinding] = await runOn(short);
    const [longFinding] = await runOn(await makeRepo(CHAIN));
    expect(shortFinding!.severity).toBe("low");
    expect(longFinding!.scores.severity).toBeGreaterThan(shortFinding!.scores.severity);
  });

  it("lists the rest of the chain as related files, in chain order", async () => {
    // Chain order, not sorted: the reader follows the same path the
    // evidence renders. The walk is deterministic, so the order is too.
    const [finding] = await runOn(await makeRepo(CHAIN));
    expect(finding!.related_files).toEqual([
      "src/services/users.ts",
      "src/repo/users.ts",
      "src/db/users.ts",
    ]);
  });
});

describe("pass_through_abstraction — clusters", () => {
  it("reports a type whose members all forward to one collaborator", async () => {
    const repo = await makeRepo({
      "src/services/order-service.ts": `
        export class OrderService {
          constructor(repo) { this.repo = repo; }
          find(id) { return this.repo.find(id); }
          save(order) { return this.repo.save(order); }
          remove(id) { return this.repo.remove(id); }
          list(filter) { return this.repo.list(filter); }
        }
      `,
    });
    const [finding] = await runOn(repo);
    expect(finding!.symbol).toBe("this.repo");
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("4 function(s) in this file forward to `this.repo` and add nothing");
    expect(evidence).toContain("share a name with the method they call");
    expect(evidence).toContain(
      "every caller of this type could call `this.repo` directly with no change in behaviour",
    );
  });

  it("does not report a class that mostly does real work", async () => {
    const repo = await makeRepo({
      "src/services/order-service.ts": `
        export class OrderService {
          constructor(repo) { this.repo = repo; }
          find(id) { return this.repo.find(id); }
          save(order) { return this.repo.save({ ...order, updatedAt: now() }); }
          total(order) { return order.items.reduce((a, b) => a + b.price, 0); }
        }
      `,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });
});

describe("pass_through_abstraction — false-positive boundaries", () => {
  it("never reports an isolated thin wrapper", async () => {
    const repo = await makeRepo({
      "src/api/users.ts": `
        import { saveUser } from "../services/users.js";
        export function createUser(user) { return saveUser(user); }
      `,
      "src/services/users.ts": `export function saveUser(user) { return db.users.insert(user); }`,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("does not report a chain where a layer adds something", async () => {
    const repo = await makeRepo({
      "src/a/one.ts": `import { two } from "../b/two.js";\nexport function one(x) { return two(x); }`,
      "src/b/two.ts": `import { three } from "../c/three.js";\nexport async function two(x) { return await three(x, "v2"); }`,
      "src/c/three.ts": `import { four } from "../d/four.js";\nexport function three(x) { return four(x); }`,
      "src/d/four.ts": `export function four(x) { return db.write(x); }`,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("does not report a chain confined to one file", async () => {
    const repo = await makeRepo({
      "src/a.ts": `
        export function one(x) { return two(x); }
        export function two(x) { return three(x); }
        export function three(x) { return db.write(x); }
      `,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });

  it("excludes deliberate architectural boundaries by path", async () => {
    const boundaryChain: Record<string, string> = {};
    for (const [path, source] of Object.entries(CHAIN)) {
      boundaryChain[path.replace("src/api/", "src/adapters/")] = source;
    }
    expect(await runOn(await makeRepo(boundaryChain))).toHaveLength(0);
  });

  it("never fires in tests, fixtures, or generated code", async () => {
    const testChain: Record<string, string> = {};
    for (const [path, source] of Object.entries(CHAIN)) {
      testChain[path.replace("src/", "test/fixtures/")] = source;
    }
    expect(await runOn(await makeRepo(testChain))).toHaveLength(0);
  });

  it("does not treat recursion as indirection", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export function walk(n) { return walk(n.next); }`,
      "src/b.ts": `export function step(n) { return step(n.next); }`,
    });
    expect(await runOn(repo)).toHaveLength(0);
  });
});

describe("pass_through_abstraction — configuration", () => {
  it("honours minChainLength", async () => {
    const repo = await makeRepo(CHAIN);
    expect(await runOn(repo)).toHaveLength(1);
    expect(
      await runOn(repo, configWithOptions("pass_through_abstraction", { minChainLength: 6 })),
    ).toHaveLength(0);
  });

  it("honours minClusterSize", async () => {
    const cluster = {
      "src/services/order-service.ts": `
        export class OrderService {
          constructor(repo) { this.repo = repo; }
          find(id) { return this.repo.find(id); }
          save(order) { return this.repo.save(order); }
          remove(id) { return this.repo.remove(id); }
          list(filter) { return this.repo.list(filter); }
        }
      `,
    };
    const repo = await makeRepo(cluster);
    expect(await runOn(repo)).toHaveLength(1);
    expect(
      await runOn(repo, configWithOptions("pass_through_abstraction", { minClusterSize: 8 })),
    ).toHaveLength(0);
  });

  it("honours boundaryPaths", async () => {
    const repo = await makeRepo(CHAIN);
    expect(
      await runOn(repo, configWithOptions("pass_through_abstraction", {
        boundaryPaths: ["src/repo/"],
      })),
    ).toHaveLength(0);
  });

  it("validates its options schema", () => {
    const schema = passThroughAbstractionDetector.optionsSchema!;
    expect(schema.safeParse({ minChainLength: 4 }).success).toBe(true);
    expect(schema.safeParse({ minChainLength: 1 }).success).toBe(false);
    expect(schema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("pass_through_abstraction — stability", () => {
  it("is deterministic across runs", async () => {
    const repo = await makeRepo(CHAIN);
    expect(JSON.stringify(await runOn(repo))).toBe(JSON.stringify(await runOn(repo)));
  });

  it("reports one finding per chain, not one per link", async () => {
    // Four links would be four findings under a naive walk. The head of
    // the chain is the only emission point.
    const findings = await runOn(await makeRepo(CHAIN));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.join("\n")).toContain("4 layers");
  });
});
