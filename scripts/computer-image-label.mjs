#!/usr/bin/env node
// The agent-computer image's security label: the one the app requires
// (src/lib/computer/docker.ts COMPUTER_IMAGE_SECURITY_LABEL, its single source),
// and every copy that must say the same (the Dockerfile's LABEL, the computer
// host's SECURITY_LABEL, deploy/computer-host/setup.sh's LABEL). CI uses this
// instead of a sed over TypeScript; tests/computer-image-label.test.ts holds it to
// the exported constant, so reformatting that line fails a unit test in the pull
// request rather than the deploy chain.
//
//   node scripts/computer-image-label.mjs                 prints the label; exits 1 if a copy disagrees
//   node scripts/computer-image-label.mjs --image <ref>   and checks a built image's juno.security label
//
// Plain Node, no dependencies: the computer-image job runs it before `npm ci`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the label is written, and how to read it there (exactly one match each). */
export const LABEL_SOURCES = [
  {
    file: "src/lib/computer/docker.ts",
    pattern: /^export const COMPUTER_IMAGE_SECURITY_LABEL\s*=\s*(["'`])([^"'`\n]+)\1\s*;?[ \t]*$/gm,
    group: 2,
  },
  { file: "deploy/agent-computers/Dockerfile", pattern: /^LABEL\s+juno\.security\s*=\s*"?([^"\s]+)"?[ \t]*$/gm, group: 1 },
  { file: "deploy/computer-host/juno-computer-host.py", pattern: /^SECURITY_LABEL\s*=\s*(["'])([^"'\n]+)\1[ \t]*$/gm, group: 2 },
  { file: "deploy/computer-host/setup.sh", pattern: /^LABEL=(["']?)([^"'\s]+)\1[ \t]*$/gm, group: 2 },
];

/** The label one source text carries, or an error that names the file. */
export function labelIn(source, text) {
  const found = [...text.matchAll(source.pattern)].map((match) => match[source.group]);
  if (found.length !== 1) {
    throw new Error(`${source.file}: expected the security label exactly once, found ${found.length}`);
  }
  return found[0];
}

/** The app's label, after checking that every copy agrees with it. */
export function requiredLabel(readText = (file) => readFileSync(path.join(ROOT, file), "utf8")) {
  const [app, ...copies] = LABEL_SOURCES.map((source) => ({ file: source.file, label: labelIn(source, readText(source.file)) }));
  const disagree = copies.filter((copy) => copy.label !== app.label);
  if (disagree.length > 0) {
    throw new Error(
      `the image security label differs from ${app.file} (${app.label}): ${disagree.map((copy) => `${copy.file} says ${copy.label}`).join("; ")}`,
    );
  }
  return app.label;
}

function main(argv) {
  const label = requiredLabel();
  const at = argv.indexOf("--image");
  if (at === -1) {
    process.stdout.write(`${label}\n`);
    return 0;
  }
  const image = argv[at + 1];
  if (!image) throw new Error("--image needs an image reference");
  const carried = execFileSync("docker", ["image", "inspect", "--format", '{{index .Config.Labels "juno.security"}}', image], {
    encoding: "utf8",
  }).trim();
  process.stdout.write(`image ${image} carries "${carried}"; the app requires "${label}"\n`);
  return carried === label ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`computer-image-label: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
