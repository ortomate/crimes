"""The public site may only claim a version that was actually released.

Between releases the package version takes continuous-improvement patch
bumps (`evals/README.md`): they redirect the eval results directory and
are never published. Stamping one onto the landing page would advertise
a version nobody can install and link to release notes that do not
exist, which is what `generate-reference.mjs` used to do.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def released_versions():
    return {
        match.group(1)
        for match in (
            re.fullmatch(r"v(\d+\.\d+\.\d+)\.md", path.name)
            for path in (ROOT / "docs" / "releases").iterdir()
        )
        if match
    }


class SiteVersions(unittest.TestCase):
    def setUp(self):
        self.released = released_versions()
        self.assertTrue(self.released, "no docs/releases/vX.Y.Z.md found")

    def test_landing_claims_a_released_version(self):
        landing = (ROOT / "apps" / "website" / "landing" / "index.html").read_text()
        claimed = set(re.findall(r'"softwareVersion"\s*:\s*"([^"]+)"', landing))
        claimed |= set(re.findall(r'<span class="pill">v([0-9.]+)', landing))
        self.assertTrue(claimed, "landing page states no version")
        for version in claimed:
            self.assertIn(version, self.released, f"landing claims unreleased {version}")

    def test_every_release_link_resolves_to_release_notes(self):
        for name in ("index.html", "llms.txt"):
            text = (ROOT / "apps" / "website" / "landing" / name).read_text()
            for version in re.findall(r"/docs/releases/v([0-9.]+)/", text):
                self.assertIn(version, self.released, f"{name} links to missing notes")

    def test_package_version_may_run_ahead_of_the_released_set(self):
        # The inverse guard: this test must not be "fixed" by pinning the
        # package version to the last release. A patch bump running ahead
        # is the documented state, not a defect.
        package = json.loads((ROOT / "packages" / "cli" / "package.json").read_text())
        self.assertRegex(package["version"], r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
