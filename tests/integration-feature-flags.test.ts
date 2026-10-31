import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/*
 * The six features merged on 2026-10-31 before their review, each behind a
 * server switch that is off unless set to exactly "1" (src/lib/env.ts):
 *
 *   SHARE_PEOPLE_ENABLED          the Share dialog's "Specific people"
 *   CHAT_MEMORY_OFF_ENABLED       "Memory off for this chat"
 *   CLOUD_ATTACH_ENABLED          Add from Google Drive / OneDrive
 *   VOICE_TOOLS_ENABLED           a voice call lent the chat's tools
 *   TONE_CHARACTERISTICS_ENABLED  the five tone controls
 *   ARTIFACT_AI_ENABLED           window.alevr in app artifacts
 *
 * Here: each predicate is off by default and for anything but "1"; the app
 * bootstrap carries each one the UI reads; and every entry point the feature
 * opens checks its switch. The feature suites themselves run with their switch
 * on and show the refusals in detail (share-people-store, chat-memory-off-route,
 * voice-tools, artifact-runtime-routes, characteristics, composer-plus-menu-tray).
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
const envModule = require("../src/lib/env") as typeof import("@/lib/env");
loader._load = originalLoad;

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const FLAGS: Record<string, () => boolean> = {
  SHARE_PEOPLE_ENABLED: envModule.isSharePeopleEnabled,
  CHAT_MEMORY_OFF_ENABLED: envModule.isChatMemoryOffEnabled,
  CLOUD_ATTACH_ENABLED: envModule.isCloudAttachEnabled,
  VOICE_TOOLS_ENABLED: envModule.isVoiceToolsEnabled,
  TONE_CHARACTERISTICS_ENABLED: envModule.isToneCharacteristicsEnabled,
  ARTIFACT_AI_ENABLED: envModule.isArtifactAiEnabled,
};

function withValue<T>(name: string, value: string | undefined, run: () => T): T {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

for (const [name, predicate] of Object.entries(FLAGS)) {
  test(`${name}: off unset and for anything but "1", on for "1"`, () => {
    assert.equal(withValue(name, undefined, predicate), false, "off by default");
    for (const value of ["", "0", "true", "yes", "on", "2"]) {
      assert.equal(withValue(name, value, predicate), false, `"${value}" is off`);
    }
    assert.equal(withValue(name, "1", predicate), true);
    assert.equal(withValue(name, " 1 ", predicate), true, "surrounding space is trimmed, as for the other switches");
    // One switch never turns on another.
    for (const [other, otherPredicate] of Object.entries(FLAGS)) {
      if (other !== name) assert.equal(withValue(name, "1", otherPredicate), false, `${name} turned on ${other}`);
    }
  });
}

test("the app bootstrap carries every switch the web's UI reads, and only from env.ts", () => {
  const data = read("src/lib/app-data.ts");
  assert.match(data, /sharePeople: isSharePeopleEnabled\(\),/);
  assert.match(data, /chatMemoryOff: isChatMemoryOffEnabled\(\),/);
  assert.match(data, /cloudAttach: isCloudAttachEnabled\(\),/);
  assert.match(data, /toneCharacteristics: isToneCharacteristicsEnabled\(\),/);
  assert.match(data, /artifactAi: isArtifactAiEnabled\(\),/);
  // Voice tools are decided where the relay token is signed, not in the UI.
  assert.doesNotMatch(data, /voiceTools/);
  const types = read("src/types/app.ts");
  for (const key of ["sharePeople", "chatMemoryOff", "cloudAttach", "toneCharacteristics", "artifactAi"]) {
    assert.match(types, new RegExp(`\\b${key}\\?: boolean;`), `${key} is optional: an older server never sends it`);
  }
});

test("every route a gated feature opens checks its switch first", () => {
  const gates: Array<[string, string, string]> = [
    ["src/app/api/share/people/route.ts", "isSharePeopleEnabled()", "export async function POST"],
    ["src/app/api/conversations/[id]/memory/route.ts", "isChatMemoryOffEnabled()", "export async function PATCH"],
    ["src/app/api/connectors/[id]/files/route.ts", "isCloudAttachEnabled()", "export async function GET"],
    ["src/app/api/connectors/[id]/files/attach/route.ts", "isCloudAttachEnabled()", "export async function POST"],
    ["src/app/api/voice/tools/route.ts", "isVoiceToolsEnabled()", "export async function GET"],
    ["src/app/api/voice/tools/route.ts", "isVoiceToolsEnabled()", "export async function POST"],
    ["src/app/api/artifact-runtime/complete/route.ts", "isArtifactAiEnabled()", "export async function POST"],
    ["src/app/api/artifact-runtime/storage/route.ts", "isArtifactAiEnabled()", "export async function POST"],
  ];
  for (const [file, check, handler] of gates) {
    const source = read(file);
    const start = source.indexOf(handler);
    assert.ok(start >= 0, `${file}: ${handler}`);
    const body = source.slice(start, start + 600);
    assert.ok(body.includes(check), `${file}: ${handler} checks ${check}`);
    assert.match(source, /code: "not_enabled"/, `${file} answers not_enabled`);
  }
  // Voice tools: no tools claim is signed while the switch is off.
  assert.match(read("src/app/api/voice/relay-token/route.ts"), /const tools = isVoiceToolsEnabled\(\) \? parseVoiceToolsRequest\(params\) : null;/);
});

test("with ARTIFACT_AI_ENABLED off no preview carries window.alevr: the bridge rides on a provider that defaults off", () => {
  const frame = read("src/components/canvas/sandbox-document-frame.tsx");
  assert.match(frame, /const AlevrBridgeContext = React\.createContext\(false\);/);
  const sandbox = read("src/components/canvas/sandbox-frame.tsx");
  assert.match(sandbox, /const alevrOn = useAlevrBridgeEnabled\(\);/);
  assert.match(sandbox, /alevrOn \? \{ channel: bridgeChannel \} : undefined/);
  assert.match(sandbox, /useAlevrBridge\(\{\s*enabled: alevrOn,/);
  assert.match(read("src/components/canvas/use-alevr-bridge.ts"), /if \(!enabled\) return;/);
  // The two places that turn it on read the server's switch.
  assert.match(read("src/app/(app)/layout.tsx"), /<AlevrBridgeProvider enabled=\{bootstrap\.features\.artifactAi === true\}>/);
  const share = read("src/app/share/[token]/page.tsx");
  assert.match(share, /const alevrOn = isArtifactAiEnabled\(\);/);
  assert.match(share, /<AlevrBridgeProvider enabled=\{alevrOn\}>/);
});

test("every switch is documented beside the others", () => {
  const example = read(".env.example");
  const juno = read("docs/JUNO.md");
  for (const name of Object.keys(FLAGS)) {
    assert.match(example, new RegExp(`^# ${name}=""$`, "m"), `.env.example names ${name}`);
    assert.ok(juno.includes(`\`${name}\``), `docs/JUNO.md names ${name}`);
    assert.ok(read("src/lib/env.ts").includes(`process.env.${name} ?? ""`), `env.ts reads ${name}`);
  }
});
