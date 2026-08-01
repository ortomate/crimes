/**
 * Lightweight English pluraliser. Hand-rolled (~60 lines) so the
 * naming-tier detectors don't need a runtime dependency. Covers the
 * regular `-s` / `-es` / `-ies` rules plus a handful of common
 * irregulars; everything else gets the default `+ s`. Inverse
 * (`singularise`) follows the same map.
 *
 * Scope: identifier names in real code, not arbitrary English.
 * Edge cases like `octopus → octopi` are intentionally skipped — they
 * don't appear in production identifier naming.
 *
 * Lowercase in, lowercase out. Callers normalise case before passing.
 */

const UNCOUNTABLE = new Set([
  "data",
  "information",
  "news",
  "software",
  "staff",
  "equipment",
  "audio",
  "video",
  "traffic",
  "weather",
  "advice",
  "feedback",
  "knowledge",
  "music",
  "research",
  "work",
  "content",
  "luggage",
  "evidence",
]);

const IRREGULARS: Array<[singular: string, plural: string]> = [
  ["child", "children"],
  ["person", "people"],
  ["man", "men"],
  ["woman", "women"],
  ["foot", "feet"],
  ["tooth", "teeth"],
  ["goose", "geese"],
  ["mouse", "mice"],
  ["ox", "oxen"],
  ["criterion", "criteria"],
  ["datum", "data"],
  ["medium", "media"],
  ["analysis", "analyses"],
  ["basis", "bases"],
  ["thesis", "theses"],
  ["index", "indices"],
];

const SINGULAR_TO_PLURAL = new Map<string, string>(IRREGULARS);
const PLURAL_TO_SINGULAR = new Map<string, string>(IRREGULARS.map(([s, p]) => [p, s]));

export function isUncountable(word: string): boolean {
  return UNCOUNTABLE.has(word.toLowerCase());
}

/**
 * Best-effort pluralisation. Returns the input unchanged if the word
 * is uncountable.
 */
export function pluralise(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  const irregular = SINGULAR_TO_PLURAL.get(lower);
  if (irregular) return matchCase(word, irregular);

  // Regular rules
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, "ies");
  return `${word}s`;
}

/**
 * Best-effort singularisation. Returns the input unchanged if the
 * word is uncountable or doesn't look plural.
 */
export function singularise(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  const irregular = PLURAL_TO_SINGULAR.get(lower);
  if (irregular) return matchCase(word, irregular);

  if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.replace(/es$/i, "");
  // Words ending in `ss`, `us`, `is`, `os`, `as` — not regular plurals.
  if (/(ss|us|is|os|as)$/i.test(word)) return word;
  if (/s$/i.test(word)) return word.replace(/s$/i, "");
  return word;
}

/**
 * Does the word look plural to the heuristic — i.e. would
 * `singularise(word)` actually strip something? Uncountables count
 * as "not plural" so detectors skip them cleanly.
 */
export function looksPlural(word: string): boolean {
  if (isUncountable(word)) return false;
  return singularise(word).toLowerCase() !== word.toLowerCase();
}

function matchCase(original: string, target: string): string {
  if (!original) return target;
  if (original[0] === original[0]?.toUpperCase()) {
    return target[0]!.toUpperCase() + target.slice(1);
  }
  return target;
}
