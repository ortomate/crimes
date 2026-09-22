import { describe, expect, it } from "vitest";
import { SKILL_BODY, SKILL_VERSION } from "./template.js";

describe("the bundled skill's calibration instructions", () => {
  it("tells the agent to confirm true positives, not only to suppress false ones", () => {
    // The first machine-wide rollup import, 2026-09-22, collected 54
    // verdicts from five repositories. Every one was `fp`, because this
    // text only ever named `fp`. A detector that fires correctly fifty
    // times and wrongly once is indistinguishable, in that data, from one
    // that is wrong once and never right — and act rate is what
    // docs/dogfooding/2026-08-02-protocol.md says decides whether a
    // detector is kept, retuned or sunset.
    expect(SKILL_BODY).toContain("--verdict tp");
    expect(SKILL_BODY).toContain("--verdict fp");
  });

  it("keeps the skill version in step with a workflow change", () => {
    expect(SKILL_VERSION).not.toBe("0.29.0");
  });
});
