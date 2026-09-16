# crimes.sh

The homepage is static HTML in `landing/`. Astro and Starlight build the
documentation from the repository's `docs/` directory. Edit those source
files; `src/content/docs/` and `dist/` are generated.

## Build and verify

From the repository root, using the Node version in `.nvmrc`:

```sh
pnpm verify
pnpm --filter @crimes/website build
node apps/website/scripts/verify-build.mjs
```

The website checks cover internal links and anchors, product claims,
canonical URLs, Vercel's trailing-slash policy and the sitemap tree
advertised in `robots.txt`. Rebuild before checking.

## URLs and indexing

Documentation URLs end in `/`. Keep Astro's `trailingSlash: "always"`
and Vercel's `trailingSlash: true` together. Sitemap entries, canonical
tags and internal links must use the same URL that serves the page.
Link to hosted documentation from the homepage; GitHub links are for
repository content such as source files and raw fixtures.

Vercel deploys pushes to `main` automatically. After deployment, check
the actual host as well as the build:

```sh
curl -sSI https://crimes.sh/docs/
curl -sSI https://crimes.sh/docs/agent-usage/
curl -sSI https://crimes.sh/docs
curl -sSI https://crimes.sh/docs/sitemap-index.xml
```

The slash URLs and sitemap should return `200` directly. `/docs` should
redirect to `/docs/`. Keep the HTTP-to-HTTPS redirect.

In Search Console, submit `https://crimes.sh/docs/sitemap-index.xml`
and confirm it is read successfully. For important pages, use URL
Inspection, test the live URL, then request indexing if the test passes.
Check Crawl stats and Host status if Google cannot fetch a page.
“Discovered, currently not indexed” with no last-crawl date means Google
has found the URL but has not crawled it yet. Passing our checks does
not establish Google's crawl access or guarantee indexing. See Google's
[report guide](https://support.google.com/webmasters/answer/7440203) and
[crawl request guidance](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl).
