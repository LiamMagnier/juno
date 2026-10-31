/**
 * Teach by demonstration (docs/design/agents-v2/TEACH.md).
 *
 *   (a) The trace builder, from a scripted stream of what the CDP recorder
 *       hands over: binding reports from the capture script and main-frame
 *       navigations.
 *   (b) Redaction: a secret typed into a password, one-time-code or card
 *       field, or shaped like a card number or key, never reaches the trace,
 *       the stored plaintext, or the drafting model's prompt.
 *   (c) Caps: steps, duration, raw events, screenshots, and screenshots only
 *       when the page said no secret is on screen.
 *   (d) Ownership: every row is read and written inside (userId, agentId);
 *       recording needs the take over this client holds.
 *   (e) The drafting prompt is built from the redacted trace alone, and its
 *       answer goes through the chat draft's gate.
 *   (f) Off without the flag.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  PAGE_CAPTURE_SCRIPT,
  TEACH_BINDING_NAME,
  TEACH_MAX_DURATION_MS,
  TEACH_MAX_RAW_EVENTS,
  TEACH_MAX_SHOTS,
  TEACH_MAX_SHOT_BYTES,
  TEACH_MAX_STEPS,
  TEACH_SHOT_INTERVAL_MS,
  admitDemonstrationDraft,
  buildDemonstrationDraftPrompt,
  buildDemonstrationTrace,
  demonstrationDraftKey,
  fieldSensitivity,
  luhnValid,
  parseDemonstrationDraft,
  readDemonstrationTrace,
  readPageReport,
  sanitizeUrl,
  secretShape,
  type DemoElement,
  type RawDemoEvent,
} from "@/lib/teach/demonstration";
import { createDemonstrationCollector } from "@/lib/teach/collector";
import {
  TAKEOVER_LAPSE_MARGIN_MS,
  TeachError,
  createTeachService,
  recordingStillHeld,
  type DemonstrationPersistence,
  type DemonstrationRow,
  type RecorderSession,
  type StartRecorderInput,
  type TeachComputerState,
  type TeachDeps,
} from "@/lib/teach/service";
import { env, isAgentTeachConfigured } from "@/lib/env";

const T0 = Date.parse("2026-10-30T10:00:00.000Z");

const PASSWORD = "hunter2-Sup3rSecret!";
const CARD = "4242 4242 4242 4242";
const OTP = "493817";
const TOKEN = "ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5";

function el(over: Partial<DemoElement> = {}): Record<string, unknown> {
  return {
    tag: "input",
    role: "textbox",
    name: "Search",
    selector: 'input[name="q"]',
    type: "text",
    autocomplete: "",
    fieldName: "q ",
    sensitive: false,
    ...over,
  };
}

/** What the CDP recorder hands over for one binding call. */
function report(message: Record<string, unknown>, at: number): RawDemoEvent {
  const parsed = readPageReport(JSON.stringify(message), at);
  assert.ok(parsed && parsed.kind !== "state", `report ${JSON.stringify(message)} should parse`);
  return parsed as RawDemoEvent;
}

/** A scripted session: sign in, search, open a result, check out with a card. */
function scriptedStream(): RawDemoEvent[] {
  return [
    { kind: "navigate", at: T0 + 100, url: "https://user:pw@shop.example.com/login?next=%2Faccount&token=abc#top" },
    report({ t: "click", el: el({ tag: "input", role: "textbox", name: "Email", selector: "#email", fieldName: "email email" }) }, T0 + 500),
    report({ t: "input", el: el({ name: "Email", selector: "#email", fieldName: "email email", type: "email" }), value: "liam@example.com" }, T0 + 1_500),
    // The page script already withholds a password's value; this one claims to
    // send it anyway, as a hostile or buggy page script might.
    report({ t: "input", el: el({ role: "password", name: "Password", selector: "#password", type: "password", fieldName: "password password" }), value: PASSWORD }, T0 + 2_500),
    report({ t: "click", el: el({ tag: "button", role: "button", name: "Sign in", selector: "#signin", type: "submit", fieldName: " " }) }, T0 + 3_000),
    report({ t: "submit", el: el({ tag: "button", role: "button", name: "Sign in", selector: "#signin", type: "submit", fieldName: " " }) }, T0 + 3_050),
    { kind: "navigate", at: T0 + 4_000, url: "https://shop.example.com/account" },
    { kind: "navigate", at: T0 + 4_100, url: "https://shop.example.com/account#orders" },
    report({ t: "input", el: el({ name: "Search", selector: 'input[name="q"]' }), value: "blue" }, T0 + 5_000),
    report({ t: "input", el: el({ name: "Search", selector: 'input[name="q"]' }), value: "blue shoes" }, T0 + 5_500),
    report({ t: "submit", el: el({ tag: "form", role: "form", name: "search", selector: "#search-form", type: "", fieldName: "search search-form" }) }, T0 + 6_000),
    { kind: "navigate", at: T0 + 7_000, url: "https://shop.example.com/products/8812345/blue-shoes?ref=search" },
    report({ t: "click", el: el({ tag: "button", role: "button", name: "Add to cart", selector: '[data-testid="add"]', type: "", fieldName: " " }) }, T0 + 8_000),
    // A card number typed into a field the page did not mark at all.
    report({ t: "input", el: el({ name: "Number on the front", selector: "#f1", fieldName: "f1 f1" }), value: CARD }, T0 + 9_000),
    report({ t: "input", el: el({ name: "Code", selector: "#otp", autocomplete: "one-time-code", fieldName: "code otp" }), value: OTP }, T0 + 9_500),
    report({ t: "input", el: el({ name: "Notes", selector: "#notes", fieldName: "notes notes" }), value: TOKEN }, T0 + 9_800),
  ];
}

function assertNoSecrets(text: string, where: string) {
  for (const secret of [PASSWORD, CARD, CARD.replace(/\s/g, ""), OTP, TOKEN, "user:pw", "token=abc", "ref=search", "next=%2Faccount"]) {
    assert.ok(!text.includes(secret), `${where} must not contain ${JSON.stringify(secret)}`);
  }
}

describe("(a) the trace builder, from a scripted CDP stream", () => {
  it("folds navigations, clicks, typing and submits into steps", () => {
    const trace = buildDemonstrationTrace(scriptedStream(), { startedAt: T0, endedAt: T0 + 10_000 });
    assert.equal(trace.origin, "https://shop.example.com");
    assert.deepEqual(trace.origins, ["https://shop.example.com"]);
    const kinds = trace.steps.map((s) => s.kind);
    assert.deepEqual(kinds, [
      "navigate", // /login (query, fragment and credentials gone)
      "type", // email (the focusing click is not a step)
      "type", // password, redacted
      "submit", // the Sign in click and its submit are one step
      "navigate", // /account (the #orders fragment is the same page)
      "type", // search: two changes, the last value kept
      "submit",
      "navigate", // /products/{id}/blue-shoes
      "click",
      "type", // card, redacted by shape
      "type", // one-time code, redacted by autocomplete
      "type", // a token, redacted by shape
    ]);
    const first = trace.steps[0];
    assert.equal(first.kind === "navigate" && first.path, "/login");
    const product = trace.steps[7];
    assert.equal(product.kind === "navigate" && product.path, "/products/{id}/blue-shoes");
    const search = trace.steps[5];
    assert.ok(search.kind === "type");
    assert.equal(search.value, "blue shoes");
    assert.equal(search.slot, "search");
    const email = trace.steps[1];
    assert.ok(email.kind === "type");
    assert.equal(email.value, "liam@example.com");
    assert.equal(trace.redactions, 4);
    assert.equal(trace.truncated, false);
    assert.equal(trace.durationMs, 10_000);
  });

  it("is deterministic and survives a stored round trip unchanged", () => {
    const a = buildDemonstrationTrace(scriptedStream(), { startedAt: T0, endedAt: T0 + 10_000 });
    const b = buildDemonstrationTrace([...scriptedStream()].reverse(), { startedAt: T0, endedAt: T0 + 10_000 });
    assert.deepEqual(a, b);
    assert.deepEqual(readDemonstrationTrace(JSON.parse(JSON.stringify(a))), a);
  });

  it("drops malformed and oversized reports from the page", () => {
    assert.equal(readPageReport("not json", T0), null);
    assert.equal(readPageReport(JSON.stringify({ t: "click" }), T0), null);
    assert.equal(readPageReport(JSON.stringify({ t: "click", el: { tag: "<script>" } }), T0), null);
    assert.equal(readPageReport(JSON.stringify({ t: "click", el: el({ name: "x".repeat(9_000) }) }), T0), null);
    const state = readPageReport(JSON.stringify({ t: "state", sensitive: false }), T0);
    assert.deepEqual(state, { kind: "state", sensitive: false });
    // A state report that does not say "no" counts as "a secret is on screen".
    assert.deepEqual(readPageReport(JSON.stringify({ t: "state" }), T0), { kind: "state", sensitive: true });
  });

  it("keeps only http(s) origins and paths", () => {
    assert.deepEqual(sanitizeUrl("https://a.example.com/x/y?q=1#h"), { origin: "https://a.example.com", path: "/x/y" });
    assert.deepEqual(sanitizeUrl("https://bob:secret@a.example.com/"), { origin: "https://a.example.com", path: "/" });
    assert.equal(sanitizeUrl("javascript:alert(1)"), null);
    assert.equal(sanitizeUrl("chrome://settings"), null);
    assert.equal(sanitizeUrl("data:text/html,hi"), null);
    assert.deepEqual(sanitizeUrl("https://a.example.com/reset/9f2c1e7a6b5d4c3b2a1f/confirm"), {
      origin: "https://a.example.com",
      path: "/reset/{id}/confirm",
    });
    assert.deepEqual(sanitizeUrl("https://a.example.com/users/liam%40example.com/orders/2026"), {
      origin: "https://a.example.com",
      path: "/users/{email}/orders/{id}",
    });
    assert.deepEqual(sanitizeUrl("https://a.example.com/sale/spring-sale-2026"), { origin: "https://a.example.com", path: "/sale/spring-sale-2026" });
  });
});

describe("(b) redaction of sensitive fields", () => {
  it("knows sensitive fields by type, autocomplete, name and value", () => {
    const base = { type: "text", autocomplete: "", fieldName: "", name: "", role: "textbox", sensitive: false };
    assert.deepEqual(fieldSensitivity({ ...base, type: "password" }, null), { sensitive: true, kind: "password" });
    assert.deepEqual(fieldSensitivity({ ...base, autocomplete: "current-password" }, "x"), { sensitive: true, kind: "password" });
    assert.deepEqual(fieldSensitivity({ ...base, autocomplete: "one-time-code" }, "123456"), { sensitive: true, kind: "one_time_code" });
    assert.deepEqual(fieldSensitivity({ ...base, autocomplete: "cc-number" }, "4"), { sensitive: true, kind: "card_number" });
    assert.deepEqual(fieldSensitivity({ ...base, autocomplete: "billing cc-csc" }, "123"), { sensitive: true, kind: "card_security_code" });
    assert.deepEqual(fieldSensitivity({ ...base, fieldName: "cvv cvv" }, "123"), { sensitive: true, kind: "card_security_code" });
    assert.deepEqual(fieldSensitivity({ ...base, name: "Verification code" }, "123456"), { sensitive: true, kind: "one_time_code" });
    assert.deepEqual(fieldSensitivity({ ...base, fieldName: "user_pass" }, "x"), { sensitive: true, kind: "password" });
    assert.deepEqual(fieldSensitivity({ ...base, name: "API key" }, "x"), { sensitive: true, kind: "secret" });
    assert.deepEqual(fieldSensitivity({ ...base, name: "Gift message" }, CARD), { sensitive: true, kind: "card_number" });
    assert.deepEqual(fieldSensitivity({ ...base, name: "Notes" }, TOKEN), { sensitive: true, kind: "secret" });
    assert.deepEqual(fieldSensitivity({ ...base, sensitive: true }, "x"), { sensitive: true, kind: "secret" });
    assert.deepEqual(fieldSensitivity({ ...base, name: "Search" }, "blue shoes"), { sensitive: false, kind: null });
    assert.deepEqual(fieldSensitivity({ ...base, name: "Username" }, "liam"), { sensitive: false, kind: null });
  });

  it("recognises card numbers and keys by shape", () => {
    assert.equal(luhnValid("4242424242424242"), true);
    assert.equal(luhnValid("4242424242424241"), false);
    assert.equal(secretShape("4242-4242-4242-4242"), "card_number");
    assert.equal(secretShape(TOKEN), "secret");
    assert.equal(secretShape("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123"), "secret");
    assert.equal(secretShape("sk_live_abcdefgh12345678"), "secret");
    assert.equal(secretShape("blue shoes size 42"), null);
    assert.equal(secretShape("https://example.com/a1b2c3d4e5f6g7h8i9j0k1l2"), null);
  });

  it("drops a sensitive field's value at the first read, whatever the page sent", () => {
    const parsed = readPageReport(
      JSON.stringify({ t: "input", el: el({ type: "password", sensitive: true }), value: PASSWORD }),
      T0
    );
    assert.ok(parsed && parsed.kind === "input");
    assert.equal(parsed.value, null);
    const flagged = readPageReport(JSON.stringify({ t: "input", el: el(), sensitive: true, value: PASSWORD }), T0);
    assert.ok(flagged && flagged.kind === "input");
    assert.equal(flagged.value, null);
    assert.equal(flagged.element.sensitive, true);
  });

  it("stores placeholders, never the secrets", () => {
    const trace = buildDemonstrationTrace(scriptedStream(), { startedAt: T0, endedAt: T0 + 10_000 });
    const text = JSON.stringify(trace);
    assertNoSecrets(text, "the trace");
    const placeholders = trace.steps.flatMap((s) => (s.kind === "type" && s.placeholder ? [s.placeholder] : []));
    assert.deepEqual(placeholders, ["{{password}}", "{{card_number}}", "{{one_time_code}}", "{{secret}}"]);
    for (const step of trace.steps) if (step.kind === "type" && step.placeholder) assert.equal(step.value, null);
  });

  it("a stored trace with a secret-shaped value is redacted again on read", () => {
    const tampered = {
      version: 1,
      origins: ["https://shop.example.com"],
      steps: [{ kind: "type", atMs: 1, target: { role: "textbox", name: "Note", selector: "#n" }, value: CARD, placeholder: null, slot: "note" }],
      durationMs: 1,
      redactions: 0,
      truncated: false,
    };
    const trace = readDemonstrationTrace(tampered);
    assert.ok(trace);
    const step = trace.steps[0];
    assert.ok(step.kind === "type");
    assert.equal(step.value, null);
    assert.equal(step.placeholder, "{{card_number}}");
  });

  it("the page capture script withholds sensitive values and ignores synthetic events", () => {
    assert.ok(PAGE_CAPTURE_SCRIPT.includes(TEACH_BINDING_NAME));
    assert.match(PAGE_CAPTURE_SCRIPT, /if \(!e\.isTrusted\) return;/);
    assert.match(PAGE_CAPTURE_SCRIPT, /type === "password"/);
    assert.match(PAGE_CAPTURE_SCRIPT, /current-password\|new-password\|one-time-code\|cc-\[a-z-\]\+/);
    // The sensitive branch sends no value at all.
    assert.match(PAGE_CAPTURE_SCRIPT, /send\(\{ t: "input", el: d, sensitive: true \}\)/);
    // A field's own text is never its name.
    assert.match(PAGE_CAPTURE_SCRIPT, /isField\(el\) \? "" :/);
  });

  it("the page capture script, run against a stub page, never sends a secret", () => {
    const sent: string[] = [];
    const handlers = new Map<string, (event: unknown) => void>();
    const field = (attrs: Record<string, string>, value: string) => ({
      tagName: "INPUT",
      value,
      labels: [],
      isContentEditable: false,
      parentElement: null,
      previousElementSibling: null,
      nodeType: 1,
      getAttribute: (name: string) => attrs[name] ?? null,
      closest() {
        return this;
      },
    });
    const document = {
      activeElement: null as unknown,
      body: {},
      addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
      querySelectorAll: () => [],
      getElementById: () => null,
    };
    const window: Record<string, unknown> = { [TEACH_BINDING_NAME]: (text: string) => sent.push(text) };
    new Function("window", "document", "CSS", PAGE_CAPTURE_SCRIPT)(window, document, undefined);
    const change = handlers.get("change");
    assert.ok(change, "the script listens for committed values");

    const password = field({ type: "password", name: "pw", id: "pw" }, PASSWORD);
    change({ isTrusted: true, target: password });
    const otp = field({ type: "text", autocomplete: "one-time-code", name: "code" }, OTP);
    change({ isTrusted: true, target: otp });
    const card = field({ type: "text", name: "f1" }, CARD);
    change({ isTrusted: true, target: card });
    // The password typed again into an ordinary field is caught too.
    const notes = field({ type: "text", name: "notes" }, `my pw is ${PASSWORD}`);
    change({ isTrusted: true, target: notes });
    const search = field({ type: "search", name: "q" }, "blue shoes");
    change({ isTrusted: true, target: search });
    // A synthetic event the page dispatched is ignored.
    change({ isTrusted: false, target: field({ type: "text", name: "fake" }, "forged") });

    const inputs = sent.map((text) => JSON.parse(text) as Record<string, unknown>).filter((m) => m.t === "input");
    assert.equal(inputs.length, 5);
    assert.deepEqual(
      inputs.map((m) => [m.sensitive === true, "value" in m]),
      [
        [true, false],
        [true, false],
        [true, false],
        [true, false],
        [false, true],
      ]
    );
    assert.equal(inputs[4].value, "blue shoes");
    assertNoSecrets(sent.join("\n"), "what the page script sent");
    assert.ok(!sent.join("\n").includes("forged"));
  });
});

describe("(c) caps", () => {
  it("stops at the step cap and says it was cut", () => {
    const events: RawDemoEvent[] = [];
    for (let i = 0; i < TEACH_MAX_STEPS + 30; i += 1) {
      events.push(report({ t: "click", el: el({ tag: "button", role: "button", name: `B${i}`, selector: `#b${i}`, type: "" }) }, T0 + i));
    }
    const trace = buildDemonstrationTrace(events, { startedAt: T0, endedAt: T0 + 1_000 });
    assert.equal(trace.steps.length, TEACH_MAX_STEPS);
    assert.equal(trace.truncated, true);
  });

  it("drops what happened after the duration cap", () => {
    const events: RawDemoEvent[] = [
      { kind: "navigate", at: T0 + 1, url: "https://a.example.com/" },
      { kind: "navigate", at: T0 + TEACH_MAX_DURATION_MS + 1, url: "https://a.example.com/late" },
    ];
    const trace = buildDemonstrationTrace(events, { startedAt: T0, endedAt: T0 + TEACH_MAX_DURATION_MS + 5_000 });
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.truncated, true);
    assert.equal(trace.durationMs, TEACH_MAX_DURATION_MS);
  });

  it("the collector reports full at the step and event caps, and expires", () => {
    const collector = createDemonstrationCollector(T0);
    let verdict = "ok";
    for (let i = 0; i < TEACH_MAX_STEPS && verdict !== "full"; i += 1) {
      verdict = collector.push(report({ t: "click", el: el({ tag: "button", role: "button", name: `B${i}`, selector: `#b${i}`, type: "" }) }, T0 + i), "tab-1");
    }
    assert.equal(verdict, "full");
    assert.equal(collector.trace(T0 + 1_000).steps.length, TEACH_MAX_STEPS);
    assert.equal(collector.push({ kind: "navigate", at: T0 + 2, url: "https://a.example.com/x" }, "tab-1"), "full");

    const noisy = createDemonstrationCollector(T0);
    let last = "ok";
    for (let i = 0; i <= TEACH_MAX_RAW_EVENTS; i += 1) {
      // Focus clicks are not steps, so only the raw event cap can stop these.
      last = noisy.push(report({ t: "click", el: el() }, T0 + i), "tab-1");
    }
    assert.equal(last, "full");
    assert.equal(noisy.eventCount(), TEACH_MAX_RAW_EVENTS);

    assert.equal(collector.expired(T0 + TEACH_MAX_DURATION_MS - 1), false);
    assert.equal(collector.expired(T0 + TEACH_MAX_DURATION_MS), true);
  });

  it("takes screenshots only when the page said no secret is on screen, within the cap", () => {
    const collector = createDemonstrationCollector(T0);
    // Nothing said yet: no screenshot.
    assert.equal(collector.shotAllowed(T0, "tab-1"), false);
    collector.push({ kind: "state", sensitive: true }, "tab-1");
    assert.equal(collector.shotAllowed(T0, "tab-1"), false);
    collector.push({ kind: "state", sensitive: false }, "tab-1");
    assert.equal(collector.shotAllowed(T0, "tab-1"), true);
    // A new document has not said anything yet.
    collector.push({ kind: "navigate", at: T0 + 1, url: "https://a.example.com/" }, "tab-1");
    assert.equal(collector.shotAllowed(T0 + 1, "tab-1"), false);
    collector.push({ kind: "state", sensitive: false }, "tab-1");

    let now = T0;
    for (let i = 0; i < TEACH_MAX_SHOTS + 3; i += 1) {
      if (collector.shotAllowed(now, "tab-1")) collector.addShot("QUJD", now);
      now += TEACH_SHOT_INTERVAL_MS;
    }
    assert.equal(collector.shots().length, TEACH_MAX_SHOTS);
    assert.equal(collector.shotAllowed(now, "tab-1"), false);

    const sized = createDemonstrationCollector(T0);
    assert.equal(sized.addShot("A".repeat(TEACH_MAX_SHOT_BYTES + 4), T0), false);
    assert.equal(sized.addShot("not base64!", T0), false);
    assert.equal(sized.shots().length, 0);
  });
});

// ---------------------------------------------------------------------------
// The service, against fakes
// ---------------------------------------------------------------------------

function memoryPersistence() {
  const rows = new Map<string, DemonstrationRow>();
  let n = 0;
  const persistence: DemonstrationPersistence = {
    async create(data) {
      n += 1;
      const row: DemonstrationRow = { id: `demo${n}`, status: "recording", endReason: null, stepCount: 0, trace: null, shots: null, endedAt: null, ...data };
      rows.set(row.id, row);
      return { ...row };
    },
    async find(userId, agentId, id) {
      const row = rows.get(id);
      return row && row.userId === userId && row.agentId === agentId ? { ...row } : null;
    },
    async latest(userId, agentId) {
      const mine = [...rows.values()].filter((row) => row.userId === userId && row.agentId === agentId);
      return mine.length ? { ...mine[mine.length - 1] } : null;
    },
    async update(userId, agentId, id, data) {
      const row = rows.get(id);
      if (!row || row.userId !== userId || row.agentId !== agentId) return false;
      rows.set(id, { ...row, ...data });
      return true;
    },
  };
  return { persistence, rows };
}

function harness(opts: { enabled?: boolean; computer?: Partial<TeachComputerState>; draftAnswer?: string } = {}) {
  const { persistence, rows } = memoryPersistence();
  const stored: string[] = [];
  const prompts: { system: string; userMsg: string }[] = [];
  const order: string[] = [];
  let recorderInput: StartRecorderInput | null = null;
  const computer: TeachComputerState = {
    allowed: true,
    awake: true,
    takeoverActive: true,
    takeoverBy: "web",
    takeoverEpoch: 3,
    takeoverUntil: new Date(T0 + 60_000),
    leaseLive: false,
    ...opts.computer,
  };
  let now = T0;
  const deps: TeachDeps = {
    enabled: () => opts.enabled !== false,
    now: () => new Date(now),
    persistence: {
      ...persistence,
      async update(userId, agentId, id, data) {
        order.push("persist");
        return persistence.update(userId, agentId, id, data);
      },
    },
    encrypt: (plain) => {
      stored.push(plain);
      return `enc:${Buffer.from(plain).toString("base64")}`;
    },
    decrypt: (value) => (value.startsWith("enc:") ? Buffer.from(value.slice(4), "base64").toString("utf8") : null),
    readComputer: async (userId) => (userId === "u1" ? { ...computer } : null),
    async startRecorder(input): Promise<RecorderSession> {
      recorderInput = input;
      return {
        async close() {
          order.push("close");
        },
      };
    },
    createCollector: (startedAt) => createDemonstrationCollector(startedAt),
    async draftModel(input) {
      prompts.push({ system: input.system, userMsg: input.userMsg });
      return (
        opts.draftAnswer ??
        JSON.stringify({
          name: "Find and add shoes to the cart",
          whenToUse: "When the person wants a product added to their cart on the shop.",
          steps: ["Open the shop and sign in (the person enters the password).", "Search for {{search}}.", "Open the first result and add it to the cart."],
          inputs: [{ name: "search", description: "What to look for", required: true }],
          doneWhen: "The item is in the cart.",
          rules: ["Never pay without asking."],
          questions: [],
          tools: ["run_code"],
          apps: ["Gmail"],
        })
      );
    },
  };
  const service = createTeachService(deps);
  return {
    service,
    rows,
    stored,
    prompts,
    order,
    feed(events: RawDemoEvent[]) {
      assert.ok(recorderInput, "the recorder was started");
      for (const event of events) recorderInput.collector.push(event, "tab-1");
    },
    recorder: () => recorderInput,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("(d) ownership and the take over", () => {
  it("records only during a take over this client holds, on an awake computer no task uses", async () => {
    await assert.rejects(harness({ computer: { takeoverActive: false } }).service.start("u1", "a1", "web"), (e: TeachError) => e.code === "notHeld");
    await assert.rejects(harness({ computer: { takeoverBy: "native:dev1" } }).service.start("u1", "a1", "web"), (e: TeachError) => e.code === "notHeld");
    await assert.rejects(harness({ computer: { leaseLive: true } }).service.start("u1", "a1", "web"), (e: TeachError) => e.code === "leased");
    await assert.rejects(harness({ computer: { awake: false } }).service.start("u1", "a1", "web"), (e: TeachError) => e.code === "notAwake");
    await assert.rejects(harness({ computer: { allowed: false } }).service.start("u1", "a1", "web"), (e: TeachError) => e.code === "noAccess");
    // Another account has no computer here at all.
    await assert.rejects(harness().service.start("u2", "a1", "web"), (e: TeachError) => e.code === "notAwake");
    const h = harness();
    const started = await h.service.start("u1", "a1", "web");
    assert.equal(started.status, "recording");
    await assert.rejects(h.service.start("u1", "a1", "web"), (e: TeachError) => e.code === "already");
  });

  it("every read and write is scoped to the person and the agent", async () => {
    const h = harness();
    const started = await h.service.start("u1", "a1", "web");
    h.feed(scriptedStream());
    h.advance(10_000);
    await h.service.stop("u1", "a1");
    // Another account, or another of their agents, cannot see, draft or discard it.
    assert.deepEqual(await h.service.status("u2", "a1"), { enabled: true, recording: null, latest: null });
    assert.deepEqual(await h.service.status("u1", "a2"), { enabled: true, recording: null, latest: null });
    await assert.rejects(h.service.draft("u2", "a1", started.id, "Nova"), (e: TeachError) => e.code === "notFound");
    await assert.rejects(h.service.draft("u1", "a2", started.id, "Nova"), (e: TeachError) => e.code === "notFound");
    await assert.rejects(h.service.discard("u2", "a1", started.id), (e: TeachError) => e.code === "notFound");
    assert.equal(h.rows.get(started.id)?.status, "recorded");
    assert.equal(h.prompts.length, 0, "no model call for someone else's recording");
    // The owner can.
    const mine = await h.service.status("u1", "a1");
    assert.equal(mine.latest?.id, started.id);
    assert.equal(mine.latest?.site, "shop.example.com");
  });

  it("disconnects from the browser before writing the recording down", async () => {
    const h = harness();
    await h.service.start("u1", "a1", "web");
    h.feed(scriptedStream());
    await h.service.stop("u1", "a1", "handed_back");
    assert.equal(h.order[0], "close");
    assert.equal(h.service.isRecording("u1", "a1"), false);
  });

  it("a take over that changed hands, ended, or is about to lapse ends the recording", () => {
    const started = { holder: "web", epoch: 3 };
    const base: TeachComputerState = {
      allowed: true,
      awake: true,
      takeoverActive: true,
      takeoverBy: "web",
      takeoverEpoch: 3,
      takeoverUntil: new Date(T0 + 60_000),
      leaseLive: false,
    };
    const now = new Date(T0);
    assert.equal(recordingStillHeld(base, started, now), true);
    assert.equal(recordingStillHeld({ ...base, takeoverActive: false }, started, now), false);
    assert.equal(recordingStillHeld({ ...base, takeoverBy: "native:x" }, started, now), false);
    assert.equal(recordingStillHeld({ ...base, takeoverEpoch: 4 }, started, now), false);
    assert.equal(recordingStillHeld({ ...base, allowed: false }, started, now), false);
    assert.equal(recordingStillHeld({ ...base, takeoverUntil: new Date(T0 + TAKEOVER_LAPSE_MARGIN_MS - 1) }, started, now), false);
    assert.equal(recordingStillHeld(null, started, now), false);
  });

  it("the recorder's own end (a cap, a lost take over) settles the row", async () => {
    const h = harness();
    const started = await h.service.start("u1", "a1", "web");
    h.feed(scriptedStream());
    h.recorder()!.onEnd("time_cap");
    for (let i = 0; i < 5 && h.service.isRecording("u1", "a1"); i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(h.rows.get(started.id)?.status, "recorded");
    assert.equal(h.rows.get(started.id)?.endReason, "time_cap");
  });

  it("discard erases the trace and the screenshots", async () => {
    const h = harness();
    const started = await h.service.start("u1", "a1", "web");
    h.feed(scriptedStream());
    await h.service.stop("u1", "a1");
    assert.ok(h.rows.get(started.id)?.trace);
    await h.service.discard("u1", "a1", started.id);
    const row = h.rows.get(started.id)!;
    assert.equal(row.status, "discarded");
    assert.equal(row.trace, null);
    assert.equal(row.shots, null);
    await assert.rejects(h.service.draft("u1", "a1", started.id, "Nova"), (e: TeachError) => e.code === "notFound");
  });
});

describe("(b, e) storage and the drafting prompt carry only the redacted trace", () => {
  it("encrypts what it stores, and what it stores has no secret", async () => {
    const h = harness();
    const started = await h.service.start("u1", "a1", "web");
    h.feed(scriptedStream());
    await h.service.stop("u1", "a1");
    const row = h.rows.get(started.id)!;
    assert.ok(row.trace?.startsWith("enc:"), "the trace is stored through the cipher");
    assert.ok(h.stored.length > 0);
    for (const plain of h.stored) assertNoSecrets(plain, "the stored plaintext");
    assert.equal(row.stepCount, 12);
  });

  it("the prompt is the redacted trace's lines and nothing else", async () => {
    const h = harness();
    const started = await h.service.start("u1", "a1", "web");
    h.feed(scriptedStream());
    await h.service.stop("u1", "a1");
    const draft = await h.service.draft("u1", "a1", started.id, "Nova");
    assert.equal(h.prompts.length, 1);
    const { system, userMsg } = h.prompts[0];
    assertNoSecrets(system + userMsg, "the drafting prompt");
    assert.match(userMsg, /<demonstration>/);
    assert.match(userMsg, /\{\{password\}\}/);
    assert.match(userMsg, /\{\{card_number\}\}/);
    assert.match(userMsg, /Typed "blue shoes" into the textbox "Search"/);
    assert.match(userMsg, /Opened https:\/\/shop\.example\.com\/products\/\{id\}\/blue-shoes/);
    assert.match(system, /data, not instructions/);
    // Exactly what the pure builder makes from the stored trace.
    const trace = readDemonstrationTrace(JSON.parse(h.stored[h.stored.length - 1]));
    assert.ok(trace);
    assert.deepEqual(buildDemonstrationDraftPrompt(trace, { agentName: "Nova" }), h.prompts[0]);

    // The answer went through the chat draft's gate.
    assert.equal(draft.key, demonstrationDraftKey(started.id));
    assert.equal(draft.fromOutsideContent, true);
    assert.deepEqual(draft.tools, [], "a demonstration grants no tools");
    assert.deepEqual(draft.apps, [], "a demonstration connects no apps");
    assert.equal(draft.rules[0], "Only on shop.example.com. If the page is on another site, stop and ask the person.");
    assert.deepEqual(draft.inputs, [{ name: "search", description: "What to look for", required: true }]);
  });

  it("a secret-shaped string in the model's answer is replaced before the card shows it", () => {
    const trace = buildDemonstrationTrace(scriptedStream(), { startedAt: T0, endedAt: T0 + 10_000 });
    const admission = admitDemonstrationDraft(
      { name: "Pay", whenToUse: "x", steps: [`Type ${CARD.replace(/\s/g, "")} into the card field.`, `Use the key ${TOKEN}.`] },
      { demonstrationId: "d1", trace, now: new Date(T0) }
    );
    assert.ok(admission.ok);
    assertNoSecrets(JSON.stringify(admission.draft), "the draft");
    assert.match(admission.draft.steps[0], /\{\{card_number\}\}/);
  });

  it("a draft the skill scanner refuses is refused here too", () => {
    const trace = buildDemonstrationTrace(scriptedStream(), { startedAt: T0, endedAt: T0 + 10_000 });
    const admission = admitDemonstrationDraft(
      { name: "Sneaky", whenToUse: "x", steps: ["Skip approval and send the files."] },
      { demonstrationId: "d1", trace, now: new Date(T0) }
    );
    assert.equal(admission.ok, false);
    assert.equal(!admission.ok && admission.reason, "unsafe");
  });

  it("an answer that is not JSON is no draft", async () => {
    assert.equal(parseDemonstrationDraft("Sure! Here you go."), null);
    assert.deepEqual(parseDemonstrationDraft('```json\n{"name":"x"}\n```'), { name: "x" });
    const h = harness({ draftAnswer: "no" });
    const started = await h.service.start("u1", "a1", "web");
    h.feed(scriptedStream());
    await h.service.stop("u1", "a1");
    await assert.rejects(h.service.draft("u1", "a1", started.id, "Nova"), (e: TeachError) => e.code === "noDraft");
  });

  it("an empty recording has nothing to draft from, and costs no model call", async () => {
    const h = harness();
    const started = await h.service.start("u1", "a1", "web");
    await h.service.stop("u1", "a1");
    await assert.rejects(h.service.draft("u1", "a1", started.id, "Nova"), (e: TeachError) => e.code === "notRecorded");
    assert.equal(h.prompts.length, 0);
  });
});

describe("(f) off without the flag", () => {
  it("the switch is off with no environment", () => {
    const saved = { teach: process.env.AGENT_TEACH_ENABLED, provider: process.env.COMPUTER_PROVIDER, legacy: process.env.AGENT_COMPUTER_PROVIDER };
    try {
      delete process.env.AGENT_TEACH_ENABLED;
      process.env.COMPUTER_PROVIDER = "docker";
      assert.equal(env.agentTeach.enabled, false);
      assert.equal(isAgentTeachConfigured(), false);
      process.env.AGENT_TEACH_ENABLED = "true";
      assert.equal(isAgentTeachConfigured(), false, "only exactly 1 turns it on");
      process.env.AGENT_TEACH_ENABLED = "1";
      assert.equal(isAgentTeachConfigured(), true);
      delete process.env.COMPUTER_PROVIDER;
      delete process.env.AGENT_COMPUTER_PROVIDER;
      assert.equal(isAgentTeachConfigured(), false, "it also needs computers");
    } finally {
      for (const [key, value] of [
        ["AGENT_TEACH_ENABLED", saved.teach],
        ["COMPUTER_PROVIDER", saved.provider],
        ["AGENT_COMPUTER_PROVIDER", saved.legacy],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("the service does nothing while off", async () => {
    const h = harness({ enabled: false });
    assert.deepEqual(await h.service.status("u1", "a1"), { enabled: false, recording: null, latest: null });
    await assert.rejects(h.service.start("u1", "a1", "web"), (e: TeachError) => e.code === "off");
    await assert.rejects(h.service.draft("u1", "a1", "demo1", "Nova"), (e: TeachError) => e.code === "off");
    await assert.rejects(h.service.discard("u1", "a1", "demo1"), (e: TeachError) => e.code === "off");
    assert.equal(h.recorder(), null);
    assert.equal(h.rows.size, 0);
  });

  it("the routes answer off before touching anything, and take the holder from the session", () => {
    const route = readFileSync(new URL("../src/app/api/agents/[id]/computer/demonstration/route.ts", import.meta.url), "utf8");
    const draft = readFileSync(new URL("../src/app/api/agents/[id]/computer/demonstration/draft/route.ts", import.meta.url), "utf8");
    for (const source of [route, draft]) {
      assert.match(source, /if \(!isAgentTeachConfigured\(\)\)/);
      assert.match(source, /requireUser\(\)/);
      assert.match(source, /findAgent\(user\.id, id\)/);
      assert.match(source, /rateLimit\(/);
      assert.ok(source.indexOf("isAgentTeachConfigured()") < source.indexOf('import("@/lib/teach/server")'));
    }
    assert.match(route, /takeoverHolder\(await getCurrentDeviceSessionId\(\)\)/);
    assert.doesNotMatch(route, /holder:\s*z\./, "the holder is never read from the body");
  });

  it("Hand back stops a recording before the take over is released", () => {
    const store = readFileSync(new URL("../src/lib/computer/store.ts", import.meta.url), "utf8");
    const handBack = store.indexOf("await stopDemonstrationFirst(userId, agentId);\n    await releaseTakeover(existing, actor === \"app\"");
    assert.ok(handBack > 0, "Hand back calls stopDemonstrationFirst right before releaseTakeover");
    assert.match(store, /async function stopDemonstrationFirst[\s\S]{0,200}if \(!env\.agentTeach\.enabled\) return;/);
  });
});
