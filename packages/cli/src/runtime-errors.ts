import { ConfigParseError, UnknownDetectorError } from "@crimes/core";

/**
 * Exit-code 2 errors raised by config / detector setup. The CLI command
 * runners catch these around every `scan()` / `context()` / `verdict()`
 * call so the user sees a single-line message rather than a stack trace.
 */
export function isUserSetupError(
  error: unknown,
): error is ConfigParseError | UnknownDetectorError {
  return error instanceof ConfigParseError || error instanceof UnknownDetectorError;
}

/**
 * Write the error message to stderr (prefixed with `crimes:`) and exit 2.
 * Intended to be the last line in a CLI catch block when the caller is
 * willing to terminate the process.
 */
export function fatalUserError(error: ConfigParseError | UnknownDetectorError): void {
  process.stderr.write(`crimes: ${error.message}\n`);
  process.exit(2);
}
