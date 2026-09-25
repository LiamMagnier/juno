import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import XCTest
@testable import JunoChatKit

// MARK: - Which runtime

final class NativeArtifactRuntimeInfoTests: XCTestCase {
    func testRegistryTypesWinOverTheLanguageHint() {
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .react, language: "python"),
                       NativeArtifactRuntimeInfo(mode: .web, lang: "tsx", label: "React"))
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .html, language: nil).label, "HTML")
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .mermaid, language: nil).lang, "mermaid")
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .design, language: nil).mode, .design)
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .markdown, language: nil).label, "Markdown")
    }

    func testCodeRoutesByLanguageAsTheWebDoes() {
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "py").engine, .python)
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "TypeScript").label, "TypeScript")
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "jsx").mode, .web)
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "css").mode, .web)
        let go = NativeArtifactRuntimeInfo.resolve(kind: .code, language: "golang")
        XCTAssertEqual(go.mode, .console)
        XCTAssertEqual(go.engine, .unsupported)
        XCTAssertEqual(go.label, "Go")
        let unknown = NativeArtifactRuntimeInfo.resolve(kind: .code, language: nil)
        XCTAssertEqual(unknown.lang, "plaintext")
        XCTAssertEqual(unknown.label, "Text")
        XCTAssertEqual(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "zig").label, "Zig")
    }
}

// MARK: - The document

final class NativeArtifactRuntimeDocumentTests: XCTestCase {
    /// The web's `SANDBOX_CSP_META` directives (`sandbox-frame.tsx`), word
    /// for word.
    private let webPolicy = [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
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

    /// Opened, the Mac's policy is the web's plus its bundled scheme.
    func testTheOpenPolicyIsTheWebsWithTheBundledSchemeAdded() {
        var expected = webPolicy
        expected[1] = "script-src 'unsafe-inline' 'unsafe-eval' https: blob: juno-runtime:"
        XCTAssertEqual(NativeArtifactRuntimeDocument.webContentSecurityPolicyDirectives, expected)
    }

    /// Closed — as it ships — it is the same list with every `https:` source
    /// removed, and no fetches or frames at all.
    func testTheShippingPolicyIsTheWebsWithTheNetworkTakenOut() {
        XCTAssertFalse(ArtifactRuntimeNetwork.isOpen)
        let offline = NativeArtifactRuntimeDocument.offlineContentSecurityPolicyDirectives
        XCTAssertEqual(NativeArtifactRuntimeDocument.contentSecurityPolicyDirectives, offline)
        XCTAssertEqual(offline.count, webPolicy.count)
        for (mac, web) in zip(offline, webPolicy) {
            XCTAssertFalse(mac.contains("https:"), mac)
            let name = String(web.split(separator: " ").first!)
            XCTAssertTrue(mac.hasPrefix(name + " "), "\(mac) is not \(name)")
            if name == "connect-src" || name == "frame-src" {
                XCTAssertEqual(mac, "\(name) 'none'")
            } else if name == "script-src" {
                XCTAssertEqual(mac, "script-src 'unsafe-inline' 'unsafe-eval' blob: juno-runtime:")
            } else {
                XCTAssertEqual(mac, web.replacingOccurrences(of: " https:", with: ""))
            }
        }
        let document = NativeArtifactRuntimeDocument.build(kind: .html, content: "<p>x</p>", language: nil)
        XCTAssertTrue(document.contains(NativeArtifactRuntimeDocument.contentSecurityPolicy))
    }

    func testAnHTMLFragmentGetsTailwindAndThePolicyFirst() {
        let document = NativeArtifactRuntimeDocument.build(kind: .html, content: "<div class=\"p-4\">Hi</div>", language: nil)
        // The web's rule — a fragment gets Tailwind Play — with the bundled copy.
        XCTAssertTrue(document.contains(#"<script src="juno-runtime://tailwind.play.js"></script>"#))
        XCTAssertFalse(document.contains("cdn.tailwindcss.com"))
        let charset = try? XCTUnwrap(document.range(of: #"<meta charset="utf-8"/>"#))
        let policy = try? XCTUnwrap(document.range(of: "Content-Security-Policy"))
        XCTAssertNotNil(charset)
        XCTAssertNotNil(policy)
        if let charset, let policy { XCTAssertLessThan(charset.upperBound, policy.lowerBound) }
        // The shim, the status reporter and the console bridge, before
        // </head>, posting through the native bridge — and nothing else: no
        // link bridge, no inspector.
        XCTAssertTrue(document.contains("juno:console"))
        XCTAssertTrue(document.contains("juno:status"))
        XCTAssertFalse(document.contains("juno:open"))
        XCTAssertFalse(document.contains("juno:inspect"))
        XCTAssertTrue(document.contains("__juno_probe__"))
        XCTAssertFalse(document.contains("parent.postMessage"))
        let chrome = try? XCTUnwrap(document.range(of: "__juno_probe__"))
        let head = try? XCTUnwrap(document.range(of: "</head>"))
        if let chrome, let head { XCTAssertLessThan(chrome.lowerBound, head.lowerBound) }
    }

    func testAFullDocumentKeepsItsOwnHeadWithThePolicyAheadOfIt() {
        let source = #"<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head><body>x</body></html>"#
        let document = NativeArtifactRuntimeDocument.build(kind: .html, content: source, language: nil)
        XCTAssertFalse(document.contains("tailwind"), "a full document is the author's own")
        let policy = document.range(of: "Content-Security-Policy")!.lowerBound
        let stylesheet = document.range(of: "fonts.googleapis.com")!.lowerBound
        XCTAssertLessThan(policy, stylesheet)
    }

    func testReactModuleSyntaxBecomesAGlobalComponent() {
        let source = """
        import React, { useState } from "react";
        import {
          Check,
          Copy as CopyIcon
        } from 'lucide-react';
        import "./styles.css";

        export const Title = () => <h1>Hi</h1>;

        export default function App() {
          const [n, setN] = useState(0);
          return <button onClick={() => setN(n + 1)}>{n}</button>;
        }
        """
        let document = NativeArtifactRuntimeDocument.build(kind: .react, content: source, language: "tsx")
        XCTAssertFalse(document.contains("from \"react\""))
        XCTAssertFalse(document.contains("import \"./styles.css\""))
        XCTAssertTrue(document.contains("window.__Component = function App()"))
        XCTAssertTrue(document.contains("const Title = () =>"))
        XCTAssertFalse(document.contains("export const"))
        XCTAssertTrue(document.contains(#"const Check = __JunoLucideIconFactory("Check");"#))
        XCTAssertTrue(document.contains(#"const CopyIcon = __JunoLucideIconFactory("Copy");"#))
        XCTAssertTrue(document.contains(#"typeof window["App"] === 'function'"#))
    }

    /// The web's `reactDoc`, with its four runtimes from the bundle in the
    /// web's order — Tailwind, React, ReactDOM, Babel — and compiled with the
    /// web's presets.
    func testAReactDocumentLoadsTheBundledRuntimesWithTheWebsPresets() throws {
        let document = NativeArtifactRuntimeDocument.build(kind: .react, content: "export default function App() { return <p/> }", language: nil)
        let order = try [
            NativeArtifactRuntimeDocument.tailwindScript,
            NativeArtifactRuntimeDocument.reactScript,
            NativeArtifactRuntimeDocument.reactDOMScript,
            NativeArtifactRuntimeDocument.babelScript,
        ].map { try XCTUnwrap(document.range(of: #"<script src="\#($0)"></script>"#), $0).lowerBound }
        XCTAssertEqual(order, order.sorted())
        XCTAssertEqual(NativeArtifactRuntimeDocument.reactScript, "juno-runtime://react.development.js")
        XCTAssertEqual(NativeArtifactRuntimeDocument.reactDOMScript, "juno-runtime://react-dom.development.js")
        XCTAssertEqual(NativeArtifactRuntimeDocument.babelScript, "juno-runtime://babel.min.js")
        XCTAssertEqual(NativeArtifactRuntimeDocument.tailwindScript, "juno-runtime://tailwind.play.js")
        XCTAssertTrue(document.contains("filename: 'artifact.tsx'"))
        XCTAssertTrue(document.contains("[Babel.availablePresets['react'], { runtime: 'classic' }]"))
        XCTAssertTrue(document.contains("[Babel.availablePresets['typescript'], { onlyRemoveTypeImports: true }]"))
        XCTAssertTrue(document.contains("ReactDOM.createRoot(root).render(React.createElement(ErrorBoundary"))
        // The chrome — shim, console bridge, height reporter — follows the
        // runtimes, as the web's `withChrome` puts it before `</head>`.
        let babel = try XCTUnwrap(document.range(of: NativeArtifactRuntimeDocument.babelScript))
        let bridge = try XCTUnwrap(document.range(of: "juno:console"))
        XCTAssertLessThan(babel.lowerBound, bridge.lowerBound)
        XCTAssertTrue(document.contains("juno:size"))
    }

    /// No document the Mac builds names the network: every URL in it is the
    /// bundle's. The artifacts carry no URLs of their own here — an author's
    /// own `https:` link is the rule list's to refuse — except the CDN builds
    /// a full page loads itself, which are pointed at the bundle.
    func testEveryDocumentReferencesOnlyTheBundle() throws {
        let fullPage = """
            <!doctype html><html><head><meta charset="utf-8">
            <script src="https://cdn.tailwindcss.com"></script>
            <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
            <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            </head><body><div id="root" class="p-4"></div>
            <script type="text/babel">ReactDOM.createRoot(document.getElementById('root')).render(<b>Hi</b>);</script>
            </body></html>
            """
        let cases: [(NativeArtifactKind, String?, String)] = [
            (.html, nil, #"<div class="p-4 text-red-600">Hi</div>"#),
            (.html, nil, fullPage),
            (.react, nil, "export default function App() { const [n] = useState(1); return <p className=\"p-4\">{n}</p> }"),
            (.code, "jsx", "function App() { return <p>Hi</p> }"),
            (.code, "tsx", "type P = { n: number }; export default function App({ n = 1 }: P) { return <p>{n}</p> }"),
            (.code, "typescript", "const x: number = 1; console.log(x)"),
            (.code, "javascript", "console.log(1)"),
            (.code, "python", "print(1)"),
            (.code, "go", "package main"),
            (.svg, nil, #"<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>"#),
            (.code, "css", ".card{color:red}"),
            (.mermaid, nil, "graph TD; A-->B"),
        ]
        let url = try NSRegularExpression(pattern: #"[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>)]*"#)
        for (kind, language, content) in cases {
            let document = NativeArtifactRuntimeDocument.build(kind: kind, content: content, language: language)
            let text = document as NSString
            let urls = url.matches(in: document, range: NSRange(location: 0, length: text.length)).map { text.substring(with: $0.range) }
            for found in urls {
                XCTAssertTrue(found.hasPrefix("juno-runtime://"), "\(kind) \(language ?? "-") names \(found)")
            }
            XCTAssertFalse(document.contains("//unpkg.com") || document.contains("//cdn."), "\(kind) \(language ?? "-") names a CDN")
            XCTAssertTrue(document.contains("connect-src 'none'"), "\(kind) \(language ?? "-") keeps the network closed")
        }
    }

    /// A full page that loads the web's runtimes itself gets the bundled
    /// builds; its SRI hash (which names the CDN's bytes) goes, `crossorigin`
    /// stays, and anything the Mac does not bundle is left for the rules to
    /// refuse.
    func testAFullPagesOwnCDNRuntimesPointAtTheBundle() {
        let page = """
            <!doctype html><html><head>
            <script src='https://cdn.tailwindcss.com/3.4.17?plugins=forms'></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js" integrity="sha512-abc" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
            <script SRC=https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js></script>
            <script src="https://unpkg.com/@babel/standalone@7.24.0/babel.min.js"></script>
            <script src="https://unpkg.com/react@17/umd/react.development.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
            <script data-src="https://cdn.tailwindcss.com"></script>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            </head><body></body></html>
            """
        let out = NativeArtifactRuntimeDocument.pointingAtBundledRuntimes(page)
        XCTAssertTrue(out.contains("<script src='juno-runtime://tailwind.play.js'></script>"))
        XCTAssertTrue(out.contains(#"<script src="juno-runtime://react.development.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script>"#))
        XCTAssertTrue(out.contains("<script SRC=juno-runtime://react-dom.development.js></script>"))
        XCTAssertTrue(out.contains(#"<script src="juno-runtime://babel.min.js"></script>"#))
        XCTAssertFalse(out.contains("integrity"))
        // Not bundled: React 17, Tailwind 4's browser build, Chart.js, and an
        // attribute that only looks like a source.
        XCTAssertTrue(out.contains("https://unpkg.com/react@17/umd/react.development.js"))
        XCTAssertTrue(out.contains("https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"))
        XCTAssertTrue(out.contains("https://cdn.jsdelivr.net/npm/chart.js"))
        XCTAssertTrue(out.contains(#"<script data-src="https://cdn.tailwindcss.com"></script>"#))

        XCTAssertEqual(NativeArtifactRuntimeDocument.bundledScript(forCDN: "https://unpkg.com/@babel/standalone"), NativeArtifactRuntimeDocument.babelScript)
        XCTAssertEqual(NativeArtifactRuntimeDocument.bundledScript(forCDN: "//cdn.tailwindcss.com"), NativeArtifactRuntimeDocument.tailwindScript)
        XCTAssertNil(NativeArtifactRuntimeDocument.bundledScript(forCDN: "https://cdn.tailwindcss.com.evil.example/x.js"))
        XCTAssertNil(NativeArtifactRuntimeDocument.bundledScript(forCDN: "https://unpkg.com/babel-standalone@6/babel.min.js"))
        XCTAssertNil(NativeArtifactRuntimeDocument.bundledScript(forCDN: "https://unpkg.com/react@18/index.js"))
    }

    func testAComponentWithNoExportIsStillFound() {
        XCTAssertEqual(NativeArtifactRuntimeDocument.firstComponentName("function Dashboard() { return null }"), "Dashboard")
        XCTAssertEqual(NativeArtifactRuntimeDocument.firstComponentName("const Card = (props) => null"), "Card")
        XCTAssertNil(NativeArtifactRuntimeDocument.firstComponentName("const helper = 3"))
        let document = NativeArtifactRuntimeDocument.build(kind: .react, content: "const Card = () => <p/>", language: nil)
        XCTAssertTrue(document.contains(#"if (!window.__Component && typeof Card === "function") window.__Component = Card;"#))
    }

    func testAScriptCloseInsideTheSourceCannotEndTheBlock() {
        let document = NativeArtifactRuntimeDocument.build(kind: .react, content: #"const s = "</script><b>";"#, language: nil)
        XCTAssertTrue(document.contains(#"<\/script><b>"#))
    }

    func testMermaidLoadsTheBundledEngine() {
        let document = NativeArtifactRuntimeDocument.build(kind: .mermaid, content: "graph TD; A-->B", language: nil)
        XCTAssertTrue(document.contains(#"<script src="juno-runtime://mermaid.min.js"></script>"#))
        XCTAssertTrue(document.contains(#"<pre class="mermaid">graph TD; A-->B</pre>"#))
        XCTAssertFalse(document.contains("cdn.jsdelivr.net/npm/mermaid"))
    }

    func testConsoleRuntimes() {
        // Pyodide is not bundled: the page says so rather than reach jsdelivr.
        let python = NativeArtifactRuntimeDocument.build(kind: .code, content: "print(1)", language: "python")
        XCTAssertFalse(python.contains(NativeArtifactRuntimeDocument.pyodideIndex))
        XCTAssertTrue(python.contains("Python does not run on this Mac yet"))
        XCTAssertTrue(python.contains(#"<span id="label">Python</span>"#))
        let go = NativeArtifactRuntimeDocument.build(kind: .code, content: "package main", language: "go")
        XCTAssertTrue(go.contains("Browser execution is not available for "))
        XCTAssertTrue(go.contains(#"<span id="label">Go</span>"#))
        // TypeScript compiles with the bundled Babel and the web's preset.
        let typescript = NativeArtifactRuntimeDocument.build(kind: .code, content: "export const x: number = 1", language: "ts")
        XCTAssertTrue(typescript.contains(#"<script src="juno-runtime://babel.min.js"></script>"#))
        XCTAssertTrue(typescript.contains("filename:'a.ts',presets:[[Babel.availablePresets['typescript'],{onlyRemoveTypeImports:true}]]"))
        XCTAssertFalse(typescript.contains("export const"))
        let javascript = NativeArtifactRuntimeDocument.build(kind: .code, content: "console.log(1)", language: "js")
        XCTAssertFalse(javascript.contains("babel"), "plain JavaScript needs no compiler")
    }

    func testCSSGetsASampleToStyle() {
        let document = NativeArtifactRuntimeDocument.build(kind: .code, content: ".card{color:red}", language: "css")
        XCTAssertTrue(document.contains(#"<div class="card">A .card element</div>"#))
    }

    /// Library tiles stay inert whatever the transcript does.
    func testThumbnailsKeepScriptsOffAndTheNetworkClosed() {
        let thumbnail = NativeArtifactSandbox.document(kind: .html, content: "<p>x</p>", policy: .thumbnail)
        XCTAssertTrue(thumbnail.contains("script-src 'none'"))
        XCTAssertTrue(thumbnail.contains("connect-src 'none'"))
        XCTAssertFalse(thumbnail.contains("cdn.tailwindcss.com"))
        // `.inline` is the runtime; `.document` keeps the isolated posture.
        XCTAssertEqual(
            NativeArtifactSandbox.document(kind: .html, content: "<p>x</p>", policy: .inline),
            NativeArtifactRuntimeDocument.build(kind: .html, content: "<p>x</p>", language: nil)
        )
        XCTAssertTrue(NativeArtifactSandbox.document(kind: .html, content: "<p>x</p>").contains("connect-src 'none'"))
    }
}

// MARK: - The bridge

final class ArtifactRuntimeBridgeTests: XCTestCase {
    func testMessagesAreValidated() {
        XCTAssertEqual(
            ArtifactRuntimeMessage.decode(["type": "juno:status", "status": "done", "detail": ""]),
            .status(.done, detail: nil)
        )
        XCTAssertEqual(
            ArtifactRuntimeMessage.decode(["type": "juno:status", "status": "exploded"]),
            .status(.idle, detail: nil)
        )
        XCTAssertEqual(
            ArtifactRuntimeMessage.decode(["type": "juno:console", "level": "shout", "text": "hi"]),
            .console(.log, "hi")
        )
        // Two channels and no more.
        XCTAssertNil(ArtifactRuntimeMessage.decode(["type": "juno:open", "url": "https://example.com/a"]))
        XCTAssertNil(ArtifactRuntimeMessage.decode(["type": "juno:selected"]))
        XCTAssertNil(ArtifactRuntimeMessage.decode("juno:status"))
    }

    /// The height channel: a page reports its content height, the width it
    /// was laid out at, and its ground — validated, and a transparent or
    /// malformed colour is no colour.
    @MainActor
    func testTheHeightChannel() {
        XCTAssertEqual(
            ArtifactRuntimeMessage.decode(["type": "juno:size", "height": 212, "width": 720, "background": "rgb(11, 11, 14)"]),
            .size(height: 212, width: 720, background: ArtifactRuntimeColor(red: 11 / 255, green: 11 / 255, blue: 14 / 255))
        )
        XCTAssertNil(ArtifactRuntimeMessage.decode(["type": "juno:size", "height": 212]), "no width, no size")
        XCTAssertNil(ArtifactRuntimeMessage.decode(["type": "juno:size", "height": -4, "width": 720]))
        guard case .size(_, _, let background)? = ArtifactRuntimeMessage.decode(
            ["type": "juno:size", "height": 90, "width": 400, "background": "url(javascript:alert(1))"]
        ) else { return XCTFail("a bad colour costs the colour, not the size") }
        XCTAssertNil(background)
        XCTAssertEqual(ArtifactRuntimeColor(css: "rgba(250, 249, 246, 0.5)")?.alpha, 0.5)
        XCTAssertNil(ArtifactRuntimeColor(css: "rgb(300, 0, 0)"))

        let model = ArtifactRuntimeModel()
        model.apply(.size(height: 212, width: 720, background: nil))
        XCTAssertEqual(model.contentHeight, 212)
        XCTAssertEqual(model.contentWidth, 720)
        model.reset()
        XCTAssertNil(model.contentHeight)
        XCTAssertTrue(NativeArtifactRuntimeDocument.build(kind: .html, content: "<p>Hi</p>", language: nil).contains("juno:size"))
    }

    @MainActor
    func testConsoleIsCappedAsTheWebCapsIt() {
        let model = ArtifactRuntimeModel()
        for index in 0...150 { model.append(level: .log, text: "\(index)") }
        XCTAssertEqual(model.entries.count, 151)
        model.append(level: .error, text: "next")
        XCTAssertEqual(model.entries.count, 121)
        XCTAssertEqual(model.entries.first?.text, "31")
        XCTAssertEqual(model.entries.last?.text, "next")
        XCTAssertEqual(model.errorCount, 1)

        model.append(level: .log, text: String(repeating: "x", count: 5_000))
        XCTAssertEqual(model.entries.last?.text.count, ArtifactRuntimeModel.maximumCharacters + 1)

        model.apply(.status(.error, detail: "Error"))
        XCTAssertEqual(model.status, .error)
        XCTAssertEqual(model.detail, "Error")
        model.reset()
        XCTAssertTrue(model.entries.isEmpty)
        XCTAssertEqual(model.status, .idle)
        XCTAssertEqual(model.errorCount, 0)
    }

    func testTheRuleListOpensTheBundleOnly() throws {
        let rules = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(ArtifactRuntimeNetwork.contentRuleListJSON.utf8)) as? [[String: Any]]
        )
        func verdict(_ url: String) -> String? {
            var result: String?
            for rule in rules {
                let trigger = rule["trigger"] as! [String: String]
                let action = (rule["action"] as! [String: String])["type"]!
                let expression = try! NSRegularExpression(pattern: trigger["url-filter"]!, options: .caseInsensitive)
                if expression.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil {
                    result = action == "ignore-previous-rules" ? nil : action
                }
            }
            return result
        }
        XCTAssertEqual(verdict("https://cdn.tailwindcss.com"), "block")
        XCTAssertEqual(verdict("http://example.com/a.png"), "block")
        XCTAssertNil(verdict("juno-runtime://mermaid.min.js"))
        XCTAssertNil(verdict("data:image/png;base64,AAAA"))
        XCTAssertEqual(verdict("file:///Users/me/secrets.txt"), "block")
        XCTAssertEqual(verdict("wss://example.com/socket"), "block")
        XCTAssertEqual(verdict("ftp://example.com/x"), "block")
    }

    @MainActor
    func testTheSchemeServesOnlyWhatWasBundled() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("runtime-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("ok".utf8).write(to: root.appendingPathComponent("mermaid.min.js"))
        let handler = ArtifactRuntimeSchemeHandler(root: root)

        XCTAssertEqual(handler.fileURL(for: URL(string: "juno-runtime://mermaid.min.js")!)?.lastPathComponent, "mermaid.min.js")
        XCTAssertEqual(handler.fileURL(for: URL(string: "juno-runtime:///mermaid.min.js")!)?.lastPathComponent, "mermaid.min.js")
        XCTAssertNil(handler.fileURL(for: URL(string: "juno-runtime://missing.js")!))
        XCTAssertNil(handler.fileURL(for: URL(string: "juno-runtime://a/../mermaid.min.js")!))
        XCTAssertNil(handler.fileURL(for: URL(string: "juno-runtime:///..%2Fmermaid.min.js")!))
        XCTAssertNil(handler.fileURL(for: URL(string: "https://mermaid.min.js")!))
        XCTAssertNil(ArtifactRuntimeSchemeHandler(root: nil).fileURL(for: URL(string: "juno-runtime://mermaid.min.js")!))
    }
}

// MARK: - Resolving stored rows

final class ChatArtifactResolverTests: XCTestCase {
    private func row(
        conversation: String = "conv-1",
        identifier: String = "pricing-card",
        kind: NativeArtifactKind = .html,
        version: Int = 2,
        messageID: String? = "a-first"
    ) -> NativeArtifact {
        NativeArtifact(
            id: "art-\(identifier)-\(conversation)",
            conversationID: conversation,
            conversationTitle: "Chat",
            messageID: messageID,
            identifier: identifier,
            title: "Pricing card",
            kind: kind,
            language: nil,
            currentVersion: version,
            versions: (1...version).map {
                NativeArtifactVersion(id: "v\($0)", version: $0, content: "<p>v\($0)</p>", origin: nil, createdAt: Date())
            },
            createdAt: Date(),
            updatedAt: Date(),
            revision: 1
        )
    }

    private func reference(streaming: Bool = false, kind: String = "HTML") -> NativeMessageContent.ArtifactReference {
        NativeMessageContent.ArtifactReference(
            identifier: "pricing-card",
            title: "Card from the tag",
            kind: kind,
            language: nil,
            streaming: streaming,
            content: "<p>tag</p>"
        )
    }

    func testTheStoredRowWinsOverTheTag() {
        let resolver = ChatArtifactResolver(artifacts: [row(), row(conversation: "conv-2", version: 5)], conversationID: "conv-1")
        let card = resolver.card(for: reference(kind: "CODE"), messageID: "a-second", messageCreatedAt: nil, messageIsPending: false)
        XCTAssertEqual(card.content, "<p>v2</p>")
        XCTAssertEqual(card.kind, .html)
        XCTAssertEqual(card.version, 2)
        XCTAssertEqual(card.title, "Pricing card")
        XCTAssertTrue(card.isUpdated, "a later message carrying the same identifier revised it")
        XCTAssertFalse(resolver.card(for: reference(), messageID: "a-first", messageCreatedAt: nil, messageIsPending: false).isUpdated)
    }

    func testWithoutARowTheTagIsTheArtifact() {
        let card = ChatArtifactResolver.empty.card(for: reference(), messageID: "m", messageCreatedAt: nil, messageIsPending: false)
        XCTAssertNil(card.stored)
        XCTAssertEqual(card.content, "<p>tag</p>")
        XCTAssertNil(card.version)
        XCTAssertEqual(card.kind, .html)
        XCTAssertEqual(ChatArtifactResolver(artifacts: [row()], conversationID: nil).artifact(for: reference(), messageID: "m", messageCreatedAt: nil), nil)
    }

    func testWhileWritingTheTagIsWhatIsArriving() {
        let resolver = ChatArtifactResolver(artifacts: [row()], conversationID: "conv-1")
        let writing = resolver.card(for: reference(streaming: true), messageID: "a-second", messageCreatedAt: nil, messageIsPending: true)
        XCTAssertTrue(writing.isStreaming)
        XCTAssertEqual(writing.content, "<p>tag</p>")
        XCTAssertNil(writing.version)
        // An open tag on a settled message is not streaming.
        XCTAssertFalse(resolver.card(for: reference(streaming: true), messageID: "a-second", messageCreatedAt: nil, messageIsPending: false).isStreaming)
    }

    // MARK: M11's retired rows (the web's `resolveArtifactTag`)

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func held(
        _ id: String,
        identifier: String,
        at offset: TimeInterval,
        messageID: String? = nil,
        conversation: String = "conv-1",
        kind: NativeArtifactKind = .html
    ) -> NativeArtifact {
        NativeArtifact(
            id: id, conversationID: conversation, conversationTitle: "Chat", messageID: messageID,
            identifier: identifier, title: id, kind: kind, language: nil, currentVersion: 1,
            versions: [NativeArtifactVersion(id: "\(id)-v1", version: 1, content: id, origin: nil, createdAt: t0)],
            createdAt: t0.addingTimeInterval(offset), updatedAt: t0.addingTimeInterval(offset), revision: 1
        )
    }

    private func tag(_ identifier: String = "chart") -> NativeMessageContent.ArtifactReference {
        NativeMessageContent.ArtifactReference(
            identifier: identifier, title: "Chart", kind: "HTML", language: nil, streaming: false, content: "tag"
        )
    }

    /// 1. No retired rows: the exact row, and nil when there is none.
    func testWithNoRetiredRowsTheExactRowOrNil() {
        let exact = held("art-1", identifier: "chart", at: 0)
        let resolver = ChatArtifactResolver(artifacts: [exact], conversationID: "conv-1")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "m", messageCreatedAt: t0)?.id, "art-1")
        XCTAssertNil(resolver.artifact(for: tag("missing"), messageID: "m", messageCreatedAt: t0))
    }

    /// 2. One retired candidate and no current row: that candidate.
    func testALoneRetiredRowIsTheAnswer() {
        let retired = held("art-old123", identifier: "chart~old123", at: 0)
        let resolver = ChatArtifactResolver(artifacts: [retired], conversationID: "conv-1")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "m-9", messageCreatedAt: t0.addingTimeInterval(-60))?.id, "art-old123")
    }

    /// 3. The message's own candidate beats a newer one.
    func testTheMessagesOwnRowWins() {
        let old = held("art-aaaaaa", identifier: "chart~aaaaaa", at: 0, messageID: "m-1")
        let current = held("art-bbbbbb", identifier: "chart", at: 100, messageID: "m-2")
        let resolver = ChatArtifactResolver(artifacts: [current, old], conversationID: "conv-1")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "m-1", messageCreatedAt: t0.addingTimeInterval(500))?.id, "art-aaaaaa")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "m-2", messageCreatedAt: t0)?.id, "art-bbbbbb")
    }

    /// 4. No own candidate: the newest that existed when the message was written.
    func testOtherwiseTheNewestWrittenBeforeTheMessage() {
        let first = held("art-aaaaaa", identifier: "chart~aaaaaa", at: 0)
        let second = held("art-bbbbbb", identifier: "chart~bbbbbb", at: 100)
        let current = held("art-cccccc", identifier: "chart", at: 200)
        let resolver = ChatArtifactResolver(artifacts: [current, first, second], conversationID: "conv-1")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "x", messageCreatedAt: t0.addingTimeInterval(150))?.id, "art-bbbbbb")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "x", messageCreatedAt: t0.addingTimeInterval(200))?.id, "art-cccccc")
    }

    /// 5. None existed yet: the oldest.
    func testNoneQualifyingGivesTheOldest() {
        let first = held("art-aaaaaa", identifier: "chart~aaaaaa", at: 10)
        let current = held("art-cccccc", identifier: "chart", at: 200)
        let resolver = ChatArtifactResolver(artifacts: [current, first], conversationID: "conv-1")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "x", messageCreatedAt: t0)?.id, "art-aaaaaa")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "x", messageCreatedAt: nil)?.id, "art-aaaaaa")
    }

    /// 6. Rows from another conversation are never candidates.
    func testOtherConversationsAreIgnored() {
        let elsewhere = held("art-zzzzzz", identifier: "chart~zzzzzz", at: 0, messageID: "m-1", conversation: "conv-2")
        let current = held("art-cccccc", identifier: "chart", at: 200)
        let resolver = ChatArtifactResolver(artifacts: [elsewhere, current], conversationID: "conv-1")
        XCTAssertEqual(resolver.artifact(for: tag(), messageID: "m-1", messageCreatedAt: t0)?.id, "art-cccccc")
    }

    /// 7. The retired handle is `{identifier}~…`, never a bare prefix.
    func testThePrefixIsTheIdentifierAndATilde() {
        let lookalike = held("art-abc123", identifier: "chart-2~abc123", at: 0, messageID: "m-1")
        let current = held("art-cccccc", identifier: "chart", at: 200)
        XCTAssertEqual(
            ChatArtifactResolver(artifacts: [lookalike, current], conversationID: "conv-1")
                .artifact(for: tag(), messageID: "m-1", messageCreatedAt: t0)?.id,
            "art-cccccc"
        )
        let retired = held("art-abc123", identifier: "chart~abc123", at: 0, messageID: "m-1")
        XCTAssertEqual(
            ChatArtifactResolver(artifacts: [retired, current], conversationID: "conv-1")
                .artifact(for: tag(), messageID: "m-1", messageCreatedAt: t0)?.id,
            "art-abc123"
        )
    }

    /// 8. When a retired row wins, the card is that row: its identifier is the
    /// retired handle, which is what opening it passes on.
    func testTheCardCarriesTheRetiredHandle() {
        let old = held("art-aaaaaa", identifier: "chart~aaaaaa", at: 0, messageID: "m-1")
        let current = held("art-bbbbbb", identifier: "chart", at: 100, messageID: "m-2", kind: .code)
        let resolver = ChatArtifactResolver(artifacts: [old, current], conversationID: "conv-1")
        let card = resolver.card(for: tag(), messageID: "m-1", messageCreatedAt: t0, messageIsPending: false)
        XCTAssertEqual(card.stored?.identifier, "chart~aaaaaa")
        XCTAssertEqual(card.kind, .html)
        XCTAssertEqual(resolver.artifact(id: "art-aaaaaa")?.identifier, "chart~aaaaaa")
    }

    /// 9. A row its own message created is not "Updated".
    func testARowItsMessageCreatedIsNotUpdated() {
        let old = held("art-aaaaaa", identifier: "chart~aaaaaa", at: 0, messageID: "m-1")
        let current = held("art-bbbbbb", identifier: "chart", at: 100, messageID: "m-2")
        let resolver = ChatArtifactResolver(artifacts: [old, current], conversationID: "conv-1")
        XCTAssertFalse(resolver.card(for: tag(), messageID: "m-1", messageCreatedAt: t0, messageIsPending: false).isUpdated)
        XCTAssertFalse(resolver.card(for: tag(), messageID: "m-2", messageCreatedAt: t0, messageIsPending: false).isUpdated)
    }

    /// 10. One message that emitted both types owns two candidates: the oldest
    /// by `(createdAt, id)` wins, whatever order the rows arrive in.
    func testTwoOwnCandidatesBreakTheTieByAgeThenID() {
        let a = held("art-aaaaaa", identifier: "chart~aaaaaa", at: 0, messageID: "m-1")
        let b = held("art-bbbbbb", identifier: "chart", at: 0, messageID: "m-1")
        let later = held("art-000000", identifier: "chart~000000", at: 5, messageID: "m-1")
        for rows in [[a, b, later], [later, b, a], [b, later, a]] {
            XCTAssertEqual(
                ChatArtifactResolver(artifacts: rows, conversationID: "conv-1")
                    .artifact(for: tag(), messageID: "m-1", messageCreatedAt: t0)?.id,
                "art-aaaaaa"
            )
        }
    }

    /// X-11: a chat-made design's tag holds the compact authoring form; only
    /// the stored row holds a document a native renderer can read.
    func testADesignIsDrawnOnlyFromItsStoredRow() {
        let compact = NativeMessageContent.ArtifactReference(
            identifier: "signin",
            title: "Sign in",
            kind: "DESIGN",
            language: nil,
            streaming: false,
            content: #"{"name":"Sign in","nodes":[{"type":"frame","name":"Screen","width":375,"height":812}]}"#
        )
        let untouched = ChatArtifactResolver.empty.card(for: compact, messageID: "m", messageCreatedAt: nil, messageIsPending: false)
        XCTAssertEqual(untouched.kind, .design)
        XCTAssertFalse(untouched.drawsDesign, "never from the tag body")

        let stored = NativeArtifact(
            id: "art-design", conversationID: "conv-1", conversationTitle: "Chat", messageID: "m",
            identifier: "signin", title: "Sign in", kind: .design, language: nil, currentVersion: 1,
            versions: [NativeArtifactVersion(id: "v1", version: 1, content: #"{"schemaVersion":1}"#, origin: nil, createdAt: Date())],
            createdAt: Date(), updatedAt: Date(), revision: 1
        )
        let resolver = ChatArtifactResolver(artifacts: [stored], conversationID: "conv-1")
        XCTAssertTrue(resolver.card(for: compact, messageID: "m", messageCreatedAt: nil, messageIsPending: false).drawsDesign)
        let writing = NativeMessageContent.ArtifactReference(
            identifier: "signin", title: "Sign in", kind: "DESIGN", language: nil, streaming: true, content: "{"
        )
        XCTAssertFalse(resolver.card(for: writing, messageID: "m2", messageCreatedAt: nil, messageIsPending: true).drawsDesign)
    }

    /// React, JSX, TSX and TypeScript run on the bundled Babel and React;
    /// Python's engine is not bundled, so it alone shows Code.
    func testOnlyReachableRuntimesRun() {
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .react, language: nil).runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "jsx").runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "tsx").runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "ts").runsOnThisMac)
        XCTAssertFalse(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "python").runsOnThisMac)
        XCTAssertFalse(NativeArtifactRuntimeDocument.bundlesPython)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .html, language: nil).runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .mermaid, language: nil).runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "js").runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "go").runsOnThisMac, "it runs to say it cannot")
        XCTAssertFalse(NativeArtifactRuntimeInfo.resolve(kind: .design, language: nil).runsOnThisMac)
    }

    func testAVersionOneRowShowsNoVersion() {
        let resolver = ChatArtifactResolver(artifacts: [row(version: 1)], conversationID: "conv-1")
        XCTAssertNil(resolver.card(for: reference(), messageID: "a-first", messageCreatedAt: nil, messageIsPending: false).version)
    }
}

// MARK: - The store

@MainActor
final class NativeArtifactModelStreamedTests: XCTestCase {
    private let account = "account-a"

    @MainActor
    func testStreamedRowsSurviveReloadsUntilSyncCatchesUp() async throws {
        let repository = InMemoryTransactionalStore()
        let (model, _) = makeModel(repository, responses: [])
        await model.start(for: try AccountID(account))
        XCTAssertTrue(model.artifacts.isEmpty)

        model.merge(streamed: [streamed(version: 1)], conversationID: "conv-1")
        XCTAssertEqual(model.artifacts.map(\.id), ["art-1"])
        XCTAssertEqual(model.artifacts.first?.currentContent, "<p>one</p>")
        XCTAssertEqual(model.artifacts.first?.conversationID, "conv-1")

        await model.reload()
        XCTAssertEqual(model.artifacts.first?.currentVersion, 1, "a reload before sync must not drop it")

        try await seed(repository, version: 2)
        await model.reload()
        XCTAssertEqual(model.artifacts.count, 1)
        XCTAssertEqual(model.artifacts.first?.currentVersion, 2)
        XCTAssertEqual(model.artifacts.first?.currentContent, "<p>synced</p>")
    }

    @MainActor
    func testAnUnknownKindIsSkippedNotFatal() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, version: 1)
        let id = StorageAccountID(account)
        _ = try await repository.apply(StorageTransaction(accountID: id, operations: [
            .upsert(StoredRecord(
                accountID: id,
                key: RecordKey(namespace: "artifact", id: "art-future"),
                revision: 9,
                updatedAt: Date(),
                payload: Data(#"{"id":"art-future","conversationId":"conv-1","messageId":null,"identifier":"deck","title":"Deck","type":"SLIDES","language":null,"currentVersion":1,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}"#.utf8)
            )),
            .upsert(StoredRecord(
                accountID: id,
                key: RecordKey(namespace: "artifact_version", id: "ver-huge"),
                revision: 9,
                updatedAt: Date(),
                payload: try JSONSerialization.data(withJSONObject: [
                    "id": "ver-huge", "artifactId": "art-1", "version": 3,
                    "content": String(repeating: "x", count: 200_001),
                    "createdAt": "2026-09-01T00:00:00.000Z",
                ])
            )),
        ]))

        let snapshot = try await NativeArtifactStore(repository: repository).load(accountID: id)
        XCTAssertEqual(snapshot.artifacts.map(\.id), ["art-1"])
        XCTAssertEqual(snapshot.artifacts.first?.versions.map(\.version), [1], "the oversized v3 is left out, not fatal")
    }

    @MainActor
    func testSaveSendsTheVersionTheEditWasMadeAgainst() async throws {
        let repository = InMemoryTransactionalStore()
        try await seed(repository, version: 2)
        let (model, sender) = makeModel(repository, responses: [HTTPResponse(
            statusCode: 200,
            headers: HTTPHeaders(),
            body: Data(#"{"artifact":{"id":"art-1","identifier":"pricing-card","type":"HTML","title":"Pricing card","language":null,"currentVersion":3,"messageId":"m-1","content":"<p>mine</p>","versions":[{"version":2,"content":"<p>synced</p>","origin":"generated","createdAt":"2026-09-01T00:00:00.000Z"},{"version":3,"content":"<p>mine</p>","origin":"edit","createdAt":"2026-09-01T00:01:00.000Z"}],"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:01:00.000Z"}}"#.utf8)
        )])
        await model.start(for: try AccountID(account))

        let landed = await model.saveArtifact(id: "art-1", content: "<p>mine</p>", baseVersion: 1)
        XCTAssertTrue(landed)
        let requests = await sender.requests
        let request = try XCTUnwrap(requests.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(body["baseVersion"] as? Int, 1, "the edit's own base, not the newest synced version")
        XCTAssertEqual(model.artifacts.first?.currentVersion, 3, "the saved version is kept over a stale projection")
    }

    // MARK: Helpers

    private func streamed(version: Int) -> NativeStreamedArtifact {
        NativeStreamedArtifact(
            id: "art-1",
            identifier: "pricing-card",
            type: "HTML",
            title: "Pricing card",
            language: nil,
            currentVersion: version,
            content: "<p>one</p>",
            versions: [],
            messageID: "m-1",
            createdAt: Date(timeIntervalSince1970: 1_758_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_758_000_000)
        )
    }

    private func seed(_ repository: InMemoryTransactionalStore, version: Int) async throws {
        let id = StorageAccountID(account)
        _ = try await repository.apply(StorageTransaction(accountID: id, operations: [
            .upsert(StoredRecord(
                accountID: id,
                key: RecordKey(namespace: "artifact", id: "art-1"),
                revision: UInt64(version),
                updatedAt: Date(),
                payload: Data(#"{"id":"art-1","conversationId":"conv-1","messageId":"m-1","identifier":"pricing-card","title":"Pricing card","type":"HTML","language":null,"currentVersion":\#(version),"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}"#.utf8)
            )),
            .upsert(StoredRecord(
                accountID: id,
                key: RecordKey(namespace: "artifact_version", id: "ver-\(version)"),
                revision: UInt64(version),
                updatedAt: Date(),
                payload: Data(#"{"id":"ver-\#(version)","artifactId":"art-1","version":\#(version),"content":"<p>synced</p>","createdAt":"2026-09-01T00:00:00.000Z"}"#.utf8)
            )),
        ]))
    }

    @MainActor
    private func makeModel(
        _ repository: InMemoryTransactionalStore,
        responses: [HTTPResponse]
    ) -> (NativeArtifactModel<InMemoryTransactionalStore>, RuntimeQueueSender) {
        let sender = RuntimeQueueSender(responses: responses)
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)
        let sync = NativeSyncModel(
            coordinator: coordinator,
            monitor: NativeSyncMonitor(coordinator: coordinator, streamer: sender)
        )
        return (NativeArtifactModel(repository: repository, syncModel: sync, sender: sender), sender)
    }
}

// MARK: - Design previews

@MainActor
final class NativeDesignPreviewLoaderTests: XCTestCase {
    private let svg = #"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>"#
    private let newer = #"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="5"/></svg>"#

    private func ok(_ body: String, etag: String? = nil) throws -> HTTPResponse {
        var headers = try HTTPHeaders(["content-type": "image/svg+xml"])
        if let etag { try headers.set(etag, for: "etag") }
        return HTTPResponse(statusCode: 200, headers: headers, body: Data(body.utf8))
    }

    private func status(_ code: Int, json: Bool) throws -> HTTPResponse {
        json
            ? HTTPResponse(statusCode: code, headers: try HTTPHeaders(["content-type": "application/json"]), body: Data(#"{"error":"Not found"}"#.utf8))
            : HTTPResponse(statusCode: code, headers: try HTTPHeaders(["content-type": "text/html"]), body: Data("<html>Not Found</html>".utf8))
    }

    private func root() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("design-\(UUID().uuidString)")
    }

    /// The poster comes first: the web's `designPosterUrl(id, v)` with the
    /// renderer, asking for SVG.
    func testAsksForThePosterWithTheVersionAndRenderer() async throws {
        let cache = root()
        defer { try? FileManager.default.removeItem(at: cache) }
        let sender = RuntimeQueueSender(responses: [try ok(svg, etag: #"W/"p1""#)])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: cache)

        XCTAssertEqual(loader.designPreviewState(artifactID: "art-design", version: 3), .loading)
        await loader.loadDesignPreview(artifactID: "art-design", version: 3)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-design", version: 3), .ready(svg: svg))
        let requests = await sender.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.path, "/api/artifacts/art-design/poster")
        XCTAssertEqual(requests.first?.queryItems, [URLQueryItem(name: "v", value: "3"), URLQueryItem(name: "r", value: "1")])
        XCTAssertEqual(requests.first?.headers["accept"], "image/svg+xml")
        XCTAssertNil(requests.first?.headers["if-none-match"])
        XCTAssertEqual(NativeDesignPreviewLoader.posterRenderer, 1)
    }

    /// `<id>-v<n>-r1.svg` for a poster and its `.etag`; `<id>-v<n>.svg` for
    /// an export, the name from before posters.
    func testCacheFileNames() throws {
        XCTAssertEqual(NativeDesignPreviewLoader.posterFileName("art-1", 4), "art-1-v4-r1.svg")
        XCTAssertEqual(NativeDesignPreviewLoader.exportFileName("art-1", 4), "art-1-v4.svg")
        XCTAssertEqual(NativeDesignPreviewLoader.etagFileName("art-1-v4-r1.svg"), "art-1-v4-r1.etag")
    }

    /// A version a later one superseded never changes: once cached it is read
    /// from disk forever, by this loader and the next.
    func testSealedVersionsAreNeverAskedForAgain() async throws {
        let cache = root()
        defer { try? FileManager.default.removeItem(at: cache) }
        let sender = RuntimeQueueSender(responses: [try ok(svg, etag: #""p1""#)])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: cache)
        await loader.loadDesignPreview(artifactID: "art-1", version: 1)
        await loader.loadDesignPreview(artifactID: "art-1", version: 1)
        let first = await sender.requests.count
        XCTAssertEqual(first, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.appendingPathComponent("account-a/art-1-v1-r1.svg").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.appendingPathComponent("account-a/art-1-v1-r1.etag").path))

        let next = RuntimeQueueSender(responses: [])
        let later = NativeDesignPreviewLoader(sender: next, accountID: try AccountID("account-a"), cacheRoot: cache)
        await later.loadDesignPreview(artifactID: "art-1", version: 1, isCurrent: false)
        XCTAssertEqual(later.designPreviewState(artifactID: "art-1", version: 1), .ready(svg: svg))
        let asked = await next.requests.count
        XCTAssertEqual(asked, 0)
    }

    /// The current version can change in place, so a new loader asks again
    /// once with `If-None-Match`; a 304 keeps the cached picture, a 200
    /// replaces it.
    func testTheCurrentVersionRevalidatesWithItsETag() async throws {
        let cache = root()
        defer { try? FileManager.default.removeItem(at: cache) }
        let seed = RuntimeQueueSender(responses: [try ok(svg, etag: #""p1""#)])
        let first = NativeDesignPreviewLoader(sender: seed, accountID: try AccountID("account-a"), cacheRoot: cache)
        await first.loadDesignPreview(artifactID: "art-1", version: 2, isCurrent: true)

        let unchanged = RuntimeQueueSender(responses: [HTTPResponse(statusCode: 304, headers: HTTPHeaders(), body: Data())])
        let second = NativeDesignPreviewLoader(sender: unchanged, accountID: try AccountID("account-a"), cacheRoot: cache)
        await second.loadDesignPreview(artifactID: "art-1", version: 2, isCurrent: true)
        XCTAssertEqual(second.designPreviewState(artifactID: "art-1", version: 2), .ready(svg: svg))
        let conditional = await unchanged.requests
        XCTAssertEqual(conditional.first?.headers["if-none-match"], #""p1""#)
        // Once per loader: the next appearance does not ask again.
        await second.loadDesignPreview(artifactID: "art-1", version: 2, isCurrent: true)
        let asked = await unchanged.requests.count
        XCTAssertEqual(asked, 1)

        let edited = RuntimeQueueSender(responses: [try ok(newer, etag: #""p2""#)])
        let third = NativeDesignPreviewLoader(sender: edited, accountID: try AccountID("account-a"), cacheRoot: cache)
        await third.loadDesignPreview(artifactID: "art-1", version: 2, isCurrent: true)
        XCTAssertEqual(third.designPreviewState(artifactID: "art-1", version: 2), .ready(svg: newer))
    }

    /// A JSON 404 is the route saying "no poster for this": the export is
    /// tried once for that version, and the poster is not asked again.
    func testAJSONNotFoundFallsBackToTheExport() async throws {
        let sender = RuntimeQueueSender(responses: [try status(404, json: true), try ok(svg)])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: nil)
        await loader.loadDesignPreview(artifactID: "art-1", version: 1)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-1", version: 1), .ready(svg: svg))
        let paths = await sender.requests.map(\.path)
        XCTAssertEqual(paths, ["/api/artifacts/art-1/poster", "/api/design/art-1/export"])
        XCTAssertFalse(loader.posterRouteMissing)
    }

    /// A 404 that is not JSON is an older server with no poster route: the
    /// export, and every later design skips the poster.
    func testAnHTMLNotFoundFallsBackAndRemembersTheRouteIsMissing() async throws {
        let sender = RuntimeQueueSender(responses: [try status(404, json: false), try ok(svg), try ok(newer)])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: nil)
        await loader.loadDesignPreview(artifactID: "art-1", version: 1)
        XCTAssertTrue(loader.posterRouteMissing)
        await loader.loadDesignPreview(artifactID: "art-2", version: 1)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-2", version: 1), .ready(svg: newer))
        let paths = await sender.requests.map(\.path)
        XCTAssertEqual(paths, ["/api/artifacts/art-1/poster", "/api/design/art-1/export", "/api/design/art-2/export"])
    }

    /// The export's 422 (`MISSING_ASSET`) is remembered as unavailable.
    func testTheExportsUnprocessableIsUnavailable() async throws {
        let sender = RuntimeQueueSender(responses: [
            try status(404, json: true),
            HTTPResponse(statusCode: 422, headers: HTTPHeaders(), body: Data(#"{"error":"MISSING_ASSET"}"#.utf8)),
        ])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: nil)
        await loader.loadDesignPreview(artifactID: "art-a", version: 2)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-a", version: 2), .unavailable)
        await loader.loadDesignPreview(artifactID: "art-a", version: 2)
        let count = await sender.requests.count
        XCTAssertEqual(count, 2, "unavailable is not asked again")

        // Something that is not an SVG is not drawn.
        let html = RuntimeQueueSender(responses: [HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data("<html></html>".utf8))])
        let strict = NativeDesignPreviewLoader(sender: html, accountID: try AccountID("account-a"), cacheRoot: nil)
        await strict.loadDesignPreview(artifactID: "art-c", version: 1)
        XCTAssertEqual(strict.designPreviewState(artifactID: "art-c", version: 1), .unavailable)
    }

    /// 401 and 429 are not answers about the design: failed, and tried again
    /// on the next appearance — as is a request that never completed.
    func testUnauthorizedAndRateLimitedAreRetried() async throws {
        let sender = RuntimeQueueSender(responses: [
            HTTPResponse(statusCode: 401, headers: HTTPHeaders(), body: Data()),
            HTTPResponse(statusCode: 429, headers: HTTPHeaders(), body: Data()),
            try ok(svg),
        ])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: nil)
        await loader.loadDesignPreview(artifactID: "art-b", version: 1)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-b", version: 1), .failed)
        await loader.loadDesignPreview(artifactID: "art-b", version: 1)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-b", version: 1), .failed)
        await loader.loadDesignPreview(artifactID: "art-b", version: 1)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-b", version: 1), .ready(svg: svg))

        let offline = NativeDesignPreviewLoader(sender: RuntimeQueueSender(responses: []), accountID: try AccountID("account-a"), cacheRoot: nil)
        await offline.loadDesignPreview(artifactID: "art-d", version: 1)
        XCTAssertEqual(offline.designPreviewState(artifactID: "art-d", version: 1), .failed)
    }
}

private actor RuntimeQueueSender: NativeAuthenticatedRequestSending, NativeAuthenticatedByteStreaming {
    private var responses: [HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }

    func stream(_ request: NativeBearerRequest, for _: AccountID) throws -> HTTPByteStreamResponse {
        throw URLError(.notConnectedToInternet)
    }
}
