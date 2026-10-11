"""Synthetic scoring fixtures verify the grader, never product success."""
import importlib.util
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

spec = importlib.util.spec_from_file_location("workflow_benchmark", Path(__file__).resolve().parents[1] / "scripts/workflow-benchmark.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class WorkflowScoring(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "benchmark"
        benchmark.initialize(self.directory)

    def tearDown(self):
        self.temporary.cleanup()

    def claim(self, task):
        run = self.directory / "runs/alevr" / task["id"]
        record = json.loads((run / "result.json").read_text())
        for name in task["requiredArtifacts"]:
            (run / "workspace/outputs" / name).write_text(json.dumps(task["expectedFacts"]) if name == "facts.json" else "synthetic grader fixture")
        record.update(status="claimed_complete", model="fixture", productVersion="fixture", executorIdentity="fixture-executor",
                      sessionId="fixture-session", startedAt="2026-10-11T12:00:00Z", durationSeconds=10,
                      attempts=1, manualRecovery=False, unauthorizedOperations=0, recoveryPassed=True)
        self.review(run, record)
        return run, record

    def review(self, run, record):
        record["review"] = {"reviewerIdentity":"independent-fixture-reviewer", "correct":True, "usable":True,
                            "reopened":True, "instructionsSatisfied":True, "latestRevisionVerified":True,
                            "artifactHashes": {file.name:benchmark.sha(file) for file in (run / "workspace/outputs").iterdir()}}

    def test_exact_category_counts_and_no_claimed_product_success(self):
        self.assertEqual(Counter(item["category"] for item in benchmark.TASKS), {name:6 for name in ("chat","documents","local","remote","code")})
        self.assertEqual(len({item["id"] for item in benchmark.TASKS}), 30)
        summary = benchmark.summarize(self.directory)
        self.assertFalse(summary["alevrTargetMet"])
        self.assertEqual(summary["counts"]["alevr"]["not_run"], 30)
        self.assertEqual(len(summary["untestedComparisons"]), 7)

    def test_wrong_facts_fail_despite_done_and_review_claims(self):
        item = benchmark.TASKS[1]
        run, record = self.claim(item)
        self.assertEqual(benchmark.grade(run,item,record)["status"], "verified")
        (run / "workspace/outputs/facts.json").write_text('{"volumeChangePercent":999}')
        self.review(run, record)
        self.assertEqual(benchmark.grade(run,item,record)["status"], "unverified")

    def test_edit_after_review_invalidates_evidence(self):
        item = benchmark.TASKS[0]
        run, record = self.claim(item)
        (run / "workspace/outputs/summary.md").write_text("different bytes")
        self.assertIn("Independent review hashes do not match final artifacts",benchmark.grade(run,item,record)["errors"])

    def test_outside_grant_symlink_artifact_refuses(self):
        item = benchmark.TASKS[0]
        run, record = self.claim(item)
        file = run / "workspace/outputs/summary.md"
        file.unlink()
        file.symlink_to(run / "outside/credentials.txt")
        self.assertEqual(benchmark.grade(run,item,record)["status"], "unverified")

    def test_missing_independent_review_security_and_manual_recovery_refuse(self):
        item = benchmark.TASKS[0]
        run, record = self.claim(item)
        for change in ({"review":None}, {"unauthorizedOperations":1}, {"manualRecovery":True}, {"attempts":2},
                       {"humanInterventions":[{"kind":"human-fixed-output"}]}):
            with self.subTest(change=change):
                self.assertEqual(benchmark.grade(run,item,{**record,**change})["status"],"unverified")

    def test_remote_phone_success_requires_physical_device(self):
        item = next(item for item in benchmark.TASKS if item["id"] == "remote-02")
        run, record = self.claim(item)
        self.assertEqual(benchmark.grade(run,item,record)["status"], "unverified")
        record["physicalDeviceTested"] = True
        self.assertEqual(benchmark.grade(run,item,record)["status"], "verified")

    def test_latest_code_revision_must_match_executed_checks(self):
        item = next(item for item in benchmark.TASKS if item["id"] == "code-01")
        run, record = self.claim(item)
        (run / "workspace/outputs/test.log").write_text("synthetic checker fixture; not a live model run")
        (run / "workspace/outputs/test-results.json").write_text(json.dumps({"workspaceSHA256":benchmark.workspace_hash(run / "workspace/project"), "checks":[{"command":"node --test test.mjs","exitCode":0}]}))
        self.review(run,record)
        self.assertEqual(benchmark.grade(run,item,record)["status"], "verified")
        (run / "workspace/project/ledger.mjs").write_text("changed after tests")
        self.assertIn("Test evidence does not match latest project revision",benchmark.grade(run,item,record)["errors"])


if __name__ == "__main__":
    unittest.main()
