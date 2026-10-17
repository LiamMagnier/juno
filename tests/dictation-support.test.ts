import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  canRecordMicrophone,
  dictationMode,
  hasWebSpeech,
  serverDictationAvailable,
} from "@/hooks/use-dictation-support";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/*
 * G36: dictation in every browser that can open a microphone. The Dictate
 * control used to be drawn only where the Web Speech API existed, so Firefox
 * never saw it, even on a deployment whose own server transcribes everything.
 */

test("a browser without Web Speech dictates through the server", () => {
  assert.equal(dictationMode({ serverStt: true, microphone: true, webSpeech: false }), "server");
  // The server path is preferred even where Web Speech exists: it hears every language.
  assert.equal(dictationMode({ serverStt: true, microphone: true, webSpeech: true }), "server");
});

test("Web Speech alone still dictates, and nothing at all hides the control", () => {
  assert.equal(dictationMode({ serverStt: false, microphone: true, webSpeech: true }), "browser");
  assert.equal(dictationMode({ serverStt: true, microphone: false, webSpeech: true }), "browser");
  assert.equal(dictationMode({ serverStt: false, microphone: true, webSpeech: false }), "none");
  assert.equal(dictationMode({ serverStt: true, microphone: false, webSpeech: false }), "none");
});

test("the server path needs both a provider and a plan that includes voice", () => {
  const app = (serverStt: boolean, plan: "FREE" | "PRO") => ({ features: { serverStt }, quota: { plan } });
  assert.equal(serverDictationAvailable(app(true, "PRO")), true);
  assert.equal(serverDictationAvailable(app(true, "FREE")), false, "/api/voice/stt refuses a plan without voice");
  assert.equal(serverDictationAvailable(app(false, "PRO")), false);
  assert.equal(serverDictationAvailable(null), false, "outside the app shell (a gallery)");
});

test("capability probes read the real browser objects, and say no on the server", () => {
  assert.equal(canRecordMicrophone(), false);
  assert.equal(hasWebSpeech(), false);
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in g;
  const hadNavigator = Object.getOwnPropertyDescriptor(g, "navigator");
  try {
    g.window = { isSecureContext: true, AudioContext: function AudioContext() {} };
    Object.defineProperty(g, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => Promise.resolve(null) } },
    });
    assert.equal(canRecordMicrophone(), true, "Firefox: microphone and Web Audio, no Web Speech");
    assert.equal(hasWebSpeech(), false);
    (g.window as Record<string, unknown>).webkitSpeechRecognition = function SpeechRecognition() {};
    assert.equal(hasWebSpeech(), true);
    (g.window as Record<string, unknown>).isSecureContext = false;
    assert.equal(canRecordMicrophone(), false, "an insecure page cannot open the microphone");
  } finally {
    if (!hadWindow) delete g.window;
    if (hadNavigator) Object.defineProperty(g, "navigator", hadNavigator);
    else delete g.navigator;
  }
});

test("every composer draws Dictate from the shared support check, not Web Speech alone", () => {
  for (const file of [
    "src/components/chat/composer.tsx",
    // The Code landing hosts the v2 composer (G58), so its mic is that one.
    "src/components/code/v2/composer.tsx",
    "src/components/code/code-session-view.tsx",
    "src/components/work/composer/work-thread-composer.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /const speechSupported = useDictationSupported\(\);/, file);
    assert.doesNotMatch(source, /supported: speechSupported\s*}\s*=\s*useSpeechRecognition/, file);
  }
});

test("a failed server transcription keeps the recording for another try", () => {
  const source = read("src/components/chat/composer-dictation.tsx");
  assert.match(source, /if \(accurate === null && !previewText\) return setFailedTake\(/);
  assert.match(source, /onDone=\{failedTake \? retryTake : stop\}/);
  assert.match(source, /serverDictationAvailable\(app\) && !stage/);
});
