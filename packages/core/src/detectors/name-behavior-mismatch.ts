import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { resolveDiscriminators } from "./disambiguate.js";

const PURE_PREFIXES = [
  "get",
  "find",
  "read",
  "select",
  "is",
  "has",
  "can",
  "should",
  "build",
  "format",
  "render",
  "calculate",
  "derive",
  "parse",
];

const DISCLOSES_MUTATION =
  /^(getOrCreate|findOrCreate|create|save|update|delete|remove|send|emit|publish|track|charge|refund|write|set)/;
const SIDE_EFFECT_CALL =
  /\b(?:save|create|update|delete|remove|insert|send|emit|publish|track|charge|refund|write|set|mutate|dispatch)[A-Z_]\w*\s*\(/g;
const STRONG_SIDE_EFFECT =
  /\b(?:charge|refund|delete|remove|sendEmail|sendInvoice|publish|emit|track)[A-Z_]\w*\s*\(/g;
const API_SIDE_EFFECT =
  /\b(?:fetch|localStorage\.setItem|sessionStorage\.setItem|writeFile|appendFile|unlink|mkdir|rm|rmdir)\s*\(/g;
const ASSIGNMENT = /(?:^|[^=!<>])=(?!=)|\+\+|--/g;

export const nameBehaviorMismatchDetector: LanguageJsDetector = {
  id: "name_behavior_mismatch",
  name: "Name / Behaviour Mismatch",
  description:
    "Flags functions whose names imply safe reads or calculations while their bodies perform side effects.",
  whyItMatters:
    "A function whose name reads as a pure getter but does I/O, or a " +
    "setter that fires side effects, surprises every caller. Agents triage " +
    "code by names — a safe-sounding name often makes them call something " +
    "dangerous from a hot loop.",

  pack: "language-js",
  run(ctx) {
    const lines = ctx.source.split(/\r?\n/);
    const findings: Finding[] = [];

    for (const fn of ctx.parsed.functions) {
      const name = fn.name;
      if (!name || !looksPure(name) || DISCLOSES_MUTATION.test(name)) continue;
      if (isTestFile(ctx.file)) continue;

      const body = lines.slice(fn.startLine - 1, fn.endLine).join("\n");
      const score = scoreBody(body);
      if (!score) continue;

      const severity = pickSeverity(body);
      const confidence = round(Math.min(0.62 + score.signals.length * 0.06, 0.86));
      findings.push({
        id: "",
        type: "name_behavior_mismatch",
        charge: "False Identity",
        severity,
        confidence,
        file: ctx.file,
        symbol: name,
        lines: [fn.startLine, fn.endLine],
        summary:
          `${name} has a safe-sounding name but appears to perform side effects. ` +
          `Misleading names make edits riskier because callers may treat the function as pure.`,
        evidence: [
          `name prefix suggests ${prefixMeaning(name)}`,
          `side-effect-like calls: ${score.calls.slice(0, 5).join(", ")}`,
          `${score.signals.length} side-effect signal${score.signals.length === 1 ? "" : "s"} in the function body`,
        ],
        effort: "small",
        fix_shape: "rename to match behaviour, or change the body to match the name",
        scores: {
          severity: severityScore(severity),
          confidence,
          agent_risk: round(Math.min(0.6 + score.signals.length * 0.06, 0.85)),
        },
        suggested_actions: [
          {
            kind: "rename_or_extract_side_effect",
            description:
              "Rename the function to disclose the side effect, or extract the pure calculation/read from the mutation.",
            risk: "low",
          },
        ],
      });
    }

    const emitted = findings.slice(0, 5);
    // Several functions can share a name in one file — n8n has four
    // `build` methods in one model-factory file and two `render`
    // exports in each of a dozen .stories.ts files, each group sharing
    // one fingerprint. There is nothing content-derived to key them on,
    // so no candidate is offered and `resolveDiscriminators` falls back
    // to the start line for exactly the findings that collide.
    resolveDiscriminators(emitted);
    return emitted;
  },
};

interface BodyScore {
  calls: string[];
  signals: string[];
}

function looksPure(name: string): boolean {
  const lower = `${name[0]!.toLowerCase()}${name.slice(1)}`;
  return PURE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix));
}

function scoreBody(body: string): BodyScore | undefined {
  const calls = [
    ...matches(body, SIDE_EFFECT_CALL),
    ...matches(body, STRONG_SIDE_EFFECT),
    ...matches(body, API_SIDE_EFFECT),
  ];
  const factories = factoryCalls(body);
  const uniqueCalls = Array.from(
    new Set(calls.map((call) => call.replace(/\s*\($/, ""))),
  ).filter((call) => !factories.has(call));
  const signals = [...uniqueCalls];

  const assignmentCount = matches(body, ASSIGNMENT).length;
  if (assignmentCount >= 2) signals.push(`${assignmentCount} assignments`);
  if (/\bawait\b/.test(body) && uniqueCalls.length > 0)
    signals.push("await with side-effect-like call");

  const hasStrongSideEffect = matches(body, STRONG_SIDE_EFFECT).length > 0;
  if (signals.length < 2 && !hasStrongSideEffect) return undefined;
  if (uniqueCalls.length === 0) return undefined;

  return { calls: uniqueCalls, signals };
}

function matches(text: string, pattern: RegExp): string[] {
  return text.match(pattern) ?? [];
}

/**
 * `create*` calls that build the thing the function then works
 * *through*, rather than causing an effect.
 *
 * Field notes from choreograph.cc: `getChoreoByDate() → calls
 * createClient` fired five times in one file, "because a `get*`
 * function makes a side-effect-like call — but `createClient()` is
 * constructing the client in order to *do the read*. Every data-access
 * layer in every Next.js app has this shape."
 *
 * The shape is unmistakable once you look for it:
 *
 *   const supabase = await createClient()
 *   const { data } = await supabase.from('posts').select(…)
 *
 * The result is bound, then dereferenced. A `create*` call made for its
 * *effect* — `await createOrder(cart)` — has no such follow-up: the
 * return value is returned, discarded, or destructured, not used as a
 * receiver.
 *
 * Deliberately a shape rule, not a `createClient` allowlist. An
 * allowlist is a treadmill — the next framework names it
 * `getConnection`, `makePool`, `initSupabase` — and it would encode one
 * ecosystem's vocabulary into a detector that is supposed to be about
 * naming in general.
 *
 * Only the factory call is discounted. Everything else in the body
 * still counts, so a `get*` that builds a client **and** deletes a row
 * still reports.
 */
function factoryCalls(body: string): Set<string> {
  const found = new Set<string>();
  const BINDING =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of body.matchAll(BINDING)) {
    const bound = match[1]!;
    const callee = match[2]!;
    // The callee has to *look* like a constructor. Bound-and-
    // dereferenced alone is too broad: `const res = await fetch(url)`
    // followed by `res.json()` fits the shape exactly, and a network
    // call is a side effect whatever you do with the response. Caught
    // on the corpus — the first version of this rule silently dropped a
    // `fetch` finding in `integrations/google-oauth.ts`.
    if (!FACTORY_NAME.test(callee)) continue;
    // Used as a receiver later in the same body: `supabase.from(…)`.
    const dereferenced = new RegExp(`\\b${escapeRe(bound)}\\s*(?:\\.|\\?\\.|\\[)`);
    if (dereferenced.test(body.slice(match.index + match[0].length))) {
      found.add(callee);
    }
  }
  return found;
}

/**
 * Names that build a thing, as opposed to doing one. Anchored at the
 * start and requiring a capitalised remainder, so `create` matches
 * `createClient` and `createAdminClient` but not `created`.
 */
const FACTORY_NAME = /^(?:create|make|build|init|connect|open)[A-Z_]/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickSeverity(body: string): Severity {
  return /\bexport\b/.test(body) ? "medium" : "low";
}

function severityScore(severity: Severity): number {
  return severity === "medium" ? 0.55 : 0.35;
}

function prefixMeaning(name: string): string {
  const lower = `${name[0]!.toLowerCase()}${name.slice(1)}`;
  const prefix = PURE_PREFIXES.find((p) => lower === p || lower.startsWith(p));
  if (prefix === "is" || prefix === "has" || prefix === "can" || prefix === "should") {
    return "a predicate";
  }
  if (
    prefix === "build" ||
    prefix === "format" ||
    prefix === "calculate" ||
    prefix === "derive" ||
    prefix === "parse"
  ) {
    return "a pure transformation";
  }
  return "a read";
}

function isTestFile(file: string): boolean {
  return /\.test\.|\.spec\.|__tests__\//.test(file);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
