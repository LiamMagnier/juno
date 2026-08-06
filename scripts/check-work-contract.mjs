/**
 * Fails when the checked-in Swift Work contract no longer matches the vocabulary
 * it is generated from.
 *
 * Regenerating into a temporary file and byte-comparing is the only check that
 * actually holds: comparing version numbers, or trusting a reviewer to notice,
 * both pass a Swift enum that is missing the status added to the contract that
 * morning — and a client that cannot name a status renders the run as nothing
 * at all, so the failure is invisible on exactly the surface it matters on.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checkedInPath = resolve(
  "native/Packages/JunoNativeKit/Sources/JunoCore/Generated/JunoWorkContract.swift",
);
const directory = await mkdtemp(join(tmpdir(), "juno-work-drift-"));
const generatedPath = join(directory, "JunoWorkContract.swift");

try {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/generate-work-contract.mjs", `--output=${generatedPath}`],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Work contract generator exited with status ${code}`));
    });
  });

  const [checkedIn, generated] = await Promise.all([
    readFile(checkedInPath, "utf8").catch(() => null),
    readFile(generatedPath, "utf8"),
  ]);

  if (checkedIn === null) {
    throw new Error(
      "The generated Swift Work contract is missing. Run: "
        + "node scripts/generate-work-contract.mjs "
        + `--output=${checkedInPath}`,
    );
  }
  if (checkedIn !== generated) {
    throw new Error(
      "The Swift Work contract is stale — the vocabulary changed without it. Run: "
        + "node scripts/generate-work-contract.mjs "
        + `--output=${checkedInPath}`,
    );
  }
  console.log("Swift Work contract matches contracts/work/juno-work-v1.json.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
