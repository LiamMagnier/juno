/**
 * The register of deliberate web/Mac differences stays one numbered list.
 *
 *   node scripts/check-design-register.mjs
 *
 * docs/native/WEB_TO_NATIVE_DESIGN.md, "Register of deliberate differences",
 * is where every intentional difference is written down (MACOS_LIQUID_GLASS_
 * REDESIGN.md §A4.9); anything not on it is drift. This holds the list to its
 * numbering — one entry per number, from 1, no gaps, nothing empty — because
 * code comments, the spec and the parity ledger cite entries by number, and a
 * renumbering nobody noticed silently repoints every one of them. It also
 * fails when the parity ledger or the chat wire's notes cite an entry that
 * does not exist or is retired ("*Retired …*").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const REGISTER = "docs/native/WEB_TO_NATIVE_DESIGN.md";
const CITERS = ["contracts/parity/features.json", "contracts/chat/juno-chat-wire-v1.status.json"];
const errors = [];

const lines = readFileSync(join(root, REGISTER), "utf8").split("\n");
const start = lines.findIndex((line) => line === "## Register of deliberate differences");
if (start === -1) {
  console.error(`[register] ${REGISTER} has no "## Register of deliberate differences" section`);
  process.exit(1);
}
const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
const section = lines.slice(start + 1, end === -1 ? lines.length : end);

const entries = new Map();
let expected = 1;
for (const line of section) {
  const match = /^(\d+)\. (.*)$/.exec(line);
  if (!match) continue;
  const number = Number(match[1]);
  const text = match[2].trim();
  if (entries.has(number)) errors.push(`#${number} appears twice`);
  else if (number !== expected) errors.push(`#${number} follows #${expected - 1}: the register is numbered from 1 with no gaps (retire an entry, never delete its number)`);
  if (!text) errors.push(`#${number} is empty`);
  entries.set(number, { text, retired: text.startsWith("*Retired") });
  expected = number + 1;
}
if (!entries.size) errors.push("the register has no entries");

// Cross-references inside the register: "extends #39", "superseded by #73".
for (const [number, { text }] of entries) {
  for (const match of text.matchAll(/(?<![\w/])#(\d+)\b/g)) {
    const cited = Number(match[1]);
    if (!entries.has(cited)) errors.push(`#${number} cites #${cited}, which is not in the register`);
  }
}

// The ledger and the wire cite entries in their notes.
for (const file of CITERS) {
  let source = "";
  try {
    source = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  for (const match of source.matchAll(/register #(\d+)/g)) {
    const cited = Number(match[1]);
    const entry = entries.get(cited);
    if (!entry) errors.push(`${file} cites register #${cited}, which does not exist`);
    else if (entry.retired) errors.push(`${file} cites register #${cited}, which is retired`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`[register] ${error}`);
  process.exit(1);
}
const retired = [...entries.values()].filter((entry) => entry.retired).length;
console.log(`[register] ${entries.size} entries (#1–#${entries.size}, ${retired} retired); every citation in the ledger and the chat wire resolves`);
