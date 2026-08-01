import { z } from "zod";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import { ConfidenceLadder, SeverityLadder } from "../scoring/confidence.js";
import type {
  PassThroughChain,
  PassThroughCluster,
  PassThroughEdge,
} from "../risk/types.js";

/**
 * Abstraction Laundering — layers of indirection that add nothing.
 *
 * ## What it reports, and what it does not
 *
 * It does **not** report a thin wrapper. A single function that forwards
 * to another is how a façade, a port, a compatibility shim, and a
 * dependency-injection seam are all spelled, and reporting those would
 * be reporting good design as a defect.
 *
 * It reports **stacks**: a chain of two or more wrappers spanning two or
 * more files where no layer adds anything, or a cluster of three or more
 * wrappers in one file that all forward to the same collaborator. Those
 * are the shapes where answering "what does this actually do?" costs a
 * reader five file opens and ends at a one-line call.
 *
 * ## Why it matters to agents specifically
 *
 * An agent asked to change behaviour must first find where behaviour
 * lives. Each empty layer is a place the answer might be and is not, and
 * each one consumes context window. Worse, a laundered chain makes it
 * genuinely ambiguous *which* layer a change belongs in — so two agents
 * (or an agent and a human) making the same change will pick different
 * layers, and the second change will look redundant.
 *
 * ## Excluded by construction
 *
 * Any layer that adds something — a transformation, a default, a narrowed
 * type, an `await` that changes error handling — is recorded as adding
 * it, and a chain whose layers all add something is never reported.
 * Generated clients, vendored code, tests, and fixtures never contribute
 * edges. Files whose path marks them as a public façade, an adapter, a
 * port, or an instrumentation boundary are excluded by name.
 *
 * ## Severity
 *
 * Low by default. It rises to medium only when the chain is long enough
 * that ownership is genuinely obscured — the point at which a reader
 * cannot hold the path in their head.
 */

const optionsSchema = z
  .object({
    /** Wrappers in a chain before it is reported. Default 3. */
    minChainLength: z.number().int().min(2).max(20).optional(),
    /** Distinct files a chain must span. Default 2. */
    minChainFiles: z.number().int().min(1).max(20).optional(),
    /** Wrappers sharing one receiver before a cluster is reported. Default 4. */
    minClusterSize: z.number().int().min(3).max(50).optional(),
    /**
     * Path fragments that mark a deliberate architectural boundary. Files
     * matching any of these never anchor a finding. Added to the built-in
     * list rather than replacing it.
     */
    boundaryPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();

type Options = z.infer<typeof optionsSchema>;

const MAX_FINDINGS = 8;

/**
 * Paths where forwarding *is* the job. A façade that forwards is a
 * façade doing its work; reporting it would be reporting the pattern.
 */
const BOUNDARY_PATH_RE =
  /(^|\/)(adapters?|ports?|facades?|gateways?|clients?|sdk|shims?|compat|polyfills?|bridges?|wrappers?|instrumentation|telemetry|tracing|public|index)\.[cm]?[jt]sx?$|(^|\/)(adapters?|ports?|facades?|gateways?|shims?|compat|public-api|api-client|generated)\//;

export const passThroughAbstractionDetector: LanguageJsDetector = {
  id: "pass_through_abstraction",
  name: "Abstraction Laundering",
  description:
    "Flags chains and clusters of wrapper functions that forward their " +
    "arguments unchanged and add no transformation, policy, " +
    "instrumentation, or boundary value.",
  whyItMatters:
    "Each empty layer is a place the behaviour might live and does not. " +
    "Finding out what a call actually does means opening every file in " +
    "the chain, and deciding where a change belongs becomes genuinely " +
    "ambiguous — so two people making the same change pick different " +
    "layers. For an agent the cost is measured directly in context: every " +
    "hop is a file read that ends in another forward.",

  pack: "language-js",
  optionsSchema,

  run(ctx) {
    const risk = ctx.risk;
    if (!risk) return [];

    const options = readOptions(ctx.config);
    const minChainLength = options.minChainLength ?? 3;
    const minChainFiles = options.minChainFiles ?? 2;
    const minClusterSize = options.minClusterSize ?? 4;
    const extraBoundaries = options.boundaryPaths ?? [];

    const findings: Finding[] = [];

    for (const chain of risk.passThrough.chains) {
      if (findings.length >= MAX_FINDINGS) break;
      if (chain.anchorFile !== ctx.file) continue;
      if (chain.edges.length < minChainLength) continue;
      if (chain.files.length < minChainFiles) continue;
      // A chain where any layer contributes something is a pipeline, not
      // laundering.
      if (chain.edges.some((e) => e.adds.length > 0)) continue;
      if (chain.files.some((f) => isBoundaryPath(f, extraBoundaries))) continue;

      findings.push(buildChainFinding(chain));
    }

    for (const cluster of risk.passThrough.clusters) {
      if (findings.length >= MAX_FINDINGS) break;
      if (cluster.anchorFile !== ctx.file) continue;
      if (cluster.edges.length < minClusterSize) continue;
      if (isBoundaryPath(cluster.file, extraBoundaries)) continue;
      const empty = cluster.edges.filter((e) => e.adds.length === 0);
      // Most of the members must be empty; a class with two real methods
      // and four delegations is a normal class.
      if (empty.length < minClusterSize) continue;

      findings.push(buildClusterFinding(cluster, empty));
    }

    findings.sort((a, b) => (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0));
    return findings;
  },
};

/* ------------------------------------------------------------------ *
 * Chains
 * ------------------------------------------------------------------ */

function buildChainFinding(chain: PassThroughChain): Finding {
  const head = chain.edges[0]!;
  const allIdentical = chain.edges.every((e) => e.forwarding === "identical");
  const sameNameHops = chain.edges.filter((e) => e.sameName === true).length;

  const confidence = new ConfidenceLadder(0.6)
    .add(allIdentical, "every hop forwards its arguments unchanged", 0.14)
    .add(sameNameHops >= 2, `${sameNameHops} hops reuse the same function name`, 0.1)
    .add(chain.files.length >= 3, `spans ${chain.files.length} files`, 0.08)
    .add(chain.edges.length >= 4, `${chain.edges.length} layers deep`, 0.06)
    .add(!allIdentical, "at least one hop forwards a subset of its arguments", -0.1);

  const severity = new SeverityLadder(0.22)
    .add(chain.edges.length >= 4, "four or more layers obscure ownership", 0.2)
    .add(chain.files.length >= 4, "the chain crosses four or more files", 0.12)
    .add(
      chain.edges.length >= 3 && chain.files.length >= 3,
      "three files, three layers",
      0.08,
    );

  const evidence: string[] = [
    `call chain, ${chain.edges.length} layers across ${chain.files.length} files:`,
  ];
  chain.edges.forEach((edge, i) => {
    const indent = "  ".repeat(i + 1);
    const adds =
      edge.adds.length > 0 ? ` — adds: ${edge.adds.join(", ")}` : " — adds nothing";
    evidence.push(
      `${indent}${edge.file}:${edge.line} \`${edge.name}(…)\` → \`${edge.target}(…)\`${adds}`,
    );
  });
  evidence.push(`${"  ".repeat(chain.edges.length + 1)}⇒ ${chain.terminal}(…)`);
  evidence.push(
    `forwarding fidelity: ${[...new Set(chain.edges.map((e) => e.forwarding))].sort().join(", ")}`,
  );
  evidence.push(
    "no layer performs a transformation, applies a default, narrows a type, " +
      "or adds instrumentation — reading the chain end to end yields the same " +
      "call the caller wrote",
  );
  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);

  return {
    id: "",
    type: "pass_through_abstraction",
    charge: "Abstraction Laundering",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: chain.anchorFile,
    lines: [head.line, head.endLine],
    symbol: head.name,
    summary:
      `\`${head.name}\` forwards through ${chain.edges.length} layers across ` +
      `${chain.files.length} files to reach \`${chain.terminal}\`, and no layer ` +
      "adds anything. Finding the behaviour costs a reader every hop.",
    evidence,
    effort: "medium",
    fix_shape: "collapse the empty layers; keep the one boundary that earns its place",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "collapse_indirection",
        description:
          `Have \`${head.name}\`'s callers reach \`${chain.terminal}\` through ` +
          "at most one boundary, and delete the layers in between.",
        risk: "medium",
      },
      {
        kind: "document_boundary",
        description:
          "If one of these layers is a deliberate seam — a port for testing, " +
          "a compatibility shim — say so in a comment at that layer, so the " +
          "next reader (and this detector) can tell it from the rest.",
        risk: "low",
      },
    ],
    related_files: chain.files.filter((f) => f !== chain.anchorFile),
  };
}

/* ------------------------------------------------------------------ *
 * Clusters
 * ------------------------------------------------------------------ */

function buildClusterFinding(
  cluster: PassThroughCluster,
  empty: PassThroughEdge[],
): Finding {
  const sameNameCount = empty.filter((e) => e.sameName === true).length;
  const ratio = empty.length / cluster.edges.length;

  const confidence = new ConfidenceLadder(0.6)
    .add(ratio === 1, "every member forwards and adds nothing", 0.12)
    .add(
      sameNameCount >= empty.length - 1,
      "members reuse the collaborator's own method names",
      0.12,
    )
    .add(empty.length >= 6, `${empty.length} forwarding members`, 0.06)
    .add(ratio < 0.8, "some members do real work", -0.12);

  const severity = new SeverityLadder(0.22)
    .add(empty.length >= 6, "six or more forwarding members", 0.14)
    .add(
      sameNameCount === empty.length,
      "the type is a verbatim restatement of its collaborator",
      0.1,
    );

  const evidence: string[] = [
    `${empty.length} function(s) in this file forward to \`${cluster.receiver}\` and add nothing:`,
  ];
  for (const edge of empty.slice(0, 8)) {
    evidence.push(`  line ${edge.line}: \`${edge.name}(…)\` → \`${edge.target}(…)\``);
  }
  if (empty.length > 8) evidence.push(`  +${empty.length - 8} more`);
  if (empty.length < cluster.edges.length) {
    evidence.push(
      `${cluster.edges.length - empty.length} further member(s) forward to the ` +
        "same collaborator but do add something",
    );
  }
  if (sameNameCount > 0) {
    evidence.push(
      `${sameNameCount} member(s) share a name with the method they call, so the ` +
        "wrapper cannot be doing anything the name would have to describe",
    );
  }
  evidence.push(
    `every caller of this type could call \`${cluster.receiver}\` directly with ` +
      "no change in behaviour",
  );
  evidence.push(confidence.explain());
  const escalation = severity.explain();
  if (escalation !== undefined) evidence.push(escalation);

  const first = empty[0]!;
  return {
    id: "",
    type: "pass_through_abstraction",
    charge: "Abstraction Laundering",
    severity: severity.severity(),
    confidence: confidence.value(),
    file: cluster.file,
    lines: [first.line, empty[empty.length - 1]!.endLine],
    symbol: cluster.receiver,
    summary:
      `${empty.length} functions in this file exist only to forward to ` +
      `\`${cluster.receiver}\`. The layer restates an interface without ` +
      "changing it.",
    evidence,
    effort: "medium",
    fix_shape: "expose the collaborator directly, or give the layer a reason to exist",
    scores: {
      severity: severity.score(),
      confidence: confidence.value(),
    },
    suggested_actions: [
      {
        kind: "remove_delegating_layer",
        description:
          `Let callers use \`${cluster.receiver}\` directly, or narrow this ` +
          "type to the subset of operations callers actually need — a smaller " +
          "surface is a reason to exist; a mirrored one is not.",
        risk: "medium",
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isBoundaryPath(file: string, extra: string[]): boolean {
  if (BOUNDARY_PATH_RE.test(file)) return true;
  return extra.some((fragment) => file.includes(fragment));
}

function readOptions(config: {
  detectors?: { options?: Record<string, unknown> };
}): Options {
  const raw = config.detectors?.options?.pass_through_abstraction;
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
