import { describe, expect, it } from "vitest";
import { isSnapshotBaseline } from "./snapshot-baselines.js";

describe("isSnapshotBaseline", () => {
  it("recognises snapshot-library directories", () => {
    expect(
      isSnapshotBaseline("Tests/FeedTests/__Snapshots__/FeedTests/testFeed.1.png"),
    ).toBe(true);
    expect(isSnapshotBaseline("src/__image_snapshots__/button-test-tsx.png")).toBe(true);
    expect(isSnapshotBaseline("app/src/test/snapshots/images/com_example_Row.png")).toBe(
      true,
    );
    expect(
      isSnapshotBaseline("feature/impl/src/test/screenshots/Screen_tablet.png"),
    ).toBe(true);
    expect(isSnapshotBaseline("app/src/testDemo/screenshots/nav_rail.png")).toBe(true);
  });

  it("leaves screenshots outside a test tree alone", () => {
    expect(isSnapshotBaseline("docs/images/screenshots.png")).toBe(false);
    expect(isSnapshotBaseline("website/public/screenshots/home.png")).toBe(false);
    expect(isSnapshotBaseline("src/assets/hero.png")).toBe(false);
  });
});
