import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * A source guard, in the style of tests/security-regressions.test.ts.
 *
 * Encryption at rest only holds while EVERY write seals and EVERY read unseals.
 * A single new call site that reads `Message.activity` straight off the row, or
 * writes `ScheduledTask.prompt` without `encryptField`, silently reverts the
 * column to plaintext for the rows it touches — and nothing about that failure
 * is visible in the product: the feature keeps working perfectly. A unit test
 * of the cipher cannot catch it, because the cipher is not what broke.
 *
 * So this reads the source. It is coarse on purpose: it asserts that the
 * columns are named only where field-crypto is also named, which is a rule a
 * reviewer can hold in their head and a grep can check.
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Every .ts/.tsx file under `dir`, skipping node_modules and build output. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message.activity — the tool-call log, i.e. the user's own connector content
// ---------------------------------------------------------------------------

test("every write of Message.activity goes through encryptJsonField", () => {
  // The chat route is the hot path (three writes: the private turn, the saved
  // turn, and the research-partial turn); code-remote persists a Juno Code
  // outcome; the import route ingests an uploaded package.
  for (const [file, expected] of [
    ["src/app/api/chat/route.ts", 3],
    ["src/lib/code-remote.ts", 1],
    ["src/app/api/import/route.ts", 1],
  ] as const) {
    const text = source(file);
    // A line that assigns `activity:` into a Prisma payload — that is what
    // `InputJsonValue` / `jsonInput` mark — must name encryptJsonField on it.
    const unsealed = text
      .split("\n")
      .filter((line) => /\bactivity:/.test(line) && /InputJsonValue|jsonInput/.test(line))
      .filter((line) => !line.includes("encryptJsonField"));
    assert.deepEqual(unsealed, [], `${file} writes Message.activity without sealing it`);
    assert.equal(
      (text.match(/encryptJsonField\(/g) ?? []).length,
      expected,
      `${file} should seal activity at exactly ${expected} site(s)`
    );
  }
});

test("the fork route copies the activity ciphertext verbatim rather than re-sealing it", () => {
  // A fork is a byte copy of the row, exactly as MessageVersion copies content:
  // decrypting and re-encrypting would burn a fresh IV per branched message for
  // no gain, and would break the moment a key leaves the ring mid-fork.
  const fork = source("src/app/api/conversations/[id]/fork/route.ts");
  assert.match(fork, /activity: m\.activity === null \? Prisma\.DbNull : \(m\.activity as unknown as Prisma\.InputJsonValue\)/);
  assert.doesNotMatch(fork, /field-crypto/);
});

test("the conversation serializer unseals Message.activity before rebuilding it", () => {
  const serializers = source("src/lib/serializers.ts");
  assert.match(serializers, /import \{ decryptJsonField \} from "@\/lib\/field-crypto"/);
  assert.match(serializers, /const raw = decryptJsonField\(stored\)/);
  // The field whitelist must run on the RECOVERED structure, never on the row.
  assert.doesNotMatch(serializers, /function serializeActivity\(raw: unknown\)/);
});

test("the account export unseals activity and the memory summary", () => {
  const route = source("src/app/api/account/export/route.ts");
  assert.match(route, /activity: decryptJsonField\(m\.activity\)/);
  assert.match(route, /content: decryptField\(memorySummary\.content\)/);
});

test("a public share link still does not select Message.activity at all", () => {
  // Encryption does not change this: everyone who can open the link would hold
  // the plaintext. The column stays out of the projection entirely.
  const share = source("src/lib/share.ts");
  const select = share.match(/select: \{ id: true, role: true, content: true[^}]*\}/);
  assert.ok(select, "the shared-snapshot projection moved — re-check that activity is still absent");
  assert.doesNotMatch(select[0], /activity/);
});

// ---------------------------------------------------------------------------
// MemorySummary.content and ScheduledTask.prompt
// ---------------------------------------------------------------------------

test("MemorySummary.content is sealed on write and unsealed on read", () => {
  const memory = source("src/lib/memory.ts");
  assert.match(memory, /const sealed = encryptField\(content\)/);
  assert.match(memory, /create: \{ userId: opts\.userId, content: sealed/);
  assert.match(memory, /update: \{ content: sealed/);
  assert.match(memory, /content: decryptField\(row\.content\)/);
  // The import route is the other writer of this row.
  assert.equal((source("src/app/api/import/route.ts").match(/content: encryptField\(summaryContent\)/g) ?? []).length, 2);
});

test("ScheduledTask.prompt is sealed at every write", () => {
  assert.match(source("src/app/api/tasks/route.ts"), /prompt: encryptField\(input\.prompt\)/);
  // PATCH spreads `input` wholesale, so the column must be re-stated after it.
  const patch = source("src/app/api/tasks/[id]/route.ts");
  assert.match(patch, /\.\.\.\(input\.prompt !== undefined \? \{ prompt: encryptField\(input\.prompt\) \} : \{\}\)/);
  assert.ok(
    patch.indexOf("prompt: encryptField") > patch.indexOf("...input,"),
    "the encrypted prompt must come AFTER the spread, or the spread overwrites it"
  );
});

test("ScheduledTask.prompt is unsealed at every read, and the runner never uses the raw column", () => {
  const tasks = source("src/lib/scheduled-tasks.ts");
  assert.match(tasks, /prompt: decryptField\(task\.prompt\)/);
  assert.match(tasks, /const prompt = decryptField\(task\.prompt\)/);
  // Every mention of the sealed column in CODE is a decrypt. Any other
  // `task.prompt` here would be ciphertext used as if it were text — the exact
  // regression this file exists to catch.
  const codeMentions = tasks
    .split("\n")
    .filter((line) => line.includes("task.prompt") && !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.equal(codeMentions.length, 2, codeMentions.join("\n"));
  for (const line of codeMentions) assert.match(line, /decryptField\(task\.prompt\)/);
  // An undecryptable prompt must refuse the run rather than bill a provider
  // for an answer to the placeholder.
  assert.match(tasks, /prompt === FIELD_DECRYPT_PLACEHOLDER/);
  // The native sync projection is the other reader.
  assert.match(source("src/lib/sync-entities.ts"), /prompt: decryptField\(row\.prompt\)/);
});

// ---------------------------------------------------------------------------
// The scope decision: what stays plaintext, and why
// ---------------------------------------------------------------------------

test("the columns search reads inside Postgres are NOT routed through field-crypto", () => {
  // Encrypting these would make `to_tsvector` match ciphertext — search would
  // return nothing, with no error anywhere. The guard is that the query builder
  // must not learn about field-crypto at all.
  const sql = source("src/lib/search/sql.ts");
  assert.doesNotMatch(sql, /field-crypto/);
  // And the statements that depend on the plaintext must still be there, so
  // this test fails loudly if someone encrypts a column out from under them.
  assert.match(sql, /a\."extractedText"/);
  assert.match(sql, /to_tsvector\('simple', v\."content"\)|\|\| ' ' \|\| v\."content"/);
  assert.match(sql, /FROM "MemoryEntry" m/);
  assert.match(sql, /to_tsvector\('simple', m\."content"\)/);
});

test("MemoryEntry.content stays plaintext everywhere, because memorySearchSql reads it", () => {
  // Sealing it in one writer while memorySearchSql still tokenises the column
  // would half-break memory search: old rows found, new rows silently missing.
  const memory = source("src/lib/memory.ts");
  assert.doesNotMatch(memory, /encryptField\(entry\.content\)|content: encryptField\(content\)/);
  const mutations = source("src/app/api/v1/mutations/route.ts");
  assert.doesNotMatch(mutations, /field-crypto/);
});

test("SECURITY.md states the coverage and names the reason for the exclusions", () => {
  const security = source("SECURITY.md");
  assert.match(security, /Message\.activity/);
  assert.match(security, /MemorySummary\.content/);
  assert.match(security, /ScheduledTask\.prompt/);
  assert.match(security, /field-crypto\.ts/);
  // The exclusions have to say WHY, or the next reader re-opens the decision.
  assert.match(security, /Attachment\.extractedText/);
  assert.match(security, /ArtifactVersion\.content/);
  assert.match(security, /MemoryEntry\.content/);
  assert.match(security, /searchable encryption/i);
});

// ---------------------------------------------------------------------------
// The helpers themselves
// ---------------------------------------------------------------------------

test("field-crypto owns no key material and never logs a payload", () => {
  const fieldCrypto = source("src/lib/field-crypto.ts");
  // One keyring for the whole database — that is what makes a single rotation
  // cover these columns too.
  assert.match(fieldCrypto, /from "@\/lib\/message-crypto"/);
  assert.doesNotMatch(fieldCrypto, /createCipheriv|hkdfSync|AUTH_SECRET|DATA_ENCRYPTION_KEY/);
  // Logs carry a key id and an error message and nothing else. A ciphertext in
  // the logs is a copy of the data sitting outside the database the encryption
  // exists to protect; a plaintext there is worse.
  const calls = fieldCrypto.match(/console\.(error|warn|log)\([\s\S]*?\n  \}\);/g) ?? [];
  assert.equal(calls.length, 1, "one log site, so there is one thing to review");
  for (const call of calls) {
    assert.doesNotMatch(call, /\$\{stored|\$\{plain|\$\{value|JSON\.stringify|messageKeyId\(stored\)\.enc/);
    // The only things passed alongside the message.
    assert.deepEqual([...call.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]), ["message", "keyId"]);
  }
});

test("a decrypt failure can never throw out of a read path", () => {
  const fieldCrypto = source("src/lib/field-crypto.ts");
  // Both public readers funnel through the one guarded call.
  assert.match(fieldCrypto, /function safeDecrypt\(stored: string, reason: string\): string \{\s*try \{/);
  assert.equal((fieldCrypto.match(/decryptMessageText\(/g) ?? []).length, 1, "exactly one raw decrypt, inside the try");
  // Logged once per reason: these columns are read in bulk, and a systemic
  // failure must not write one line per row.
  assert.match(fieldCrypto, /if \(loggedReasons\.has\(reason\)\) return;/);
});

test("no module outside field-crypto reaches for the raw enc: prefixes on these columns", () => {
  // message-crypto's own prefix constants are the cipher's business. A caller
  // hand-rolling `startsWith("enc:")` against `activity` or `prompt` is a
  // read-both check written twice, and the second copy is the one that rots.
  const offenders = walk("src")
    .filter((f) => !f.endsWith("field-crypto.ts") && !f.endsWith("message-crypto.ts"))
    .filter((f) => {
      const text = readFileSync(join(ROOT, f), "utf8");
      return /"enc:v[12]:"|startsWith\("enc:/.test(text);
    });
  assert.deepEqual(offenders, []);
});
