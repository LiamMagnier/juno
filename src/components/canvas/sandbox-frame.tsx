"use client";

import * as React from "react";
import type { ArtifactType } from "@/lib/message-content";
import { runtimeFor, type RunMode } from "@/lib/artifact-runtime";

const TAILWIND_CDN = "https://cdn.tailwindcss.com";
const REACT_CDN = "https://unpkg.com/react@18.3.1/umd/react.development.js";
const REACT_DOM_CDN = "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js";
const BABEL_CDN = "https://unpkg.com/@babel/standalone/babel.min.js";
const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

const BASE_STYLE = `<style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#111}</style>`;
const CLOSE_SCRIPT = /<\/script/gi;
const esc = (s: string) => s.replace(CLOSE_SCRIPT, "<\\/script");

/**
 * Remove ESM `import` statements — including multi-line `import { … } from "x"`
 * and side-effect `import "x"` — since the sandbox has no bundler and runs code
 * as a classic script. Bare specifiers can't be resolved here anyway; React and
 * hooks are provided as globals.
 */
function stripImports(code: string): string {
  return code.replace(
    /^[ \t]*import\b[\s\S]*?(?:from[ \t]*['"][^'"]*['"]|['"][^'"]*['"])[ \t]*;?[ \t]*\r?\n?/gm,
    ""
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

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
 * A sandboxed opaque-origin iframe (no `allow-same-origin`, kept that way so
 * artifact code can never reach the app's cookies/storage) throws
 * "The operation is insecure." the moment code touches localStorage /
 * sessionStorage or calls history.pushState/replaceState. Portfolios hit this
 * constantly — a saved theme read in a useEffect, hash-nav, or client routing —
 * and it crashes the whole preview. Shim those APIs with in-memory / swallowing
 * versions so the artifact runs; nothing actually persists (correct for a
 * sandbox), it just no longer throws. Injected FIRST, before any artifact code.
 */
const SANDBOX_SHIM = `<script>
(function(){
  function mem(){var s={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null;},setItem:function(k,v){s[String(k)]=String(v);},removeItem:function(k){delete s[String(k)];},clear:function(){s={};},key:function(i){var ks=Object.keys(s);return i<ks.length?ks[i]:null;},get length(){return Object.keys(s).length;}};}
  function shimStorage(name){var ok=false;try{var t=window[name];t.getItem('__juno_probe__');t.removeItem('__juno_probe__');ok=true;}catch(e){ok=false;}if(!ok){try{Object.defineProperty(window,name,{value:mem(),configurable:true});}catch(e){}}}
  shimStorage('localStorage');
  shimStorage('sessionStorage');
  try{
    var h=window.history;
    ['pushState','replaceState'].forEach(function(m){
      var orig=h[m];
      if(typeof orig!=='function')return;
      h[m]=function(){try{return orig.apply(h,arguments);}catch(e){/* sandboxed: swallow "operation is insecure" */}};
    });
  }catch(e){}
})();
</${"script"}>`;

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

/** Inject the console bridge (early) + inspector (late) into a web document. */
function withChrome(doc: string, statusLite = false): string {
  const head = doc.indexOf("</head>");
  // Shim first (before console bridge), so storage/history are safe before any
  // artifact or bridge code runs.
  const chrome = SANDBOX_SHIM + (statusLite ? STATUS_LITE : "") + CONSOLE_BRIDGE;
  const out = head !== -1 ? doc.slice(0, head) + chrome + doc.slice(head) : chrome + doc;
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
  if (!window.React || !window.ReactDOM) { fail('Could not load React (offline?).'); status('error','Error'); return; }
  if (!window.Babel) { fail('Could not load the Babel compiler (offline?).'); status('error','Error'); return; }
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

const TERMINAL_STYLE = `<style>
:root{color-scheme:dark}
html,body{margin:0;height:100%;background:#0b0b0e;color:#e7e7ea}
#wrap{display:flex;flex-direction:column;height:100%;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1e1e24;background:#111117;color:#9a9aa4;font-size:11px;letter-spacing:.08em;text-transform:uppercase;flex:0 0 auto}
#dot{width:8px;height:8px;border-radius:50%;background:#f5a524;box-shadow:0 0 8px currentColor}
#term{flex:1 1 auto;overflow:auto;padding:12px 14px;white-space:pre-wrap;word-break:break-word}
.ln{display:block;padding:1px 0}
.log{color:#e7e7ea}.info{color:#7dd3fc}.warn{color:#fbbf24}.error{color:#f87171}.muted{color:#6b6b76}.result{color:#a7f3d0}
.error::selection{background:#7f1d1d}
</style>`;

/** Self-contained dark terminal that executes JS/TS or Python and streams output. */
function consoleDoc(rawCode: string, engine: "js" | "python" | "unsupported", lang: string, label?: string): string {
  // Python keeps its source verbatim; JS/TS get module syntax stripped so the
  // classic-script eval doesn't choke on imports/exports.
  const code = engine === "python" ? rawCode : stripImports(rawCode).replace(/^[ \t]*export\s+(default\s+)?/gm, "");
  const runtimeLabel = JSON.stringify(label ?? lang);
  const boot =
    engine === "unsupported"
      ? `
  line('Browser execution is not available for '+${runtimeLabel}+' artifacts yet.','warn');
  line('The source is loaded and the Code tab can copy or download it for a local compiler/runtime.','muted');
  status('done','Ready');`
      : engine === "python"
      ? `
  status('loading','Loading Python…');
  var s=document.createElement('script'); s.src='${PYODIDE_INDEX}pyodide.js';
  s.onload=function(){
    loadPyodide({indexURL:'${PYODIDE_INDEX}'}).then(function(py){
      py.setStdout({batched:function(t){line(t,'log');}});
      py.setStderr({batched:function(t){line(t,'error');}});
      status('running','Running');
      return py.runPythonAsync(raw);
    }).then(function(){status('done','Done');}).catch(function(e){printErr(e);status('error','Error');});
  };
  s.onerror=function(){printErr('Could not load the Python runtime (offline?).');status('error','Error');};
  document.head.appendChild(s);`
      : `
  function run(js){
    status('running','Running');
    var wrapped='(async function(){\\n'+js+'\\n})()';
    try{
      Promise.resolve((0,eval)(wrapped)).then(function(v){ if(v!==undefined) line(fmt(v),'result'); status('done','Done'); })
        .catch(function(e){printErr(e);status('error','Error');});
    }catch(e){printErr(e);status('error','Error');}
  }
  var body=raw;
  ${
    lang === "typescript"
      ? `if(!window.Babel){printErr('Could not load the TypeScript compiler (offline?).');status('error','Error');}
     else{try{body=Babel.transform(body,{filename:'a.ts',presets:[[Babel.availablePresets['typescript'],{onlyRemoveTypeImports:true}]]}).code;}catch(e){printErr(e);status('error','Error');body=null;}}
     if(body!==null) run(body);`
      : `run(body);`
  }`;

  return `<!doctype html><html><head><meta charset="utf-8"/>${SANDBOX_SHIM}${TERMINAL_STYLE}${
    lang === "typescript" ? `<script src="${BABEL_CDN}"></script>` : ""
  }</head>
<body><div id="wrap"><div id="bar"><span id="dot"></span><span id="label">${escapeHtml(label ?? lang)}</span><span id="st" style="margin-left:auto"></span></div><div id="term"></div></div>
<script type="text/plain" id="__src">${esc(code)}</${"script"}>
<script>
(function(){
  var term=document.getElementById('term'), st=document.getElementById('st'), dot=document.getElementById('dot');
  var raw=document.getElementById('__src').textContent;
  function fmt(v){try{return typeof v==='string'?v:JSON.stringify(v,null,2);}catch(e){return String(v);}}
  function line(text,cls){var d=document.createElement('span');d.className='ln '+(cls||'log');d.textContent=text;term.appendChild(d);term.scrollTop=term.scrollHeight;try{parent.postMessage({type:'juno:console',level:cls==='result'?'log':(cls||'log'),text:text},'*');}catch(e){}}
  function printErr(e){line((e&&e.stack)?e.stack:(e&&e.message?e.message:String(e)),'error');}
  function status(s,detail){st.textContent=detail||s;dot.style.background=s==='done'?'#34d399':s==='error'?'#f87171':s==='running'?'#38bdf8':'#f5a524';try{parent.postMessage({type:'juno:status',status:s,detail:detail||''},'*');}catch(e){}}
  ['log','info','warn','error'].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){var a=Array.prototype.map.call(arguments,function(x){return typeof x==='string'?x:fmt(x);}).join(' ');line(a,k);o.apply(null,arguments);};});
  window.addEventListener('unhandledrejection',function(e){printErr(e.reason);});
  ${boot}
})();
</${"script"}></body></html>`;
}

export function buildSandboxDoc(type: ArtifactType, content: string, language?: string | null): string {
  const rt = runtimeFor(type, language);
  if (rt.mode === "console" && rt.engine) return consoleDoc(content, rt.engine, rt.lang, rt.label);
  switch (rt.lang) {
    case "tsx":
    case "jsx":
      return withChrome(reactDoc(content));
    case "html":
      return withChrome(htmlDoc(content), true);
    case "svg":
      return withChrome(svgDoc(content), true);
    case "css":
      return withChrome(cssDoc(content), true);
    case "mermaid":
      return mermaidDoc(content);
    default:
      return withChrome(htmlDoc(`<pre style="padding:16px;white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace">${escapeHtml(content)}</pre>`), true);
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
  className,
}: {
  type: ArtifactType;
  content: string;
  language?: string | null;
  /** Bump to force a re-run/reload of the sandbox. */
  runNonce?: number;
  mode?: RunMode;
  inspectEnabled?: boolean;
  onElementSelected?: (selection: SandboxElementSelection) => void;
  onInspectExit?: () => void;
  /** Console/stdout lines forwarded from the sandbox. */
  onConsole?: (entry: ConsoleEntry) => void;
  onStatus?: (status: RunStatus, detail?: string) => void;
  className?: string;
}) {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  // runNonce participates in the memo so a re-run rebuilds the document.
  const srcDoc = React.useMemo(() => buildSandboxDoc(type, content, language), [type, content, language, runNonce]);

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
      } else if (data.type === "juno:console" && onConsole) {
        const level = data.level;
        onConsole({
          level: level === "info" || level === "warn" || level === "error" ? level : "log",
          text: typeof data.text === "string" ? data.text : String(data.text),
        });
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
  }, [onElementSelected, onInspectExit, onConsole, onStatus]);

  const isDark = mode === "console";

  return (
    <iframe
      ref={iframeRef}
      title="Artifact preview"
      srcDoc={srcDoc}
      onLoad={() => {
        if (inspectEnabled) postInspect(true);
      }}
      // Opaque origin (no allow-same-origin) so artifact code cannot touch the app, cookies, or storage.
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      className={className ?? `h-full w-full border-0 ${isDark ? "bg-[#0b0b0e]" : "bg-white"}`}
    />
  );
}
