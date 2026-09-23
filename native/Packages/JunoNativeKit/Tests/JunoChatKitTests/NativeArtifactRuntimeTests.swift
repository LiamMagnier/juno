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
        XCTAssertTrue(document.contains(#"<script src="https://cdn.tailwindcss.com"></script>"#))
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
        XCTAssertFalse(document.contains("cdn.tailwindcss.com"), "a full document is the author's own")
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
        XCTAssertTrue(document.contains(NativeArtifactRuntimeDocument.reactCDN))
        XCTAssertTrue(document.contains(NativeArtifactRuntimeDocument.babelCDN))
        XCTAssertTrue(document.contains(#"typeof window["App"] === 'function'"#))
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
        let python = NativeArtifactRuntimeDocument.build(kind: .code, content: "print(1)", language: "python")
        XCTAssertTrue(python.contains(NativeArtifactRuntimeDocument.pyodideIndex + "pyodide.js"))
        XCTAssertTrue(python.contains(#""docx":"python-docx""#))
        let go = NativeArtifactRuntimeDocument.build(kind: .code, content: "package main", language: "go")
        XCTAssertTrue(go.contains("Browser execution is not available for "))
        XCTAssertTrue(go.contains(#"<span id="label">Go</span>"#))
        let typescript = NativeArtifactRuntimeDocument.build(kind: .code, content: "export const x: number = 1", language: "ts")
        XCTAssertTrue(typescript.contains(NativeArtifactRuntimeDocument.babelCDN))
        XCTAssertFalse(typescript.contains("export const"))
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
        let card = resolver.card(for: reference(kind: "CODE"), messageID: "a-second", messageIsPending: false)
        XCTAssertEqual(card.content, "<p>v2</p>")
        XCTAssertEqual(card.kind, .html)
        XCTAssertEqual(card.version, 2)
        XCTAssertEqual(card.title, "Pricing card")
        XCTAssertTrue(card.isUpdated, "a later message carrying the same identifier revised it")
        XCTAssertFalse(resolver.card(for: reference(), messageID: "a-first", messageIsPending: false).isUpdated)
    }

    func testWithoutARowTheTagIsTheArtifact() {
        let card = ChatArtifactResolver.empty.card(for: reference(), messageID: "m", messageIsPending: false)
        XCTAssertNil(card.stored)
        XCTAssertEqual(card.content, "<p>tag</p>")
        XCTAssertNil(card.version)
        XCTAssertEqual(card.kind, .html)
        XCTAssertEqual(ChatArtifactResolver(artifacts: [row()], conversationID: nil).artifact(for: reference()), nil)
    }

    func testWhileWritingTheTagIsWhatIsArriving() {
        let resolver = ChatArtifactResolver(artifacts: [row()], conversationID: "conv-1")
        let writing = resolver.card(for: reference(streaming: true), messageID: "a-second", messageIsPending: true)
        XCTAssertTrue(writing.isStreaming)
        XCTAssertEqual(writing.content, "<p>tag</p>")
        XCTAssertNil(writing.version)
        // An open tag on a settled message is not streaming.
        XCTAssertFalse(resolver.card(for: reference(streaming: true), messageID: "a-second", messageIsPending: false).isStreaming)
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
        let untouched = ChatArtifactResolver.empty.card(for: compact, messageID: "m", messageIsPending: false)
        XCTAssertEqual(untouched.kind, .design)
        XCTAssertFalse(untouched.drawsDesign, "never from the tag body")

        let stored = NativeArtifact(
            id: "art-design", conversationID: "conv-1", conversationTitle: "Chat", messageID: "m",
            identifier: "signin", title: "Sign in", kind: .design, language: nil, currentVersion: 1,
            versions: [NativeArtifactVersion(id: "v1", version: 1, content: #"{"schemaVersion":1}"#, origin: nil, createdAt: Date())],
            createdAt: Date(), updatedAt: Date(), revision: 1
        )
        let resolver = ChatArtifactResolver(artifacts: [stored], conversationID: "conv-1")
        XCTAssertTrue(resolver.card(for: compact, messageID: "m", messageIsPending: false).drawsDesign)
        let writing = NativeMessageContent.ArtifactReference(
            identifier: "signin", title: "Sign in", kind: "DESIGN", language: nil, streaming: true, content: "{"
        )
        XCTAssertFalse(resolver.card(for: writing, messageID: "m2", messageIsPending: true).drawsDesign)
    }

    /// React, TypeScript and Python load their engines from CDNs the closed
    /// sandbox cannot reach, so they show Code; the rest run.
    func testOnlyReachableRuntimesRun() {
        XCTAssertFalse(NativeArtifactRuntimeInfo.resolve(kind: .react, language: nil).runsOnThisMac)
        XCTAssertFalse(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "python").runsOnThisMac)
        XCTAssertFalse(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "ts").runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .html, language: nil).runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .mermaid, language: nil).runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "js").runsOnThisMac)
        XCTAssertTrue(NativeArtifactRuntimeInfo.resolve(kind: .code, language: "go").runsOnThisMac, "it runs to say it cannot")
        XCTAssertFalse(NativeArtifactRuntimeInfo.resolve(kind: .design, language: nil).runsOnThisMac)
    }

    func testAVersionOneRowShowsNoVersion() {
        let resolver = ChatArtifactResolver(artifacts: [row(version: 1)], conversationID: "conv-1")
        XCTAssertNil(resolver.card(for: reference(), messageID: "a-first", messageIsPending: false).version)
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

    @MainActor
    func testFetchesOncePerVersionAndCachesOnDisk() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("design-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let sender = RuntimeQueueSender(responses: [HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(svg.utf8))])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: root)

        XCTAssertEqual(loader.designPreviewState(artifactID: "art-design", version: 1), .loading)
        await loader.loadDesignPreview(artifactID: "art-design", version: 1)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-design", version: 1), .ready(svg: svg))
        await loader.loadDesignPreview(artifactID: "art-design", version: 1)
        let requests = await sender.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.path, "/api/design/art-design/export")
        XCTAssertEqual(requests.first?.queryItems, [URLQueryItem(name: "format", value: "svg")])
        XCTAssertEqual(requests.first?.headers["accept"], "image/svg+xml")

        // A second loader for the same account reads the disk, not the network.
        let offline = NativeDesignPreviewLoader(sender: nil, accountID: try AccountID("account-a"), cacheRoot: root)
        await offline.loadDesignPreview(artifactID: "art-design", version: 1)
        XCTAssertEqual(offline.designPreviewState(artifactID: "art-design", version: 1), .ready(svg: svg))
    }

    @MainActor
    func testAnExportFailureIsRememberedAndANetworkFailureIsNot() async throws {
        let sender = RuntimeQueueSender(responses: [
            HTTPResponse(statusCode: 422, headers: HTTPHeaders(), body: Data(#"{"error":"MISSING_ASSET"}"#.utf8)),
        ])
        let loader = NativeDesignPreviewLoader(sender: sender, accountID: try AccountID("account-a"), cacheRoot: nil)
        await loader.loadDesignPreview(artifactID: "art-a", version: 2)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-a", version: 2), .unavailable)
        await loader.loadDesignPreview(artifactID: "art-a", version: 2)
        let afterUnavailable = await sender.requests.count
        XCTAssertEqual(afterUnavailable, 1)

        // The queue is empty now, so the next request fails in transport.
        await loader.loadDesignPreview(artifactID: "art-b", version: 1)
        XCTAssertEqual(loader.designPreviewState(artifactID: "art-b", version: 1), .failed)
        await loader.loadDesignPreview(artifactID: "art-b", version: 1)
        let afterFailure = await sender.requests.count
        XCTAssertEqual(afterFailure, 3, "a network failure is tried again")

        // Something that is not an SVG is not drawn.
        let html = RuntimeQueueSender(responses: [HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data("<html></html>".utf8))])
        let strict = NativeDesignPreviewLoader(sender: html, accountID: try AccountID("account-a"), cacheRoot: nil)
        await strict.loadDesignPreview(artifactID: "art-c", version: 1)
        XCTAssertEqual(strict.designPreviewState(artifactID: "art-c", version: 1), .unavailable)
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
