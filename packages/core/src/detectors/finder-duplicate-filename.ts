import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";

const FINDER_DUPLICATE_RE = /(?:^|\/)([^/]+) ([2-9])(\.[^/.]+)$/;

export const finderDuplicateFilenameDetector: LanguageJsDetector = {
  id: "finder_duplicate_filename",
  name: "Finder Duplicate Filename",
  description:
    "Flags macOS Finder-style duplicate filenames such as `Button 2.tsx`.",
  whyItMatters:
    "Finder and iCloud append ` 2` when resolving local filename conflicts. " +
    "Those duplicate files often slip into repos as accidental copies, then " +
    "agents and humans have to guess which file is canonical. The fix is " +
    "usually unambiguous: compare the copy, keep the real file, delete the duplicate.",

  pack: "language-js",
  run(ctx) {
    const match = FINDER_DUPLICATE_RE.exec(ctx.file);
    if (!match) return [];

    const duplicateName = ctx.file.split("/").at(-1)!;
    const canonicalName = `${match[1]}${match[3]}`;
    const canonicalPath = ctx.file.replace(/[^/]+$/, canonicalName);

    const finding: Finding = {
      id: "",
      type: "finder_duplicate_filename",
      charge: "Finder Duplicate Filename",
      severity: "medium",
      confidence: 0.9,
      file: ctx.file,
      summary:
        `${duplicateName} looks like a macOS Finder/iCloud conflict copy. ` +
        `This usually means the repo contains an accidental duplicate file.`,
      evidence: [
        `filename ends with Finder conflict suffix: "${duplicateName}"`,
        `likely intended canonical path: ${canonicalPath}`,
        `suffix number: ${match[2]}`,
      ],
      effort: "quick",
      fix_shape: "delete the duplicate; the canonical file already exists",
      scores: {
        severity: 0.55,
        confidence: 0.9,
      },
      suggested_actions: [
        {
          kind: "remove_duplicate_file",
          description:
            "Compare the suffixed file with the likely canonical file. If it is an accidental copy, delete it; if both are real, rename one with a domain-specific name.",
          risk: "low",
        },
      ],
      related_files: [canonicalPath],
    };
    return [finding];
  },
};
