/**
 * The native contract gate.
 *
 * Two generated Swift files, not one. `JunoWorkContract.swift` had a
 * `work:contract:check` script and no caller anywhere in CI, so the vocabulary
 * the Mac and the phone use to name a run's status could drift from
 * contracts/work/juno-work-v1.json for as long as nobody happened to run it by
 * hand. Chaining it here rather than adding a second workflow step is
 * deliberate: `native:contract:check` is what every gate already invokes — the
 * native workflow, the iOS release job and docs/native/handoff.json — and a
 * check that only some of them call is a check that only some of them have.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checkedInPath = resolve(
  "native/Packages/JunoNativeKit/Sources/JunoAPI/Generated/JunoNativeContract.swift",
);
const directory = await mkdtemp(join(tmpdir(), "juno-contract-drift-"));
const generatedPath = join(directory, "JunoNativeContract.swift");

try {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/generate-native-swift-contract.mjs",
        `--output=${generatedPath}`,
      ],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Swift contract generator exited with status ${code}`));
    });
  });

  const [checkedIn, generated] = await Promise.all([
    readFile(checkedInPath, "utf8"),
    readFile(generatedPath, "utf8"),
  ]);
  if (checkedIn !== generated) {
    throw new Error(
      "Generated native Swift contract is stale. Run: "
        + "node scripts/generate-native-swift-contract.mjs "
        + "--output=native/Packages/JunoNativeKit/Sources/JunoAPI/Generated/JunoNativeContract.swift",
    );
  }
  console.log("Native Swift contract matches the canonical OpenAPI digest.");
} finally {
  await rm(directory, { recursive: true, force: true });
}

// Runs after the OpenAPI comparison rather than beside it so a single failure
// reads unambiguously: the first message names which of the two contracts moved.
await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, ["scripts/check-work-contract.mjs"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`Work contract check exited with status ${code}`));
  });
});
