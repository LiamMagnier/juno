/**
 * Message-crypto unit tests — run with `npx tsx scripts/test-message-crypto.ts`.
 *
 * Exercises src/lib/message-crypto.ts without touching the database:
 *   1. encrypt → decrypt round-trips (ascii, unicode, long, empty)
 *   2. legacy plaintext rows pass through decryptMessageText unchanged
 *   3. tampering (flipped ciphertext/tag byte) is detected and throws
 *   4. malformed enc:v1: payloads throw descriptive errors
 *
 * No provider keys or database needed; AUTH_SECRET falls back to a test value
 * so the script runs anywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// —— Env loading (.env then .env.local; never override already-set keys) ——
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));
process.env.AUTH_SECRET ??= "test-message-crypto-fallback-secret";

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Flip one bit inside a base64 segment of the enc:v1: payload. */
function tamper(payload: string, segment: 1 | 2 | 3): string {
  const parts = payload.split(":"); // ["enc", "v1", iv, tag, data]
  const idx = segment + 1;
  const bytes = Buffer.from(parts[idx], "base64");
  bytes[0] ^= 0x01;
  parts[idx] = bytes.toString("base64");
  return parts.join(":");
}

async function main() {
  // Env must be in place before the lib chain loads — import inside main.
  const { encryptMessageText, decryptMessageText, isEncryptedMessageText } = await import("../src/lib/message-crypto");

  console.log("1. Round-trips");
  const samples = [
    "Hello, world!",
    "unicode — émojis 🎉🔐 and CJK 中文 and \n newlines \t tabs",
    "x".repeat(120_000),
    "",
    "enc:v1:user typed something that looks encrypted", // must survive a round-trip verbatim
  ];
  for (const plain of samples) {
    const stored = encryptMessageText(plain);
    check(
      `round-trips ${JSON.stringify(plain.slice(0, 32))}${plain.length > 32 ? `… (${plain.length} chars)` : ""}`,
      decryptMessageText(stored) === plain
    );
    check("  …and is stored with the enc:v1: prefix", isEncryptedMessageText(stored));
  }
  const a = encryptMessageText("same input");
  const b = encryptMessageText("same input");
  check("two encryptions of the same input differ (random iv)", a !== b);
  check("null passes through the nullable overload", decryptMessageText(null) === null);

  console.log("\n2. Legacy plaintext passthrough");
  for (const legacy of ["plain old message", "", "multi\nline body", "enc:v2:not-our-version"]) {
    check(`returns ${JSON.stringify(legacy.slice(0, 24))} unchanged`, decryptMessageText(legacy) === legacy);
  }

  console.log("\n3. Tamper detection");
  const stored = encryptMessageText("tamper with me");
  const cases: Array<[string, 1 | 2 | 3]> = [
    ["flipped iv byte", 1],
    ["flipped auth-tag byte", 2],
    ["flipped ciphertext byte", 3],
  ];
  for (const [label, segment] of cases) {
    const msg = throws(() => decryptMessageText(tamper(stored, segment)));
    check(`${label} throws`, msg !== null, msg ?? "did not throw");
  }

  console.log("\n4. Malformed payloads");
  const malformed = [
    "enc:v1:",
    "enc:v1:onlyone",
    "enc:v1:a:b", // two segments
    `${stored}:extra`, // four segments
    "enc:v1:AAAA:BBBB:CCCC", // wrong iv/tag lengths
  ];
  for (const payload of malformed) {
    const msg = throws(() => decryptMessageText(payload));
    check(`throws on ${JSON.stringify(payload.slice(0, 32))}`, msg !== null, "did not throw");
    check("  …with a descriptive error", msg !== null && /malformed|decrypt/i.test(msg), msg ?? "");
  }

  if (failures.length) {
    console.error(`\n${failures.length} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll message-crypto tests passed.");
  process.exit(0);
}

void main();
