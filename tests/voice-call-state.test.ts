import test from "node:test";
import assert from "node:assert/strict";

import {
  ANNOUNCE_MIN_GAP_MS,
  ANNOUNCE_SETTLE_MS,
  METER_FLOOR,
  VoiceAnnouncer,
  canShareScreen,
  easeLevel,
  meterStepDue,
  meterTargets,
  voiceCallAnnouncement,
  voiceCallView,
  type AnnouncerTimers,
  type VoiceCallInput,
  type VoiceCallState,
} from "@/lib/voice-call-state";

const live: VoiceCallInput = {
  transport: "live",
  muted: false,
  userSpeaking: false,
  awaitingResponse: false,
  assistantSpeaking: false,
};
const view = (over: Partial<VoiceCallInput> = {}) => voiceCallView({ ...live, ...over });

test("one state at a time, said in a word", () => {
  assert.deepEqual(
    [
      view({ transport: "connecting" }),
      view(),
      view({ awaitingResponse: true }),
      view({ assistantSpeaking: true }),
      view({ muted: true }),
      view({ transport: "reconnecting" }),
      view({ transport: "ended" }),
    ].map((v) => [v.state, v.word]),
    [
      ["connecting", "Connecting…"],
      ["listening", "Listening"],
      ["thinking", "Thinking"],
      ["speaking", "Speaking"],
      ["muted", "Muted"],
      ["reconnecting", "Reconnecting…"],
      ["ended", "Call ended"],
    ]
  );
  // The frame before start() lands is a call on its way, not a dead one.
  assert.equal(view({ transport: "idle" }).state, "connecting");
  // Sentence case everywhere: nothing in this product shouts.
  for (const v of [view(), view({ transport: "connecting" }), view({ transport: "error" })]) {
    assert.notEqual(v.word, v.word.toUpperCase());
  }
});

test("muted outranks speaking for the word, while the meter still shows the voice that is playing", () => {
  const v = view({ muted: true, assistantSpeaking: true });
  assert.equal(v.state, "muted");
  assert.equal(v.word, "Muted");
  assert.equal(v.meter, "alevr");
  assert.equal(view({ muted: true }).meter, "rest", "muted and quiet: still dots, not a frozen frame");
  // The transport still outranks mute: a pre-muted call is connecting until it is up.
  assert.equal(view({ muted: true, transport: "connecting" }).state, "connecting");
});

test("your own speech reads Listening, the meter does the moving; thinking waits for you to stop", () => {
  assert.equal(view({ userSpeaking: true }).word, "Listening");
  assert.equal(view({ userSpeaking: true }).meter, "you");
  assert.equal(view({ userSpeaking: true, awaitingResponse: true }).state, "listening");
  assert.equal(view({ awaitingResponse: true }).mark, "working");
});

test("the edge light is on only while audio moves, in the speaker's tone", () => {
  assert.equal(view().edge, "you");
  assert.equal(view({ assistantSpeaking: true }).edge, "alevr");
  for (const off of [view({ awaitingResponse: true }), view({ transport: "connecting" }), view({ transport: "reconnecting" }), view({ muted: true }), view({ transport: "ended" }), view({ transport: "error" })]) {
    assert.equal(off.edge, null, off.state);
  }
});

test("an error says whether a call stopped or never started", () => {
  assert.equal(view({ transport: "error", wasLive: true }).word, "Call stopped");
  assert.equal(view({ transport: "error" }).word, "Couldn’t start");
  assert.equal(view({ transport: "error" }).mark, "alert");
});

test("announcements: what a person acts on, never the turns", () => {
  assert.equal(voiceCallAnnouncement(null, "connecting"), "Connecting the call.");
  assert.equal(voiceCallAnnouncement("connecting", "listening"), "Connected. Listening.");
  assert.equal(voiceCallAnnouncement("listening", "muted"), "Microphone off.");
  assert.equal(voiceCallAnnouncement("muted", "speaking"), "Microphone on.");
  assert.equal(voiceCallAnnouncement("listening", "reconnecting"), "Reconnecting.");
  assert.equal(voiceCallAnnouncement("reconnecting", "listening"), "Reconnected.");
  assert.equal(voiceCallAnnouncement("speaking", "ended"), "The call has ended.");
  // The turns are the call doing its job; the error has its own alert line.
  for (const [a, b] of [
    ["listening", "thinking"],
    ["thinking", "speaking"],
    ["speaking", "listening"],
    ["listening", "error"],
  ] as const) {
    assert.equal(voiceCallAnnouncement(a, b), null, `${a} → ${b}`);
  }
});

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const timers: AnnouncerTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      jobs.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void jobs.delete(handle as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...jobs.entries()].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      jobs.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance };
}

test("the live region is debounced: a flip and its undo say nothing, and nothing lands inside 2 s", () => {
  const said: string[] = [];
  const { timers, advance } = fakeTimers();
  const announcer = new VoiceAnnouncer((text) => said.push(text), timers);
  const go = (state: VoiceCallState, ms = 0) => {
    announcer.observe(state);
    advance(ms);
  };

  go("connecting", ANNOUNCE_SETTLE_MS);
  assert.deepEqual(said, ["Connecting the call."]);

  // Up and straight into a turn: "Connected" once, after the 2 s gap.
  go("listening", 100);
  go("thinking", 100);
  go("speaking", ANNOUNCE_MIN_GAP_MS);
  assert.deepEqual(said, ["Connecting the call.", "Connected."]);

  // Turns alone are never read out.
  go("listening", 5_000);
  go("thinking", 5_000);
  assert.equal(said.length, 2);

  // Mute and unmute inside the settle window: nothing at all.
  go("muted", ANNOUNCE_SETTLE_MS / 2);
  go("listening", 5_000);
  assert.equal(said.length, 2);

  // A real mute is said, and so is the unmute after it, never sooner than the gap.
  go("muted", ANNOUNCE_SETTLE_MS);
  assert.equal(said.at(-1), "Microphone off.");
  go("listening", ANNOUNCE_SETTLE_MS);
  assert.equal(said.at(-1), "Microphone off.", "held for the 2 s gap");
  advance(ANNOUNCE_MIN_GAP_MS);
  assert.equal(said.at(-1), "Microphone on.");

  announcer.dispose();
});

test("share screen is drawn only where the browser can share a screen", () => {
  assert.equal(canShareScreen({ mediaDevices: { getDisplayMedia: () => undefined } }), true);
  // iOS Safari and Android Chrome: no getDisplayMedia.
  assert.equal(canShareScreen({ mediaDevices: {} }), false);
  assert.equal(canShareScreen({}), false);
  assert.equal(canShareScreen(undefined), false);
});

test("the meter: loudness sets the height, the spectrum only the shape, and quiet is dots", () => {
  const quiet = meterTargets(0, [0.4, 0.3, 0.2, 0.1, 0.05]);
  for (const h of quiet) assert.ok(Math.abs(h - METER_FLOOR) < 1e-6);
  const loud = meterTargets(0.8, [0.6, 0.3, 0.2, 0.1, 0.05]);
  // The lows sit in the middle, so speech rises as a mound.
  assert.ok(loud[2] >= Math.max(loud[0], loud[1], loud[3], loud[4]));
  for (const h of loud) assert.ok(h >= METER_FLOOR && h <= 1);
  // Louder is taller, bar for bar.
  const louder = meterTargets(1, [0.6, 0.3, 0.2, 0.1, 0.05]);
  for (let i = 0; i < 5; i++) assert.ok(louder[i] >= loud[i]);
});

test("the level is eased by time, faster up than down, the same at 60 and 120 Hz", () => {
  const up = easeLevel(0, 1, 16);
  const down = 1 - easeLevel(1, 0, 16);
  assert.ok(up > down, "attack is quicker than release");
  let at60 = 0;
  for (let i = 0; i < 6; i++) at60 = easeLevel(at60, 1, 1000 / 60);
  let at120 = 0;
  for (let i = 0; i < 12; i++) at120 = easeLevel(at120, 1, 1000 / 120);
  assert.ok(Math.abs(at60 - at120) < 1e-9);
  assert.equal(easeLevel(0.3, 1, 0), 0.3);
});

test("reduced motion steps the meter four times a second", () => {
  assert.equal(meterStepDue(0, null), true);
  assert.equal(meterStepDue(200, 0), false);
  assert.equal(meterStepDue(250, 0), true);
});
