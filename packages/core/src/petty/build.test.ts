import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildPettyIndex } from "./build.js";

describe("buildPettyIndex", () => {
  it("indexes repeated domain-looking literals in production files", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-petty-"));
    await mkdir(join(root, "src"));
    const a = join(root, "src/ui.ts");
    const b = join(root, "src/api.ts");
    await writeFile(
      a,
      `export const label = "enterprise";\nconst cls = "flex items-center";\n`,
    );
    await writeFile(b, `const plan = "enterprise";\n`);

    const index = await buildPettyIndex({ root, files: [a, b] });
    expect(index.domainLiterals.enterprise?.map((hit) => hit.file)).toEqual([
      "src/api.ts",
      "src/ui.ts",
    ]);
    expect(index.domainLiterals["flex items-center"]).toBeUndefined();
  });

  it("skips tests, imports, paths, and prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "crimes-petty-"));
    await mkdir(join(root, "src"));
    const src = join(root, "src/app.ts");
    const test = join(root, "src/app.test.ts");
    await writeFile(
      src,
      `import x from "./enterprise";\nconst img = "/billing/icon.svg";\nconst msg = "Enterprise billing is ready for all users";\n`,
    );
    await writeFile(test, `it("enterprise", () => expect(true).toBe(true));\n`);

    const index = await buildPettyIndex({ root, files: [src, test] });
    expect(index.domainLiterals).toEqual({});
  });
});
