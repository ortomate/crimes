# Asset findings

Asset crimes flag problems with images and other binary assets shipped
inside the repo. The detectors run a **second pass** after the
TS/JS source pipeline: a separate file discovery walks
`**/*.{png,jpg,jpeg,gif,webp,avif,svg}` and emits findings per asset.
No AST is involved.

For the wire format, see [`docs/json-schema.md`](../json-schema.md).
For the agent workflow that consumes findings, see
[`docs/agent-usage.md`](../agent-usage.md).

## What ships

| `Finding.type`              | Charge                       | Severity range | Confidence |
| --------------------------- | ---------------------------- | -------------- | ---------- |
| `oversized_raster`          | Oversized Raster             | low-high       | 0.95       |
| `raster_should_be_vector`   | Icon-Sized Raster            | low            | 0.85       |
| `svg_with_embedded_raster`  | SVG With Embedded Raster     | medium-high    | 0.95       |

All emit the standard `Finding` shape. No schema bump is required.

**Score backfill caveat.** Asset files aren't in the cross-file
scoring context (no imports, no test-file proximity, no churn in the
sense the source detectors use). Every asset finding lands with
`scores.churn = scores.test_gap = scores.blast_radius = 0`. Trust the
detector-set `severity` and `confidence` as the ranking signal.

---

## Oversized Raster (`oversized_raster`)

**What it detects.** Raster images (`png` / `jpg` / `jpeg` / `gif` /
`webp` / `avif`) whose byte size exceeds the configured asset-weight
thresholds. The detector only reads `byteSize` from `fs.stat`:
flagging a 5 MB image is a single syscall.

**Example evidence.**

```text
byte size: 1,572,864 bytes (1.50 MB)
severity ladder: low ≥ 200 KB · medium ≥ 500 KB · high ≥ 1000 KB
format: png
consider resizing to the rendered dimensions and re-encoding to webp or avif
```

**Why it matters.** Page weight directly drives Core Web Vitals.
Every extra kilobyte of image is a kilobyte the user's browser
downloads, decodes, and paints. Designers and coding agents both
tend to ship images at native camera-roll resolution and leave them
there; resizing + re-encoding rarely affects how the image actually
renders.

**Severity ramp.** Default thresholds in KB: `low: 200`,
`medium: 500`, `high: 1000`: mirroring Core Web Vitals "good /
needs improvement / poor" guidance. Configurable via
`thresholds.assetWeight`:

```json
{
  "thresholds": {
    "assetWeight": {
      "lowKb": 300,
      "mediumKb": 800,
      "highKb": 1500
    }
  }
}
```

Confidence stays at `0.95`: the signal is just bytes-on-disk.

**Project-specific exemptions** via
`detectors.options.oversized_raster.allowedPaths`:

```json
{
  "detectors": {
    "options": {
      "oversized_raster": {
        "allowedPaths": ["public/hero/", "marketing/posters/"]
      }
    }
  }
}
```

**Suggested fix.** Resize the image to the dimensions it actually
renders at and re-encode as WebP or AVIF. If the asset is decorative,
consider whether an SVG icon or CSS gradient would replace it
entirely.

---

## Icon-Sized Raster (`raster_should_be_vector`)

**What it detects.** Raster images (`png` / `jpg` / `jpeg` / `gif`)
whose width AND height both fit inside an icon-sized box (≤ 64 px by
default). These are almost always cases where an SVG would scale
cleanly across DPIs and ship smaller.

The detector reads each file's header bytes via a tiny in-tree
dimension parser (PNG + GIF + JPEG only: WebP / AVIF return
"unparseable" and are silently skipped in v1).

**Example evidence.**

```text
dimensions: 32 × 32 px (≤ 64 threshold both sides)
format: png
consider replacing with an SVG icon — same render at every DPI, smaller bytes
```

**Why it matters.** An icon-sized PNG is one resolution wide. On
every higher-DPI display it either pixel-blurs or sits at the wrong
size; the fix is almost always an SVG. Coding agents reach for raster
icons because they treat icons like screenshots: bring the literal
pixels, paste them in. The detector starts the conversation at "is
this really raster on purpose?"

**Severity.** Always `low`: single-finding noise per icon, not a
deploy blocker. Confidence `0.85`.

**Project-specific exemptions / threshold tuning** via
`detectors.options.raster_should_be_vector`:

```json
{
  "detectors": {
    "options": {
      "raster_should_be_vector": {
        "allowedPaths": ["public/favicons/"],
        "iconSizeMax": 128
      }
    }
  }
}
```

**Suggested fix.** Re-author or re-export the icon as an SVG. If the
source is a designer's PNG, the original vector likely exists in
Figma / Sketch / Illustrator: re-export from there.

---

## SVG With Embedded Raster (`svg_with_embedded_raster`)

**What it detects.** SVG files containing one or more
`<image href="data:image/...;base64,...">` (or `xlink:href`)
elements. The pattern defeats the entire reason to use SVG: the
vector container ships, but the actual content is a raster blob.

**Example evidence.**

```text
2 `<image href="data:image/…;base64,…">` occurrences
embedded MIME types: image/jpeg, image/png
SVG byte size: 84,210 bytes (includes the base64 overhead)
re-author the raster region as vector paths, or split it out to its own asset
```

**Why it matters.** An SVG with an embedded base64 raster is the
worst of both worlds: the SVG mime type promises infinite scale,
but the actual pixels inside are locked to one resolution. The
asset is almost always larger than the equivalent PNG would have
been (base64 adds ~33% overhead). Design tool exporters (Figma,
Sketch, Illustrator's "convert to SVG") introduce this pattern
silently when a layer was originally a raster; coding agents copy
the file verbatim and never notice.

**Severity ramp.** `medium` for a single embedded raster; `high`
when two or more appear in the same SVG (multi-embed almost always
indicates a flattened multi-layer export). Confidence `0.95`.

**Project-specific exemptions** via
`detectors.options.svg_with_embedded_raster.allowedPaths`:

```json
{
  "detectors": {
    "options": {
      "svg_with_embedded_raster": {
        "allowedPaths": ["brand-logos/legacy/"]
      }
    }
  }
}
```

**Suggested fix.** Re-export the SVG from the design tool with the
raster layer flattened to vector geometry, or split the embedded
image out to its own PNG / WebP asset referenced by URL.

---

## Configuration

Asset discovery is independent of source discovery and configured
under `assets`:

```json
{
  "assets": {
    "include": ["**/*.{png,jpg,jpeg,gif,webp,avif,svg}"],
    "exclude": [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/public/vendor/**",
      "**/__snapshots__/**",
      "**/fixtures/**",
      "**/*.test.{png,jpg,jpeg,gif,webp,avif,svg}"
    ]
  }
}
```

Setting `assets.include` to an empty list disables the asset pass
entirely; setting individual detector ids in `detectors.disable`
disables that detector specifically (and the file is still scanned by
other asset detectors whose extensions match).
