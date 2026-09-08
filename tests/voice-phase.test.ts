import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE_ANNOUNCEMENT,
  PHASE_LABEL,
  announcementFor,
  derivePhase,
  type PhaseInput,
  type VoicePhase,
} from "@/lib/voice-phase";

const base: PhaseInput = {
  transport: "live",
  muted: false,
  userSpeaking: false,
  awaitingResponse: false,
  assistantSpeaking: false,
};

const phase = (over: Partial<PhaseInput> = {}) => derivePhase({ ...base, ...over });

test("a live call reports what is happening inside it", () => {
  assert.equal(phase(), "listening");
  assert.equal(phase({ userSpeaking: true }), "user-speaking");
  // The gap the old build rendered nothing for.
  assert.equal(phase({ awaitingResponse: true }), "thinking");
  assert.equal(phase({ assistantSpeaking: true }), "speaking");
});

test("transport outranks everything inside the call", () => {
  for (const transport of ["idle", "ended"] as const) {
    assert.equal(phase({ transport, assistantSpeaking: true }), "idle");
  }
  for (const transport of ["connecting", "reconnecting"] as const) {
    assert.equal(phase({ transport, userSpeaking: true }), "connecting");
  }
  assert.equal(phase({ transport: "error", assistantSpeaking: true }), "error");
});

test("muted is never hidden behind listening", () => {
  // Believing you are heard when you are not is the one confusion a call
  // must never produce, so muted outranks both idle and speaking-into-a-mute.
  assert.equal(phase({ muted: true }), "muted");
  assert.equal(phase({ muted: true, userSpeaking: true }), "muted");
  assert.equal(phase({ muted: true, awaitingResponse: true }), "muted");
});

test("the model speaking outranks mute, because that audio is still audible", () => {
  assert.equal(phase({ muted: true, assistantSpeaking: true }), "speaking");
});

test("every phase has a label and an announcement", () => {
  const all: VoicePhase[] = [
    "idle",
    "connecting",
    "listening",
    "user-speaking",
    "thinking",
    "speaking",
    "muted",
    "error",
  ];
  for (const p of all) {
    assert.ok(PHASE_LABEL[p], `no label for ${p}`);
    assert.ok(PHASE_ANNOUNCEMENT[p], `no announcement for ${p}`);
    // Sentence case: nothing in this product shouts.
    assert.notEqual(PHASE_LABEL[p], PHASE_LABEL[p].toUpperCase());
  }
});

test("announcements fire on change and never narrate the caller back at themselves", () => {
  assert.equal(announcementFor("listening", null), PHASE_ANNOUNCEMENT.listening);
  assert.equal(announcementFor("listening", "listening"), null);
  // Starting and stopping speaking is the same situation to a listener.
  assert.equal(announcementFor("user-speaking", "listening"), null);
  assert.equal(announcementFor("listening", "user-speaking"), null);
  // The moments that matter are announced.
  assert.equal(announcementFor("thinking", "user-speaking"), PHASE_ANNOUNCEMENT.thinking);
  assert.equal(announcementFor("speaking", "thinking"), PHASE_ANNOUNCEMENT.speaking);
  assert.equal(announcementFor("muted", "listening"), PHASE_ANNOUNCEMENT.muted);
  assert.equal(announcementFor("error", "speaking"), PHASE_ANNOUNCEMENT.error);
});

test("the speaking announcement tells a caller who cannot see the button that they may talk over it", () => {
  assert.match(PHASE_ANNOUNCEMENT.speaking, /interrupt/i);
});
