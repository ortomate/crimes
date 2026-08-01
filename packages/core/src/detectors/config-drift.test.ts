import { describe, expect, it } from "vitest";
import { configDriftDetector } from "./config-drift.js";
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
    out.push(...(await configDriftDetector.run(await jsContext(repo, file, config))));
  }
  return out;
}

function findByName(findings: PreFinding[], name: string): PreFinding | undefined {
  return findings.find((f) => f.symbol === name);
}

describe("config_drift — positive cases", () => {
  it("reports a variable parsed as different types", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const t = Number(process.env.REQUEST_TIMEOUT_MS);`,
      "src/b.ts": `export const on = process.env.REQUEST_TIMEOUT_MS === "true";`,
    });
    const finding = findByName(await runOn(repo), "REQUEST_TIMEOUT_MS");
    expect(finding).toBeDefined();
    expect(finding!.type).toBe("config_drift");
    expect(finding!.charge).toBe("Environment Roulette");

    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("issue — parsed as different types:");
    expect(evidence).toContain("parsers observed: boolean, number");
    expect(evidence).toContain("src/a.ts:1 parses as number");
  });

  it("treats Number / parseInt / parseFloat as one type, not three", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const p = Number(process.env.PORT);`,
      "src/b.ts": `export const q = parseInt(process.env.PORT, 10);`,
    });
    const finding = findByName(await runOn(repo), "PORT");
    const evidence = finding?.evidence.join("\n") ?? "";
    expect(evidence).not.toContain("parsed as different types");
  });

  it("reports disagreeing defaults with both values", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const t = Number(process.env.TIMEOUT_MS ?? "5000");`,
      "src/b.ts": `export const u = Number(process.env.TIMEOUT_MS ?? "30000");`,
    });
    const finding = findByName(await runOn(repo), "TIMEOUT_MS");
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("issue — given different defaults:");
    expect(evidence).toContain('defaults observed: "30000", "5000"');
  });

  it("reports requiredness disagreement", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const url = process.env.DATABASE_URL!;`,
      "src/b.ts": `export const maybe = process.env.DATABASE_URL ?? "";`,
    });
    const finding = findByName(await runOn(repo), "DATABASE_URL");
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("required in one place, optional in another");
    expect(evidence).toMatch(/1 read\(s\) treat it as required, 1 do not/);
  });

  it("reports a secret carrying a client-exposing prefix at high severity", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;`,
      "src/b.ts": `export const j = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;`,
    });
    const finding = findByName(await runOn(repo), "NEXT_PUBLIC_STRIPE_SECRET_KEY");
    expect(finding!.severity).toBe("high");
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("which bundlers inline into client output");
    const actions = finding!.suggested_actions ?? [];
    expect(actions[0]!.kind).toBe("unprefix_secret");
    expect(actions[0]!.description).toContain("rotate the current value");
  });

  it("reports a direct read that bypasses a central config module", async () => {
    const repo = await makeRepo({
      "src/config.ts": `
        export const port = Number(process.env.PORT ?? "3000");
        export const host = process.env.HOST ?? "0.0.0.0";
        export const url = process.env.DATABASE_URL;
      `,
      "src/worker.ts": `export const p = Number(process.env.PORT ?? "3000");`,
    });
    const finding = findByName(await runOn(repo), "PORT");
    const evidence = finding!.evidence.join("\n");
    expect(evidence).toContain("read directly despite a central config module");
    expect(evidence).toContain("src/config.ts");
  });

  it("reports a variable used but absent from .env.example", async () => {
    const repo = await makeRepo({
      ".env.example": "PORT=\nHOST=\n",
      "src/a.ts": `export const s = process.env.SECRET_SAUCE;`,
      "src/b.ts": `export const t = process.env.SECRET_SAUCE;`,
    });
    const finding = findByName(await runOn(repo), "SECRET_SAUCE");
    expect(finding!.evidence.join("\n")).toContain("used but not documented");
  });

  it("never puts a configuration value in a finding", async () => {
    const repo = await makeRepo({
      ".env.example": "API_TOKEN=\n",
      // A real `.env` is never globbed; this proves the inventory reader
      // is also name-only for the files it does read.
      ".env": "API_TOKEN=sk_live_supersecretvalue\n",
      "src/a.ts": `export const t = process.env.API_TOKEN!;`,
      "src/b.ts": `export const u = process.env.API_TOKEN ?? "";`,
    });
    const all = (await runOn(repo)).map((f) => JSON.stringify(f)).join("\n");
    expect(all).not.toContain("sk_live_supersecretvalue");
    expect(all).toContain("API_TOKEN");
    // The explicit promise is stated in evidence, so a reader knows.
    expect(all).toContain("no configuration values are reported by this detector");
  });
});

describe("config_drift — false-positive boundaries", () => {
  it("says nothing about a variable handled consistently", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const p = Number(process.env.PORT ?? "3000");`,
      "src/b.ts": `export const q = Number(process.env.PORT ?? "3000");`,
    });
    expect(findByName(await runOn(repo), "PORT")).toBeUndefined();
  });

  it("does not report a single-file read that is only undocumented", async () => {
    const repo = await makeRepo({
      ".env.example": "PORT=\n",
      "src/a.ts": `export const x = process.env.ONE_OFF;`,
    });
    expect(findByName(await runOn(repo), "ONE_OFF")).toBeUndefined();
  });

  it("does not treat a non-secret public variable as exposure", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const u = process.env.NEXT_PUBLIC_SITE_URL;`,
      "src/b.ts": `export const v = process.env.NEXT_PUBLIC_SITE_URL;`,
    });
    expect(findByName(await runOn(repo), "NEXT_PUBLIC_SITE_URL")).toBeUndefined();
  });

  it("does not report boundary bypass when there is no central module", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const p = process.env.PORT;`,
      "src/b.ts": `export const q = process.env.PORT;`,
    });
    expect(findByName(await runOn(repo), "PORT")).toBeUndefined();
  });
});

describe("config_drift — documented-but-unused", () => {
  it("is off by default and reports when enabled", async () => {
    const repo = await makeRepo({
      ".env.example": "PORT=\nLEGACY_FLAG=\nOLD_URL=\n",
      "src/a.ts": `export const p = process.env.PORT;`,
    });
    expect(await runOn(repo)).toHaveLength(0);

    const findings = await runOn(
      repo,
      configWithOptions("config_drift", { reportUnused: true }),
    );
    const unused = findings.find((f) => f.symbol === "(documented but unused)");
    expect(unused).toBeDefined();
    expect(unused!.severity).toBe("low");
    expect(unused!.evidence.join("\n")).toContain(
      "documented but unread: LEGACY_FLAG, OLD_URL",
    );
  });

  it("stays silent when the code performs computed reads it cannot enumerate", async () => {
    const repo = await makeRepo({
      ".env.example": "PORT=\nLEGACY_FLAG=\n",
      "src/a.ts": `export function get(name) { return process.env[name]; }`,
    });
    const findings = await runOn(
      repo,
      configWithOptions("config_drift", { reportUnused: true }),
    );
    expect(findings.find((f) => f.symbol === "(documented but unused)")).toBeUndefined();
  });
});

describe("config_drift — configuration", () => {
  const DRIFT = {
    "src/a.ts": `export const t = Number(process.env.TIMEOUT_MS ?? "5000");`,
    "src/b.ts": `export const u = Number(process.env.TIMEOUT_MS ?? "30000");`,
  };

  it("honours ignoreNames", async () => {
    const repo = await makeRepo(DRIFT);
    expect(findByName(await runOn(repo), "TIMEOUT_MS")).toBeDefined();
    expect(
      findByName(
        await runOn(
          repo,
          configWithOptions("config_drift", { ignoreNames: ["TIMEOUT_MS"] }),
        ),
        "TIMEOUT_MS",
      ),
    ).toBeUndefined();
  });

  it("honours reportUndocumented: false", async () => {
    const repo = await makeRepo({
      ".env.example": "PORT=\n",
      "src/a.ts": `export const s = process.env.UNDOCUMENTED;`,
      "src/b.ts": `export const t = process.env.UNDOCUMENTED;`,
    });
    expect(findByName(await runOn(repo), "UNDOCUMENTED")).toBeDefined();
    expect(
      findByName(
        await runOn(
          repo,
          configWithOptions("config_drift", { reportUndocumented: false }),
        ),
        "UNDOCUMENTED",
      ),
    ).toBeUndefined();
  });

  it("honours publicPrefixes for a project-specific convention", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const k = process.env.CLIENT_STRIPE_SECRET;`,
      "src/b.ts": `export const j = process.env.CLIENT_STRIPE_SECRET;`,
    });
    const finding = findByName(
      await runOn(
        repo,
        configWithOptions("config_drift", { publicPrefixes: ["CLIENT_"] }),
      ),
      "CLIENT_STRIPE_SECRET",
    );
    expect(finding?.severity).toBe("high");
  });

  it("validates its options schema", () => {
    const schema = configDriftDetector.optionsSchema!;
    expect(schema.safeParse({ reportUnused: true }).success).toBe(true);
    expect(schema.safeParse({ ignoreNames: ["A"] }).success).toBe(true);
    expect(schema.safeParse({ ignoreNames: "A" }).success).toBe(false);
    expect(schema.safeParse({ typo: 1 }).success).toBe(false);
  });
});

describe("config_drift — stability", () => {
  it("is deterministic across runs", async () => {
    const repo = await makeRepo({
      "src/a.ts": `export const t = Number(process.env.TIMEOUT_MS ?? "5000");`,
      "src/b.ts": `export const u = Number(process.env.TIMEOUT_MS ?? "30000");`,
    });
    expect(JSON.stringify(await runOn(repo))).toBe(JSON.stringify(await runOn(repo)));
  });

  it("anchors on the lexicographically first reading file", async () => {
    const repo = await makeRepo({
      "src/zzz.ts": `export const t = Number(process.env.TIMEOUT_MS ?? "5000");`,
      "src/aaa.ts": `export const u = Number(process.env.TIMEOUT_MS ?? "30000");`,
    });
    const finding = findByName(await runOn(repo), "TIMEOUT_MS");
    expect(finding!.file).toBe("src/aaa.ts");
    expect(finding!.related_files).toEqual(["src/zzz.ts"]);
  });

  it("uses the variable name as the symbol so fingerprints stay unique", async () => {
    const repo = await makeRepo({
      "src/a.ts": `
        export const t = Number(process.env.TIMEOUT_MS ?? "5000");
        export const r = Number(process.env.RETRY_MS ?? "100");
      `,
      "src/b.ts": `
        export const u = Number(process.env.TIMEOUT_MS ?? "30000");
        export const s = Number(process.env.RETRY_MS ?? "500");
      `,
    });
    const findings = await runOn(repo);
    expect(findings.map((f) => f.symbol).sort()).toEqual(["RETRY_MS", "TIMEOUT_MS"]);
    expect(new Set(findings.map((f) => `${f.file}::${f.symbol}`)).size).toBe(2);
  });
});
