/**
 * Recorded screenshot-test baselines.
 *
 * Snapshot tests compare a rendered view against a PNG committed beside
 * the test: swift-snapshot-testing writes `__Snapshots__/`,
 * jest-image-snapshot `__image_snapshots__/`, Paparazzi
 * `src/test/snapshots/images/`, and Roborazzi setups commonly
 * `src/test/screenshots/`. These images are test data. They are never
 * shipped, so page weight and vector advice do not apply, and their size
 * is set by the device under test. On a public iOS app they were 161 of
 * 200 `oversized_raster` findings.
 */
const SNAPSHOT_DIR = /(?:^|\/)__(?:image_)?snapshots__\//i;

/** A `screenshots/` or `snapshots/` directory counts only inside a test tree. */
const TEST_SCREENSHOT_DIR =
  /(?:^|\/)(?:src\/test\w*|tests?|\w+Tests|androidTest\w*)\/(?:.*\/)?(?:screenshots|snapshots)\//;

/** True when `file` is a recorded screenshot-test baseline. */
export function isSnapshotBaseline(file: string): boolean {
  return SNAPSHOT_DIR.test(file) || TEST_SCREENSHOT_DIR.test(file);
}
