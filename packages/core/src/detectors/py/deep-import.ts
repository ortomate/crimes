import type { PyImport } from "@crimes/language-py";
import { z } from "zod";
import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { intrinsicFor, plural, severityScore } from "./shared.js";

const optionsSchema = z
  .object({
    maxDepth: z.number().int().positive().optional(),
    maxRelativeLevel: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `from a.b.c.d import x` — four segments — is the point at which an
 * import stops describing a dependency on a package and starts
 * describing one on a package's internal layout.
 */
const DEFAULT_MAX_DEPTH = 4;

/**
 * `from ... import x` — three or more dots. Two is a normal sibling-
 * package reference; three means the module is reaching across a
 * package boundary it probably shouldn't know exists.
 */
const DEFAULT_MAX_RELATIVE_LEVEL = 3;

export const deepImportPyDetector: LanguagePyDetector = {
  id: "deep_import.py",
  name: "Deep Import (Python)",
  description:
    "Flags imports that reach deep into a package's internals, either by dotted depth " +
    "or by climbing three or more levels with leading dots.",
  whyItMatters:
    "A deep import couples the importing module to a package's internal layout rather " +
    "than to its public surface, so any reorganisation inside that package breaks " +
    "callers that were never supposed to know it existed. Python makes this " +
    "particularly easy because nothing is private: `from a.b.c.d import helper` works " +
    "whether or not `a` intended to export it, and `__init__.py` exists precisely so " +
    "a package can decide what to expose. Long relative chains (`from ... import x`) " +
    "are worse still, because the meaning of the import depends on where the file " +
    "sits — move the file and the import silently resolves somewhere else.",

  pack: "language-py",
  optionsSchema,
  run(ctx) {
    const { maxDepth, maxRelativeLevel } = readOptions(ctx.config);

    const offenders = ctx.parsed.imports.filter(
      (imp) => imp.depth > maxDepth || imp.relativeLevel >= maxRelativeLevel,
    );
    if (offenders.length === 0) return [];

    const deepest = offenders.reduce((a, b) => (b.depth > a.depth ? b : a));
    const severity = pickSeverity(offenders, maxDepth);
    const shown = offenders.slice(0, 8);

    const evidence: string[] = [
      ...shown.map((imp) => `${describe(imp)} — depth ${imp.depth}, line ${imp.line}`),
      ...(offenders.length > shown.length
        ? [`…+${offenders.length - shown.length} more`]
        : []),
      `threshold: depth > ${maxDepth}, or ${maxRelativeLevel}+ leading dots`,
    ];
    const climbers = offenders.filter((i) => i.relativeLevel >= maxRelativeLevel);
    if (climbers.length > 0) {
      evidence.push(
        `${climbers.length} ${plural(climbers.length, "import")} climb ` +
          `${maxRelativeLevel}+ package levels — these re-resolve if the file moves`,
      );
    }
    const wildcards = offenders.filter((i) => i.wildcard);
    if (wildcards.length > 0) {
      evidence.push(
        `${wildcards.length} of them is a wildcard import, which binds every public ` +
          "name in the target and makes the coupling unbounded",
      );
    }

    const finding: Finding = {
      id: "",
      type: "deep_import",
      charge: "Deep Import",
      severity,
      confidence: 0.85,
      file: ctx.file,
      lines: [offenders[0]!.line, offenders[offenders.length - 1]!.line],
      summary:
        `${offenders.length} ${plural(offenders.length, "import")} reach past a ` +
        `package's public surface (deepest: ${describe(deepest)} at depth ${deepest.depth}). ` +
        "These couple this module to another package's internal layout.",
      evidence,
      effort: "small",
      fix_shape: "import from the package root; re-export in __init__.py",
      scores: {
        severity: severityScore(severity),
        confidence: 0.85,
        agent_risk: intrinsicFor({
          count: offenders.length,
          base: 0.4,
          step: 0.06,
          cap: 0.75,
        }),
      },
      suggested_actions: [
        {
          kind: "import_from_package_root",
          description:
            "Re-export the needed names from the owning package's `__init__.py` and " +
            "import from there, so the package controls its own surface.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

function describe(imp: PyImport): string {
  const dots = ".".repeat(imp.relativeLevel);
  if (imp.kind === "import") return `import ${imp.module}`;
  const names = imp.wildcard ? "*" : imp.names.join(", ");
  return `from ${dots}${imp.module} import ${names || "…"}`;
}

function pickSeverity(offenders: PyImport[], maxDepth: number): Severity {
  const worst = Math.max(...offenders.map((i) => i.depth));
  if (worst >= maxDepth + 3 || offenders.length >= 6) return "high";
  if (worst >= maxDepth + 1 || offenders.length >= 3) return "medium";
  return "low";
}

function readOptions(config: Parameters<LanguagePyDetector["run"]>[0]["config"]): {
  maxDepth: number;
  maxRelativeLevel: number;
} {
  const raw = config.detectors?.options?.["deep_import.py"];
  const parsed = optionsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      maxDepth: DEFAULT_MAX_DEPTH,
      maxRelativeLevel: DEFAULT_MAX_RELATIVE_LEVEL,
    };
  }
  return {
    maxDepth: parsed.data.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxRelativeLevel: parsed.data.maxRelativeLevel ?? DEFAULT_MAX_RELATIVE_LEVEL,
  };
}

export const PY_DEEP_IMPORT_DEFAULTS = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxRelativeLevel: DEFAULT_MAX_RELATIVE_LEVEL,
};
