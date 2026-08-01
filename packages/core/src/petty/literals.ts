export interface SourceStringLiteral {
  value: string;
  line: number;
  lineText: string;
}

export function extractStringLiterals(source: string): SourceStringLiteral[] {
  const literals: SourceStringLiteral[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let state: "code" | "line_comment" | "block_comment" = "code";

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === "\n") {
      line += 1;
      lineStart = i + 1;
      if (state === "line_comment") state = "code";
      i += 1;
      continue;
    }

    if (state === "line_comment") {
      i += 1;
      continue;
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "line_comment";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block_comment";
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const read = readLiteral(source, i, ch, line, lineStart);
      if (read.literal) literals.push(read.literal);
      i = read.nextIndex;
      line = read.line;
      lineStart = read.lineStart;
      continue;
    }

    i += 1;
  }

  return literals;
}

function readLiteral(
  source: string,
  start: number,
  quote: string,
  startLine: number,
  startLineStart: number,
): {
  literal?: SourceStringLiteral;
  nextIndex: number;
  line: number;
  lineStart: number;
} {
  let i = start + 1;
  let line = startLine;
  let lineStart = startLineStart;
  let value = "";
  let interpolated = false;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "\\") {
      value += ch + (next ?? "");
      i += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && next === "{") interpolated = true;
    if (ch === quote) {
      const endOfLine = source.indexOf("\n", start);
      const lineEnd = endOfLine === -1 ? source.length : endOfLine;
      return {
        literal: interpolated
          ? undefined
          : {
              value,
              line: startLine,
              lineText: source.slice(startLineStart, lineEnd).trim(),
            },
        nextIndex: i + 1,
        line,
        lineStart,
      };
    }
    if (ch === "\n") {
      line += 1;
      lineStart = i + 1;
    }
    value += ch;
    i += 1;
  }

  return { nextIndex: i, line, lineStart };
}
