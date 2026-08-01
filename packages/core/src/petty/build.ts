import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isTestFile } from "../util/test-files.js";
import { extractStringLiterals } from "./literals.js";
import type { PettyIndex, PettyLiteralHit, RepoPath } from "./types.js";

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const DOMAIN_WORDS = [
  "active",
  "admin",
  "archived",
  "billing",
  "cancelled",
  "canceled",
  "charge",
  "enterprise",
  "feature",
  "flag",
  "free",
  "owner",
  "past_due",
  "payment",
  "permission",
  "plan",
  "pro",
  "refund",
  "role",
  "status",
  "subscription",
  "team",
  "tier",
  "trial",
  "workspace",
];

export interface BuildPettyIndexOptions {
  root: string;
  files: string[];
}

export async function buildPettyIndex(
  options: BuildPettyIndexOptions,
): Promise<PettyIndex> {
  const root = resolve(options.root);
  const domainLiterals: Record<string, PettyLiteralHit[]> = {};

  for (const abs of options.files) {
    const file = toRepoRel(root, abs);
    if (!SOURCE_EXT.test(file) || isTestFile(file)) continue;

    let source: string;
    try {
      source = await readFile(abs, "utf8");
    } catch {
      continue;
    }

    for (const literal of extractStringLiterals(source)) {
      if (!isInterestingDomainLiteral(literal.value, literal.lineText)) continue;
      const hit: PettyLiteralHit = {
        value: literal.value,
        file,
        line: literal.line,
        lineText: literal.lineText,
        exportedConstant: isExportedConstantLine(literal.lineText),
      };
      (domainLiterals[literal.value] ??= []).push(hit);
    }
  }

  return {
    root: toPosix(root),
    domainLiterals: sortLiteralHits(domainLiterals),
  };
}

function isInterestingDomainLiteral(value: string, lineText: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (looksLikeBareCatalogueEntry(lineText)) return false;
  if (looksLikeTypeUnionEntry(lineText)) return false;
  if (looksLikeImportOrPath(trimmed, lineText)) return false;
  if (looksLikeClassName(trimmed, lineText)) return false;
  if (looksLikeProse(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(trimmed)) return true;
  if (/^[a-z0-9]+(?:[._:-][a-z0-9]+)+$/.test(lower)) {
    return DOMAIN_WORDS.some((word) => lower === word || lower.includes(word));
  }
  return DOMAIN_WORDS.some((word) => lower === word || lower.includes(word));
}

function looksLikeBareCatalogueEntry(lineText: string): boolean {
  return /^\s*["'`][^"'`]+["'`],?\s*$/.test(lineText);
}

function looksLikeTypeUnionEntry(lineText: string): boolean {
  return /^\s*\|\s*["'`][^"'`]+["'`]/.test(lineText);
}

function looksLikeImportOrPath(value: string, lineText: string): boolean {
  if (/^(?:\.{1,2}\/|\/|@[\w-]+\/)/.test(value)) return true;
  if (/\.(?:js|jsx|ts|tsx|json|css|md|png|jpg|svg)$/.test(value)) return true;
  if (/^\s*import\b/.test(lineText) || /\bfrom\s+["'`]/.test(lineText)) return true;
  return /\brequire\s*\(\s*["'`]/.test(lineText);
}

function looksLikeClassName(value: string, lineText: string): boolean {
  if (/className\s*=/.test(lineText)) return true;
  const parts = value.split(/\s+/);
  return (
    parts.length >= 2 &&
    parts.every((part) => /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/.test(part))
  );
}

function looksLikeProse(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return false;
  const alphaWords = words.filter((word) => /^[a-z][a-z'-]+[,.!?]?$/i.test(word));
  return alphaWords.length / words.length > 0.75;
}

function isExportedConstantLine(lineText: string): boolean {
  return (
    /^\s*export\s+const\s+[A-Z0-9_]+\s*=/.test(lineText) ||
    /^\s*export\s+const\s+[a-zA-Z_$][\w$]*\s*=/.test(lineText) ||
    /^\s*export\s+enum\s+/.test(lineText)
  );
}

function sortLiteralHits(
  hits: Record<string, PettyLiteralHit[]>,
): Record<string, PettyLiteralHit[]> {
  const sorted: Record<string, PettyLiteralHit[]> = {};
  for (const key of Object.keys(hits).sort()) {
    sorted[key] = hits[key]!.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });
  }
  return sorted;
}

function toRepoRel(root: string, abs: string): RepoPath {
  const rel = isAbsolute(abs) ? relative(root, abs) : abs;
  return toPosix(rel);
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}
