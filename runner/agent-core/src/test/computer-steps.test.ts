/**
 * The cloud computer's step loop: frames, semantic sentences, settling,
 * batched image pruning and the new tools.
 *
 * Everything here runs against injected deps (a fake screen and a virtual
 * clock), so no Docker and no real sleeping is involved; the seconds-per-step
 * figures it prints are the settle and capture overhead the loop adds per
 * action under the fake provider's timings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  computerFrameRef,
  computerTools,
  settleScreen,
  SETTLE_TIMEOUT_MS,
  TAKEOVER_OVERLAP_TEXT,
  TARGET_CHANGED_TEXT,
  type ComputerShotData,
  type ComputerToolsDeps,
} from '../work/computer-tools.js';
import { IMAGE_PRUNE_BATCH, pruneOldMessageImages } from '../loop.js';
import { NO_BUDGET, WorkAgentSession, WorkPlan, canonicalJson } from '../work/index.js';
import type { WorkApprovalRequest, WorkEmittedEvent, WorkToolResult } from '../work/types.js';
import type { ChatMessage } from '../types.js';
import type { ProviderAdapter, ProviderStreamEvent } from '../providers/types.js';

/** A virtual clock: `pause` advances it, captures cost `captureCostMs`. */
function virtualClock(captureCostMs = 40) {
  let now = 0;
  return {
    now: () => now,
    pause: async (ms: number) => {
      now += ms;
    },
    spend: (ms = captureCostMs) => {
      now += ms;
    },
    captureCostMs,
  };
}

function shot(label: string): ComputerShotData {
  return { mediaType: 'image/jpeg', data: Buffer.from(`jpeg:${label}`).toString('base64'), width: 1280, height: 800, hash: label };
}

interface Harness {
  deps: ComputerToolsDeps;
  calls: string[];
  stored: Array<{ ref: string; hash: string | undefined }>;
  clock: ReturnType<typeof virtualClock>;
}

/**
 * A fake desktop whose screen shows `frames[n]` on the n-th capture (the last
 * one repeats): a page still loading for a few captures, then settled.
 */
function harness(opts: {
  frames?: string[];
  blocked?: () => string | null;
  epoch?: () => number | null;
  describePoint?: ComputerToolsDeps['describePoint'];
  describeFocus?: ComputerToolsDeps['describeFocus'];
  payment?: boolean;
} = {}): Harness {
  const clock = virtualClock();
  const frames = opts.frames ?? ['steady'];
  let captures = 0;
  const calls: string[] = [];
  const stored: Array<{ ref: string; hash: string | undefined }> = [];
  const capture = async () => {
    clock.spend();
    const label = frames[Math.min(captures, frames.length - 1)]!;
    captures += 1;
    return shot(label);
  };
  const act = (name: string) => async () => {
    calls.push(name);
    return capture();
  };
  const deps: ComputerToolsDeps = {
    isHealthy: () => true,
    ...(opts.blocked ? { blockedReason: opts.blocked } : {}),
    ...(opts.epoch ? { takeoverEpoch: opts.epoch } : {}),
    pageTakesPayment: () => opts.payment === true,
    currentUrl: () => 'https://example.com/login',
    screenEpoch: () => 7,
    screenshot: async () => {
      calls.push('screenshot');
      return capture();
    },
    click: act('click'),
    type: act('type'),
    key: act('key'),
    scroll: act('scroll'),
    drag: act('drag'),
    zoom: async (region) => {
      calls.push(`zoom:${region.x},${region.y},${region.width},${region.height}`);
      return { ...shot('zoomed'), width: region.width * 4, height: region.height * 4 };
    },
    exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }),
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
    storeFrame: async (ref, frame) => {
      stored.push({ ref, hash: frame.hash });
      return { ref, width: frame.width, height: frame.height, src: `/api/work/runs/run_1/frames/${ref}` };
    },
    ...(opts.describePoint ? { describePoint: opts.describePoint } : {}),
    ...(opts.describeFocus ? { describeFocus: opts.describeFocus } : {}),
    now: clock.now,
    pause: clock.pause,
  };
  return { deps, calls, stored, clock };
}

const byName = (deps: ComputerToolsDeps, name: string) => {
  const tool = computerTools(deps).find((candidate) => candidate.spec.name === name);
  assert.ok(tool, `${name} exists`);
  return tool;
};

test('computer_drag, computer_wait and computer_zoom exist with their risk tiers', async () => {
  const plain = harness();
  const drag = byName(plain.deps, 'computer_drag');
  const wait = byName(plain.deps, 'computer_wait');
  const zoom = byName(plain.deps, 'computer_zoom');
  // A drag is a click's risk: a command, and a purchase on a payment page.
  assert.equal(drag.riskFor({ x1: 1, y1: 2, x2: 3, y2: 4 }), 'command');
  assert.equal(drag.actionFor({}), 'work.computer.drag');
  const paying = harness({ payment: true });
  assert.equal(byName(paying.deps, 'computer_drag').riskFor({}), 'irreversible');
  assert.equal(byName(paying.deps, 'computer_drag').actionFor({}), 'work.browser.purchase');
  // Waiting and zooming change nothing.
  assert.equal(wait.riskFor({ seconds: 3 }), 'safe');
  assert.equal(wait.kind, 'read');
  assert.equal(zoom.riskFor({ x: 0, y: 0, width: 100, height: 100 }), 'safe');
  assert.equal(zoom.kind, 'read');
  assert.equal(byName(paying.deps, 'computer_zoom').riskFor({}), 'safe', 'zooming is read-only, even on a payment page');

  const dragged = await drag.execute({ x1: 10, y1: 20, x2: 300, y2: 40 }, { cwd: '/tmp', callId: 'call_drag' });
  assert.equal(dragged.isError ?? false, false);
  assert.ok(plain.calls.includes('drag'));
  assert.deepEqual(drag.pointFor?.({ x1: 10, y1: 20, x2: 300, y2: 40 }), { x: 10, y: 20 });

  // Wait is capped at ten seconds of the (virtual) clock, then looks once.
  const before = plain.clock.now();
  const waited = await wait.execute({ seconds: 60 }, { cwd: '/tmp', callId: 'call_wait' });
  assert.equal(waited.isError ?? false, false);
  assert.equal(waited.images?.length, 1);
  assert.ok(plain.clock.now() - before >= 10_000 && plain.clock.now() - before < 10_200);

  // Zoom crops a region of a fresh screenshot and keeps no frame of its own.
  const storedBefore = plain.stored.length;
  const zoomed = await zoom.execute({ x: 100, y: 50, width: 320, height: 200 }, { cwd: '/tmp', callId: 'call_zoom' });
  assert.equal(zoomed.isError ?? false, false);
  assert.match(zoomed.output, /1280x800/);
  assert.ok(plain.calls.includes('zoom:100,50,320,200'));
  assert.equal(plain.stored.length, storedBefore, 'a zoom changes nothing on screen, so it stores nothing');
});

test('waiting on a screen that is changing is not a repeat; waiting on a frozen one is', async () => {
  const moving = harness({ frames: ['10%', '40%', '80%', 'done'] });
  const wait = byName(moving.deps, 'computer_wait');
  const signatures: string[] = [];
  for (let i = 0; i < 3; i++) {
    signatures.push(JSON.stringify(wait.signatureInput!({ seconds: 5 })));
    await wait.execute({ seconds: 5 }, { cwd: '/tmp', callId: `w${i}` });
  }
  assert.equal(new Set(signatures).size, 3, 'each wait saw a different screen');

  const frozen = harness({ frames: ['stuck'] });
  const stuck = byName(frozen.deps, 'computer_wait');
  const same: string[] = [];
  for (let i = 0; i < 3; i++) {
    await stuck.execute({ seconds: 5 }, { cwd: '/tmp', callId: `s${i}` });
    same.push(JSON.stringify(stuck.signatureInput!({ seconds: 5 })));
  }
  assert.equal(new Set(same).size, 1, 'the stall detector still sees a loop on a frozen screen');
});

test('settling returns as soon as two captures agree, or at the 500 ms cap', async () => {
  const clock = virtualClock();
  // 100 ms between captures, 40 ms per capture: spinner at 140 ms, loaded at
  // 280 ms, loaded again at 420 ms — two that agree, so it returns there.
  const loading = ['spinner', 'loaded', 'loaded', 'never-reached'];
  let n = 0;
  const capture = async () => {
    clock.spend();
    return shot(loading[Math.min(n++, loading.length - 1)]!);
  };
  const settled = await settleScreen(shot('before'), { capture, now: clock.now, pause: clock.pause });
  assert.equal(settled.stable, true);
  assert.equal(settled.shot.hash, 'loaded');
  assert.equal(n, 3, 'stopped polling at the first agreement');
  assert.equal(settled.settleMs, 420);
  assert.ok(settled.settleMs < SETTLE_TIMEOUT_MS);
  assert.equal(settled.captureMs, clock.captureCostMs);

  // A screen that never stops changing (a video) is cut off at the cap.
  const busyClock = virtualClock();
  let frame = 0;
  const busy = await settleScreen(shot('v0'), {
    capture: async () => {
      busyClock.spend();
      return shot(`v${++frame}`);
    },
    now: busyClock.now,
    pause: busyClock.pause,
  });
  assert.equal(busy.stable, false);
  assert.ok(busy.settleMs >= SETTLE_TIMEOUT_MS, `${busy.settleMs}ms`);
  assert.ok(busy.settleMs < SETTLE_TIMEOUT_MS + busyClock.captureCostMs + 1, `${busy.settleMs}ms`);

  // Through a tool, on a fake provider whose frames change: the model and
  // the stored frame both get the settled screen, not the first one.
  const h = harness({ frames: ['navigating', 'half', 'done'] });
  const click = byName(h.deps, 'computer_click');
  const result: WorkToolResult = await click.execute({ x: 640, y: 400 }, { cwd: '/tmp', callId: 'call_settle' });
  assert.equal(result.images?.[0]?.data, shot('done').data);
  assert.deepEqual(h.stored, [{ ref: 'call_settle', hash: 'done' }]);
  assert.equal(typeof result.settleMs, 'number');
  assert.equal(typeof result.captureMs, 'number');

  const perStep = ((result.settleMs ?? 0) + (result.captureMs ?? 0)) / 1000;
  console.log(`# settle + capture per step (fake provider, ${h.clock.captureCostMs} ms captures, changing frames): ${perStep.toFixed(3)} s`);
  const steady = harness();
  const quick: WorkToolResult = await byName(steady.deps, 'computer_click').execute({ x: 1, y: 1 }, { cwd: '/tmp', callId: 'c' });
  console.log(`# settle + capture per step (fake provider, steady screen): ${(((quick.settleMs ?? 0) + (quick.captureMs ?? 0)) / 1000).toFixed(3)} s`);
});

test('batched pruning keeps the prefix byte-identical for K steps, then cuts back to 3', () => {
  const image = (n: number): ChatMessage => ({
    role: 'user',
    content: [
      { type: 'text', text: `step ${n}` },
      { type: 'image', mediaType: 'image/jpeg', data: `jpeg_${n}` },
    ],
  });
  const count = (messages: ChatMessage[]) =>
    messages.reduce((total, m) => total + (m.role === 'user' ? m.content.filter((p) => p.type === 'image').length : 0), 0);
  const messages: ChatMessage[] = [image(1), image(2), image(3)];
  pruneOldMessageImages(messages, 3, IMAGE_PRUNE_BATCH);
  assert.equal(count(messages), 3);
  for (let step = 1; step <= IMAGE_PRUNE_BATCH; step++) {
    const prefix = JSON.stringify(messages);
    messages.push(image(3 + step));
    pruneOldMessageImages(messages, 3, IMAGE_PRUNE_BATCH);
    assert.equal(JSON.stringify(messages.slice(0, -1)), prefix, `step ${step}: the cached prefix did not move`);
    assert.equal(count(messages), 3 + step);
  }
  messages.push(image(4 + IMAGE_PRUNE_BATCH));
  pruneOldMessageImages(messages, 3, IMAGE_PRUNE_BATCH);
  assert.equal(count(messages), 3, 'one cut, back to the newest three');
  const last = messages.slice(-3).map((m) => (m.role === 'user' ? m.content[1] : null));
  assert.deepEqual(
    last.map((part) => (part && part.type === 'image' ? part.data : null)),
    [`jpeg_${2 + IMAGE_PRUNE_BATCH}`, `jpeg_${3 + IMAGE_PRUNE_BATCH}`, `jpeg_${4 + IMAGE_PRUNE_BATCH}`],
  );
  // Batch 0 is the old rule: exactly the newest three, every time.
  const exact: ChatMessage[] = [image(1), image(2), image(3), image(4)];
  pruneOldMessageImages(exact, 3);
  assert.equal(count(exact), 3);
});

test('a frame is never stored when the person held control, or took it mid-step', async () => {
  // Blocked from the start: nothing touches the screen, nothing is stored.
  const held = harness({ blocked: () => 'The person has control of this computer.' });
  for (const name of ['computer_screenshot', 'computer_click', 'computer_drag', 'computer_wait', 'computer_zoom']) {
    const result = await byName(held.deps, name).execute({ x: 1, y: 1, x1: 1, y1: 1, x2: 2, y2: 2 }, { cwd: '/tmp', callId: `call_${name}` });
    assert.equal(result.isError, true, name);
  }
  assert.deepEqual(held.calls, []);
  assert.deepEqual(held.stored, []);

  // A takeover that started (and even ended) during the capture: the epoch
  // moved, so the result and its frame are both discarded.
  let epoch = 1;
  const overlap = harness({ epoch: () => epoch });
  const inner = overlap.deps.screenshot;
  overlap.deps.screenshot = async () => {
    epoch += 1; // the person pressed Take control while this was capturing
    return inner();
  };
  const result = await byName(overlap.deps, 'computer_screenshot').execute({ reason: 'look' }, { cwd: '/tmp', callId: 'call_overlap' });
  assert.equal(result.output, TAKEOVER_OVERLAP_TEXT);
  assert.equal(result.images, undefined);
  assert.deepEqual(overlap.stored, [], 'no frame from a takeover reaches storage');

  // And an approval's pre-action frame is fenced the same way.
  const tools = computerTools(overlap.deps);
  const preview = await tools.find((tool) => tool.spec.name === 'computer_type')!.preview!(
    { text: 'hello' },
    { callId: 'call_type', forApproval: true },
  );
  assert.equal(preview?.detail?.frame, undefined);
  assert.deepEqual(overlap.stored, []);
});

test('a click names its target when Chromium is in front, and falls back to coordinates otherwise', async () => {
  const inFront = harness({
    describePoint: async (x, y) => (x === 640 && y === 400 ? { role: 'button', name: 'Sign in', host: 'example.com' } : null),
  });
  const click = byName(inFront.deps, 'computer_click');
  const named = await click.preview!({ x: 640, y: 400 }, { callId: 'c1', forApproval: false });
  assert.equal(named?.summary, 'Click the “Sign in” button on example.com');
  const right = await click.preview!({ x: 640, y: 400, button: 'right' }, { callId: 'c2', forApproval: false });
  assert.equal(right?.summary, 'Right-click the “Sign in” button on example.com');

  // Not in front (the describer answers null), or no describer at all.
  assert.equal((await click.preview!({ x: 10, y: 10 }, { callId: 'c3', forApproval: false }))?.summary, undefined);
  assert.equal(click.summarize({ x: 10, y: 10 }), 'Click at (10, 10) on example.com');
  const plain = byName(harness().deps, 'computer_click');
  assert.equal((await plain.preview!({ x: 640, y: 400 }, { callId: 'c4', forApproval: false }))?.summary, undefined);

  // A page cannot smuggle quotes, controls or a novel into the sentence.
  const hostile = byName(
    harness({ describePoint: async () => ({ role: 'link', name: `Pay‮ now” and “${'x'.repeat(200)}`, host: 'shop.example' }) }).deps,
    'computer_click',
  );
  const sentence = (await hostile.preview!({ x: 1, y: 1 }, { callId: 'c5', forApproval: false }))?.summary ?? '';
  assert.doesNotMatch(sentence, /‮/);
  assert.ok(sentence.length <= 200);
  assert.match(sentence, /^Click the “Pay now' and '.*\.\.\.” link on shop\.example$/);

  // Typing names the focused field.
  const typing = byName(
    harness({ describeFocus: async () => ({ role: 'searchbox', name: 'Search', host: 'example.com' }) }).deps,
    'computer_type',
  );
  assert.equal(
    (await typing.preview!({ text: 'flights' }, { callId: 'c6', forApproval: false }))?.summary,
    'Type 7 characters into the “Search” search field on example.com',
  );
});

test('an approved click whose target changed before it ran does nothing', async () => {
  let name = 'Sign in';
  const h = harness({ describePoint: async () => ({ role: 'button', name, host: 'example.com' }) });
  const click = byName(h.deps, 'computer_click');
  const preview = await click.preview!({ x: 640, y: 400 }, { callId: 'call_ok', forApproval: true });
  assert.equal(preview?.summary, 'Click the “Sign in” button on example.com');
  const ok = await click.execute({ x: 640, y: 400 }, { cwd: '/tmp', callId: 'call_ok' });
  assert.equal(ok.isError ?? false, false);

  await click.preview!({ x: 640, y: 400 }, { callId: 'call_moved', forApproval: true });
  name = 'Delete account'; // the page changed while the person was deciding
  const refused = await click.execute({ x: 640, y: 400 }, { cwd: '/tmp', callId: 'call_moved' });
  assert.equal(refused.isError, true);
  assert.equal(refused.output, TARGET_CHANGED_TEXT);
  assert.equal(h.calls.filter((call) => call === 'click').length, 1, 'the second click never reached the screen');
});

test('a session carries the point on tool_started, the frame on tool_finished, and the frame and text on the approval', async () => {
  const h = harness({
    describePoint: async () => ({ role: 'button', name: 'Sign in', host: 'example.com' }),
    describeFocus: async () => ({ role: 'textbox', name: 'Email', host: 'example.com' }),
  });
  const script: ProviderStreamEvent[][] = [
    [{ type: 'tool_call', id: 'tc_click', name: 'computer_click', input: { x: 640, y: 400 } }, { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }],
    [{ type: 'tool_call', id: 'tc_type', name: 'computer_type', input: { text: 'me@example.com' } }, { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }],
    [{ type: 'text_delta', text: 'Signed in.' }, { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }],
  ];
  let turn = 0;
  const provider: ProviderAdapter = {
    id: 'fake',
    name: 'Fake',
    defaultModel: 'fake-1',
    models: () => ['fake-1'],
    capabilities: () => ({ tools: true, vision: true, computerUse: true, reasoningLevels: [], maxContext: 200_000, streaming: true, mcp: false }),
    async *stream() {
      for (const event of script[Math.min(turn, script.length - 1)]!) yield event;
      turn += 1;
    },
  };
  const events: WorkEmittedEvent[] = [];
  const approvals: WorkApprovalRequest[] = [];
  const session = new WorkAgentSession({
    runId: 'run_steps',
    goal: 'Sign in.',
    provider,
    model: 'fake-1',
    cwd: '/tmp',
    tools: computerTools(h.deps),
    plan: new WorkPlan([{ id: 'step_1', title: 'Sign in' }]),
    budget: NO_BUDGET,
    approvalMode: 'conservative',
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async (request) => {
        approvals.push(request);
        return 'allowed';
      },
      askQuestion: async () => 'ok',
    },
  });
  const result = await session.run();
  assert.equal(result.state, 'finished');

  const started = events.filter((event) => event.kind === 'tool_started');
  const finished = events.filter((event) => event.kind === 'tool_finished');
  const click = started.find((event) => event.kind === 'tool_started' && event.callId === 'tc_click');
  assert.ok(click && click.kind === 'tool_started');
  assert.deepEqual(click.point, { x: 640, y: 400 }, "the click's start carries where it lands");
  assert.equal(click.summary, 'Click the “Sign in” button on example.com');
  for (const event of finished) {
    assert.ok(event.kind === 'tool_finished');
    assert.deepEqual(event.frame, { ref: computerFrameRef(event.callId), width: 1280, height: 800 });
    assert.equal(typeof event.settleMs, 'number');
    assert.equal(typeof event.captureMs, 'number');
  }
  assert.equal(finished.length, 2);

  // Typing asks every time; its card gets the text, the frame before it and
  // the semantic sentence — and the digest is still over action, tool, input.
  const typed = approvals.find((request) => request.callId === 'tc_type');
  assert.ok(typed);
  assert.equal(typed.summary, 'Type 14 characters into the “Email” field on example.com');
  assert.equal(typed.detail.text, 'me@example.com');
  assert.deepEqual(typed.detail.frame, { ref: 'tc_type-pre', width: 1280, height: 800, epoch: 7, src: '/api/work/runs/run_1/frames/tc_type-pre' });
  assert.equal(typed.detail.intent, 'screen.type');
  const digestInput = canonicalJson({ action: 'work.computer.type', tool: 'computer_type', input: { text: 'me@example.com' } });
  assert.equal(typed.digestInput, digestInput);
  assert.equal(typed.actionDigest, crypto.createHash('sha256').update(digestInput).digest('hex'));
  assert.doesNotMatch(typed.digestInput, /frame|tc_type-pre/, 'the frame reference is not in what the answer authorises');
});
