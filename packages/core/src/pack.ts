/**
 * The four packs a detector can belong to. See
 * `docs/superpowers/specs/2026-05-22-wider-codebase-support-design.md`
 * §"Pack model" for the full semantics.
 *
 * Distinct from the existing `Tier` type (`domain | nonDomain`) in
 * `scoring/tier.ts`, which describes a finding's **file scope** rather
 * than the detector capability that produced it.
 */
export type Pack =
  | "universal"
  | "language-js"
  | "language-py"
  | "cross-language";

export const PACK_IDS = [
  "universal",
  "language-js",
  "language-py",
  "cross-language",
] as const satisfies readonly Pack[];

export function isLanguagePack(pack: Pack): boolean {
  return pack === "language-js" || pack === "language-py";
}
