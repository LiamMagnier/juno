import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

/*
 * scripts/computer-image-label.mjs, which CI uses to check the agent-computer
 * image's label (.github/workflows/deploy.yml computer-image, computer-boundary,
 * computer-e2e), reads the same label the app requires, and every copy of it
 * agrees: the image the suites test is one the app would accept.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const docker = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/computer-image-label.mjs");

interface LabelModule {
  LABEL_SOURCES: Array<{ file: string }>;
  labelIn(source: { file: string }, text: string): string;
  requiredLabel(readText?: (file: string) => string): string;
}
const load = () => import(SCRIPT) as Promise<LabelModule>;

test("the script prints the label the app requires, and every copy agrees", () => {
  const printed = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }).trim();
  assert.equal(printed, docker.COMPUTER_IMAGE_SECURITY_LABEL);
});

test("it still reads the app's constant when the line is reformatted", async () => {
  const { LABEL_SOURCES, labelIn } = await load();
  const app = LABEL_SOURCES[0]!;
  for (const line of [
    'export const COMPUTER_IMAGE_SECURITY_LABEL = "pipe-v9";',
    "export const COMPUTER_IMAGE_SECURITY_LABEL = 'pipe-v9'",
    "export const COMPUTER_IMAGE_SECURITY_LABEL=`pipe-v9`;",
  ]) {
    assert.equal(labelIn(app, `// x\n${line}\n`), "pipe-v9", line);
  }
  assert.throws(() => labelIn(app, "const COMPUTER_IMAGE_SECURITY_LABEL = 'x';"), /exactly once, found 0/);
});

test("a copy that disagrees fails, and names the file", async () => {
  const { requiredLabel } = await load();
  const real = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  const dockerfile = (file: string) =>
    file.endsWith("Dockerfile") ? real(file).replace(/^LABEL juno\.security=.*$/m, 'LABEL juno.security="pipe-v0"') : real(file);
  assert.throws(() => requiredLabel(dockerfile), /Dockerfile says pipe-v0/);
  const host = (file: string) =>
    file.endsWith("juno-computer-host.py") ? real(file).replace(/^SECURITY_LABEL = .*$/m, 'SECURITY_LABEL = "pipe-v0"') : real(file);
  assert.throws(() => requiredLabel(host), /juno-computer-host\.py says pipe-v0/);
  assert.equal(requiredLabel(real), docker.COMPUTER_IMAGE_SECURITY_LABEL);
});
