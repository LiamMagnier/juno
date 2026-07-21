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
