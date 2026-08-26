import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{32,}\b/],
  ["GitHub token", /\b(?:ghp|github_pat)_[0-9A-Za-z_]{30,}\b/],
  ["OpenAI secret", /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}\b/],
  ["Stripe live secret", /\bsk_live_[0-9A-Za-z]{20,}\b/],
  ["Resend secret", /\bre_[0-9A-Za-z]{24,}\b/],
];
const intentionalFixtures = new Set([
  "native/Packages/JunoCode/Tests/JunoCodeCoreTests/SecretRedactorTests.swift|private key",
  "native/Packages/JunoCode/Tests/JunoCodeLocalTests/CommandExecutionServiceTests.swift|GitHub token",
  "native/Packages/JunoCode/Tests/JunoCodeLocalTests/DevServerServiceTests.swift|GitHub token",
  "tests/dlp-policy.test.ts|OpenAI secret",
  "tests/dlp.test.ts|GitHub token",
  "tests/dlp.test.ts|OpenAI secret",
]);

const findings = [];
for (const file of tracked) {
  if (file === "package-lock.json" || file.endsWith(".png") || file.endsWith(".jpg") || file.endsWith(".pdf")) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  text = text.replaceAll("AKIAIOSFODNN7EXAMPLE", "[AWS_DOCUMENTATION_EXAMPLE]");
  for (const [label, pattern] of patterns) {
    if (pattern.test(text) && !intentionalFixtures.has(`${file}|${label}`)) {
      findings.push(`${file}: possible ${label}`);
    }
  }
}
if (findings.length) {
  console.error("Tracked secret scan failed:\n" + findings.join("\n"));
  process.exit(1);
}
console.log(`Tracked secret scan passed (${tracked.length} files inspected).`);
