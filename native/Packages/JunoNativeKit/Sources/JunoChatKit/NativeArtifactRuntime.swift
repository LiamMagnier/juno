import Foundation
import Observation

// MARK: - Which runtime an artifact gets

/// How an artifact runs, decided exactly as the web decides it:
/// `runtimeFor` in `src/lib/artifact-runtime.ts`, ported.
///
/// The server's type is coarse (HTML, REACT, CODE, …); the language the model
/// attaches is the fine hint that routes a CODE artifact to a web page, a
/// console program, or nothing at all. Both clients have to reach the same
/// answer for the same artifact, or one shows a running page where the other
/// shows source.
public struct NativeArtifactRuntimeInfo: Equatable, Sendable {
    public enum Mode: String, Sendable {
        /// Rendered live in the sandbox: HTML, CSS, SVG, Mermaid, React.
        case web
        /// Executed headlessly into a dark terminal: JavaScript, TypeScript,
        /// Python — and every other language, which says it cannot run.
        case console
        /// No runtime; the code is shown, not run.
        case none
        /// A Juno Design document, which is opened rather than executed.
        case design
    }

    public enum Engine: String, Sendable {
        case js
        case python
        case unsupported
    }

    public let mode: Mode
    /// The canonical language key: `tsx`, `python`, `css`, `design`, …
    public let lang: String
    /// The human label the card and the canvas print: "React", "Python".
    public let label: String
    public let engine: Engine?

    public init(mode: Mode, lang: String, label: String, engine: Engine? = nil) {
        self.mode = mode
        self.lang = lang
        self.label = label
        self.engine = engine
    }

    /// Whether this runtime loads its engine from the network: React and
    /// TypeScript need Babel (and React) from unpkg, Python needs Pyodide from
    /// jsdelivr. With the Mac's sandbox closed to the network
    /// (``ArtifactRuntimeNetwork/isOpen``) these have no Preview; everything
    /// else — pages, graphics, CSS, Mermaid (bundled), plain JavaScript — runs.
    public var needsRemoteRuntime: Bool {
        switch lang {
        case "tsx", "jsx", "typescript", "python": true
        default: false
        }
    }

    /// Whether the Mac can show this artifact running: it has a runtime, and
    /// that runtime is reachable from the sandbox.
    public var runsOnThisMac: Bool {
        guard mode == .web || mode == .console else { return false }
        return ArtifactRuntimeNetwork.isOpen || !needsRemoteRuntime
    }

    /// The web's `runtimeFor(type, language)`.
    public static func resolve(kind: NativeArtifactKind, language: String?) -> Self {
        let lang = canonicalLanguage(language)
        switch kind {
        case .design: return Self(mode: .design, lang: "design", label: "Design")
        case .react: return Self(mode: .web, lang: "tsx", label: "React")
        case .html: return Self(mode: .web, lang: "html", label: "HTML")
        case .svg: return Self(mode: .web, lang: "svg", label: "SVG")
        case .mermaid: return Self(mode: .web, lang: "mermaid", label: "Mermaid")
        case .markdown: return Self(mode: .web, lang: "markdown", label: "Markdown")
        case .code: break
        }
        switch lang {
        case "jsx", "tsx": return Self(mode: .web, lang: lang, label: "React")
        case "html": return Self(mode: .web, lang: lang, label: "HTML")
        case "svg": return Self(mode: .web, lang: lang, label: "SVG")
        case "css": return Self(mode: .web, lang: lang, label: "CSS")
        case "mermaid": return Self(mode: .web, lang: lang, label: "Mermaid")
        case "javascript": return Self(mode: .console, lang: lang, label: "JavaScript", engine: .js)
        case "typescript": return Self(mode: .console, lang: lang, label: "TypeScript", engine: .js)
        case "python": return Self(mode: .console, lang: lang, label: "Python", engine: .python)
        default:
            return Self(
                mode: .console,
                lang: lang.isEmpty ? "plaintext" : lang,
                label: label(forLanguage: lang),
                engine: .unsupported
            )
        }
    }

    /// The web's `canonicalLang`: an alias table, then the key itself.
    public static func canonicalLanguage(_ raw: String?) -> String {
        var key = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while key.hasPrefix(".") { key.removeFirst() }
        return aliases[key] ?? key
    }

    /// The web's `langLabel`.
    public static func label(forLanguage lang: String) -> String {
        if let label = labels[lang] { return label }
        guard let first = lang.first else { return "Text" }
        return first.uppercased() + lang.dropFirst()
    }

    private static let aliases: [String: String] = [
        "js": "javascript", "javascript": "javascript", "mjs": "javascript", "cjs": "javascript", "node": "javascript",
        "ts": "typescript", "typescript": "typescript",
        "jsx": "jsx", "tsx": "tsx", "react": "tsx",
        "py": "python", "python": "python", "python3": "python",
        "html": "html", "htm": "html",
        "svg": "svg",
        "css": "css",
        "mermaid": "mermaid", "mmd": "mermaid",
        "md": "markdown", "markdown": "markdown",
        "sh": "bash", "bash": "bash", "shell": "bash", "zsh": "bash",
        "sql": "sql",
        "go": "go", "golang": "go",
        "rust": "rust", "rs": "rust",
        "c": "c", "c++": "cpp", "cpp": "cpp", "cc": "cpp", "cxx": "cpp",
        "c#": "csharp", "cs": "csharp", "csharp": "csharp",
        "java": "java", "kotlin": "kotlin", "kt": "kotlin", "swift": "swift",
        "ruby": "ruby", "rb": "ruby", "php": "php", "perl": "perl",
        "json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml", "xml": "xml",
        "dockerfile": "dockerfile", "makefile": "makefile", "ini": "ini", "graphql": "graphql",
        "vue": "vue", "svelte": "svelte", "dart": "dart", "r": "r", "lua": "lua", "scala": "scala",
        "elixir": "elixir", "haskell": "haskell",
    ]

    private static let labels: [String: String] = [
        "design": "Design",
        "javascript": "JavaScript", "typescript": "TypeScript", "jsx": "React", "tsx": "React",
        "python": "Python", "html": "HTML", "svg": "SVG", "css": "CSS", "mermaid": "Mermaid", "markdown": "Markdown",
        "bash": "Shell", "sql": "SQL", "go": "Go", "rust": "Rust", "c": "C", "cpp": "C++", "csharp": "C#",
        "java": "Java", "kotlin": "Kotlin", "swift": "Swift", "ruby": "Ruby", "php": "PHP", "perl": "Perl",
        "json": "JSON", "yaml": "YAML", "toml": "TOML", "xml": "XML", "dockerfile": "Dockerfile", "makefile": "Makefile",
        "ini": "INI", "graphql": "GraphQL", "vue": "Vue", "svelte": "Svelte", "dart": "Dart", "r": "R", "lua": "Lua",
        "scala": "Scala", "elixir": "Elixir", "haskell": "Haskell", "plaintext": "Text",
    ]
}

// MARK: - The document

/// The document an artifact runs in — `buildSandboxDoc` from the web's
/// `components/canvas/sandbox-frame.tsx`, ported builder for builder.
///
/// **Same builders, a closed network.** The documents are the web's, builder
/// for builder, so an artifact is laid out and run the same way. What differs
/// is what the page may reach. The web's policy lets a preview pull https
/// scripts, styles, fonts and images (Tailwind, React, Babel and Pyodide from
/// CDNs) — and in production that policy is moot, because the app's own
/// enforcing CSP is inherited into the `srcdoc` frame and no script runs at all
/// (Artifacts & Design audit, X-01). The Mac does not copy that: its preview
/// runs scripts, in a sandbox of its own with **no network** (Phase 2 brief,
/// addendum of 2026-09-23). ``contentSecurityPolicyDirectives`` is the web's
/// list with every `https:` source taken out and `connect-src` and `frame-src`
/// closed; the rule list blocks every scheme but the app's `juno-runtime:`.
/// Opening the network is one switch (``ArtifactRuntimeNetwork/isOpen``), and
/// the web's list comes back with it (``webContentSecurityPolicyDirectives``).
///
/// **What isolates the page.** A `WKWebView` with a non-persistent data store,
/// a nil base URL, no navigation beyond its own document, no popups and no
/// `file:` access (``NativeArtifactRuntimeWebView``). The policy keeps the
/// three capabilities an attack always needs and a preview never does: no
/// `object-src`, no `base-uri`, no `form-action`.
///
/// **One transport, two channels.** The web's shims post to `parent`; there is
/// no parent here, so the status reporter and the console bridge call
/// `__junoPost(m)`, a function the web view defines at document start
/// (``bridgeScript``) over `window.webkit.messageHandlers.juno`. Nothing else
/// crosses: the web's link bridge is left out (a clicked link is the
/// navigation policy's to open), and so is its inspector.
public enum NativeArtifactRuntimeDocument {
    public static let tailwindCDN = "https://cdn.tailwindcss.com"
    public static let reactCDN = "https://unpkg.com/react@18.3.1/umd/react.development.js"
    public static let reactDOMCDN = "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"
    public static let babelCDN = "https://unpkg.com/@babel/standalone/babel.min.js"
    public static let pyodideIndex = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
    /// Served by the app, not a CDN: the web imports Mermaid 11 from jsdelivr;
    /// the Mac bundles the same major version (`Resources/ArtifactRuntime`).
    public static let mermaidScript = "juno-runtime://mermaid.min.js"
    /// The scheme ``mermaidScript`` and anything else bundled is served from.
    public static let runtimeScheme = "juno-runtime"
    /// The message handler the bridge posts to.
    public static let messageHandlerName = "juno"

    /// The web's `SANDBOX_CSP_META` directives, in its order, plus
    /// `juno-runtime:` on `script-src` — the policy for an open network.
    public static let webContentSecurityPolicyDirectives: [String] = [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' https: blob: juno-runtime:",
        "style-src 'unsafe-inline' https:",
        "img-src https: data: blob:",
        "font-src https: data:",
        "media-src https: data: blob:",
        "connect-src https: data: blob:",
        "frame-src https: data: blob:",
        "worker-src blob:",
        "child-src blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ]

    /// The same list for the closed network the Mac runs: no `https:`
    /// anywhere, no fetches, no frames. Inline and `blob:` sources stay, so a
    /// page's own scripts, styles and generated images still work.
    public static let offlineContentSecurityPolicyDirectives: [String] = [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' blob: juno-runtime:",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "media-src data: blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src blob:",
        "child-src blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ]

    public static var contentSecurityPolicyDirectives: [String] {
        ArtifactRuntimeNetwork.isOpen ? webContentSecurityPolicyDirectives : offlineContentSecurityPolicyDirectives
    }

    public static var contentSecurityPolicy: String {
        contentSecurityPolicyDirectives.joined(separator: "; ")
    }

    static var cspMeta: String {
        #"<meta http-equiv="Content-Security-Policy" content="\#(contentSecurityPolicy)">"#
    }

    /// Defines `__junoPost` before any page script runs: the one function the
    /// shims below call instead of `parent.postMessage`. Not enumerable, not
    /// writable, so artifact code cannot swap the transport out from under
    /// its own console.
    public static let bridgeScript = """
    (function(){
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(messageHandlerName);
      try {
        Object.defineProperty(window, '__junoPost', {
          value: function(message){ try { if (handler) handler.postMessage(message); } catch (e) {} },
          configurable: false, enumerable: false, writable: false
        });
      } catch (e) {}
    })();
    """

    /// The web's `buildSandboxDoc(type, content, language)`.
    public static func build(kind: NativeArtifactKind, content: String, language: String?) -> String {
        let runtime = NativeArtifactRuntimeInfo.resolve(kind: kind, language: language)
        if runtime.mode == .console, let engine = runtime.engine {
            return consoleDocument(content, engine: engine, lang: runtime.lang, label: runtime.label)
        }
        switch runtime.lang {
        case "tsx", "jsx":
            return withChrome(reactDocument(content))
        case "html":
            return withChrome(htmlDocument(content), statusLite: true)
        case "svg":
            return withChrome(svgDocument(content), statusLite: true)
        case "css":
            return withChrome(cssDocument(content), statusLite: true)
        case "mermaid":
            return withChrome(mermaidDocument(content), statusLite: true)
        default:
            return withChrome(
                htmlDocument(
                    #"<pre style="padding:16px;white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace">\#(escapeHTML(content))</pre>"#
                ),
                statusLite: true
            )
        }
    }

    // MARK: Shims

    static let baseStyle = "<style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#111}</style>"

    /// Storage and history that do not throw. The web's `SANDBOX_SHIM`: an
    /// opaque origin throws on `localStorage` and `pushState`, and a portfolio
    /// reading a saved theme in an effect crashed its whole preview. A
    /// non-persistent store throws less, but the shim costs nothing where the
    /// real API works — it only steps in when the probe fails.
    static let sandboxShim = """
    <script>
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
          h[m]=function(){try{return orig.apply(h,arguments);}catch(e){}};
        });
      }catch(e){}
    })();
    </script>
    """

    /// The page's console and uncaught errors, forwarded as `juno:console`.
    static let consoleBridge = """
    <script>
    (function(){
      function ser(a){try{return typeof a==='string'?a:(a instanceof Error?(a.stack||a.message):JSON.stringify(a,null,2));}catch(e){return String(a);}}
      function send(level,args){try{__junoPost({type:'juno:console',level:level,text:Array.prototype.map.call(args,ser).join(' ')});}catch(e){}}
      ['log','info','warn','error','debug'].forEach(function(k){var o=console[k]?console[k].bind(console):function(){};console[k]=function(){send(k==='debug'?'log':k,arguments);o.apply(null,arguments);};});
      window.addEventListener('error',function(e){send('error',[e.message+(e.filename?' ('+e.lineno+':'+e.colno+')':'')]);});
      window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection: '+ser(e.reason)]);});
    })();
    </script>
    """

    /// Loading → done on load, for documents with no runtime of their own. An
    /// uncaught exception before load is a render failure; a dead image or a
    /// 404'd CDN script is not.
    static let statusLite = """
    <script>
    (function(){
      var failed=false;
      function post(s){try{__junoPost({type:'juno:status',status:s,detail:''});}catch(e){}}
      post('loading');
      window.addEventListener('error',function(e){
        if(e instanceof ErrorEvent && document.readyState!=='complete'){failed=true;post('error');}
      });
      window.addEventListener('load',function(){setTimeout(function(){if(!failed)post('done');},0);});
    })();
    </script>
    """

    // MARK: Composition

    /// The policy first — after the charset declaration when there is one,
    /// otherwise straight after `<head>` — so everything the author put in the
    /// head is inside it too.
    static func insertPolicy(_ document: String) -> String {
        if let charset = document.range(of: #"<meta[^>]+charset[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            var out = document
            out.insert(contentsOf: cspMeta, at: charset.upperBound)
            return out
        }
        if let head = document.range(of: #"<head[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            var out = document
            out.insert(contentsOf: cspMeta, at: head.upperBound)
            return out
        }
        return cspMeta + document
    }

    /// The web's `withChrome`: the shim, the status reporter and the console
    /// bridge before `</head>`. The web also injects a link bridge and an
    /// element inspector; the Mac leaves both out (see the type's note).
    static func withChrome(_ document: String, statusLite includeStatus: Bool = false) -> String {
        let chrome = sandboxShim + (includeStatus ? statusLite : "") + consoleBridge
        let withPolicy = insertPolicy(document)
        guard let head = withPolicy.range(of: "</head>") else { return chrome + withPolicy }
        var out = withPolicy
        out.insert(contentsOf: chrome, at: head.lowerBound)
        return out
    }

    // MARK: Builders

    static func htmlDocument(_ code: String) -> String {
        if code.range(of: #"<html[\s>]"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return code
        }
        return #"<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><script src="\#(tailwindCDN)"></script>\#(baseStyle)</head><body>\#(code)</body></html>"#
    }

    static func svgDocument(_ code: String) -> String {
        #"<!doctype html><html><head><meta charset="utf-8"/>\#(baseStyle)<style>body{display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:100%;height:auto}</style></head><body>\#(code)</body></html>"#
    }

    static func cssDocument(_ code: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
        <style>\(code)</style></head>
        <body>
        <main style="font-family:ui-sans-serif,system-ui,sans-serif;padding:24px;max-width:720px;margin:0 auto;line-height:1.6">
        <h1>Heading one</h1><h2>Heading two</h2>
        <p>A paragraph with a <a href="#">link</a>, <strong>bold</strong>, <em>italic</em>, and <code>inline code</code>.</p>
        <p><button>Button</button> <input placeholder="Input"/></p>
        <ul><li>List item one</li><li>List item two</li></ul>
        <blockquote>A block quote to preview.</blockquote>
        <div class="card">A .card element</div>
        </main></body></html>
        """
    }

    /// The web imports Mermaid 11 as a module from jsdelivr; the Mac loads the
    /// bundled build from `juno-runtime:` and starts it the same way.
    static func mermaidDocument(_ code: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8"/>\(baseStyle)<style>body{display:grid;place-items:center;min-height:100vh;padding:16px}</style></head>
        <body><pre class="mermaid">\(escapeScriptClose(code))</pre>
        <script src="\(mermaidScript)"></script>
        <script>
        (function(){
          if (!window.mermaid) { console.error('Couldn’t load the Mermaid engine.'); return; }
          mermaid.initialize({ startOnLoad: true });
        })();
        </script></body></html>
        """
    }

    static func reactDocument(_ code: String) -> String {
        let inferred = firstComponentName(code)
        let cleaned = replacing(
            #"^\s*export\s+(const|let|var|function|class)\s"#,
            in: replacing(
                #"export\s+default\s+"#,
                in: replacing(
                    #"export\s+default\s+class"#,
                    in: replacing(#"export\s+default\s+function"#, in: stripImports(code), with: "window.__Component = function"),
                    with: "window.__Component = class"
                ),
                with: "window.__Component = "
            ),
            with: "$1 ",
            options: [.anchorsMatchLines]
        )
        let inferredAssignment = inferred.map {
            "\ntry{ if (!window.__Component && typeof \($0) === \"function\") window.__Component = \($0); }catch(e){}\n"
        } ?? ""
        let preamble = "const {useState,useEffect,useRef,useMemo,useCallback,useReducer,useContext,useLayoutEffect,createContext,Fragment,forwardRef,memo}=React;\n"
            + lucideIconPreamble(code)
        let inferredLiteral = jsonLiteral(inferred)

        return """
        <!doctype html><html><head><meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <script src="\(tailwindCDN)"></script>
        <script src="\(reactCDN)"></script>
        <script src="\(reactDOMCDN)"></script>
        <script src="\(babelCDN)"></script>
        \(baseStyle)</head>
        <body><div id="root"></div>
        <script type="text/plain" id="__src">\(escapeScriptClose(preamble + cleaned + inferredAssignment))</script>
        <script>
        (function(){
          var root = document.getElementById('root');
          function status(s,detail){try{__junoPost({type:'juno:status',status:s,detail:detail||''});}catch(e){}}
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
              filename: 'artifact.tsx',
              presets: [
                [Babel.availablePresets['react'], { runtime: 'classic' }],
                [Babel.availablePresets['typescript'], { onlyRemoveTypeImports: true }]
              ]
            }).code;
            (0, eval)(out);
          } catch (e) { failError(e); return; }
          var C = window.__Component;
          if (!C && \(inferredLiteral) && typeof window[\(inferredLiteral)] === 'function') C = window[\(inferredLiteral)];
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
        </script></body></html>
        """
    }

    // MARK: Console runtimes

    /// Pure-Python wheels micropip can install for the imports a script names,
    /// in the web's order (`PY_WHEELS`).
    static let pythonWheelsJSON = #"{"fpdf":"fpdf2","reportlab":"reportlab","pypdf":"pypdf","docx":"python-docx","pptx":"python-pptx","markdown":"markdown","markdownify":"markdownify","tabulate":"tabulate","qrcode":"qrcode","pydantic":"pydantic","dateutil":"python-dateutil","jinja2":"Jinja2"}"#

    static let terminalStyle = """
    <style>
    :root{color-scheme:dark}
    html,body{margin:0;height:100%;background:#0b0b0e;color:#e7e7ea}
    #wrap{display:flex;flex-direction:column;height:100%;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    #bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1e1e24;background:#111117;color:#9a9aa4;font-size:11px;letter-spacing:.02em;flex:0 0 auto}
    #dot{width:8px;height:8px;border-radius:50%;background:#f5a524;box-shadow:0 0 8px currentColor}
    #term{flex:1 1 auto;overflow:auto;padding:12px 14px;white-space:pre-wrap;word-break:break-word}
    .ln{display:block;padding:1px 0}
    .log{color:#e7e7ea}.info{color:#7dd3fc}.warn{color:#fbbf24}.error{color:#f87171}.muted{color:#6b6b76}.result{color:#a7f3d0}
    .error::selection{background:#7f1d1d}
    </style>
    """

    /// A self-contained dark terminal that runs JavaScript, TypeScript or
    /// Python and streams what it prints — the web's `consoleDoc`.
    static func consoleDocument(
        _ rawCode: String,
        engine: NativeArtifactRuntimeInfo.Engine,
        lang: String,
        label: String?
    ) -> String {
        let code = engine == .python
            ? rawCode
            : replacing(#"^[ \t]*export\s+(default\s+)?"#, in: stripImports(rawCode), with: "", options: [.anchorsMatchLines])
        let runtimeLabel = jsonLiteral(label ?? lang)
        let boot: String
        switch engine {
        case .unsupported:
            boot = """
              line('Browser execution is not available for '+\(runtimeLabel)+' artifacts yet.','warn');
              line('The source is loaded and the Code tab can copy or download it for a local compiler/runtime.','muted');
              status('done','Ready');
            """
        case .python:
            boot = """
              status('loading','Loading Python…');
              var s=document.createElement('script'); s.src='\(pyodideIndex)pyodide.js';
              s.onload=function(){
                var py=null;
                loadPyodide({indexURL:'\(pyodideIndex)'}).then(function(p){
                  py=p;
                  py.setStdout({batched:function(t){line(t,'log');}});
                  py.setStderr({batched:function(t){line(t,'error');}});
                  status('loading','Loading packages…');
                  return py.loadPackagesFromImports(raw).catch(function(){});
                }).then(function(){
                  var wanted=\(pythonWheelsJSON);
                  var imported={};
                  var re=/^[ \\t]*(?:from[ \\t]+([A-Za-z_][\\w]*)|import[ \\t]+([A-Za-z_][\\w]*))/gm, m;
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
                  var before={};
                  try{ py.FS.readdir('.').forEach(function(n){ before[n]=true; }); }catch(e){}
                  return py.runPythonAsync(raw).then(function(){ return before; });
                }).then(function(before){
                  offerFiles(py, before);
                  status('done','Done');
                }).catch(function(e){printErr(e);status('error','Error');});
              };
              s.onerror=function(){printErr('Couldn’t load the Python runtime (offline?).');status('error','Error');};
              document.head.appendChild(s);
            """
        case .js:
            let run = lang == "typescript"
                ? """
                  if(!window.Babel){printErr('Couldn’t load the TypeScript compiler (offline?).');status('error','Error');}
                     else{try{body=Babel.transform(body,{filename:'a.ts',presets:[[Babel.availablePresets['typescript'],{onlyRemoveTypeImports:true}]]}).code;}catch(e){printErr(e);status('error','Error');body=null;}}
                     if(body!==null) run(body);
                  """
                : "run(body);"
            boot = """
              function run(js){
                status('running','Running');
                var wrapped='(async function(){\\n'+js+'\\n})()';
                try{
                  Promise.resolve((0,eval)(wrapped)).then(function(v){ if(v!==undefined) line(fmt(v),'result'); status('done','Done'); })
                    .catch(function(e){printErr(e);status('error','Error');});
                }catch(e){printErr(e);status('error','Error');}
              }
              var body=raw;
              \(run)
            """
        }

        let babel = lang == "typescript" ? #"<script src="\#(babelCDN)"></script>"# : ""
        return """
        <!doctype html><html><head><meta charset="utf-8"/>\(cspMeta)\(sandboxShim)\(terminalStyle)\(babel)</head>
        <body><div id="wrap"><div id="bar"><span id="dot"></span><span id="label">\(escapeHTML(label ?? lang))</span><span id="st" style="margin-left:auto"></span></div><div id="term"></div></div>
        <script type="text/plain" id="__src">\(escapeScriptClose(code))</script>
        <script>
        (function(){
          var term=document.getElementById('term'), st=document.getElementById('st'), dot=document.getElementById('dot');
          var raw=document.getElementById('__src').textContent;
          function fmt(v){try{return typeof v==='string'?v:JSON.stringify(v,null,2);}catch(e){return String(v);}}
          function line(text,cls){var d=document.createElement('span');d.className='ln '+(cls||'log');d.textContent=text;term.appendChild(d);term.scrollTop=term.scrollHeight;try{__junoPost({type:'juno:console',level:cls==='result'?'log':(cls||'log'),text:text});}catch(e){}}
          function printErr(e){line((e&&e.stack)?e.stack:(e&&e.message?e.message:String(e)),'error');}
          function status(s,detail){st.textContent=detail||s;dot.style.background=s==='done'?'#34d399':s==='error'?'#f87171':s==='running'?'#38bdf8':'#f5a524';try{__junoPost({type:'juno:status',status:s,detail:detail||''});}catch(e){}}
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
        \(boot)
        })();
        </script></body></html>
        """
    }

    // MARK: Source transforms

    /// Removes ESM `import` statements — multi-line `import { … } from "x"`
    /// and side-effect `import "x"` included — because the sandbox runs code as
    /// a classic script with React and its hooks as globals.
    static func stripImports(_ code: String) -> String {
        replacing(importPattern, in: code, with: "", options: [.anchorsMatchLines])
    }

    static let importPattern = #"^[ \t]*import\b[\s\S]*?(?:from[ \t]*['"][^'"]*['"]|['"][^'"]*['"])[ \t]*;?[ \t]*\r?\n?"#

    /// The component the source defines, for a module that never says
    /// `export default`.
    static func firstComponentName(_ code: String) -> String? {
        let patterns = [
            #"\bexport\s+default\s+(?:function|class)\s+([A-Z][A-Za-z0-9_$]*)\b"#,
            #"(?:^|[\r\n;])\s*(?:function|class)\s+([A-Z][A-Za-z0-9_$]*)\b"#,
            #"(?:^|[\r\n;])\s*(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>"#,
        ]
        for pattern in patterns {
            if let name = firstCapture(pattern, in: code) { return name }
        }
        return nil
    }

    struct LucideBinding: Equatable {
        let local: String
        let icon: String
        var namespace = false
    }

    /// The names a `lucide-react` import binds, so each can be drawn by the
    /// small shape table below instead of failing as an undefined global.
    static func lucideBindings(_ code: String) -> [LucideBinding] {
        guard let expression = try? NSRegularExpression(pattern: importPattern, options: [.anchorsMatchLines]) else { return [] }
        let source = code as NSString
        var order: [String] = []
        var bindings: [String: LucideBinding] = [:]
        func set(_ binding: LucideBinding) {
            if bindings[binding.local] == nil { order.append(binding.local) }
            bindings[binding.local] = binding
        }
        for match in expression.matches(in: code, range: NSRange(location: 0, length: source.length)) {
            let statement = source.substring(with: match.range)
            guard statement.range(of: #"from[ \t]*['"]lucide-react['"]|['"]lucide-react['"]"#, options: .regularExpression) != nil else { continue }
            if let namespace = firstCapture(#"\*\s+as\s+([A-Za-z_$][\w$]*)"#, in: statement) {
                set(LucideBinding(local: namespace, icon: namespace, namespace: true))
            }
            guard let named = firstCapture(#"\{([\s\S]*?)\}"#, in: statement) else { continue }
            for raw in named.split(separator: ",") {
                var spec = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if spec.hasPrefix("type ") { spec = String(spec.dropFirst(5)).trimmingCharacters(in: .whitespaces) }
                guard !spec.isEmpty else { continue }
                let parts = spec.components(separatedBy: " as ").map { $0.trimmingCharacters(in: .whitespaces) }
                let icon = parts[0]
                let local = parts.count > 1 && !parts[1].isEmpty ? parts[1] : icon
                if local.range(of: #"^[A-Z_$][\w$]*$"#, options: .regularExpression) != nil, local != "LucideIcon" {
                    set(LucideBinding(local: local, icon: icon))
                }
            }
        }
        return order.compactMap { bindings[$0] }
    }

    static func lucideIconPreamble(_ code: String) -> String {
        let iconBindings = lucideBindings(code)
        guard !iconBindings.isEmpty else { return "" }
        let bindings = iconBindings.map { binding in
            binding.namespace
                ? "const \(binding.local) = new Proxy({}, { get: function(_, iconName){ return __JunoLucideIconFactory(String(iconName)); } });"
                : "const \(binding.local) = __JunoLucideIconFactory(\(jsonLiteral(binding.icon)));"
        }.joined(separator: "\n")
        return """

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
        \(bindings)

        """
    }

    // MARK: Helpers

    /// `</script` inside a script body ends the element wherever it appears,
    /// string literals included; `<\/script` is the same text to JavaScript
    /// and not a closing tag to the HTML tokenizer. The web's `esc`.
    static func escapeScriptClose(_ text: String) -> String {
        replacing(#"</script"#, in: text, with: #"<\\/script"#, options: [.caseInsensitive])
    }

    static func escapeHTML(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// `JSON.stringify` of an optional string: a quoted literal, or `null`.
    static func jsonLiteral(_ value: String?) -> String {
        guard let value,
            let data = try? JSONEncoder().encode(value),
            let literal = String(data: data, encoding: .utf8)
        else { return "null" }
        // JSONEncoder escapes "/" as "\/"; JSON.stringify does not.
        return literal.replacingOccurrences(of: #"\/"#, with: "/")
    }

    static func replacing(
        _ pattern: String,
        in text: String,
        with template: String,
        options: NSRegularExpression.Options = []
    ) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        return expression.stringByReplacingMatches(
            in: text,
            range: NSRange(location: 0, length: (text as NSString).length),
            withTemplate: template
        )
    }

    static func firstCapture(_ pattern: String, in text: String) -> String? {
        guard let expression = try? NSRegularExpression(pattern: pattern),
            let match = expression.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)),
            match.numberOfRanges > 1,
            match.range(at: 1).location != NSNotFound
        else { return nil }
        return (text as NSString).substring(with: match.range(at: 1))
    }
}

// MARK: - What the page says

/// One message from a running artifact, validated.
///
/// Two channels and no more: the run's status (with its errors) and the
/// console. Anything else a page posts is dropped.
public enum ArtifactRuntimeMessage: Equatable, Sendable {
    case status(ArtifactRuntimeStatus, detail: String?)
    case console(ArtifactRuntimeLevel, String)

    /// Decodes a `WKScriptMessage` body. The sender is artifact code, so every
    /// field is re-checked here rather than trusted: an unknown type is
    /// dropped, and a level outside the four is a log.
    public static func decode(_ body: Any) -> Self? {
        guard let object = body as? [String: Any], let type = object["type"] as? String else { return nil }
        switch type {
        case "juno:status":
            let raw = object["status"] as? String ?? ""
            let status = ArtifactRuntimeStatus(rawValue: raw) ?? .idle
            let detail = (object["detail"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(200)) }
            return .status(status, detail: detail)
        case "juno:console":
            let level = ArtifactRuntimeLevel(rawValue: object["level"] as? String ?? "") ?? .log
            let text = object["text"].map { $0 as? String ?? String(describing: $0) } ?? ""
            return .console(level, text)
        default:
            return nil
        }
    }
}

public enum ArtifactRuntimeStatus: String, Equatable, Sendable {
    case idle, loading, running, done, error
}

public enum ArtifactRuntimeLevel: String, Equatable, Sendable {
    case log, info, warn, error
}

/// What a running artifact has said so far: its status, its console, and how
/// many errors it has thrown — the state the web keeps beside each
/// `SandboxFrame` (`runStatus`, `consoleEntries`).
///
/// One per loaded document. A new document resets it (``reset()``), so a
/// console line never outlives the page that printed it.
@MainActor
@Observable
public final class ArtifactRuntimeModel {
    public struct Entry: Identifiable, Equatable, Sendable {
        public let id: Int
        public let level: ArtifactRuntimeLevel
        public let text: String
    }

    /// The web's cap: past 150 lines, keep the newest 120 and carry on.
    public static let maximumEntries = 150
    public static let retainedEntries = 120
    /// One line is at most this many characters; a page that logs a megabyte
    /// of JSON gets its first two thousand characters shown.
    public static let maximumCharacters = 2_000

    public private(set) var status: ArtifactRuntimeStatus = .idle
    public private(set) var detail: String?
    public private(set) var entries: [Entry] = []
    public private(set) var errorCount = 0
    private var nextID = 0

    public init() {}

    public func reset() {
        status = .idle
        detail = nil
        entries = []
        errorCount = 0
    }

    public func apply(_ message: ArtifactRuntimeMessage) {
        switch message {
        case .status(let status, let detail):
            self.status = status
            self.detail = detail
        case .console(let level, let text):
            append(level: level, text: text)
        }
    }

    public func append(level: ArtifactRuntimeLevel, text: String) {
        if entries.count > Self.maximumEntries {
            entries = Array(entries.suffix(Self.retainedEntries))
        }
        let clipped = text.count > Self.maximumCharacters
            ? String(text.prefix(Self.maximumCharacters)) + "…"
            : text
        entries.append(Entry(id: nextID, level: level, text: clipped))
        nextID += 1
        if level == .error { errorCount += 1 }
    }
}
