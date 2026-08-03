/**
 * Wrap a value so it survives being pasted into a POSIX shell.
 *
 * `crimes` prints commands for people and agents to copy — `crimes
 * ignore <fingerprint>`, `crimes feedback <fingerprint>`, `crimes
 * context <file>`. Every one of them embeds a repo path, and paths
 * contain spaces: `crimes ignore large_function::my src/big file.ts::f`
 * pasted bare arrives as three arguments. The command then fails, or
 * worse, silently addresses something other than what was printed.
 *
 * Single quotes rather than double, because a fingerprint can also
 * carry `$` or a backtick — which a double-quoted string would still
 * expand — and because inside single quotes the shell interprets
 * nothing at all. The `'\''` sequence is the standard way to carry an
 * embedded single quote through: close the quote, escape one, reopen.
 *
 * Quoting is unconditional rather than applied only when a path looks
 * dangerous. A command that is sometimes quoted teaches the reader to
 * check, and the check is exactly the thing they will skip.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
