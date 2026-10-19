import { readdirSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { z } from "zod";
import type { AssetDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import { readImageDimensions } from "../util/image-dimensions.js";
import { isSnapshotBaseline } from "../util/snapshot-baselines.js";

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
 * Same-format rasters in one directory at which they are treated as one
 * asset set (a flag set, a sprite source, an admin theme's icons). 243
 * country-flag PNGs are one decision, not 243 findings.
 */
const ASSET_SET_MIN = 20;

/**
 * Android density buckets (`drawable-hdpi`, `mipmap-xxhdpi`, with any
 * other qualifiers). Shipping one raster per density *is* the platform's
 * answer to the multi-DPI problem this detector exists to raise.
 */
const ANDROID_DENSITY_DIR =
  /(?:^|\/)res\/(?:drawable|mipmap)(?:-[a-z0-9]+)*-(?:ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi|tvdpi)(?:-[a-z0-9]+)*\//;

/**
 * `icon@2x.png`, `icon@3x.png`: resolution variants, the web/iOS answer.
 * `@1x` names the base of such a set, and Xcode adds device and duplicate
 * suffixes (`bg@2x~ipad.png`, `icon@2x-1.png`).
 */
const RESOLUTION_VARIANT = /@[123]x(?:[-~][\w-]*)?\.[a-z]+$/i;

/**
 * An Xcode app-icon set: the App Store and SpringBoard require PNGs at
 * fixed sizes, so a vector here is not an option.
 */
const APP_ICON_SET = /\.appiconset\//i;

/**
 * Email templates: major mail clients (Gmail, Outlook) do not render
 * SVG, so a raster is the requirement, not a shortcut.
 */
const EMAIL_SEGMENT = /(?:^|\/)(?:email|emails|mail|mails)\//i;

/**
 * True when a raster is not a candidate for SVG regardless of size. Each
 * reason is a constraint SVG cannot meet or a DPI strategy already in
 * place.
 */
function exemption(file: string, format: string, buffer: Buffer, dims: Dims): boolean {
  // A JPEG is photographic by construction: an avatar, a thumbnail.
  if (format === "jpeg") return true;
  // Animation: a spinner or loader. SVG can animate, but replacing a
  // GIF loader is a redesign, not the conversion the finding proposes.
  if (format === "gif" && isAnimatedGif(buffer)) return true;
  // A 1px line or tile is a spacer or a repeating background.
  if (Math.min(dims.width, dims.height) <= 2) return true;
  if (ANDROID_DENSITY_DIR.test(file)) return true;
  if (RESOLUTION_VARIANT.test(file)) return true;
  if (APP_ICON_SET.test(file)) return true;
  if (isSnapshotBaseline(file)) return true;
  if (EMAIL_SEGMENT.test(file)) return true;
  return false;
}

interface Dims {
  width: number;
  height: number;
}

function isAnimatedGif(buffer: Buffer): boolean {
  return buffer.includes("NETSCAPE2.0") || buffer.includes("ANIMEXTS1.0");
}

/**
 * Sibling listings, cached per scan. The config object is created once
 * per scan, so it scopes the cache without module-level state that a
 * long-lived process would see go stale.
 */
const siblingCache = new WeakMap<object, Map<string, string[]>>();

/**
 * Same-extension siblings of `absolutePath`, sorted, or `undefined` when
 * the directory cannot be read.
 */
function sameFormatSiblings(scanKey: object, absolutePath: string): string[] | undefined {
  let byDir = siblingCache.get(scanKey);
  if (!byDir) {
    byDir = new Map();
    siblingCache.set(scanKey, byDir);
  }
  const dir = dirname(absolutePath);
  const ext = extname(absolutePath).toLowerCase();
  const key = `${dir}\0${ext}`;
  const cached = byDir.get(key);
  if (cached) return cached;
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => extname(n).toLowerCase() === ext)
      .sort();
  } catch {
    return undefined;
  }
  byDir.set(key, names);
  return names;
}

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
    if (exemption(ctx.file, dims.format, buffer, dims)) return [];

    // A large same-format set is reported once, on its first member.
    const siblings = sameFormatSiblings(ctx.config, ctx.absolutePath) ?? [];
    const assetSet = siblings.length >= ASSET_SET_MIN;
    if (assetSet && siblings[0] !== basename(ctx.absolutePath)) return [];

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
        ...(assetSet
          ? [
              `one of ${siblings.length} ${extname(ctx.file).toLowerCase()} files in ` +
                `${dirname(ctx.file)}/ — the set is one decision, reported once here`,
            ]
          : []),
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
  const raw = options?.raster_should_be_vector;
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
