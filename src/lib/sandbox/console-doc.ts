/**
 * The console document a code block runs in (JavaScript, TypeScript, Python
 * on Pyodide, SQL on sql.js against the HR sample), and the helpers it shares
 * with the other preview documents in src/components/canvas/sandbox-frame.tsx.
 *
 * Pure strings and no React, so a route handler can build the same document
 * the web's frame shows: /api/code/console hands it to the native apps, which
 * run it in a WKWebView (owner, 2026-10-09: "add ... the ability to run code
 * like we did on the website").
 */
import { sandboxPolicyMeta, type SandboxProfile } from "@/lib/sandbox-policy";
import { HR_SAMPLE_NOTE, HR_SAMPLE_SQL } from "@/lib/sandbox/hr-sample";
import { runtimeFor } from "@/lib/artifact-runtime";
import { runTargetFor } from "@/lib/exec/snippet-languages";

export const BABEL_CDN = "https://unpkg.com/@babel/standalone/babel.min.js";
const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
/** SQLite compiled to WebAssembly: a SQL block runs against the HR sample (src/lib/sandbox/hr-sample.ts). */
const SQLJS_INDEX = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";

/**
 * Module name → PyPI wheel, for the libraries Pyodide does not bundle.
 *
 * Deliberately short, and every entry is here for the same reason: it is a
 * PURE-PYTHON package, so micropip can install it in a browser with no
 * compilation, and it is one of the things people ask a chat assistant to do
 * with a file. Producing a PDF, a Word document or a deck; reading a PDF back;
 * turning Markdown or HTML into either. Anything needing a C extension is
 * absent, because micropip cannot build one and a name in this list that fails
 * to install is worse than a name that was never offered.
 *
 * Pyodide's OWN bundled set — numpy, pandas, matplotlib, scipy, sympy, pillow,
 * openpyxl, lxml, beautifulsoup4 and some eighty more — is not repeated here.
 * `loadPackagesFromImports` finds those from the script's imports already; this
 * is only what it cannot.
 */
const PY_WHEELS: Record<string, string> = {
  fpdf: "fpdf2",              // write a PDF
  reportlab: "reportlab",     // write a PDF, the heavyweight way
  pypdf: "pypdf",             // read, merge, split a PDF
  docx: "python-docx",        // write/read .docx
  pptx: "python-pptx",        // write/read .pptx
  markdown: "markdown",       // Markdown → HTML
  markdownify: "markdownify", // HTML → Markdown
  tabulate: "tabulate",       // tables for a terminal or a document
  qrcode: "qrcode",
  pydantic: "pydantic",
  dateutil: "python-dateutil",
  jinja2: "Jinja2",
};

const CLOSE_SCRIPT = /<\/script/gi;
export const esc = (s: string) => s.replace(CLOSE_SCRIPT, "<\\/script");

/**
 * Remove ESM `import` statements — including multi-line `import { … } from "x"`
 * and side-effect `import "x"` — since the sandbox has no bundler and runs code
 * as a classic script. Bare specifiers can't be resolved here anyway; React and
 * hooks are provided as globals.
 */
export function stripImports(code: string): string {
  return code.replace(
    /^[ \t]*import\b[\s\S]*?(?:from[ \t]*['"][^'"]*['"]|['"][^'"]*['"])[ \t]*;?[ \t]*\r?\n?/gm,
    ""
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
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
export const SANDBOX_SHIM = `<script>
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

const TERMINAL_STYLE = `<style>
:root{color-scheme:dark}
html,body{margin:0;height:100%;background:#0b0b0e;color:#e7e7ea}
#wrap{display:flex;flex-direction:column;height:100%;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1e1e24;background:#111117;color:#9a9aa4;font-size:11px;letter-spacing:.02em;flex:0 0 auto}
#dot{width:8px;height:8px;border-radius:50%;background:#f5a524;box-shadow:0 0 8px currentColor}
#term{flex:1 1 auto;overflow:auto;padding:12px 14px;white-space:pre-wrap;word-break:break-word}
.ln{display:block;padding:1px 0}
.log{color:#e7e7ea}.info{color:#7dd3fc}.warn{color:#fbbf24}.error{color:#f87171}.muted{color:#6b6b76}.result{color:#a7f3d0}
.error::selection{background:#7f1d1d}
table.rs{border-collapse:collapse;margin:6px 0 4px;white-space:nowrap}
table.rs th,table.rs td{border:1px solid #26262e;padding:3px 10px;text-align:left}
table.rs th{color:#9cdcfe;font-weight:600;background:#15151c}
table.rs td.n{text-align:right;color:#b5cea8}
table.rs td.null{color:#6b6b76;font-style:italic}
</style>`;

/**
 * How a console run is drawn. `terminal` is the canvas's dark terminal with
 * its own bar. `inline` is a run under a chat code block (code-run-output.tsx):
 * no bar and no status dot (the host draws the header in text), a transparent
 * ground in the app's own theme, and its height posted to the parent so the
 * output takes exactly the room it needs.
 */
export interface ConsoleAppearance {
  inline: boolean;
  theme: "light" | "dark";
}

export const CONSOLE_SIZE_MESSAGE = "juno:console-size";

function inlineConsoleStyle(theme: "light" | "dark"): string {
  const c =
    theme === "dark"
      ? { fg: "#e6e6e9", muted: "#8b8b96", info: "#7cc4f8", warn: "#e5b25a", error: "#f2827a", result: "#b5cea8", num: "#b5cea8", rule: "rgba(255,255,255,.09)", head: "#a9a9b3" }
      : { fg: "#1d1d21", muted: "#6b6b75", info: "#1f6fb2", warn: "#9a5b00", error: "#b42318", result: "#0a7a50", num: "#0a7a50", rule: "rgba(0,0,0,.09)", head: "#5f5f69" };
  return `<style>
:root{color-scheme:${theme}}
html,body{margin:0;background:transparent;color:${c.fg}}
#wrap{font:12.5px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#bar{display:none}
#term{padding:8px 16px 14px;white-space:pre-wrap;word-break:break-word}
.ln{display:block;padding:1px 0}
.log{color:${c.fg}}.info{color:${c.info}}.warn{color:${c.warn}}.error{color:${c.error}}.muted{color:${c.muted}}.result{color:${c.result}}
table.rs{border-collapse:collapse;margin:0 0 6px;white-space:nowrap;font-variant-numeric:tabular-nums}
table.rs th,table.rs td{padding:4px 16px 4px 0;text-align:left;border-bottom:1px solid ${c.rule}}
table.rs th{color:${c.head};font-weight:500}
table.rs tr:last-child td{border-bottom:0}
table.rs td.n{text-align:right;color:${c.num}}
table.rs td.null{color:${c.muted};font-style:italic}
</style>`;
}

/** Self-contained dark terminal that executes JS/TS or Python and streams output. */
export function consoleDoc(
  rawCode: string,
  engine: "js" | "python" | "sql" | "unsupported",
  lang: string,
  label: string | undefined,
  profile: SandboxProfile,
  appearance?: ConsoleAppearance
): string {
  // Python keeps its source verbatim; JS/TS get module syntax stripped so the
  // classic-script eval doesn't choke on imports/exports.
  const code = engine === "python" || engine === "sql" ? rawCode : stripImports(rawCode).replace(/^[ \t]*export\s+(default\s+)?/gm, "");
  const runtimeLabel = JSON.stringify(label ?? lang);
  const boot =
    engine === "unsupported"
      ? `
  line('Browser execution is not available for '+${runtimeLabel}+' artifacts yet.','warn');
  line('The source is loaded and the Code tab can copy or download it for a local compiler/runtime.','muted');
  status('done','Ready');`
      : engine === "sql"
      ? `
  status('loading','Loading SQLite…');
  ${appearance?.inline ? "" : `line(${JSON.stringify(HR_SAMPLE_NOTE)},'muted');`}
  var s=document.createElement('script'); s.src='${SQLJS_INDEX}sql-wasm.js';
  s.onload=function(){
    initSqlJs({locateFile:function(f){return '${SQLJS_INDEX}'+f;}}).then(function(SQL){
      var db=new SQL.Database();
      db.exec(${JSON.stringify(HR_SAMPLE_SQL)});
      // A few Oracle functions courses lean on, so their queries run as written.
      db.create_function('NVL',function(a,b){return a===null?b:a;});
      db.create_function('NVL2',function(a,b,c){return a===null?c:b;});
      db.create_function('INITCAP',function(t){return t===null?null:String(t).toLowerCase().replace(/(^|[^a-z])([a-z])/g,function(m,p,c){return p+c.toUpperCase();});});
      status('running','Running');
      var started=performance.now();
      var results;
      try{ results=db.exec(raw); }
      catch(e){ printErr(e&&e.message?e.message:String(e)); line('SQLite in the browser: Oracle-only syntax (CONNECT BY, ROWNUM, sequences, PL/SQL) does not run here.','muted'); status('error','Error'); return; }
      if(results.length===0){ var ch=db.getRowsModified(); line(ch>0?(ch+' row'+(ch===1?'':'s')+' changed.'):'Done. No rows returned.','muted'); }
      results.forEach(function(r){
        var t=document.createElement('table'); t.className='rs';
        var h=document.createElement('tr');
        r.columns.forEach(function(c){var th=document.createElement('th');th.textContent=c.toUpperCase();h.appendChild(th);});
        t.appendChild(h);
        r.values.forEach(function(row){
          var tr=document.createElement('tr');
          row.forEach(function(v){var td=document.createElement('td');if(v===null){td.textContent='(null)';td.className='null';}else{td.textContent=String(v);if(typeof v==='number')td.className='n';}tr.appendChild(td);});
          t.appendChild(tr);
        });
        term.appendChild(t);
        line(r.values.length+' row'+(r.values.length===1?'':'s')+' selected.','muted');
        try{ parent.postMessage({type:'juno:console',level:'log',text:r.columns.join('\\t')+'\\n'+r.values.map(function(v){return v.join('\\t');}).join('\\n')},'*'); }catch(e){}
      });
      line('Ran in '+Math.max(1,Math.round(performance.now()-started))+' ms.','muted');
      status('done','Done');
    }).catch(function(e){printErr(e);status('error','Error');});
  };
  s.onerror=function(){printErr('Couldn’t load SQLite (offline?).');status('error','Error');};
  document.head.appendChild(s);`
      : engine === "python"
      ? `
  status('loading','Loading Python…');
  var s=document.createElement('script'); s.src='${PYODIDE_INDEX}pyodide.js';
  s.onload=function(){
    var py=null;
    loadPyodide({indexURL:'${PYODIDE_INDEX}'}).then(function(p){
      py=p;
      py.setStdout({batched:function(t){line(t,'log');}});
      py.setStderr({batched:function(t){line(t,'error');}});
      /*
       * THE PACKAGES THE SCRIPT ACTUALLY ASKS FOR.
       *
       * Pyodide ships a large set of compiled wheels — numpy, pandas,
       * matplotlib, scipy, sympy, pillow, openpyxl, lxml — but loads NONE of
       * them until told, so "import pandas" used to fail with
       * ModuleNotFoundError in a runtime that had pandas sitting right there.
       * loadPackagesFromImports() reads the source's own import statements and
       * fetches exactly those.
       */
      status('loading','Loading packages…');
      return py.loadPackagesFromImports(raw).catch(function(){ /* a package it cannot place is not a failed run */ });
    }).then(function(){
      /*
       * …and the ones it does NOT ship, from PyPI.
       *
       * The document libraries are pure Python, so micropip can install them
       * at runtime: this is what makes "write me a PDF" work in a browser.
       * Only wheels whose module the script actually imports are fetched —
       * installing the whole list on every run would put a megabyte of
       * unrelated code in front of a two-line calculation.
       */
      var wanted=${JSON.stringify(PY_WHEELS)};
      var imported={};
      var re=/^[ \t]*(?:from[ \t]+([A-Za-z_][\w]*)|import[ \t]+([A-Za-z_][\w]*))/gm, m;
      while((m=re.exec(raw))) imported[m[1]||m[2]]=true;
      var wheels=Object.keys(wanted).filter(function(mod){
        if(!imported[mod]) return false;
        try{ return !py.pyimport(mod); }catch(e){ return true; }
      }).map(function(mod){ return wanted[mod]; });
      if(wheels.length===0) return;
      status('loading','Installing '+wheels.join(', ')+'…');
      return py.loadPackage('micropip').then(function(){
        return py.pyimport('micropip').install(wheels);
      }).catch(function(e){
        line('Could not install '+wheels.join(', ')+': '+(e&&e.message?e.message:String(e)),'warn');
      });
    }).then(function(){
      status('running','Running');
      // Snapshot the working directory so anything the script WRITES can be
      // told apart from the runtime's own files afterwards.
      var before={};
      try{ py.FS.readdir('.').forEach(function(n){ before[n]=true; }); }catch(e){}
      return py.runPythonAsync(raw).then(function(){ return before; });
    }).then(function(before){
      offerFiles(py, before);
      status('done','Done');
    }).catch(function(e){printErr(e);status('error','Error');});
  };
  s.onerror=function(){printErr('Couldn’t load the Python runtime (offline?).');status('error','Error');};
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
      ? `if(!window.Babel){printErr('Couldn’t load the TypeScript compiler (offline?).');status('error','Error');}
     else{try{body=Babel.transform(body,{filename:'a.ts',presets:[[Babel.availablePresets['typescript'],{onlyRemoveTypeImports:true}]]}).code;}catch(e){printErr(e);status('error','Error');body=null;}}
     if(body!==null) run(body);`
      : `run(body);`
  }`;

  return `<!doctype html><html><head><meta charset="utf-8"/>${sandboxPolicyMeta(profile)}${SANDBOX_SHIM}${appearance?.inline ? inlineConsoleStyle(appearance.theme) : TERMINAL_STYLE}${
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
  /*
   * A FILE THE SCRIPT WROTE, AS A FILE YOU CAN KEEP.
   *
   * "Produce a PDF" only finishes when the PDF leaves the sandbox. The script
   * writes into Pyodide's in-memory filesystem, which nothing outside the
   * frame can see — so anything that appeared in the working directory during
   * the run is offered here as a download link on the terminal's last line.
   *
   * A blob URL and a same-frame click: the iframe carries allow-downloads
   * and no allow-same-origin, so this reaches the reader's disk without the
   * bytes ever touching the app's origin or a server.
   */
  var MAX_FILES=12, MAX_FILE_BYTES=25*1024*1024;
  function mimeOf(name){
    var ext=(name.split('.').pop()||'').toLowerCase();
    return {pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',svg:'image/svg+xml',gif:'image/gif',
      csv:'text/csv',txt:'text/plain',md:'text/markdown',json:'application/json',html:'text/html',xml:'application/xml',
      docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip:'application/zip'}[ext]||'application/octet-stream';
  }
  function humanBytes(n){var u=['B','KB','MB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return (Math.round(n*10)/10)+' '+u[i];}
  function offerFiles(py, before){
    if(!py||!py.FS) return;
    var names=[];
    try{ names=py.FS.readdir('.').filter(function(n){ return n!=='.'&&n!=='..'&&!before[n]; }); }catch(e){ return; }
    if(names.length===0) return;
    var row=document.createElement('span');
    row.className='ln muted';
    row.appendChild(document.createTextNode(names.length===1?'Produced 1 file: ':'Produced '+names.length+' files: '));
    var shown=0;
    names.forEach(function(name){
      if(shown>=MAX_FILES) return;
      var data;
      try{
        var stat=py.FS.stat(name);
        if(py.FS.isDir(stat.mode)||stat.size>MAX_FILE_BYTES) return;
        data=py.FS.readFile(name);
      }catch(e){ return; }
      var url=URL.createObjectURL(new Blob([data],{type:mimeOf(name)}));
      var a=document.createElement('a');
      a.href=url; a.download=name; a.textContent=name+' ('+humanBytes(data.length)+')';
      a.style.cssText='color:#7dd3fc;text-decoration:underline;margin-right:10px';
      if(shown>0) row.appendChild(document.createTextNode(' '));
      row.appendChild(a);
      shown++;
    });
    if(shown>0){ term.appendChild(row); term.scrollTop=term.scrollHeight; }
  }
  ['log','info','warn','error'].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){var a=Array.prototype.map.call(arguments,function(x){return typeof x==='string'?x:fmt(x);}).join(' ');line(a,k);o.apply(null,arguments);};});
  window.addEventListener('unhandledrejection',function(e){printErr(e.reason);});
  ${appearance?.inline ? `try{var lastH=0;new ResizeObserver(function(){var h=Math.ceil(document.getElementById('wrap').getBoundingClientRect().height);if(h!==lastH){lastH=h;parent.postMessage({type:'${CONSOLE_SIZE_MESSAGE}',height:h},'*');}}).observe(document.getElementById('wrap'));}catch(e){}` : ""}
  ${boot}
})();
</${"script"}></body></html>`;
}

/**
 * The console document for one chat code block, as the web's Run draws it
 * under the block (`inline`, in the reader's theme): what /api/code/console
 * returns to the native apps. Only the languages a browser runs itself
 * (JavaScript, TypeScript, Python, SQL); null for anything else.
 */
export function codeBlockConsoleDoc(
  language: string,
  code: string,
  theme: "light" | "dark",
): { html: string; language: string; label: string } | null {
  const target = runTargetFor(language);
  if (!target || target.where !== "browser") return null;
  const rt = runtimeFor("CODE", target.language);
  if (rt.mode !== "console" || !rt.engine || rt.engine === "unsupported") return null;
  return {
    html: consoleDoc(code, rt.engine, rt.lang, rt.label, "private", { inline: true, theme }),
    language: target.language,
    label: target.label,
  };
}
