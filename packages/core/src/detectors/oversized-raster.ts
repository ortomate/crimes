import { z } from "zod";
import type { AssetDetector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";

const optionsSchema = z
  .object({
    /**
     * Path substrings (matched as `includes`) where the size policy
     * should NOT fire. Useful for intentionally-large hero images or
     * vendor assets whose dimensions you control by other means.
     */
    allowedPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();

const DEFAULT_LOW_KB = 200;
const DEFAULT_MEDIUM_KB = 500;
const DEFAULT_HIGH_KB = 1000;

/**
 * A raster image whose byte weight exceeds typical web-perf budgets.
 * Thresholds are configurable via `thresholds.assetWeight.{low,medium,high}Kb`
 * — defaults mirror Core Web Vitals guidance: "good" content images
 * stay under 200 KB, "needs improvement" under 500 KB, anything over
 * 1 MB is a page-weight outlier.
 *
 * The detector reads only `byteSize` — never the bytes themselves —
 * so a 5 MB image costs one `fs.stat()` call to flag.
 */
export const oversizedRasterDetector: AssetDetector = {
  id: "oversized_raster",
  name: "Oversized Raster",
  description:
    "Flags raster images whose file size exceeds the configured " +
    "asset-weight thresholds.",
  whyItMatters:
    "Page weight directly drives Core Web Vitals: every extra " +
    "kilobyte of image is a kilobyte the user's browser downloads, " +
    "decodes, and paints. Designers and agents both reach for a " +
    "screenshot or hero image at native camera-roll resolution and " +
    "leave it that way; the fix (resize / re-encode to WebP or AVIF) " +
    "rarely affects how the image renders. Tooling that runs as part " +
    "of a build pipeline is the long-term fix, but flagging the asset " +
    "at scan time gets the size into the conversation before merge.",
  extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"],
  optionsSchema,

  run(ctx) {
    const allowed = readAllowedPaths(ctx.config.detectors?.options);
    for (const a of allowed) {
      if (ctx.file.includes(a)) return [];
    }

    const weight = ctx.config.thresholds.assetWeight ?? {};
    const lowKb = weight.lowKb ?? DEFAULT_LOW_KB;
    const mediumKb = weight.mediumKb ?? DEFAULT_MEDIUM_KB;
    const highKb = weight.highKb ?? DEFAULT_HIGH_KB;
    const sizeKb = ctx.byteSize / 1024;
    if (sizeKb < lowKb) return [];

    const severity: Severity =
      sizeKb >= highKb ? "high" : sizeKb >= mediumKb ? "medium" : "low";
    const formatted = formatSize(ctx.byteSize);

    const finding: Finding = {
      id: "",
      type: "oversized_raster",
      charge: "Oversized Raster",
      severity,
      confidence: 0.95,
      file: ctx.file,
      summary:
        `${formatted} raster asset (threshold ${describeThresholds({ lowKb, mediumKb, highKb })}). ` +
        `Heavy images directly inflate page weight and Core Web Vitals; the ` +
        `fix is usually a resize plus a modern-format re-encode, not a build ` +
        `change.`,
      evidence: [
        `byte size: ${ctx.byteSize.toLocaleString()} bytes (${formatted})`,
        `severity ladder: low ≥ ${lowKb} KB · medium ≥ ${mediumKb} KB · high ≥ ${highKb} KB`,
        `format: ${ctx.extension.replace(/^\./, "")}`,
        `consider resizing to the rendered dimensions and re-encoding to webp or avif`,
      ],
      effort: "quick",
      fix_shape: "downscale or convert to WebP/AVIF; budget the size",
      scores: {
        severity: severityScore(severity),
        confidence: 0.95,
        agent_risk: round(severityToAgentRisk(severity)),
      },
      suggested_actions: [
        {
          kind: "shrink_raster",
          description:
            "Resize the image to the dimensions it actually renders at " +
            "and re-encode as WebP or AVIF. If the asset is decorative, " +
            "consider whether an SVG icon or CSS gradient would replace " +
            "it entirely.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function readAllowedPaths(
  options: Record<string, unknown> | undefined,
): Set<string> {
  const raw = options?.["oversized_raster"];
  if (!raw) return new Set();
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.allowedPaths ?? []);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function describeThresholds(args: {
  lowKb: number;
  mediumKb: number;
  highKb: number;
}): string {
  return `${args.lowKb} / ${args.mediumKb} / ${args.highKb} KB`;
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.4;
}

function severityToAgentRisk(s: Severity): number {
  return s === "high" ? 0.7 : s === "medium" ? 0.5 : 0.35;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
