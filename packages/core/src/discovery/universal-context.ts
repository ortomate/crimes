import type { CrimesConfig } from "../config.js";
import type { UniversalDetectorContext } from "../detector.js";
import type { IaIndex } from "../ia/types.js";
import type { PettyIndex } from "../petty/types.js";
import type { ScoringContext } from "../scoring/build.js";
import { buildUniversalFile } from "./universal-file.js";

export async function buildUniversalContext(args: {
  root: string;
  absolutePath: string;
  file: string;
  config: CrimesConfig;
  indexes: {
    ia?: IaIndex;
    petty?: PettyIndex;
    scoring?: ScoringContext;
  };
}): Promise<UniversalDetectorContext> {
  const uf = await buildUniversalFile({
    root: args.root,
    absolutePath: args.absolutePath,
  });
  // Eagerly load source so `ctx.lineCount` is accessible without a
  // sync error inside detector bodies.
  await uf.readSource();
  return {
    kind: "universal",
    file: args.file,
    absolutePath: args.absolutePath,
    extension: uf.extension,
    readSource: uf.readSource,
    byteSize: uf.byteSize,
    get lineCount() {
      return uf.lineCount;
    },
    config: args.config,
    ia: args.indexes.ia,
    petty: args.indexes.petty,
    scoring: args.indexes.scoring,
  };
}
