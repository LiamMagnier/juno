import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { FEATURE_NAMES } from "@/lib/brand/names";
import { SHELL_RETIRED_STRINGS, SHELL_STRINGS, shellLocale, shellMenuTitle, shellString, type ShellStringKey } from "@/lib/strings";

/**
 * The shared string table (spec §6.18): one table, English and French, to
 * the web (src/lib/strings), the Mac (JunoShellContract.swift) and the
 * iPhone (Shell.xcstrings).
 */

const REPO = process.cwd();
const GENERATOR = resolve(REPO, "scripts/generate-shell-contract.mjs");
const CONTRACT = resolve(REPO, "contracts/product/juno-shell-v1.json");
const contract = JSON.parse(readFileSync(CONTRACT, "utf8"));
const swift = readFileSync(resolve(REPO, "native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift"), "utf8");
const catalog = JSON.parse(readFileSync(resolve(REPO, "native/iOS/JunoMobile/Resources/Shell.xcstrings"), "utf8"));
/** The spec writes straight apostrophes; the table sets typographic ones. */
const plain = (s: string) => s.replace(/’/g, "'");

test("the three projections are current", () => {
  const check = spawnSync(process.execPath, [GENERATOR, "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test("the table holds the spec's strings, word for word", () => {
  const expected: Array<[ShellStringKey, Record<string, string | number>, string]> = [
    ["home.greetingNamed", { firstName: "Ada" }, "What's next, Ada?"],
    ["home.greeting", {}, "What's next?"],
    ["composer.placeholderHome", {}, "Ask Alevr"],
    ["composer.placeholderThread", {}, "Ask a follow-up"],
    ["incognito.name", {}, "Incognito chat"],
    ["incognito.promise", {}, "This chat won't appear in your history and won't be added to memory."],
    ["incognito.confirmTitle", {}, "End this incognito chat?"],
    ["incognito.confirmBody", {}, "It isn't saved, so leaving ends it."],
    ["status.needsYou", {}, "Needs you"],
    ["now.inFlight", {}, "In flight"],
    ["now.updates", { n: 3 }, "3 updates"],
    ["product.routines", {}, "Routines"],
    ["product.newRoutine", {}, "New routine"],
    ["product.research", {}, "Deep research"],
    ["product.researchBrand", {}, "Deep Field"],
    ["turn.thoughtFor", { n: 4 }, "Thought for 4s"],
    ["turn.reconnecting", {}, "Reconnecting…"],
    ["turn.failed", {}, "Something went wrong. Try again."],
    ["turn.fallback", { failed: "Sonnet 4.6", used: "Haiku 4.5" }, "Sonnet 4.6 was unavailable, so Auto used Haiku 4.5."],
    ["turn.capacity", { s: 12 }, "Waiting for capacity · 12s"],
    ["transcript.jumpToLatest", { n: 2 }, "Jump to latest · 2 new"],
    ["composer.queuedOne", {}, "One message is already waiting"],
    ["composer.quota", { plan: "Pro", time: "14:00" }, "You've reached your Pro limit. It resets at 14:00."],
    ["transcript.modelUnavailable", { model: "GPT-5" }, "GPT-5 isn't available right now."],
    ["state.offline", {}, "Offline · you can read, sending is paused"],
    ["state.notFound", {}, "This page isn't here"],
    ["state.sessionExpired", {}, "Your session expired. Sign in again to continue."],
    ["sidebar.empty", { shortcut: "⇧⌘O" }, "No chats yet. Start one with ⇧⌘O."],
    ["approval.editFiles", { n: 3 }, "Edit 3 files"],
    ["approval.deleteForGood", {}, "Delete for good"],
    ["approval.tellInstead", {}, "Tell Alevr instead"],
    ["approval.armed", {}, "Available in a moment"],
    ["voice.deniedTitle", {}, "Alevr can't hear you"],
    ["plan.codeTitle", {}, "Code is part of Pro"],
    ["plan.codeBody", {}, "Run coding agents on your repositories and your Mac."],
    ["signIn.title", {}, "Welcome back"],
    ["signIn.providerHint", {}, "Signed up with Google or Apple? Use those buttons above."],
    ["onboarding.title", {}, "Make Alevr yours"],
  ];
  for (const [key, vars, text] of expected) assert.equal(plain(shellString(key, vars)), text, key);
  const uploading = shellString("composer.uploadProgress", { files: shellString("composer.uploadingFiles", { n: 2 }), p: 40 });
  assert.equal(uploading, "Uploading 2 files · 40%");
});

test("every key has French, plural forms follow CLDR, and numbers format by locale", () => {
  for (const [key, entry] of Object.entries(SHELL_STRINGS)) {
    const fr = entry.fr as unknown;
    assert.ok(typeof fr === "string" ? fr.length > 0 : fr && typeof fr === "object", `${key} has no French`);
  }
  assert.equal(shellString("now.updates", { n: 1 }), "1 update");
  assert.equal(shellString("now.updates", { n: 0 }), "0 updates");
  assert.equal(shellString("now.updates", { n: 0 }, "fr"), "0 mise à jour", "French counts 0 as singular");
  assert.equal(shellString("now.updates", { n: 2 }, "fr-CA"), "2 mises à jour");
  assert.equal(shellString("approval.announceMany", { n: 1200 }), "1,200 approvals waiting");
  assert.equal(shellString("approval.announceMany", { n: 1200 }, "fr"), `1 200 approbations en attente`);
  assert.equal(shellString("turn.thoughtFor", { n: 4 }, "fr"), "Réflexion de 4 s");
  assert.equal(shellString("home.greeting", {}, "fr"), "Et maintenant ?", "French puts a no-break space before ?");
  // A language the table does not carry gets the English source (the i18n layer translates it).
  assert.equal(shellString("status.ready", {}, "de"), "Ready");
  assert.equal(shellLocale("fr_FR"), "fr");
  assert.equal(shellLocale("en-GB"), "en");
  assert.equal(shellLocale(undefined), "en");
  // A missing argument stays visible rather than becoming "".
  assert.equal(shellString("home.greetingNamed", {}), "What’s next, {firstName}?");
});

test("macOS menu commands are Title Case; everything else is sentence case", () => {
  assert.equal(shellMenuTitle("menu.newChat"), "New Chat");
  assert.equal(shellMenuTitle("menu.newCodeSession"), "New Code Session");
  assert.equal(shellMenuTitle("menu.newChat", "fr"), "Nouvelle conversation");
  assert.match(swift, /static func menuNewChatTitle\(in language: JunoShellLanguage = \.current\) -> String \{\n\s+switch language \{\n\s+case \.en: "New Chat"/);
  for (const [key, entry] of Object.entries(SHELL_STRINGS)) {
    for (const text of typeof entry.en === "string" ? [entry.en] : Object.values(entry.en)) {
      // Each sentence (or "·"-separated part) starts with a capital; nothing after it does, bar names.
      for (const sentence of text.replace(/\{[^}]+\}/g, "").split(/[.?!·]\s+/)) {
        const words = sentence.split(/\s+/).filter((w) => /^[A-Za-z]{4,}$/.test(w));
        const capitalised = words.slice(1).filter((w) => /^[A-Z][a-z]/.test(w) && !["Alevr", "Auto", "Code", "Library", "Google", "Apple", "Claude", "ChatGPT", "Deep", "Field", "Quick", "Entry", "Control", "Center", "French", "System", "Settings", "Pro", "Mac", "Sonnet"].includes(w));
        assert.deepEqual(capitalised, [], `${key} is not sentence case: ${text}`);
      }
    }
  }
});

test("no retired string is in the table", () => {
  assert.deepEqual([...SHELL_RETIRED_STRINGS], ["How can I help you today?", "Private chat", "What can I help with?", "Automations", "New automation"]);
  const all = Object.values(SHELL_STRINGS).flatMap((e) => [e.en, e.fr].flatMap((v) => (typeof v === "string" ? [v] : Object.values(v))));
  for (const retired of SHELL_RETIRED_STRINGS) assert.ok(!(all as string[]).includes(retired), retired);
});

test("names.ts supplies Routines and Deep research, the same words as the table", () => {
  assert.equal(FEATURE_NAMES.routines.label, SHELL_STRINGS["product.routines"].en);
  assert.equal(FEATURE_NAMES.routines.newLabel, SHELL_STRINGS["product.newRoutine"].en);
  assert.equal(FEATURE_NAMES.research.label, SHELL_STRINGS["product.research"].en);
  assert.equal(FEATURE_NAMES.research.description, SHELL_STRINGS["product.researchBrand"].en);
  assert.equal(FEATURE_NAMES.needsYou.label, SHELL_STRINGS["status.needsYou"].en);
});

test("the Mac reads every key, in both languages", () => {
  for (const key of Object.keys(SHELL_STRINGS)) {
    const ident = key.replace(/\.([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
    assert.match(swift, new RegExp(`static func ${ident}\\(`), `JunoShellStrings.${ident} is missing`);
  }
  assert.match(swift, /static func nowUpdates\(n: Int, in language: JunoShellLanguage = \.current\) -> String/);
  assert.match(swift, /case \.fr: count == 0 \|\| count == 1 \? \.one : \.other/);
  assert.match(swift, /case \.fr: "Et maintenant\\u\{00A0\}\?"/);
});

test("the iPhone's Shell.xcstrings carries every key with format specifiers and plural variations", () => {
  assert.equal(catalog.sourceLanguage, "en");
  assert.deepEqual(Object.keys(catalog.strings).sort(), Object.keys(SHELL_STRINGS).sort());
  for (const [key, entry] of Object.entries(catalog.strings) as Array<[string, { localizations: Record<string, unknown> }]>) {
    assert.deepEqual(Object.keys(entry.localizations).sort(), ["en", "fr"], key);
  }
  const unit = (key: string, locale: string) => (catalog.strings[key].localizations[locale] as { stringUnit: { value: string } }).stringUnit.value;
  assert.equal(unit("home.greetingNamed", "en"), "What’s next, %@?");
  assert.equal(unit("turn.fallback", "fr"), "%1$@ n’était pas disponible : Auto a utilisé %2$@.");
  assert.equal(unit("composer.uploadProgress", "en"), "%1$@ · %2$lld%%", "a literal percent sign is escaped");
  const plural = catalog.strings["now.updates"].localizations.fr.variations.plural;
  assert.equal(plural.one.stringUnit.value, "%lld mise à jour");
  assert.equal(plural.other.stringUnit.value, "%lld mises à jour");
});

test("generation fails on a key without French, a dropped placeholder, a retired string or a two-argument plural", () => {
  const dir = mkdtempSync(join(tmpdir(), "juno-p1-strings-"));
  try {
    const run = (mutate: (doc: typeof contract) => void) => {
      const doc = structuredClone(contract);
      mutate(doc);
      const path = join(dir, "contract.json");
      writeFileSync(path, JSON.stringify(doc));
      return spawnSync(
        process.execPath,
        [GENERATOR, `--contract=${path}`, `--output=${join(dir, "a.swift")}`, `--ts-output=${join(dir, "a.ts")}`, `--xcstrings-output=${join(dir, "a.xcstrings")}`],
        { encoding: "utf8" }
      );
    };
    const ok = run(() => {});
    assert.equal(ok.status, 0, ok.stderr);
    const noFrench = run((doc) => { delete doc.strings.entries["status.ready"].fr; });
    assert.equal(noFrench.status, 1);
    assert.match(noFrench.stderr, /status\.ready: no fr value/);
    const dropped = run((doc) => { doc.strings.entries["home.greetingNamed"].fr = "Et maintenant ?"; });
    assert.equal(dropped.status, 1);
    assert.match(dropped.stderr, /English uses \{firstName\} but French uses \{\}/);
    const retired = run((doc) => { doc.strings.entries["composer.placeholderHome"].en = "How can I help you today?"; });
    assert.equal(retired.status, 1);
    assert.match(retired.stderr, /RETIRED/);
    const twoArgs = run((doc) => { doc.strings.entries["now.updates"].en.other = "{n} updates at {time}"; doc.strings.entries["now.updates"].fr.other = "{n} mises à jour à {time}"; });
    assert.equal(twoArgs.status, 1);
    assert.match(twoArgs.stderr, /carries only its plural placeholder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a contract change without regenerated outputs fails the check", () => {
  const dir = mkdtempSync(join(tmpdir(), "juno-p1-strings-drift-"));
  try {
    const doc = structuredClone(contract);
    doc.strings.entries["status.ready"].en = "Done";
    const path = join(dir, "contract.json");
    writeFileSync(path, JSON.stringify(doc, null, 2));
    // Check the edited contract against the CHECKED-IN outputs.
    const check = spawnSync(process.execPath, [GENERATOR, "--check", `--contract=${path}`], { encoding: "utf8" });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /JunoShellContract\.swift is stale/);
    assert.match(check.stderr, /shell\.generated\.ts is stale/);
    assert.match(check.stderr, /Shell\.xcstrings is stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
