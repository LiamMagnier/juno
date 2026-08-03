/**
 * Fails when the checked-in Swift capability contract no longer matches the
 * manifest it is generated from.
 *
 * Regenerating into a temporary file and diffing is the only check that
 * actually holds: comparing version numbers, or trusting a reviewer to notice,
 * both pass a Swift enum that is missing the degradation kind added to the
 * manifest that morning — and a client that does not recognise a kind shows
 * the user nothing rather than something wrong, so the failure is silent on
 * exactly the surface it matters on.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checkedInPath = resolve(
  "native/Packages/JunoNativeKit/Sources/JunoCore/Generated/JunoCapabilityContract.swift",
);
const directory = await mkdtemp(join(tmpdir(), "juno-capability-drift-"));
const generatedPath = join(directory, "JunoCapabilityContract.swift");

try {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/generate-capability-contract.mjs", `--output=${generatedPath}`],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Capability contract generator exited with status ${code}`));
    });
  });

  const [checkedIn, generated] = await Promise.all([
    readFile(checkedInPath, "utf8").catch(() => null),
    readFile(generatedPath, "utf8"),
  ]);

  if (checkedIn === null) {
    throw new Error(
      "The generated Swift capability contract is missing. Run: "
        + "node scripts/generate-capability-contract.mjs "
        + `--output=${checkedInPath}`,
    );
  }
  if (checkedIn !== generated) {
    throw new Error(
      "The Swift capability contract is stale — the manifest changed without it. Run: "
        + "node scripts/generate-capability-contract.mjs "
        + `--output=${checkedInPath}`,
    );
  }
  console.log("Swift capability contract matches contracts/capabilities/juno-capabilities-v1.json.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
