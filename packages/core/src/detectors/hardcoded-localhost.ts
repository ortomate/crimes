import { z } from "zod";
import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

const optionsSchema = z
  .object({
    /**
     * Literal substrings that should NOT be flagged, even when they
     * match the `localhost:NNNN` family. Useful when an integration
     * test or local-tooling helper genuinely needs the literal in
     * non-test source.
     */
    allowedUrls: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Dev-server host:port pairs. The port requirement is what makes the
 * signal strong — a bare `localhost` reference is often a doc
 * placeholder, but a literal `localhost:PORT` with a real port number
 * is "the URL of the dev server I happen to be running right now."
 * Ports between 2 and 5 digits cover the realistic range
 * (`80` / `443` / `3000` / `8080` / `54321` …).
 *
 * Hosts covered:
 *   - `localhost`
 *   - the IPv4 loopback (`127.0.0.1`)
 *   - the all-interfaces sentinel (`0.0.0.0`)
 *   - the IPv6 loopback (`[::1]`)
 */
const LOCALHOST_RES: ReadonlyArray<RegExp> = [
  /\blocalhost:\d{2,5}\b/g,
  /\b127\.0\.0\.1:\d{2,5}\b/g,
  /\b0\.0\.0\.0:\d{2,5}\b/g,
  /\[::1\]:\d{2,5}/g,
];

/**
 * Files where a dev-server URL literal is legitimate: configuration,
 * documentation, infrastructure manifests, or local-tooling scripts.
 *
 * We match by basename for files where the position in the tree is
 * irrelevant (`.env*`, `*.config.*`, `docker-compose*`, `Dockerfile*`,
 * `README*.md`, `CHANGELOG*.md`) and by leading directory segment for
 * the rest (`scripts/`, `examples/`, `docs/`, `fixtures/`, `test/`,
 * `tests/`, `__tests__/`).
 */
const CONFIG_BASENAME_RES: ReadonlyArray<RegExp> = [
  /^\.env(\.|$)/,
  /^docker-compose(\.|$)/i,
  /^Dockerfile(\.|$)/,
  /\.config\.(?:js|ts|mjs|cjs|json|yaml|yml)$/i,
  /^README(?:\.[^/]+)?\.md$/i,
  /^CHANGELOG(?:\.[^/]+)?\.md$/i,
];

const SKIPPED_DIR_RE =
  /(?:^|\/)(?:scripts|examples|fixtures|test|tests|__tests__|docs)\//;

interface UrlHit {
  text: string;
  line: number;
}

/**
 * A `localhost:NNNN`-style URL hardcoded into non-test, non-config
 * source. Such literals encode "the address of the dev server I was
 * running when I wrote this" and silently fail in every other
 * environment (CI, staging, prod, teammate machines). A
 * configuration value (env var, settings module) is the fix.
 */
export const hardcodedLocalhostDetector: Detector = {
  id: "hardcoded_localhost",
  name: "Dev-Server URL",
  description:
    "Flags `localhost:NNNN`, `127.0.0.1:NNNN`, `0.0.0.0:NNNN`, or " +
    "`[::1]:NNNN` literals embedded in non-test, non-config source — " +
    "they encode the developer's local dev server and fail elsewhere.",
  whyItMatters:
    "A `localhost:NNNN` URL inside source code is the URL of one " +
    "specific dev server on one specific machine. In production " +
    "the request hits whatever the deploy environment happens to " +
    "have running on that port (often nothing), and the failure " +
    "mode is opaque. Coding agents reach for the literal because " +
    "they were just shown a working dev URL in the conversation; " +
    "the literal sticks around long after the conversation ends. " +
    "Configuration (env vars, settings module) makes the per-" +
    "environment value explicit.",
  optionsSchema,

  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    if (SKIPPED_DIR_RE.test(ctx.file)) return [];
    if (isConfigBasename(ctx.file)) return [];

    const allowed = readAllowedUrls(ctx.config.detectors?.options);
    const hits = scanSource(ctx.source, allowed);
    if (hits.length === 0) return [];

    const severity: Severity = hits.length >= 3 ? "high" : "medium";
    const samples = hits.slice(0, 3).map((h) => `\`${h.text}\` @L${h.line}`);
    const overflow = hits.length > samples.length;
    const lineList = hits.map((h) => h.line).slice(0, 10);

    const finding: Finding = {
      id: "",
      type: "hardcoded_localhost",
      charge: "Dev-Server URL",
      severity,
      confidence: 0.9,
      file: ctx.file,
      lines: [hits[0]!.line, hits[hits.length - 1]!.line],
      summary:
        `${hits.length} hardcoded dev-server URL${hits.length === 1 ? "" : "s"} ` +
        `(\`localhost:NNNN\` / \`127.0.0.1:NNNN\` / \`0.0.0.0:NNNN\`) in ` +
        `non-test, non-config source. These literals only work against ` +
        `whichever dev server happens to be running on that port — every ` +
        `other environment silently fails to connect.`,
      evidence: [
        ...samples,
        ...(overflow ? [`…and ${hits.length - samples.length} more`] : []),
        `lines: ${lineList.join(", ")}${hits.length > 10 ? `, …+${hits.length - 10} more` : ""}`,
        `move the value behind a config / env var (\`process.env.API_URL\`, settings module, etc.)`,
      ],
      effort: "quick",
      fix_shape: "lift the host to config or env; default for dev only",
      scores: {
        severity: severity === "high" ? 0.8 : 0.6,
        confidence: 0.9,
        agent_risk: round(Math.min(0.5 + (hits.length - 1) * 0.1, 0.85)),
      },
      suggested_actions: [
        {
          kind: "move_url_to_config",
          description:
            "Replace the literal with a config-supplied URL " +
            "(`process.env.API_URL`, a settings module, or the " +
            "framework's runtime config). Keep the dev-server URL in " +
            "`.env.local` / `.env.example` so each environment supplies " +
            "its own.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function scanSource(source: string, allowed: Set<string>): UrlHit[] {
  const lines = source.split("\n");
  const hits: UrlHit[] = [];
  lines.forEach((rawLine, idx) => {
    for (const re of LOCALHOST_RES) {
      for (const m of rawLine.matchAll(re)) {
        const text = m[0]!;
        if (isAllowed(text, allowed)) continue;
        hits.push({ text, line: idx + 1 });
      }
    }
  });
  return hits;
}

function isConfigBasename(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  return CONFIG_BASENAME_RES.some((re) => re.test(base));
}

function isAllowed(text: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return false;
  for (const a of allowed) {
    if (text.includes(a)) return true;
  }
  return false;
}

function readAllowedUrls(
  options: Record<string, unknown> | undefined,
): Set<string> {
  const raw = options?.["hardcoded_localhost"];
  if (!raw) return new Set();
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.allowedUrls ?? []);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
