import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (!audit.stdout.trim()) {
  process.stderr.write(audit.stderr);
  process.exit(audit.status ?? 1);
}

const report = JSON.parse(audit.stdout);
const vulnerabilities = report.vulnerabilities ?? {};
const names = Object.keys(vulnerabilities).sort();
const accepted = ["image-size", "pptxgenjs"];

if (JSON.stringify(names) !== JSON.stringify(accepted)) {
  console.error(
    `Unexpected production dependency advisories: ${names.join(", ") || "none"}`,
  );
  process.exit(1);
}

// image-size has no patched npm release as of this audit. It is present only
// because pptxgenjs can optionally size embedded images. Juno's two deck
// writers deliberately emit text, tables, charts, and shapes only. Keep that
// reachability claim mechanically true until a patched image-size is released.
const deckWriters = [
  "src/lib/office-export.ts",
  "src/lib/work/deliverables/presentation.ts",
];
for (const file of deckWriters) {
  const source = readFileSync(file, "utf8");
  if (/\.addImage\s*\(/.test(source) || /tableToSlides\s*\(/.test(source)) {
    console.error(
      `${file} reaches pptxgenjs image parsing; remove the audit exception before shipping.`,
    );
    process.exit(1);
  }
}

console.log(
  "Dependency audit passed: no critical advisories; the sole high advisory is an unreachable, unpatched pptxgenjs image-sizing path guarded above.",
);
