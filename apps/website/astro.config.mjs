// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { remarkRepositoryLinks } from "./scripts/repository-links.mjs";

// Astro builds a single tree rooted at `/docs/`. The repo's static
// landing page (`landing/`) is copied into `dist/` separately by
// `scripts/build.mjs`, so the two surfaces compose without conflict:
//   /             → static landing page (unchanged)
//   /docs/        → Starlight docs root
//   /docs/...     → docs pages migrated from `<repo>/docs/**/*.md`
export default defineConfig({
  site: "https://crimes.sh",
  base: "/docs",
  trailingSlash: "always",
  markdown: { remarkPlugins: [remarkRepositoryLinks] },
  // Astro's `base` only rewrites URLs — output file paths stay flat
  // unless we mirror the base in `outDir`. Writing into `dist/docs/...`
  // lets `scripts/build.mjs` drop the landing page into `dist/` on top
  // without collisions.
  outDir: "./dist/docs",
  integrations: [
    starlight({
      title: "crimes docs",
      description:
        "Documentation for `crimes`, the agent-native change & risk scanner for TypeScript, JavaScript and Python repos.",
      head: [
        {
          tag: "script",
          attrs: {
            defer: true,
            "data-domain": "crimes.sh",
            src: "https://plausible.io/js/script.js",
          },
        },
      ],
      logo: {
        light: "./public/favicon.svg",
        dark: "./public/favicon.svg",
        replacesTitle: false,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/ortomate/crimes",
        },
      ],
      // Sidebar built from the migrated `docs/**/*.md` tree. The
      // grouping mirrors the URL plan in §11; new 0.6.0 finding-type
      // categories (structural / dependency / frontend / duplication)
      // get added in Prompt O alongside the new markdown pages.
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Agent usage", slug: "agent-usage" },
            { label: "Agent setup and updates", slug: "skills" },
            { label: "Try one real change", slug: "external-trial" },
            { label: "CLI and detector reference", slug: "reference" },
            { label: "Configuration", slug: "configuration" },
            { label: "Scoring", slug: "scoring" },
          ],
        },
        {
          label: "Finding types",
          items: [{ autogenerate: { directory: "finding-types" } }],
        },
        {
          label: "Operating",
          items: [
            { label: "CI integration", slug: "ci" },
            { label: "Analysis performance", slug: "performance" },
            { label: "Suppressions", slug: "suppressions" },
            { label: "Triage", slug: "triage" },
            { label: "Pin migration", slug: "pin-migration" },
            { label: "Explain", slug: "explain" },
            { label: "JSON schema", slug: "json-schema" },
            { label: "JSON report types", slug: "api-types" },
            { label: "Packs", slug: "packs" },
            { label: "Releasing", slug: "releasing" },
          ],
        },
        {
          label: "Releases",
          items: [{ autogenerate: { directory: "releases" } }],
        },
      ],
    }),
  ],
});
