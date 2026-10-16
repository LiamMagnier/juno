/**
 * The Code composer's app commands (G38), the landing's model reaching the
 * first turn (G02), and a thread's draft and choices leaving one browser
 * (the critic's missed defect): pure rules, plus the composer source wiring
 * that a unit test can pin.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SLASH_COMMANDS, compactMessage, parseClientCommand, slashCommandsFor } from "@/lib/code-v2/composer";
import { seededThreadPrefs } from "@/lib/code-v2/composer-mode";
import { buildInstances, isWebInstanceId, reconcileSelection } from "@/lib/code-v2/workspace-instances";
import { choicesFromSynced, codeDraftKey, parseSyncedModelKey, samePrefs, syncedModelKey, syncedPrefsOf, webCodeThreadKey } from "@/lib/code-v2/thread-prefs";
import { isThreadKey } from "@/lib/sync/thread-sync";
import { shouldApplyRemotePrefs } from "@/lib/sync/thread-draft-client";
import type { ProviderInstance, ProviderModel } from "@/lib/code-v2/contracts";

const read = (p: string) => readFileSync(p, "utf8");

// ── G38: /model, /clear, /plan never spend a turn ──

test("only a draft that opens with an app command is one", () => {
  assert.deepEqual(parseClientCommand("/model"), { kind: "model" });
  assert.deepEqual(parseClientCommand("  /model opus"), { kind: "model" });
  assert.deepEqual(parseClientCommand("/clear"), { kind: "clear", rest: "" });
  assert.deepEqual(parseClientCommand("/clear start over on the parser"), { kind: "clear", rest: "start over on the parser" });
  assert.deepEqual(parseClientCommand("/plan refactor the cart\nand its tests"), { kind: "plan", rest: "refactor the cart\nand its tests" });
  assert.deepEqual(parseClientCommand("/PLAN"), { kind: "plan", rest: "" });
  assert.deepEqual(parseClientCommand("/compact keep the API notes"), { kind: "compact", rest: "keep the API notes" });
  assert.equal(parseClientCommand("/planner do it"), null, "a longer word is not the command");
  assert.equal(parseClientCommand("please /plan this"), null, "not at the start");
  assert.equal(parseClientCommand("/review"), null, "sent to the agent as text");
  assert.equal(parseClientCommand(""), null);
  assert.equal(compactMessage(""), "/compact");
  assert.equal(compactMessage("keep the API notes"), "/compact keep the API notes");
});

test("the menu says who answers: app actions apart from what is sent to the agent", () => {
  const app = SLASH_COMMANDS.filter((c) => c.runs === "app").map((c) => c.name);
  assert.deepEqual(app.sort(), ["clear", "model", "plan"]);
  for (const c of SLASH_COMMANDS) {
    if (c.runs === "app") assert.equal(c.section, "Actions", `/${c.name} is an action`);
    else assert.notEqual(c.section, "Actions", `/${c.name} is sent to the agent`);
  }
  // The landing offers only what works before a session exists.
  assert.deepEqual(slashCommandsFor("landing").map((c) => c.name), ["model", "plan"]);
  assert.equal(slashCommandsFor("session").length, SLASH_COMMANDS.length);
});

test("the composer intercepts app commands before anything is sent", () => {
  const src = read("src/components/code/v2/composer.tsx");
  const submit = src.slice(src.indexOf("const submit = (intent"), src.indexOf("const pick = (i: number)"));
  assert.ok(submit.indexOf("runClientCommand(text, intent)") < submit.indexOf("send(text, intent)"), "commands run before the send");
  const commands = src.slice(src.indexOf("const runClientCommand"), src.indexOf("const send = (text: string"));
  assert.match(commands, /setPopover\("catalog"\)/, "/model opens the model catalogue");
  assert.match(commands, /actions\.clearThread\(command\.rest\)/, "/clear starts a fresh thread");
  assert.match(commands, /setComposerMode\(actions, "plan", model\.runtimeMode\)/, "/plan switches the mode");
  assert.match(commands, /actions\.compact\(command\.rest\)/, "/compact goes through the thread's compact action");
});

// ── G02: the landing's model is the first turn's ──

const models: ProviderModel[] = [
  { id: "anthropic:claude-opus-5-5", label: "Opus", isDefault: true, defaultEffort: "high" },
  { id: "openai:gpt-6.1-sol", label: "Sol" },
];
const claude: ProviderInstance = { id: "claude-agent", kind: "claude-agent", label: "Claude", status: "ready", models: [{ id: "sonnet", label: "Sonnet" }] };

test("a subscription chosen on the landing waits for the Mac's list instead of being replaced", () => {
  const web = buildInstances({ alevrModels: models });
  const chosen = { instanceId: "claude-agent", model: "sonnet", effort: "medium" as const };
  // Before the Mac answers: kept as chosen.
  assert.deepEqual(reconcileSelection(web, chosen, { awaitingDevice: true }), chosen);
  // The old behaviour, and what happens once the Mac has answered without it: the first ready instance.
  assert.equal(reconcileSelection(web, chosen).instanceId, "alevr");
  assert.equal(reconcileSelection(web, chosen, { awaitingDevice: false }).instanceId, "alevr");
  // Once listed, it is the selection.
  assert.deepEqual(reconcileSelection([...web, claude], chosen), chosen);
  // An Alevr model the catalogue no longer has is never "awaited".
  assert.equal(reconcileSelection(web, { instanceId: "alevr", model: "gone" }, { awaitingDevice: true }).model, "anthropic:claude-opus-5-5");
  assert.equal(isWebInstanceId("alevr"), true);
  assert.equal(isWebInstanceId("byok:openai"), true);
  assert.equal(isWebInstanceId("claude-agent"), false);
});

test("a new thread's prefs carry the landing's model as well as its mode", () => {
  const selection = { instanceId: "alevr", model: "openai:gpt-6.1-sol", effort: "low" as const, contextTokens: 400_000 };
  const prefs = seededThreadPrefs({ hunk: 1 }, "plan", { selection });
  assert.deepEqual(prefs, { hunk: 1, runtimeMode: "auto-edit", interactionMode: "plan", selection });
  // Without a model it is the mode alone, as before.
  assert.deepEqual(seededThreadPrefs(null, "full"), { runtimeMode: "full", interactionMode: "default" });
});

test("the landing composes the session's composer and seeds the full prefs", () => {
  const landing = read("src/components/code/code-composer.tsx");
  assert.match(landing, /<Composer\b[\s\S]*variant="landing"/, "the landing mounts the session's composer");
  assert.match(landing, /seededThreadPrefs\(readStoredJson\(key\), modeRef\.current, \{ selection \}\)/);
  assert.match(landing, /setPendingCodePrompt\(conversation\.id, seedThreadSkills\(landingSkills, conversation\.id, text\), attachments\)/, "attachments ride the hand-off");
  assert.match(landing, /router\.push\(`\/code\/\$\{conversationId\}`\)/, "straight to the session, no /chat hop");
  assert.doesNotMatch(landing, /router\.push\(`\/chat\//);
  const route = read("src/components/code/v2/live-route.tsx");
  assert.match(route, /peek: \(\) => peekPendingCodePrompt\(conversation\.id\)/, "the route reads words and attachments");
  assert.doesNotMatch(route, /peekPendingCodePrompt\(conversation\.id\)\?\.text/);
  assert.match(route, /reconcileSelection\(instances, prefs\.selection, \{ awaitingDevice \}\)/);
});

test("a model the Mac has not listed yet keeps the composer writable and holds only Send", () => {
  // Keeping the landing's subscription (above) must not turn the composer into
  // "Connect" with a disabled field for the second the Mac takes to answer.
  const v2 = read("src/components/code/v2/composer.tsx");
  assert.match(v2, /const modelPending = !instance && !!model\.selectionPending;/);
  assert.match(v2, /\(!!instance \|\| modelPending\)/, "a pending model counts as connected for typing");
  assert.match(v2, /const ready = !model\.starting && connected && !model\.offline && !waitingOn;/, "but Send waits");
  const route = read("src/components/code/v2/live-route.tsx");
  assert.match(route, /selectionPending: awaitingDevice && !selectionListed/);
  const landing = read("src/components/code/code-composer.tsx");
  assert.match(landing, /selectionPending: awaitingMac && !instances\.some/);
});

// ── Draft and choices beyond one browser ──

test("choices travel in the Mac's spelling and come back as changes", () => {
  const selection = { instanceId: "claude-agent", model: "claude/sonnet-5", effort: "high" as const };
  assert.equal(syncedModelKey(selection), "claude-agent/claude/sonnet-5");
  assert.deepEqual(parseSyncedModelKey("claude-agent/claude/sonnet-5"), { instanceId: "claude-agent", model: "claude/sonnet-5" }, "split at the first slash");
  assert.equal(parseSyncedModelKey("noslash"), null);
  assert.equal(parseSyncedModelKey("/x"), null);
  const prefs = syncedPrefsOf({ selection, runtimeMode: "auto", interactionMode: "plan", routing: { preset: "lead-workers" } });
  assert.deepEqual(prefs, { model: "claude-agent/claude/sonnet-5", effort: "high", mode: "auto", interactionMode: "plan", team: "lead-workers" });

  const here = { selection: { instanceId: "alevr", model: "anthropic:claude-opus-5-5", effort: "medium" as const }, runtimeMode: "auto-edit" as const, interactionMode: "default" as const };
  assert.deepEqual(choicesFromSynced(prefs, here), { selection, runtimeMode: "auto", interactionMode: "plan" });
  // Same model, new effort: only the effort changes.
  assert.deepEqual(choicesFromSynced({ model: "alevr/anthropic:claude-opus-5-5", effort: "max" }, here), { selection: { ...here.selection, effort: "max" } });
  // What this browser cannot read is left alone.
  assert.deepEqual(choicesFromSynced({ mode: "yolo", interactionMode: "sideways", effort: "turbo" }, here), {});
  assert.deepEqual(choicesFromSynced(syncedPrefsOf(here), here), {}, "its own choices are no change");
  assert.equal(samePrefs(prefs, { ...prefs }), true);
  assert.equal(samePrefs(prefs, { ...prefs, effort: "low" }), false);
});

test("a Mac session shares the Mac app's key; any other thread is keyed by its conversation", () => {
  const mac = webCodeThreadKey({ conversationId: "c1", deviceId: "dev_1", envSessionId: "s_abc" });
  assert.equal(mac, "code:dev_1:s_abc");
  assert.equal(webCodeThreadKey({ conversationId: "c1", deviceId: "dev_1", envSessionId: null }), "chat:c1");
  assert.equal(webCodeThreadKey({ conversationId: "c1" }), "chat:c1");
  assert.ok(isThreadKey(mac) && isThreadKey("chat:c1"), "the sync routes accept both");
  assert.equal(codeDraftKey("c1"), "code:c1");
  assert.equal(codeDraftKey(null), "code:new");
});

test("another device's choices apply only when newer than what this tab wrote", () => {
  assert.equal(shouldApplyRemotePrefs({ prefs: { mode: "auto" }, prefsUpdatedAt: "2026-10-15T10:00:01.000Z" }, Date.parse("2026-10-15T10:00:00.000Z")), true);
  // This tab's own echo carries the stamp it already holds.
  assert.equal(shouldApplyRemotePrefs({ prefs: { mode: "auto" }, prefsUpdatedAt: "2026-10-15T10:00:00.000Z" }, Date.parse("2026-10-15T10:00:00.000Z")), false);
  assert.equal(shouldApplyRemotePrefs({ prefs: {}, prefsUpdatedAt: "2026-10-15T10:00:01.000Z" }, 0), false);
  assert.equal(shouldApplyRemotePrefs({ prefsUpdatedAt: null }, 0), false);
});

test("the session composer keeps its draft per thread and syncs it", () => {
  const src = read("src/components/code/v2/composer.tsx");
  assert.match(src, /readComposerDraft\(draftKey\)/, "a draft left in this tab comes back");
  assert.match(src, /writeComposerDraft\(draftKey, \{ text: draft, tokens: \[\] \}\)/);
  assert.match(src, /channel\?\.changed\(draft\)/, "edits reach the other devices");
  assert.match(src, /channel\?\.cleared\(\)/, "a send clears it everywhere");
  const route = read("src/components/code/v2/live-route.tsx");
  assert.match(route, /useThreadDraftSync\(\s*syncKey,/, "one long-poll carries the draft and the choices");
  assert.match(route, /publishChoices\(\{ selection: sel \}\)/, "a model change is written to the row");
});

// ── Review fixes: nothing the reader typed is lost, and nothing stale is written ──

test("choosing /model or /clear from the menu never throws the rest of the draft away", () => {
  // The slash menu opens on any line, and Enter picks its first row ("/c" → /clear).
  const src = read("src/components/code/v2/composer.tsx");
  const pick = src.slice(src.indexOf("const pick = (i: number)"), src.indexOf("const onKeyDown = (e"));
  const model = pick.slice(pick.indexOf('item.key === "model"'), pick.indexOf('item.key === "clear"'));
  assert.match(model, /applyTrigger\(draft, caret, trigger, ""\)/, "only the typed trigger leaves the draft");
  assert.match(model, /setPopover\("catalog"\)/);
  assert.doesNotMatch(model, /forgetDraft|runClientCommand/, "the draft is kept");
  const clear = pick.slice(pick.indexOf('item.key === "clear"'));
  assert.match(clear, /!applyTrigger\(draft, caret, trigger, ""\)\.text\.trim\(\) && !attachments\.uploads\.length/, "/clear runs at once only on an otherwise empty composer");
});

test("re-attaching to a Mac session reads the Mac's choices instead of overwriting them", () => {
  const route = read("src/components/code/v2/live-route.tsx");
  const effect = route.slice(route.indexOf("const firstSyncKey = React.useRef(syncKey)"), route.indexOf("async function clearThread"));
  assert.match(effect, /if \(!openingEnvSession\.current \|\| !syncKey\.startsWith\("code:"\)\) return;/, "only a session this tab opened is written");
  assert.match(route, /if \(!env\.sessionId\) openingEnvSession\.current = true;/, "set only when no session existed");
});

test("a cloud thread's follow-up carries the composer's mode, so /plan runs under Plan", () => {
  const route = read("src/components/code/v2/live-route.tsx");
  const legacy = route.slice(route.indexOf("async function sendLegacy"), route.indexOf("async function filesForMac"));
  assert.match(legacy, /cloudPermissionMode\(composerModeOf\(modesRef\.current\.runtimeMode, modesRef\.current\.interactionMode\)\)/);
  assert.match(read("src/hooks/use-code-session.ts"), /permissionMode: choice\.permissionMode \|\| undefined/, "the task create carries it");
});
