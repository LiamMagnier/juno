/**
 * The workflow guest: the program that runs a model-written workflow script.
 *
 * It is plain JavaScript in a string so the host can start it with
 * `node --permission -e <source>` — no file to find in a bundled build, and a
 * process the permission model denies every filesystem read and write, every
 * child process and every worker. Inside that process the script runs in a
 * `vm` context with string code generation and WebAssembly disabled, whose
 * only globals are the workflow hooks. The hooks are created inside the
 * context (so nothing the script can reach leads back to the host realm's
 * Function constructor) and talk to this process through one closure-held
 * bridge that passes strings only.
 *
 * Wire (newline-delimited JSON on stdio):
 *   host → guest  {type:'init', meta, body, args, limits}
 *                 {type:'agent_result', callId, ok, value?, error?, fatal?}
 *   guest → host  {type:'agent', callId, prompt, opts}
 *                 {type:'phase', title} · {type:'log', message}
 *                 {type:'done', ok, value?, error?}
 *
 * The hook semantics follow DeepSeek Harness's workflow-ptc runtime (MIT):
 * `parallel` and `pipeline` turn an ordinary failure into a per-item null and
 * let a fatal one (budget, agent cap, a stopped run) end the script.
 */

export const WORKFLOW_GUEST_SOURCE = String.raw`
'use strict';
const vm = require('node:vm');
const readline = require('node:readline');

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const pending = new Map();
let nextCall = 0;
let started = false;

// Realm-side hooks. Everything the script touches is created in its own
// context; the bridge is a closure variable it cannot name.
const SHIM = '(' + function (bridge, argsJson) {
  'use strict';
  const fatal = new WeakSet();
  const call = (kind, payload) => new Promise((resolve, reject) => {
    bridge(kind, JSON.stringify(payload === undefined ? null : payload), (replyJson) => {
      const reply = JSON.parse(replyJson);
      if (reply.ok) { resolve(reply.value); return; }
      const error = new Error(reply.error || 'agent failed');
      if (reply.fatal) fatal.add(error);
      reject(error);
    });
  });
  const isFatal = (error) => typeof error === 'object' && error !== null && fatal.has(error);
  const agent = (prompt, opts) => {
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return Promise.reject(new TypeError('agent() needs a non-empty prompt string'));
    }
    return call('agent', { prompt, opts: opts === undefined ? null : opts });
  };
  const parallel = async (thunks) => {
    if (!Array.isArray(thunks)) throw new TypeError('parallel() takes an array of functions');
    return Promise.all(thunks.map(async (thunk, index) => {
      if (typeof thunk !== 'function') throw new TypeError('parallel() item ' + index + ' is not a function');
      try { return await thunk(); } catch (error) { if (isFatal(error)) throw error; return null; }
    }));
  };
  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new TypeError('pipeline() takes an items array');
    if (stages.length === 0) throw new TypeError('pipeline() needs at least one stage');
    stages.forEach((stage, index) => { if (typeof stage !== 'function') throw new TypeError('pipeline() stage ' + index + ' is not a function'); });
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      try {
        for (const stage of stages) value = await stage(value, item, index);
        return value;
      } catch (error) { if (isFatal(error)) throw error; return null; }
    }));
  };
  const phase = (title) => {
    if (typeof title !== 'string' || title.length === 0) throw new TypeError('phase() needs a title');
    bridge('phase', JSON.stringify(title), () => {});
  };
  const log = (message) => { bridge('log', JSON.stringify(String(message)), () => {}); };
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, enumerable: false, configurable: false, writable: false });
  define('agent', agent);
  define('parallel', parallel);
  define('pipeline', pipeline);
  define('phase', phase);
  define('log', log);
  define('args', argsJson === undefined ? undefined : JSON.parse(argsJson));
  // The host gets back one function: settle the script's promise as a string.
  return (promise, done) => {
    Promise.resolve(promise).then(
      (value) => {
        let json;
        try { json = JSON.stringify({ ok: true, value: value === undefined ? null : value }); }
        catch (error) { json = JSON.stringify({ ok: false, error: 'the workflow returned a value that is not plain JSON: ' + String(error && error.message || error) }); }
        done(json);
      },
      (error) => {
        let text;
        try { text = String(error && (error.stack || error.message) || error); } catch (_) { text = 'the workflow threw an unreadable value'; }
        done(JSON.stringify({ ok: false, error: text, fatal: isFatal(error) }));
      },
    );
  };
}.toString() + ')';

function bridge(kind, payloadJson, reply) {
  // Host realm: never hand the script an object, only strings — and never let
  // a host error propagate into the context, where its constructor would be
  // the host's Function.
  try { bridgeUnsafe(kind, payloadJson, reply); } catch (_) { /* swallowed on purpose */ }
}

function bridgeUnsafe(kind, payloadJson, reply) {
  let payload;
  try { payload = JSON.parse(String(payloadJson)); } catch (_) { payload = null; }
  if (kind === 'phase') { write({ type: 'phase', title: String(payload) }); return; }
  if (kind === 'log') { write({ type: 'log', message: String(payload).slice(0, 4000) }); return; }
  if (kind === 'agent') {
    const callId = 'c' + (++nextCall);
    pending.set(callId, (message) => reply(JSON.stringify({ ok: !!message.ok, value: message.value === undefined ? null : message.value, error: message.error, fatal: !!message.fatal })));
    write({ type: 'agent', callId, prompt: String(payload && payload.prompt || ''), opts: payload && payload.opts });
    return;
  }
  reply(JSON.stringify({ ok: false, error: 'unknown hook ' + String(kind), fatal: true }));
}

function start(init) {
  const context = vm.createContext(Object.create(null), {
    name: 'workflow:' + String(init.meta && init.meta.name || 'script'),
    codeGeneration: { strings: false, wasm: false },
  });
  let settle;
  try {
    const shim = new vm.Script(SHIM, { filename: 'alevr-workflow-hooks' }).runInContext(context);
    settle = shim(bridge, init.args === undefined ? undefined : JSON.stringify(init.args));
  } catch (error) {
    write({ type: 'done', ok: false, error: 'workflow hooks failed to load: ' + String(error && error.message || error) });
    return;
  }
  let script;
  try {
    script = new vm.Script('(async () => {\n' + String(init.body) + '\n})()', { filename: 'workflow:' + String(init.meta && init.meta.name || 'script'), lineOffset: -1 });
  } catch (error) {
    write({ type: 'done', ok: false, error: 'the workflow script does not parse: ' + String(error && error.message || error) });
    return;
  }
  let promise;
  try {
    promise = script.runInContext(context, { timeout: Number(init.limits && init.limits.syncTimeoutMs) || 2000 });
  } catch (error) {
    write({ type: 'done', ok: false, error: String(error && error.message || error) });
    return;
  }
  settle(promise, (json) => {
    // Called from inside the context: nothing thrown here may reach it.
    try {
      const result = JSON.parse(String(json));
      write({ type: 'done', ok: !!result.ok, value: result.value, error: result.error });
    } catch (_) {
      try { write({ type: 'done', ok: false, error: 'the workflow result could not be read' }); } catch (__) { /* stdout gone */ }
    }
  });
}

// Nothing the script could use to reach out is left on this process's global.
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers']) {
  try { delete globalThis[name]; } catch (_) { /* not deletable */ }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  if (message.type === 'init' && !started) { started = true; start(message); return; }
  if (message.type === 'agent_result') {
    const resolve = pending.get(message.callId);
    if (resolve) { pending.delete(message.callId); resolve(message); }
  }
});
`;
