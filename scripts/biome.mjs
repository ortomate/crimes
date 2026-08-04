// Run biome, and fail if it did not actually check anything.
//
// Biome 2.5.6 can abort its worker pool under memory pressure, print
//
//   [warn] Linter process terminated abnormally (possibly out of memory)
//
// as its *only* output, and still exit 0. `pnpm verify` then reports
// green with the lint step having done nothing. That is how ~16 commits
// (`6edfe2d`..`053cd14`) landed without lint ever running — the failure
// is silent by construction, so nobody could have noticed.
//
// Observed four times in one session across `lint`, `format`, `check`
// and even `--version`, on a machine with ~55MB of genuinely free
// pages. It is intermittent: 100 consecutive invocations under the same
// conditions did not reproduce it.
//
// The guard is the durable half of the fix. A real run always ends with
// a `Checked N files in Xms` summary; an aborted one has no summary at
// all. Absence of that line with a zero exit code is the exact
// signature of the silent no-op, so we turn it into a loud failure.
//
// Usage: node scripts/biome.mjs lint .

import { spawn } from "node:child_process";

const SUMMARY = /Checked \d+ files? in /;
const ABNORMAL = /terminated abnormally/;

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("scripts/biome.mjs: expected a biome subcommand\n");
  process.exit(2);
}

const child = spawn("biome", args, {
  stdio: ["inherit", "pipe", "pipe"],
  // Resolve `biome` from the workspace root's node_modules/.bin, which
  // pnpm puts on PATH for scripts run through `pnpm run`.
  shell: false,
});

let captured = "";

child.stdout.on("data", (chunk) => {
  captured += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  captured += chunk;
  process.stderr.write(chunk);
});

child.on("error", (err) => {
  process.stderr.write(`scripts/biome.mjs: could not run biome — ${err.message}\n`);
  process.exit(1);
});

child.on("close", (code) => {
  if (code !== 0) process.exit(code ?? 1);

  if (!SUMMARY.test(captured)) {
    const abnormal = ABNORMAL.test(captured);
    process.stderr.write(
      `\nscripts/biome.mjs: \`biome ${args.join(" ")}\` exited 0 but never ` +
        "reported a `Checked N files` summary — it did not check anything.\n" +
        (abnormal
          ? "Its worker pool aborted (see the warning above); this is usually " +
            "memory pressure. Free some memory and re-run.\n"
          : "Output did not match any known biome shape.\n") +
        "Treating this as a failure rather than letting the step pass silently.\n",
    );
    process.exit(1);
  }
});
