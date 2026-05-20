import { z } from "zod";
import type { AssetDetector } from "../detector.js";
import type { Finding } from "../finding.js";

const optionsSchema = z
  .object({
    /**
     * Path substrings (matched as `includes`) where the embedded-
     * raster policy should NOT fire. Useful for SVGs that intentionally
     * embed a raster (e.g. a logo whose tagline is a screenshot).
     */
    allowedPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Match `<image href="data:image/png;base64,..."` and its xlink/MIME
 * variants. Case-insensitive, MIME-agnostic — anything starting with
 * `data:image/...;base64,` inside an `<image>` element's href / xlink:href
 * counts as "an SVG that embedded a raster instead of vector geometry."
 *
 * Anchoring to `<image` means we don't trip on `<pattern>` or
 * `<feImage>` overlays where a base64 raster might legitimately appear
 * as a texture rather than as the SVG's actual content.
 */
const EMBEDDED_RASTER_RE =
  /<image[^>]*(?:xlink:)?href\s*=\s*["']data:image\/[a-z+]+;base64,/gi;

/**
 * Inner MIME-type capture used on each match's text. Matches
 * `image/png` / `image/jpeg` / `image/svg+xml` etc.
 */
const MIME_CAPTURE_RE = /data:(image\/[a-z+]+);base64,/i;

/**
 * An SVG file containing one or more `<image href="data:image/...;base64,...">`
 * elements. The pattern defeats the entire reason to use SVG: the
 * vector container ships, but its content is a raster blob.
 *
 * Almost always introduced by design tools (Figma / Sketch exporting
 * with an embedded screenshot, Illustrator's "convert to SVG" on a
 * raster layer). The fix is to re-author the embedded portion as
 * vector geometry, or move the raster out to its own asset.
 */
export const svgWithEmbeddedRasterDetector: AssetDetector = {
  id: "svg_with_embedded_raster",
  name: "SVG With Embedded Raster",
  description:
    "Flags SVG files containing `<image href=\"data:image/...;base64,...\">` " +
    "— the SVG ships, but its content is a raster blob.",
  whyItMatters:
    "An SVG with an embedded base64 raster is the worst of both " +
    "worlds: the SVG mime type promises infinite scale, but the " +
    "actual pixels inside are locked to one resolution. The asset is " +
    "almost always larger than the equivalent PNG would have been " +
    "(base64 adds ~33% overhead). Design-tool exporters introduce " +
    "this pattern silently; coding agents copy the file verbatim " +
    "and never notice. The fix is to re-author the offending region " +
    "as vector paths, or to split the raster out to its own asset.",
  extensions: [".svg"],
  optionsSchema,

  async run(ctx) {
    const allowed = readAllowedPaths(ctx.config.detectors?.options);
    for (const a of allowed) {
      if (ctx.file.includes(a)) return [];
    }

    const buffer = await ctx.read();
    const text = buffer.toString("utf8");
    const matches = [...text.matchAll(EMBEDDED_RASTER_RE)];
    if (matches.length === 0) return [];

    const mimes = new Set<string>();
    for (const m of matches) {
      const mimeMatch = m[0]!.match(MIME_CAPTURE_RE);
      if (mimeMatch) mimes.add(mimeMatch[1]!.toLowerCase());
    }
    const mimeList = [...mimes].sort().join(", ");

    const finding: Finding = {
      id: "",
      type: "svg_with_embedded_raster",
      charge: "SVG With Embedded Raster",
      severity: matches.length >= 2 ? "high" : "medium",
      confidence: 0.95,
      file: ctx.file,
      summary:
        `${matches.length} embedded base64 raster${matches.length === 1 ? "" : "s"} ` +
        `inside the SVG (${mimeList}). The SVG mime type promises infinite ` +
        `scale, but the actual pixels are locked to one resolution — usually ` +
        `larger than a plain PNG.`,
      evidence: [
        `${matches.length} \`<image href="data:image/…;base64,…">\` occurrence${matches.length === 1 ? "" : "s"}`,
        `embedded MIME type${mimes.size === 1 ? "" : "s"}: ${mimeList}`,
        `SVG byte size: ${ctx.byteSize.toLocaleString()} bytes (includes the base64 overhead)`,
        `re-author the raster region as vector paths, or split it out to its own asset`,
      ],
      effort: "small",
      fix_shape: "externalise the embedded raster or replace it with vector geometry",
      scores: {
        severity: matches.length >= 2 ? 0.75 : 0.6,
        confidence: 0.95,
        agent_risk: matches.length >= 2 ? 0.6 : 0.5,
      },
      suggested_actions: [
        {
          kind: "remove_embedded_raster",
          description:
            "Re-export the SVG from the design tool with the raster " +
            "layer flattened to vector geometry, or split the embedded " +
            "image out to its own PNG / WebP asset referenced by URL.",
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
  const raw = options?.["svg_with_embedded_raster"];
  if (!raw) return new Set();
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.allowedPaths ?? []);
}
