import { spawnSync } from "node:child_process";

const tests = [
  "tests/admin-security.test.ts",
  "tests/security-regressions.test.ts",
  "tests/gemini-network.test.ts",
  "tests/provider-error.test.ts",
  "tests/provider-health-policy.test.ts",
  "tests/search-ssrf.test.ts",
  "tests/csrf-origin.test.ts",
  "tests/ownership-guard.test.ts",
  "tests/attachment-upload.test.ts",
  "tests/sandbox-security.test.ts",
  "tests/action-approval.test.ts",
  "tests/action-approval-enforcement.test.ts",
  "tests/native-auth-core.test.ts",
  "tests/request-id.test.ts",
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["--import", "tsx", "--test", ...tests]);
run(process.execPath, ["scripts/check-tracked-secrets.mjs"]);
run(process.execPath, ["scripts/dependency-audit.mjs"]);
console.log("Security release gate passed.");
