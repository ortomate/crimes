import { z } from "zod";
import type { AssetDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import { readImageDimensions } from "../util/image-dimensions.js";

const optionsSchema = z
  .object({
    /**
     * Path substrings (matched as `includes`) where the
     * icon-sized-raster policy should NOT fire. Useful for legitimate
     * pixel art, favicons that must remain raster, or other assets
     * with a deliberate raster requirement.
     */
    allowedPaths: z.array(z.string().min(1)).optional(),
    /**
     * Override the icon-size threshold (default 64). An image whose
     * BOTH width and height are at or below this value triggers the
     * detector.
     */
    iconSizeMax: z.number().int().positive().max(512).optional(),
  })
  .strict();

const DEFAULT_ICON_SIZE_MAX = 64;

/**
 * A raster image whose width and height both fit inside an icon-sized
 * box (≤64px by default). These are almost always cases where an SVG
 * would scale cleanly, ship smaller, and avoid the high-DPI blur that
 * fixed-resolution rasters get on retina displays.
 *
 * Reads the image header (PNG / JPEG / GIF — see `readImageDimensions`)
 * to recover dimensions; WebP / AVIF / SVG callers are not flagged
 * (SVG by construction; WebP / AVIF because the dimension parser
 * doesn't handle them in v1 — files return undefined and we skip).
 */
export const rasterShouldBeVectorDetector: AssetDetector = {
  id: "raster_should_be_vector",
  name: "Icon-Sized Raster",
  description:
    "Flags raster images whose width and height both fit inside an " +
    "icon-sized box (≤64px by default). These almost always belong " +
    "as SVG icons instead.",
  whyItMatters:
    "An icon-sized PNG is one resolution wide. On every higher-DPI " +
    "display it either pixel-blurs or sits at the wrong size; the " +
    "fix is almost always an SVG, which scales freely and ships " +
    "smaller. Coding agents reach for raster icons because they " +
    "treat icons like screenshots — bring the literal pixels, paste " +
    "them in. The detector flags the asset so the conversation " +
    "starts at 'is this really raster on purpose?'",
  pack: "universal",
  extensions: [".png", ".jpg", ".jpeg", ".gif"],
  optionsSchema,

  async run(ctx) {
    const options = readOptions(ctx.config.detectors?.options);
    for (const a of options.allowedPaths) {
      if (ctx.file.includes(a)) return [];
    }
    const iconMax = options.iconSizeMax ?? DEFAULT_ICON_SIZE_MAX;

    const buffer = await ctx.read();
    const dims = readImageDimensions(buffer);
    if (!dims) return []; // unsupported format / unparseable — skip

    if (dims.width > iconMax || dims.height > iconMax) return [];

    const finding: Finding = {
      id: "",
      type: "raster_should_be_vector",
      charge: "Icon-Sized Raster",
      severity: "low",
      confidence: 0.85,
      file: ctx.file,
      summary:
        `${dims.width}×${dims.height} ${dims.format.toUpperCase()} icon-sized ` +
        `raster. SVG would scale cleanly across DPIs and ship smaller; the ` +
        `current asset locks the image to a single resolution.`,
      evidence: [
        `dimensions: ${dims.width} × ${dims.height} px (≤ ${iconMax} threshold both sides)`,
        `format: ${dims.format}`,
        `consider replacing with an SVG icon — same render at every DPI, smaller bytes`,
      ],
      effort: "quick",
      fix_shape: "ship the SVG source; rasters lose at any scale",
      scores: {
        severity: 0.35,
        confidence: 0.85,
        agent_risk: 0.4,
      },
      suggested_actions: [
        {
          kind: "switch_to_svg_icon",
          description:
            "Re-author or re-export the icon as an SVG. If the source " +
            "is a designer's PNG, the original vector likely exists in " +
            "Figma / Sketch / Illustrator — re-export from there.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

interface ParsedOptions {
  allowedPaths: Set<string>;
  iconSizeMax?: number;
}

function readOptions(options: Record<string, unknown> | undefined): ParsedOptions {
  const raw = options?.["raster_should_be_vector"];
  if (!raw) return { allowedPaths: new Set() };
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return { allowedPaths: new Set() };
  return {
    allowedPaths: new Set(parsed.data.allowedPaths ?? []),
    ...(parsed.data.iconSizeMax !== undefined
      ? { iconSizeMax: parsed.data.iconSizeMax }
      : {}),
  };
}
