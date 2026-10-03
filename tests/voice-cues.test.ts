import test from "node:test";
import assert from "node:assert/strict";
import {
  analyseCue,
  createVoiceCueScheduler,
  cueDuration,
  dbToGain,
  noteEnvelope,
  renderVoiceCue,
  VOICE_CUES,
  type VoiceCueKind,
} from "@/lib/voice-cues";
import type { VoiceTransport } from "@/lib/voice-phase";

function harness(enabled = () => true) {
  const played: VoiceCueKind[] = [];
  const cues = createVoiceCueScheduler({ play: (k) => played.push(k), enabled });
  const run = (...steps: VoiceTransport[]) => steps.forEach((s) => cues.observe(s));
  return { played, cues, run };
}

test("the ready cue plays once, when the call goes live, not on connect", () => {
  const { played, run } = harness();
  run("idle", "connecting");
  assert.deepEqual(played, []);
  run("live", "live", "live");
  assert.deepEqual(played, ["start"]);
});

test("the ended cue plays once, however the call ends", () => {
  for (const ending of ["idle", "ended", "error"] as const) {
    const { played, run } = harness();
    // The relay's close, then the End button, then the unmount: three reports, one chime.
    run("connecting", "live", ending, "ended", "idle", "idle");
    assert.deepEqual(played, ["start", "end"], ending);
  }
});

test("a call that never came up is silent at both ends", () => {
  const { played, run } = harness();
  run("connecting", "error", "idle", "connecting", "idle");
  assert.deepEqual(played, []);
});

test("a provider switch or a reconnect is the same call", () => {
  const { played, run } = harness();
  run("connecting", "live", "connecting", "live", "reconnecting", "live", "reconnecting", "live");
  assert.deepEqual(played, ["start"]);
  run("reconnecting", "error");
  assert.deepEqual(played, ["start", "end"]);
});

test("retrying after an end is a new call with its own bracket", () => {
  const { played, run } = harness();
  run("connecting", "live", "ended", "connecting", "live", "idle");
  assert.deepEqual(played, ["start", "end", "start", "end"]);
});

test("the switch silences both cues, read at the moment of each", () => {
  let on = false;
  const { played, cues, run } = harness(() => on);
  run("connecting", "live");
  assert.deepEqual(played, []);
  assert.equal(cues.open, true, "the bracket still opens, so turning sounds on mid-call replays nothing");
  on = true;
  run("live");
  assert.deepEqual(played, []);
  run("idle");
  assert.deepEqual(played, ["end"]);
});

test("envelopes start and end at silence and peak where the spec says", () => {
  for (const kind of ["start", "end"] as const) {
    const spec = VOICE_CUES[kind];
    for (const note of spec.notes) {
      assert.equal(noteEnvelope(spec, note, 0), 0);
      assert.ok(noteEnvelope(spec, note, note.dur - 1e-6) < 1e-6);
      assert.ok(Math.abs(noteEnvelope(spec, note, spec.attack) - dbToGain(note.peakDb)) < 1e-9);
      // Monotone fall after the attack: no second swell inside a note.
      let prev = Infinity;
      for (let t = spec.attack; t < note.dur; t += 0.001) {
        const g = noteEnvelope(spec, note, t);
        assert.ok(g <= prev + 1e-12);
        prev = g;
      }
    }
    assert.ok(spec.attack >= 0.005 && spec.attack <= 0.02, "an edge, but no click");
  }
});

test("rendered cues: short, quiet, click-free, rising then falling", () => {
  const sr = 48_000;
  const start = analyseCue(renderVoiceCue("start", sr), sr);
  const end = analyseCue(renderVoiceCue("end", sr), sr);
  for (const [name, a, kind] of [
    ["start", start, "start"],
    ["end", end, "end"],
  ] as const) {
    assert.ok(a.duration >= 0.18 && a.duration <= 0.3, `${name} duration ${a.duration}`);
    assert.ok(a.duration <= cueDuration(VOICE_CUES[kind]));
    assert.ok(a.peakDbfs <= -17 && a.peakDbfs >= -21, `${name} peak ${a.peakDbfs}`);
    assert.ok(Math.abs(a.edge.first) < 1e-3 && Math.abs(a.edge.last) < 1e-3, `${name} edges`);
  }
  // Within a few hertz of A4 and E5.
  assert.ok(Math.abs(start.firstPitchHz - 440) < 6, `start first ${start.firstPitchHz}`);
  assert.ok(Math.abs(start.lastPitchHz - 659.25) < 8, `start last ${start.lastPitchHz}`);
  assert.ok(Math.abs(end.firstPitchHz - 659.25) < 8, `end first ${end.firstPitchHz}`);
  assert.ok(Math.abs(end.lastPitchHz - 440) < 6, `end last ${end.lastPitchHz}`);
  assert.ok(start.lastPitchHz / start.firstPitchHz > 1.45, "start rises a fifth");
  assert.ok(end.lastPitchHz / end.firstPitchHz < 0.7, "end falls a fifth");
  // The ended cue is the softer of the two.
  assert.ok(end.peakDbfs < start.peakDbfs);
});

test("rendering is deterministic and rate-independent in length", () => {
  const a = renderVoiceCue("start", 44_100);
  const b = renderVoiceCue("start", 44_100);
  assert.deepEqual(a, b);
  assert.equal(a.length, Math.ceil(cueDuration(VOICE_CUES.start) * 44_100));
  assert.equal(renderVoiceCue("end", 24_000).length, Math.ceil(cueDuration(VOICE_CUES.end) * 24_000));
});
