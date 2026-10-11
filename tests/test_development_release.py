"""Candidate certification refuses dirty/stale sources and incomplete checks."""
import importlib.util
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("development_release", Path(__file__).resolve().parents[1] / "scripts/development-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class CandidateCertification(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "repo"
        self.output = Path(self.temporary.name) / "evidence"
        self.root.mkdir()
        self.output.mkdir()
        for args in (("init", "-q"), ("config", "user.email", "fixture@example.invalid"), ("config", "user.name", "Fixture")):
            subprocess.run(["git", "-C", str(self.root), *args], check=True)
        (self.root / "source").write_text("initial\n")
        subprocess.run(["git", "-C", str(self.root), "add", "source"], check=True)
        subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "fixture"], check=True)
        self.sha = release.require_source(self.root)
        self.manifest = {"sourceSHA": self.sha, "status": "running", "checks": [], "artifacts": []}

    def tearDown(self):
        self.temporary.cleanup()

    def test_dirty_tracked_and_untracked_sources_refuse(self):
        (self.root / "source").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "clean"):
            release.require_source(self.root, self.sha)
        (self.root / "source").write_text("initial\n")
        (self.root / "untracked").write_text("extra")
        with self.assertRaisesRegex(RuntimeError, "clean"):
            release.require_source(self.root, self.sha)

    def test_failure_stops_before_next_check_and_cannot_be_certified(self):
        steps = [("bad", [sys.executable, "-c", "raise SystemExit(7)"]),
                 ("later", [sys.executable, "-c", "print('should not run')"])]
        with self.assertRaisesRegex(RuntimeError, "bad"):
            release.run_steps(self.root, self.output, self.manifest, steps, os.environ.copy())
        self.assertEqual(self.manifest["checks"][0]["exitCode"], 7)
        self.assertFalse((self.output / "later.log").exists())
        with self.assertRaisesRegex(RuntimeError, "incomplete or failed"):
            release.seal(self.output, self.manifest, steps)

    def test_source_mutation_after_green_check_refuses(self):
        steps = [("mutation", [sys.executable, "-c", "from pathlib import Path; Path('source').write_text('different')"])]
        with self.assertRaisesRegex(RuntimeError, "clean"):
            release.run_steps(self.root, self.output, self.manifest, steps, os.environ.copy())
        self.assertEqual(self.manifest["status"], "running")

    def test_stale_bundle_identity_refuses(self):
        bundle = self.output / "Fixture.app"
        bundle.mkdir()
        (bundle / "Info.plist").write_bytes(plistlib.dumps({"JunoGitSHA": "old-commit"}))
        with self.assertRaisesRegex(RuntimeError, "source mismatch"):
            release.require_bundle_source(bundle, self.sha)
        (bundle / "Info.plist").write_bytes(plistlib.dumps({"JunoGitSHA": self.sha}))
        release.require_bundle_source(bundle, self.sha)

    def test_complete_evidence_has_log_and_manifest_checksums(self):
        steps = [("fixture", [sys.executable, "-c", "print('verified fixture')"])]
        release.run_steps(self.root, self.output, self.manifest, steps, os.environ.copy())
        with self.assertRaisesRegex(RuntimeError, "artifact"):
            release.seal(self.output, self.manifest, steps)
        artifact = self.output / "fixture.bin"
        artifact.write_bytes(b"fixture")
        self.manifest["artifacts"] = [{"file": artifact.name, "sha256": release.digest(artifact), "sourceSHA": self.sha}]
        release.seal(self.output, self.manifest, steps)
        saved = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(saved["status"], "verified-development")
        self.assertEqual(saved["checks"][0]["logSHA256"], release.digest(self.output / "fixture.log"))
        self.assertTrue((self.output / "manifest.sha256").read_text().startswith(release.digest(self.output / "manifest.json")))


if __name__ == "__main__":
    unittest.main()
