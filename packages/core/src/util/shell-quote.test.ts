import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell-quote.js";

const execFileAsync = promisify(execFile);

/**
 * Ask a real `sh` what it makes of the quoted value. Asserting against
 * a hand-written expected string only proves the function agrees with
 * the test author; asking the shell proves the thing the function
 * exists to guarantee.
 */
async function firstArgumentAfterRoundTrip(value: string): Promise<string> {
  const { stdout } = await execFileAsync("sh", [
    "-c",
    `printf '%s' ${shellQuote(value)}`,
  ]);
  return stdout;
}

describe("shellQuote", () => {
  it("keeps a path with spaces as a single argument", async () => {
    const fingerprint = "large_function::my src/big file.ts::generateInvoice";
    expect(await firstArgumentAfterRoundTrip(fingerprint)).toBe(fingerprint);
  });

  it("survives an embedded single quote", async () => {
    const fingerprint = "large_function::it's/a file.ts::f";
    expect(await firstArgumentAfterRoundTrip(fingerprint)).toBe(fingerprint);
  });

  it("does not expand a dollar sign or a backtick", async () => {
    const fingerprint = "magic_domain_literal_scatter::src/$HOME`whoami`.ts::";
    expect(await firstArgumentAfterRoundTrip(fingerprint)).toBe(fingerprint);
  });

  it("leaves an ordinary fingerprint readable", () => {
    expect(shellQuote("large_function::billing.ts::generateInvoice")).toBe(
      "'large_function::billing.ts::generateInvoice'",
    );
  });
});
