// The built CLI is the single workflow source; checked-in host copies must match.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const temporary = await mkdtemp(resolve(tmpdir(), "crimes-sync-skills-"));
try {
  execFileSync(
    process.execPath,
    [resolve(root, "packages/cli/dist/index.js"), "init", "--refresh-skills", "--agents"],
    { cwd: temporary },
  );
  for (const host of [".agents", ".claude"]) {
    const relative = `${host}/skills/crimes/SKILL.md`;
    const expected = await readFile(resolve(temporary, relative), "utf8");
    if (check) {
      if ((await readFile(resolve(root, relative), "utf8")) !== expected) {
        throw new Error(`${relative} is stale; run pnpm docs:generate`);
      }
    } else {
      await writeFile(resolve(root, relative), expected);
    }
  }
  process.stdout.write(
    `Bundled agent skills ${check ? "match" : "updated from"} the built CLI.\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
