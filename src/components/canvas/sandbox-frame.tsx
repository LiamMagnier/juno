"use client";

import * as React from "react";
import type { ArtifactType } from "@/lib/message-content";
import { runtimeFor, type RunMode } from "@/lib/artifact-runtime";
import { SANDBOX_FLAGS, sandboxPolicyMeta, type SandboxProfile } from "@/lib/sandbox-policy";
import { SandboxDocumentFrame, useSandboxProfile } from "@/components/canvas/sandbox-document-frame";
import { designPosterUrl } from "@/lib/design/poster-url";
import {
  BABEL_CDN,
  CONSOLE_SIZE_MESSAGE,
  SANDBOX_SHIM,
  consoleDoc,
  esc,
  escapeHtml,
  stripImports,
  type ConsoleAppearance,
} from "@/lib/sandbox/console-doc";

export { CONSOLE_SIZE_MESSAGE, type ConsoleAppearance };

const TAILWIND_CDN = "https://cdn.tailwindcss.com";
const REACT_CDN = "https://unpkg.com/react@18.3.1/umd/react.development.js";
const REACT_DOM_CDN = "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js";
const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

/*
 * ── WHAT ISOLATES A PREVIEW, AND WHERE ITS POLICY COMES FROM ────────────────
 *
 * The isolation is the iframe: `sandbox` WITHOUT `allow-same-origin`, so the
 * document has an opaque origin and artifact code can never read the app's
 * cookies, storage, DOM or session.
 *
 * The frame is NOT a srcdoc frame any more. A srcdoc document inherits the
 * embedding page's Content-Security-Policy, and the app's enforcing nonce policy
 * blocked every inline script in every preview for a month (audit X-01). The
 * documents built here are handed to a shell served from its own URL with its
 * own policy — `SandboxDocumentFrame` and src/lib/sandbox-policy.ts, which also
 * holds the egress allowlists and the two profiles (your own previews,
 * `private`; a public share, `public`).
 *
 * Each document also carries that same policy as a `<meta>`, generated from
 * the same directives, so a document shown some other way is no less
 * contained. Three things about it were each once a visible breakage:
 *
 *   1. `script-src` has `'unsafe-eval'`: `reactDoc` compiles with Babel and runs
 *      the output through `eval`. Without it every React artifact rendered a
 *      "Refused to evaluate a string as JavaScript" error box.
 *   2. Code, styles and fonts come from an allowlist of public CDNs broad
 *      enough for what generated pages name (GSAP, AOS, Swiper, three.js,
 *      Chart.js, Alpine, webfonts) — a list of three hosts once meant "it
 *      doesn't load and it doesn't move".
 *   3. The meta goes FIRST in the head (`insertPolicy`), so nothing the author
 *      put in the head loads before it.
 */

/**
 * The iframe's capability list for your own previews. The public profile is
 * narrower (SANDBOX_FLAGS in src/lib/sandbox-policy.ts, which explains each
 * flag). `allow-same-origin` is absent from both and must stay absent.
 */
export const SANDBOX_ALLOW = SANDBOX_FLAGS.private;


const BASE_STYLE = `<style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#111}</style>`;


function firstComponentName(code: string): string | null {
  const exportMatch = code.match(/\bexport\s+default\s+(?:function|class)\s+([A-Z][A-Za-z0-9_$]*)\b/);
  if (exportMatch) return exportMatch[1];
  const declarationMatch = code.match(/(?:^|[\r\n;])\s*(?:function|class)\s+([A-Z][A-Za-z0-9_$]*)\b/);
  if (declarationMatch) return declarationMatch[1];
  const assignmentMatch = code.match(/(?:^|[\r\n;])\s*(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/);
  if (assignmentMatch) return assignmentMatch[1];
  return null;
}

function lucideIconBindings(code: string): { local: string; icon: string; namespace?: boolean }[] {
  const bindings = new Map<string, { local: string; icon: string; namespace?: boolean }>();
  const importRe = /^[ \t]*import\b[\s\S]*?(?:from[ \t]*['"][^'"]*['"]|['"][^'"]*['"])[ \t]*;?[ \t]*\r?\n?/gm;
  for (const match of code.matchAll(importRe)) {
    const stmt = match[0];
    if (!/from[ \t]*['"]lucide-react['"]|['"]lucide-react['"]/.test(stmt)) continue;
    const namespace = stmt.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) {
      const local = namespace[1];
      bindings.set(local, { local, icon: local, namespace: true });
    }

    const named = stmt.match(/\{([\s\S]*?)\}/);
    if (!named) continue;
    for (const raw of named[1].split(",")) {
      const spec = raw.trim().replace(/^type\s+/, "");
      if (!spec) continue;
      const parts = spec.split(/\s+as\s+/i).map((p) => p.trim());
      const icon = parts[0];
      const local = parts[1] || icon;
      if (/^[A-Z_$][\w$]*$/.test(local) && local !== "LucideIcon") bindings.set(local, { local, icon });
    }
  }
  return [...bindings.values()];
}

function lucideIconPreamble(code: string): string {
  const iconBindings = lucideIconBindings(code);
  if (iconBindings.length === 0) return "";
  const bindings = iconBindings
    .map((binding) =>
      binding.namespace
        ? `const ${binding.local} = new Proxy({}, { get: function(_, iconName){ return __JunoLucideIconFactory(String(iconName)); } });`
        : `const ${binding.local} = __JunoLucideIconFactory(${JSON.stringify(binding.icon)});`
    )
    .join("\n");

  return `
var __JunoLucideShapes = {
  ArrowRight:[['path',{d:'M5 12h14'}],['path',{d:'m13 6 6 6-6 6'}]],
  Check:[['path',{d:'m5 12 4 4L19 6'}]],
  Code:[['path',{d:'m16 18 6-6-6-6'}],['path',{d:'M8 6 2 12l6 6'}]],
  Copy:[['rect',{x:9,y:9,width:11,height:11,rx:2}],['path',{d:'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'}]],
  Cpu:[['rect',{x:5,y:5,width:14,height:14,rx:2}],['path',{d:'M9 9h6v6H9z'}],['path',{d:'M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4'}]],
  Database:[['ellipse',{cx:12,cy:5,rx:8,ry:3}],['path',{d:'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5'}],['path',{d:'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'}]],
  ExternalLink:[['path',{d:'M15 3h6v6'}],['path',{d:'M10 14 21 3'}],['path',{d:'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'}]],
  FolderGit2:[['path',{d:'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'}],['circle',{cx:12,cy:13,r:1}],['path',{d:'M12 14v3M12 10V8'}]],
  Github:[['path',{d:'M15 22v-3a3 3 0 0 0-1-2c3-.3 6-1.5 6-6a5 5 0 0 0-1.4-3.7 4.5 4.5 0 0 0-.1-3.3s-1.1-.3-3.5 1.3a12 12 0 0 0-6 0C6.6 3.7 5.5 4 5.5 4a4.5 4.5 0 0 0-.1 3.3A5 5 0 0 0 4 11c0 4.5 3 5.7 6 6a3 3 0 0 0-1 2v3'}],['path',{d:'M9 19c-3 1-5-1-6-3'}]],
  GraduationCap:[['path',{d:'m22 10-10-5-10 5 10 5 10-5z'}],['path',{d:'M6 12v5c3 2 9 2 12 0v-5'}]],
  Layers:[['path',{d:'m12 2 10 5-10 5L2 7l10-5z'}],['path',{d:'m2 17 10 5 10-5'}],['path',{d:'m2 12 10 5 10-5'}]],
  Linkedin:[['path',{d:'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z'}],['rect',{x:2,y:9,width:4,height:12}],['circle',{cx:4,cy:4,r:2}]],
  Mail:[['rect',{x:3,y:5,width:18,height:14,rx:2}],['path',{d:'m3 7 9 6 9-6'}]],
  Phone:[['path',{d:'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9z'}]],
  Server:[['rect',{x:3,y:4,width:18,height:8,rx:2}],['rect',{x:3,y:14,width:18,height:6,rx:2}],['path',{d:'M7 8h.01M7 17h.01'}]],
  Sparkles:[['path',{d:'M12 3 14 9l6 3-6 3-2 6-2-6-6-3 6-3 2-6z'}]],
  Terminal:[['path',{d:'m4 17 6-6-6-6'}],['path',{d:'M12 19h8'}]],
  default:[['circle',{cx:12,cy:12,r:8}],['path',{d:'M8 12h8'}],['path',{d:'M12 8v8'}]]
};
function __JunoLucideIconFactory(iconName){
  return function JunoLucideIcon(props){
    props = props || {};
    var size = props.size || props.width || props.height || 24;
    var attrs = {};
    Object.keys(props).forEach(function(k){
      if (k !== 'children' && k !== 'size' && k !== 'absoluteStrokeWidth' && k !== 'color') attrs[k] = props[k];
    });
    attrs.width = attrs.width || size;
    attrs.height = attrs.height || size;
    attrs.viewBox = attrs.viewBox || '0 0 24 24';
    attrs.fill = attrs.fill || 'none';
    attrs.stroke = attrs.stroke || props.color || 'currentColor';
    attrs.strokeWidth = attrs.strokeWidth || props.strokeWidth || 2;
    attrs.strokeLinecap = attrs.strokeLinecap || 'round';
    attrs.strokeLinejoin = attrs.strokeLinejoin || 'round';
    attrs['aria-hidden'] = attrs['aria-hidden'] || 'true';
    var shape = __JunoLucideShapes[iconName] || __JunoLucideShapes.default;
    return React.createElement('svg', attrs, shape.map(function(part, i){
      var partAttrs = Object.assign({ key: i }, part[1]);
      return React.createElement(part[0], partAttrs);
    }));
  };
}
${bindings}
`;
}


/**
 * Forwards the sandboxed page's console + uncaught errors to the parent
 * (canvas Console panel) as { type:"juno:console", level, text }. Injected into
 * every runnable web doc so a React/HTML artifact's logs are visible in-app.
 */
const CONSOLE_BRIDGE = `<script>
(function(){
  function ser(a){try{return typeof a==='string'?a:(a instanceof Error?(a.stack||a.message):JSON.stringify(a,null,2));}catch(e){return String(a);}}
  function send(level,args){try{parent.postMessage({type:'juno:console',level:level,text:Array.prototype.map.call(args,ser).join(' ')},'*');}catch(e){}}
  ['log','info','warn','error','debug'].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){send(k==='debug'?'log':k,arguments);o.apply(null,arguments);};});
  window.addEventListener('error',function(e){send('error',[e.message+(e.filename?' ('+e.lineno+':'+e.colno+')':'')]);});
  window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection: '+ser(e.reason)]);});
})();
</${"script"}>`;

/**
 * External links, handed to the parent.
 *
 * A link in a preview used to do nothing at all: the frame has no
 * `allow-popups`, and it cannot navigate itself to an http(s) URL either —
 * `frame-src` governs children, not self-navigation, and a top-level load
 * would replace the preview with somebody else's site inside our chrome. So a
 * click on an outward link was swallowed, which is a large part of why a
 * generated page reads as a picture of a website rather than one.
 *
 * It is handed up instead, and the parent opens a real tab. Only on a genuine
 * click — never programmatically — and only http(s), so the bridge cannot be
 * turned into a redirector for `javascript:` or `data:`.
 */
const LINK_BRIDGE = `<script>
(function(){
  document.addEventListener('click', function(e){
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^#/.test(href)) return;               // in-page anchor: the page handles it
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    e.preventDefault();
    try { parent.postMessage({ type: 'juno:open', url: url.href }, '*'); } catch (err) {}
  }, true);
})();
</${"script"}>`;

/**
 * Dormant element inspector, appended AFTER the artifact code so a broken
 * artifact can never prevent it from loading. Activated by the parent via
 * postMessage({ type: "juno:inspect", on }); reports clicks back with
 * { type: "juno:selected", selector, tag, snippet, text }. Hover highlighting
 * uses a fixed-position overlay box — element styles are never mutated.
 */
const INSPECTOR_SCRIPT = `<script>
(function () {
  var on = false, box = null, chip = null, cursor = null;
  function ensure() {
    if (box) return;
    box = document.createElement("div");
    box.setAttribute("data-juno-inspector", "");
    box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid rgba(82,110,240,0.95);background:rgba(82,110,240,0.14);border-radius:3px;box-sizing:border-box;display:none;";
    chip = document.createElement("div");
    chip.setAttribute("data-juno-inspector", "");
    chip.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;font:11px/1.5 ui-monospace,SFMono-Regular,monospace;background:rgba(24,24,28,0.92);color:#fff;padding:2px 7px;border-radius:5px;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;";
    document.body.appendChild(box);
    document.body.appendChild(chip);
  }
  function labelFor(el) {
    var t = el.tagName.toLowerCase();
    if (el.id) return t + "#" + el.id;
    var cls = typeof el.className === "string" ? el.className.trim() : "";
    return cls ? t + "." + cls.split(/\\s+/).slice(0, 2).join(".") : t;
  }
  function ignored(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el === document.body || el === document.documentElement) return true;
    if (el.hasAttribute && el.hasAttribute("data-juno-inspector")) return true;
    if (el.closest && el.closest("[data-juno-error]")) return true;
    return false;
  }
  function hide() {
    if (box) { box.style.display = "none"; chip.style.display = "none"; }
  }
  function move(e) {
    if (!on) return;
    var el = e.target;
    if (ignored(el)) { hide(); return; }
    ensure();
    var r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    chip.textContent = labelFor(el);
    chip.style.display = "block";
    var cy = r.top - 24;
    if (cy < 4) cy = Math.min(r.bottom + 4, window.innerHeight - 24);
    chip.style.top = cy + "px";
    chip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 60)) + "px";
  }
  function cssPath(el) {
    var esc = window.CSS && CSS.escape ? CSS.escape : function (s) { return s; };
    if (el.id) return "#" + esc(el.id);
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) { path.unshift("#" + esc(node.id)); break; }
      var seg = node.tagName.toLowerCase();
      var parentEl = node.parentElement;
      if (parentEl) {
        var same = [];
        for (var i = 0; i < parentEl.children.length; i++) {
          if (parentEl.children[i].tagName === node.tagName) same.push(parentEl.children[i]);
        }
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      path.unshift(seg);
      try { if (document.querySelectorAll(path.join(" > ")).length === 1) return path.join(" > "); } catch (err) {}
      node = parentEl;
    }
    return path.join(" > ") || el.tagName.toLowerCase();
  }
  function pick(e) {
    if (!on) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (ignored(el)) return;
    var html = el.outerHTML || "";
    var text = el.innerText || el.textContent || "";
    parent.postMessage({
      type: "juno:selected",
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      snippet: html.length > 800 ? html.slice(0, 800) + "\\u2026" : html,
      text: text.slice(0, 200)
    }, "*");
    set(false);
  }
  function key(e) {
    if (on && e.key === "Escape") {
      set(false);
      parent.postMessage({ type: "juno:inspect-off" }, "*");
    }
  }
  function set(v) {
    on = !!v;
    if (on) {
      ensure();
      if (!cursor) {
        cursor = document.createElement("style");
        cursor.textContent = "*{cursor:crosshair !important}";
      }
      document.head.appendChild(cursor);
    } else {
      if (cursor && cursor.parentNode) cursor.parentNode.removeChild(cursor);
      hide();
    }
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (d && d.type === "juno:inspect") set(!!d.on);
  });
  document.addEventListener("mousemove", move, true);
  document.addEventListener("click", pick, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("scroll", hide, true);
})();
</${"script"}>`;

/**
 * Minimal run-state reporter for documents with no runtime of their own
 * (HTML/SVG/CSS). Loading → done on load; an uncaught error BEFORE load counts
 * as a render failure, later errors are interaction noise and only hit the
 * console. React and console docs report their own richer status instead.
 */
const STATUS_LITE = `<script>
(function(){
  var failed=false;
  function post(s){try{parent.postMessage({type:'juno:status',status:s,detail:''},'*');}catch(e){}}
  post('loading');
  // ErrorEvent check: uncaught exceptions only. A capture listener would also
  // receive non-bubbling RESOURCE errors (a dead <img>, a 404'd CDN script) —
  // pages that render fine must not be reported as failed.
  window.addEventListener('error',function(e){
    if(e instanceof ErrorEvent && document.readyState!=='complete'){failed=true;post('error');}
  });
  window.addEventListener('load',function(){setTimeout(function(){if(!failed)post('done');},0);});
})();
</${"script"}>`;

/**
 * Where the policy goes, and why it is not where it was.
 *
 * A `<meta http-equiv>` policy applies from the point the parser reaches it,
 * so injecting it before `</head>` left everything the author had already put
 * in the head — stylesheets, fonts, CDN scripts — outside it, and held only
 * the body to account. It goes in FIRST now: directly after `<head>`, or after
 * the charset declaration when there is one, because that one is required to
 * fall inside the document's first 1024 bytes and this policy is ~450 of them.
 */
function insertPolicy(doc: string, profile: SandboxProfile): string {
  const meta = sandboxPolicyMeta(profile);
  const charset = doc.match(/<meta[^>]+charset[^>]*>/i);
  if (charset && charset.index !== undefined) {
    const at = charset.index + charset[0].length;
    return doc.slice(0, at) + meta + doc.slice(at);
  }
  const head = doc.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return doc.slice(0, at) + meta + doc.slice(at);
  }
  return meta + doc;
}

/** Inject the console bridge (early) + inspector (late) into a web document. */
function withChrome(doc: string, profile: SandboxProfile, statusLite = false): string {
  // Shim first (before console bridge), so storage/history are safe before any
  // artifact or bridge code runs.
  const chrome = SANDBOX_SHIM + (statusLite ? STATUS_LITE : "") + CONSOLE_BRIDGE + LINK_BRIDGE;
  const withPolicy = insertPolicy(doc, profile);
  const head = withPolicy.indexOf("</head>");
  const out =
    head !== -1
      ? withPolicy.slice(0, head) + chrome + withPolicy.slice(head)
      : chrome + withPolicy;
  const body = out.lastIndexOf("</body>");
  return body !== -1 ? out.slice(0, body) + INSPECTOR_SCRIPT + out.slice(body) : out + INSPECTOR_SCRIPT;
}

function reactDoc(code: string): string {
  // Normalize module syntax to browser-global assignments (no bundler here).
  const inferredComponent = firstComponentName(code);
  const cleaned = stripImports(code)
    .replace(/export\s+default\s+function/g, "window.__Component = function")
    .replace(/export\s+default\s+class/g, "window.__Component = class")
    .replace(/export\s+default\s+/g, "window.__Component = ")
    .replace(/^\s*export\s+(const|let|var|function|class)\s/gm, "$1 ");
  const inferredAssignment = inferredComponent
    ? `\ntry{ if (!window.__Component && typeof ${inferredComponent} === "function") window.__Component = ${inferredComponent}; }catch(e){}\n`
    : "";
  const preamble =
    "const {useState,useEffect,useRef,useMemo,useCallback,useReducer,useContext,useLayoutEffect,createContext,Fragment,forwardRef,memo}=React;\n" +
    lucideIconPreamble(code);

  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<script src="${TAILWIND_CDN}"></script>
<script src="${REACT_CDN}"></script>
<script src="${REACT_DOM_CDN}"></script>
<script src="${BABEL_CDN}"></script>
${BASE_STYLE}</head>
<body><div id="root"></div>
<script type="text/plain" id="__src">${esc(preamble + cleaned + inferredAssignment)}</${"script"}>
<script>
(function(){
  var root = document.getElementById('root');
  function status(s,detail){try{parent.postMessage({type:'juno:status',status:s,detail:detail||''},'*');}catch(e){}}
  function text(e){
    var msg = e && e.message ? String(e.message) : '';
    var stack = e && e.stack ? String(e.stack) : '';
    if (msg && stack && stack.indexOf(msg) === -1) return msg + "\\n" + stack;
    return stack || msg || String(e);
  }
  function fail(msg){ root.innerHTML = '<pre data-juno-error style="margin:0;padding:16px;color:#b91c1c;white-space:pre-wrap;font:13px/1.6 ui-monospace,SFMono-Regular,monospace">'+String(msg).replace(/[&<]/g,function(c){return c==='&'?'&amp;':'&lt;';})+'</pre>'; }
  function failError(e){var msg=text(e); console.error(msg); fail(msg); status('error','Error');}
  status('loading','Loading');
  if (!window.React || !window.ReactDOM) { fail('Couldn’t load React (offline?).'); status('error','Error'); return; }
  if (!window.Babel) { fail('Couldn’t load the Babel compiler (offline?).'); status('error','Error'); return; }
  var raw = document.getElementById('__src').textContent;
  var before = {};
  Object.keys(window).forEach(function(k){ before[k] = true; });
  try {
    status('running','Compiling');
    var out = Babel.transform(raw, {
      // The .tsx filename makes preset-typescript parse JSX; preset-react adds the
      // JSX syntax plugin + transform. (isTSX/allExtensions were removed in Babel 8.)
      filename: 'artifact.tsx',
      presets: [
        // classic runtime → React.createElement against the global UMD React
        // (automatic runtime would inject a bare "react/jsx-runtime" import).
        [Babel.availablePresets['react'], { runtime: 'classic' }],
        [Babel.availablePresets['typescript'], { onlyRemoveTypeImports: true }]
      ]
    }).code;
    (0, eval)(out);
  } catch (e) { failError(e); return; }
  var C = window.__Component;
  if (!C && ${JSON.stringify(inferredComponent)} && typeof window[${JSON.stringify(inferredComponent)}] === 'function') C = window[${JSON.stringify(inferredComponent)}];
  if (!C) {
    Object.keys(window).some(function(k){
      if (!before[k] && /^[A-Z]/.test(k) && typeof window[k] === 'function') { C = window[k]; return true; }
      return false;
    });
  }
  try {
    if (C) {
      class ErrorBoundary extends React.Component {
        constructor(props){ super(props); this.state = { error: null }; }
        static getDerivedStateFromError(error){ return { error: error }; }
        componentDidCatch(error, info){ console.error(text(error) + (info && info.componentStack ? "\\n" + info.componentStack : "")); status('error','Error'); }
        render(){
          if (this.state.error) return React.createElement('pre', { 'data-juno-error': true, style: { margin: 0, padding: 16, color: '#b91c1c', whiteSpace: 'pre-wrap', font: '13px/1.6 ui-monospace,SFMono-Regular,monospace' } }, text(this.state.error));
          return this.props.children;
        }
      }
      ReactDOM.createRoot(root).render(React.createElement(ErrorBoundary, null, React.createElement(C)));
      setTimeout(function(){ if (!root.querySelector('[data-juno-error]')) status('done','Done'); }, 0);
    }
    else if (!root.firstChild) { fail('No component found. Export a default React component, or define one top-level PascalCase component.'); status('error','Error'); }
  } catch (e) { failError(e); }
})();
</${"script"}></body></html>`;
}

function htmlDoc(code: string): string {
  if (/<html[\s>]/i.test(code)) return code;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><script src="${TAILWIND_CDN}"></script>${BASE_STYLE}</head><body>${code}</body></html>`;
}

function svgDoc(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>${BASE_STYLE}<style>body{display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
}

/** CSS artifacts: apply the styles to a representative sample so they're visible. */
function cssDoc(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${code}</style></head>
<body>
<main style="font-family:ui-sans-serif,system-ui,sans-serif;padding:24px;max-width:720px;margin:0 auto;line-height:1.6">
<h1>Heading one</h1><h2>Heading two</h2>
<p>A paragraph with a <a href="#">link</a>, <strong>bold</strong>, <em>italic</em>, and <code>inline code</code>.</p>
<p><button>Button</button> <input placeholder="Input"/></p>
<ul><li>List item one</li><li>List item two</li></ul>
<blockquote>A block quote to preview.</blockquote>
<div class="card">A .card element</div>
</main></body></html>`;
}

function mermaidDoc(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>${BASE_STYLE}<style>body{display:grid;place-items:center;min-height:100vh;padding:16px}</style></head>
<body><pre class="mermaid">${esc(code)}</pre>
<script type="module">
import mermaid from "${MERMAID_CDN}";
mermaid.initialize({ startOnLoad: true });
</${"script"}></body></html>`;
}

/** The diagram's colours, read from the app's own tokens so it sits on the page in either theme. */
export interface MermaidTheme {
  dark: boolean;
  /** The surface the diagram sits on (the block's card). */
  surface: string;
  fill: string;
  stroke: string;
  line: string;
  text: string;
  muted: string;
}

export interface InlineMermaidOptions {
  theme: MermaidTheme;
  /** Never drawn larger than this (a two-node chart should not fill the column). */
  maxScale: number;
  /** Never drawn smaller than this; past it the diagram scrolls sideways instead. */
  minScale: number;
}

/** What an inline diagram tells its block: its drawn size, and that it was clicked. */
export const MERMAID_SIZE_MESSAGE = "juno:mermaid-size";
export const MERMAID_CLICK_MESSAGE = "juno:mermaid-click";

/**
 * A Mermaid diagram for the chat column (not the canvas): transparent on the
 * block's own surface, themed from the app's tokens, drawn at its natural size
 * then fitted to the width between `minScale` and `maxScale`, and reporting its
 * height so the frame is exactly as tall as the drawing. The old inline frame
 * was a fixed 18rem with Mermaid's light default centred in it: a small
 * diagram in a large white box in dark mode.
 */
function mermaidInlineDoc(code: string, o: InlineMermaidOptions): string {
  const t = o.theme;
  const font = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  const vars = {
    darkMode: t.dark,
    background: t.surface,
    fontFamily: font,
    fontSize: "14px",
    primaryColor: t.fill,
    primaryBorderColor: t.stroke,
    primaryTextColor: t.text,
    secondaryColor: t.fill,
    secondaryBorderColor: t.stroke,
    secondaryTextColor: t.text,
    tertiaryColor: t.surface,
    tertiaryBorderColor: t.stroke,
    tertiaryTextColor: t.text,
    lineColor: t.line,
    textColor: t.text,
    mainBkg: t.fill,
    nodeBorder: t.stroke,
    clusterBkg: t.surface,
    clusterBorder: t.stroke,
    titleColor: t.text,
    edgeLabelBackground: t.surface,
    actorBkg: t.fill,
    actorBorder: t.stroke,
    actorTextColor: t.text,
    signalColor: t.line,
    signalTextColor: t.text,
    labelBoxBkgColor: t.fill,
    labelTextColor: t.text,
    noteBkgColor: t.fill,
    noteBorderColor: t.stroke,
    noteTextColor: t.text,
  };
  const config = {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: vars,
    fontFamily: font,
    flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis", padding: 12 },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    journey: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
  };
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
:root{color-scheme:${t.dark ? "dark" : "light"}}
html,body{margin:0;background:transparent;color:${t.text};font-family:${font}}
#d{padding:12px 0;overflow-x:auto;overflow-y:hidden;cursor:zoom-in;text-align:center}
#d svg{display:inline-block;max-width:none;height:auto;vertical-align:top}
#e{margin:0;padding:12px 16px;white-space:pre-wrap;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:${t.muted}}
</style></head>
<body><div id="d" role="img" aria-label="Diagram"></div><script type="text/plain" id="src">${esc(code)}</${"script"}>
<script type="module">
const d = document.getElementById("d");
const src = document.getElementById("src").textContent;
let last = -1;
function post(h) { if (h !== last) { last = h; try { parent.postMessage({ type: "${MERMAID_SIZE_MESSAGE}", height: h }, "*"); } catch (e) {} } }
function fit() {
  const svg = d.querySelector("svg");
  if (!svg) { post(Math.ceil(document.body.scrollHeight)); return; }
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const w = vb && vb.width ? vb.width : svg.getBBox().width;
  const h = vb && vb.height ? vb.height : svg.getBBox().height;
  const avail = Math.max(1, document.documentElement.clientWidth - 16);
  const s = Math.max(${o.minScale}, Math.min(${o.maxScale}, avail / w));
  svg.setAttribute("width", String(Math.round(w * s)));
  svg.setAttribute("height", String(Math.round(h * s)));
  svg.style.maxWidth = "none";
  const scrolls = w * s > avail + 1;
  post(Math.ceil(h * s) + 24 + (scrolls ? 12 : 0));
}
d.addEventListener("click", () => { try { parent.postMessage({ type: "${MERMAID_CLICK_MESSAGE}" }, "*"); } catch (e) {} });
try {
  const { default: mermaid } = await import("${MERMAID_CDN}");
  mermaid.initialize(${JSON.stringify(config)});
  const { svg } = await mermaid.render("juno-mermaid", src);
  d.innerHTML = svg;
  fit();
  new ResizeObserver(fit).observe(document.documentElement);
} catch (err) {
  d.remove();
  const e = document.createElement("pre");
  e.id = "e";
  e.textContent = "This diagram could not be drawn. " + (err && err.message ? String(err.message).split("\\n")[0] : "");
  document.body.appendChild(e);
  fit();
}
</${"script"}></body></html>`;
}

/** An inline chat diagram's document (MermaidBlock). The static profile never gets here; it shows the source. */
export function buildInlineMermaidDoc(code: string, o: InlineMermaidOptions, profile: SandboxProfile = "private"): string {
  return withChrome(mermaidInlineDoc(code, o), profile, true);
}


/**
 * A document for the `static` profile: a public share while scripted previews
 * are off (`publicShareProfile` in src/lib/sandbox-policy.ts). The markup and
 * styles render; the shell's policy admits no script the document brings, so
 * none of the bridges are injected either. Two things a page can do without a
 * script are taken away as well: a `<meta http-equiv="refresh">` that would
 * navigate the frame to another site, and ordinary links, which open nothing
 * (`target="_blank"` in a frame with no allow-popups).
 */
function staticDoc(doc: string): string {
  const withoutRefresh = doc.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  return insertPolicy(withoutRefresh, "static").replace(
    sandboxPolicyMeta("static"),
    `${sandboxPolicyMeta("static")}<base target="_blank">`
  );
}

/** What a static public preview can show faithfully without running anything. */
export function rendersStatically(type: ArtifactType, language?: string | null): boolean {
  const lang = runtimeFor(type, language).lang;
  return lang === "html" || lang === "svg" || lang === "css";
}

/*
 * A DESIGN IS NOT A PAGE, SO THIS FRAME DOES NOT RUN ONE (X-20).
 *
 * A design document is frames and layers as JSON. It used to fall through to
 * the default branch below, which set the JSON in a `<pre>` and reported
 * "done", so every surface that previewed a design through this frame showed
 * its source under a green "Live". The picture of a design is the server's
 * render of its first page, an image keyed by the artifact's id:
 * `SandboxFrame` draws that directly, outside any iframe, when it is given the
 * id. Without an id there is no picture to show, and this document says so in
 * one line rather than pretending: no script, no chrome, no status, so nothing
 * above it claims the preview ran.
 */
function designPlaceholderDoc(profile: SandboxProfile): string {
  return insertPolicy(`<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#6b6760;text-align:center}
</style></head><body><p>This preview does not draw designs. Open the design to see it.</p></body></html>`, profile);
}

/**
 * A saved design, drawn as its poster in place of the iframe. An `<img>` is
 * the whole safety story: an image of SVG runs no script and loads nothing,
 * so it needs no sandbox. It is the same URL, and so the same cached picture,
 * that the Artifacts grid and the chat card draw, on the neutral mat a card
 * puts under a preview. `className`, when a caller sizes the frame, sizes the
 * mat instead.
 *
 * The failure is said in words, not with the design glyph the grid's
 * `DesignPoster` falls back to: this module keeps its imports to the runtime
 * helpers so `buildSandboxDoc` stays importable anywhere (the learning
 * blocks' diagram renderer and the sandbox policy test both load it for the
 * document alone), and the icon set is a component library, not a helper. The
 * failure is remembered per URL, so a later version gets its own attempt.
 */
function DesignPosterFrame({
  artifactId,
  version,
  className,
}: {
  artifactId: string;
  version?: number;
  className?: string;
}) {
  const src = designPosterUrl(artifactId, version);
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  return (
    <div className={className ?? "size-full bg-background p-2"}>
      {failedSrc === src ? (
        <p className="grid size-full place-items-center px-5 text-center text-ui text-muted-foreground">
          Preview unavailable
        </p>
      ) : (
        <img
          src={src}
          alt="Design preview, first page"
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="size-full object-contain"
        />
      )}
    </div>
  );
}

export function buildSandboxDoc(
  type: ArtifactType,
  content: string,
  language?: string | null,
  profile: SandboxProfile = "private",
  appearance?: ConsoleAppearance
): string {
  const rt = runtimeFor(type, language);
  // Before the static branch too: its fallback sets the source in a <pre>,
  // which for a design is its JSON.
  if (rt.mode === "design") return designPlaceholderDoc(profile);
  if (profile === "static") {
    if (rt.lang === "html") return staticDoc(htmlDoc(content));
    if (rt.lang === "svg") return staticDoc(svgDoc(content));
    if (rt.lang === "css") return staticDoc(cssDoc(content));
    return staticDoc(
      htmlDoc(`<pre style="padding:16px;white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace">${escapeHtml(content)}</pre>`)
    );
  }
  if (rt.mode === "console" && rt.engine) return consoleDoc(content, rt.engine, rt.lang, rt.label, profile, appearance);
  switch (rt.lang) {
    case "tsx":
    case "jsx":
      return withChrome(reactDoc(content), profile);
    case "html":
      return withChrome(htmlDoc(content), profile, true);
    case "svg":
      return withChrome(svgDoc(content), profile, true);
    case "css":
      return withChrome(cssDoc(content), profile, true);
    case "mermaid":
      return withChrome(mermaidDoc(content), profile, true);
    default:
      return withChrome(
        htmlDoc(`<pre style="padding:16px;white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace">${escapeHtml(content)}</pre>`),
        profile,
        true
      );
  }
}

export interface SandboxElementSelection {
  selector: string;
  tag: string;
  snippet: string;
  text: string;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export type RunStatus = "idle" | "loading" | "running" | "done" | "error";

export function SandboxFrame({
  type,
  content,
  language,
  runNonce = 0,
  mode,
  inspectEnabled = false,
  onElementSelected,
  onInspectExit,
  onConsole,
  onStatus,
  consoleAppearance,
  onConsoleSize,
  className,
  artifactId,
  version,
}: {
  type: ArtifactType;
  content: string;
  language?: string | null;
  /** A DESIGN's stored id, and the version to picture: the frame shows that
   *  design's poster instead of running anything. Ignored for other types. */
  artifactId?: string | null;
  version?: number;
  /** Bump to force a re-run/reload of the sandbox. */
  runNonce?: number;
  mode?: RunMode;
  inspectEnabled?: boolean;
  onElementSelected?: (selection: SandboxElementSelection) => void;
  onInspectExit?: () => void;
  /** Console/stdout lines forwarded from the sandbox. */
  onConsole?: (entry: ConsoleEntry) => void;
  onStatus?: (status: RunStatus, detail?: string) => void;
  /** A console run drawn inline under a chat code block (``ConsoleAppearance``). */
  consoleAppearance?: ConsoleAppearance;
  /** The inline console's content height, as the document reports it. */
  onConsoleSize?: (height: number) => void;
  className?: string;
}) {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const profile = useSandboxProfile();
  const appearanceKey = consoleAppearance ? `${consoleAppearance.inline}:${consoleAppearance.theme}` : "";
  const doc = React.useMemo(
    () => buildSandboxDoc(type, content, language, profile, consoleAppearance),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value, not identity
    [type, content, language, profile, appearanceKey]
  );

  const postInspect = React.useCallback((on: boolean) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "juno:inspect", on }, "*");
  }, []);

  React.useEffect(() => {
    postInspect(inspectEnabled);
  }, [inspectEnabled, postInspect]);

  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only trust messages from OUR iframe's window — artifact code runs there.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const data = e.data as { type?: unknown; [k: string]: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "juno:selected" && onElementSelected) {
        onElementSelected({
          selector: typeof data.selector === "string" ? data.selector : "",
          tag: typeof data.tag === "string" ? data.tag : "",
          snippet: typeof data.snippet === "string" ? data.snippet : "",
          text: typeof data.text === "string" ? data.text : "",
        });
      } else if (data.type === "juno:inspect-off") {
        onInspectExit?.();
      } else if (data.type === "juno:open") {
        /*
         * An outward link the reader clicked inside the preview.
         *
         * Re-validated HERE rather than trusted from the frame: the sender is
         * artifact code, and the check on its side is a convenience, not a
         * boundary. Only http(s) opens, and `noopener,noreferrer` keeps the
         * new tab from reaching back through `window.opener`.
         */
        const raw = typeof data.url === "string" ? data.url : "";
        let href: URL | null = null;
        try {
          href = new URL(raw);
        } catch {
          href = null;
        }
        if (href && (href.protocol === "http:" || href.protocol === "https:")) {
          window.open(href.href, "_blank", "noopener,noreferrer");
        }
      } else if (data.type === "juno:console" && onConsole) {
        const level = data.level;
        onConsole({
          level: level === "info" || level === "warn" || level === "error" ? level : "log",
          text: typeof data.text === "string" ? data.text : String(data.text),
        });
      } else if (data.type === CONSOLE_SIZE_MESSAGE && onConsoleSize) {
        const height = typeof data.height === "number" && Number.isFinite(data.height) ? data.height : 0;
        if (height > 0) onConsoleSize(height);
      } else if (data.type === "juno:status" && onStatus) {
        const s = data.status;
        onStatus(
          s === "loading" || s === "running" || s === "done" || s === "error" ? s : "idle",
          typeof data.detail === "string" ? data.detail : undefined
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onElementSelected, onInspectExit, onConsole, onStatus, onConsoleSize]);

  const isDark = mode === "console";

  if (type === "DESIGN" && artifactId) {
    return <DesignPosterFrame artifactId={artifactId} version={version} className={className} />;
  }

  return (
    <SandboxDocumentFrame
      // A re-run is a new frame even when the document is unchanged.
      key={runNonce}
      ref={iframeRef}
      title="Artifact preview"
      html={doc}
      // The inspector lives in the document, so a newly written one needs to
      // be told the current state.
      onDocumentLoad={() => {
        if (inspectEnabled) postInspect(true);
      }}
      // Opaque origin (no allow-same-origin) so artifact code cannot touch the
      // app, cookies, or storage — see SANDBOX_FLAGS for the rest.
      sandbox={SANDBOX_FLAGS[profile]}
      className={className ?? `size-full border-0 ${isDark ? "bg-[#0b0b0e]" : "bg-white"}`}
    />
  );
}
