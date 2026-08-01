export type CommentKind = "line" | "block";

export interface SourceComment {
  kind: CommentKind;
  raw: string;
  text: string;
  startLine: number;
  endLine: number;
}

type ScannerState = "code" | "single" | "double" | "template";

interface Cursor {
  index: number;
  line: number;
}

export function extractComments(source: string): SourceComment[] {
  const comments: SourceComment[] = [];
  const cursor: Cursor = { index: 0, line: 1 };
  let state: ScannerState = "code";

  while (cursor.index < source.length) {
    const ch = source[cursor.index]!;
    const next = source[cursor.index + 1];

    if (ch === "\n") cursor.line += 1;

    const stringState = advanceStringState(state, ch);
    if (stringState) {
      state = stringState.state;
      cursor.index += stringState.advance;
      continue;
    }

    if (state === "code" && (ch === "'" || ch === '"' || ch === "`")) {
      state = ch === "'" ? "single" : ch === '"' ? "double" : "template";
      cursor.index += 1;
      continue;
    }

    if (state === "code" && ch === "/" && next === "/") {
      comments.push(readLineComment(source, cursor));
      continue;
    }

    if (state === "code" && ch === "/" && next === "*") {
      comments.push(readBlockComment(source, cursor));
      continue;
    }

    cursor.index += 1;
  }

  return mergeConsecutiveLineComments(comments);
}

function advanceStringState(
  state: ScannerState,
  ch: string,
): { state: ScannerState; advance: number } | undefined {
  if (state === "code") return undefined;
  if (ch === "\\") return { state, advance: 2 };
  if ((state === "single" && ch === "'") || (state === "double" && ch === '"')) {
    return { state: "code", advance: 1 };
  }
  if (state === "template" && ch === "`") return { state: "code", advance: 1 };
  return { state, advance: 1 };
}

function readLineComment(source: string, cursor: Cursor): SourceComment {
  const start = cursor.index;
  const startLine = cursor.line;
  cursor.index += 2;
  while (cursor.index < source.length && source[cursor.index] !== "\n") cursor.index += 1;
  const raw = source.slice(start, cursor.index);
  return {
    kind: "line",
    raw,
    text: raw.replace(/^\/\/\s?/, ""),
    startLine,
    endLine: startLine,
  };
}

function readBlockComment(source: string, cursor: Cursor): SourceComment {
  const start = cursor.index;
  const startLine = cursor.line;
  cursor.index += 2;
  while (cursor.index < source.length) {
    if (source[cursor.index] === "\n") cursor.line += 1;
    if (source[cursor.index] === "*" && source[cursor.index + 1] === "/") {
      cursor.index += 2;
      break;
    }
    cursor.index += 1;
  }
  const raw = source.slice(start, cursor.index);
  return {
    kind: "block",
    raw,
    text: normaliseBlockComment(raw),
    startLine,
    endLine: cursor.line,
  };
}

function normaliseBlockComment(raw: string): string {
  return raw
    .replace(/^\/\*/, "")
    .replace(/\*\/$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();
}

function mergeConsecutiveLineComments(comments: SourceComment[]): SourceComment[] {
  const merged: SourceComment[] = [];
  let pending: SourceComment | undefined;

  for (const comment of comments) {
    if (comment.kind !== "line") {
      if (pending) merged.push(pending);
      pending = undefined;
      merged.push(comment);
      continue;
    }

    if (pending && comment.startLine === pending.endLine + 1) {
      pending = {
        kind: "line",
        raw: `${pending.raw}\n${comment.raw}`,
        text: `${pending.text}\n${comment.text}`,
        startLine: pending.startLine,
        endLine: comment.endLine,
      };
      continue;
    }

    if (pending) merged.push(pending);
    pending = comment;
  }

  if (pending) merged.push(pending);
  return merged;
}
