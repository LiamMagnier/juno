import { ALEVR_CHUNK, ALEVR_REQUEST, ALEVR_RESPONSE } from "@/lib/artifact-ai/protocol";

/**
 * The frame's half of `window.alevr` (src/lib/artifact-ai/protocol.ts).
 *
 * Injected into every runnable HTML and React preview, directly after the
 * policy meta so it exists before any script the author put in the head. It
 * holds no credential and can reach nothing but its parent: each call is a
 * `postMessage` to `window.parent` carrying this frame's CHANNEL, and an answer
 * is accepted only from `window.parent`, on the same channel, for a call this
 * script made. The parent (src/lib/artifact-ai/bridge-host.ts) does the
 * request with the page's own session and posts the result back.
 *
 * The channel is minted by the parent for its frame and written only into this
 * script. A document the preview navigates to never sees it, so the parent
 * drops whatever such a page posts (`parseBridgeRequest` answers nothing on a
 * wrong channel): the bridge spends only for the document it was given.
 *
 * `window.alevr` is defined non-writable and frozen, so artifact code cannot
 * swap the storage object for one that reports success without saving.
 */
export function alevrBridgeScript(channel: string): string {
  // `<` escaped so nothing in the channel can end the script element.
  const ch = JSON.stringify(channel).replace(/</g, "\\u003c");
  return `<script>
(function(){
  if (window.alevr) return;
  var CHANNEL = ${ch}, REQ = ${JSON.stringify(ALEVR_REQUEST)}, RES = ${JSON.stringify(ALEVR_RESPONSE)}, CHUNK = ${JSON.stringify(ALEVR_CHUNK)};
  var seq = 0, pending = Object.create(null);
  function fail(code, message){ var e = new Error(message); e.code = code; e.name = 'AlevrError'; return e; }
  function post(message){ parent.postMessage(message, '*'); }
  function cancel(id){
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    try { post({ type: REQ, channel: CHANNEL, id: id + ':cancel', method: 'cancel', params: { id: id } }); } catch (e) {}
    p.reject(fail('aborted', 'The request was cancelled.'));
  }
  function send(method, params, extra){
    return new Promise(function(resolve, reject){
      var id = 'r' + (++seq) + '-' + Math.random().toString(36).slice(2, 10);
      pending[id] = { resolve: resolve, reject: reject, onText: extra && extra.onText };
      try { post({ type: REQ, channel: CHANNEL, id: id, method: method, params: params }); }
      catch (err) {
        delete pending[id];
        reject(fail('invalid_request', 'This value cannot be sent: ' + (err && err.message ? err.message : String(err))));
        return;
      }
      var signal = extra && extra.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) cancel(id);
        else signal.addEventListener('abort', function(){ cancel(id); }, { once: true });
      }
    });
  }
  window.addEventListener('message', function(e){
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.channel !== CHANNEL || typeof d.id !== 'string') return;
    var p = pending[d.id];
    if (!p) return;
    if (d.type === CHUNK) {
      if (p.onText && typeof d.text === 'string') { try { p.onText(d.text); } catch (err) { console.error(err); } }
      return;
    }
    if (d.type !== RES) return;
    delete pending[d.id];
    if (d.ok === true) { p.resolve(d.result); return; }
    var err = d.error && typeof d.error === 'object' ? d.error : {};
    p.reject(fail(typeof err.code === 'string' ? err.code : 'failed', typeof err.message === 'string' ? err.message : 'The request failed.'));
  });
  function options(input){ return typeof input === 'string' ? { prompt: input } : (input && typeof input === 'object' ? input : {}); }
  function complete(input){
    var o = options(input);
    var streaming = typeof o.onText === 'function';
    return send('complete', { prompt: o.prompt, system: o.system, maxTokens: o.maxTokens, stream: streaming }, { onText: o.onText, signal: o.signal });
  }
  async function* stream(input){
    var o = options(input), queue = [], wake = null, finished = false, failure = null;
    function nudge(){ if (wake) { var w = wake; wake = null; w(); } }
    complete({ prompt: o.prompt, system: o.system, maxTokens: o.maxTokens, signal: o.signal, onText: function(t){ queue.push(t); nudge(); } })
      .then(function(){ finished = true; nudge(); }, function(err){ failure = err; finished = true; nudge(); });
    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (finished) { if (failure) throw failure; return; }
      await new Promise(function(r){ wake = r; });
    }
  }
  var storage = Object.freeze({
    get: function(key){ return send('storage.get', { key: key }); },
    set: function(key, value){ return send('storage.set', { key: key, value: value }).then(function(){}); },
    delete: function(key){ return send('storage.delete', { key: key }); },
    list: function(prefix){ return send('storage.list', { prefix: prefix == null ? '' : prefix }); }
  });
  try {
    Object.defineProperty(window, 'alevr', {
      value: Object.freeze({ complete: complete, stream: stream, storage: storage }),
      enumerable: true, configurable: false, writable: false
    });
  } catch (e) {}
})();
</${"script"}>`;
}
