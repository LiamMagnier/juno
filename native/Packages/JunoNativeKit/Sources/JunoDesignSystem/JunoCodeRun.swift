import SwiftUI

#if canImport(WebKit)
import WebKit
#endif
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - What runs

/// A language a code block can run, and how its output is named — the web's
/// browser half of `runTargetFor` (src/lib/exec/snippet-languages.ts).
///
/// Only the four the reader's own device runs: JavaScript, TypeScript, Python
/// (Pyodide) and SQL (SQLite against Oracle's HR sample). The languages the
/// web sends to its hosted sandbox (C, Java, Go, …) have no Run here, as they
/// have none on the web while the server has no sandbox.
public struct JunoCodeRunTarget: Equatable, Sendable {
    /// The canonical language: `javascript`, `typescript`, `python`, `sql`.
    public let language: String
    /// "JavaScript", "TypeScript", "Python", "SQL".
    public let label: String

    private static let languages: [String: String] = [
        "js": "javascript", "javascript": "javascript", "mjs": "javascript",
        "ts": "typescript", "typescript": "typescript",
        "py": "python", "python": "python", "python3": "python",
        "sql": "sql", "plsql": "sql", "pgsql": "sql", "mysql": "sql", "sqlite": "sql",
    ]
    private static let labels = ["javascript": "JavaScript", "typescript": "TypeScript", "python": "Python", "sql": "SQL"]

    /// The target for a fence's language, or nil when it does not run here.
    public static func target(for fence: String?) -> JunoCodeRunTarget? {
        let key = (fence ?? "").trimmingCharacters(in: .whitespaces).split(separator: " ").first.map { $0.lowercased() } ?? ""
        guard let language = languages[key], let label = labels[language] else { return nil }
        return JunoCodeRunTarget(language: language, label: label)
    }

    /// The output's header, as the web words it.
    public var outputTitle: String { language == "sql" ? "Output · SQLite, HR sample" : "Output" }
}

/// How a run gets its console document: the app asks the server for the web's
/// own (`POST /api/code/console`), so the code runs in the same document the
/// website runs it in. Set by the Mac and iOS transcripts; without it no code
/// block shows Run.
public struct JunoCodeRunner: Sendable {
    public var consoleDocument: @Sendable (_ target: JunoCodeRunTarget, _ code: String, _ dark: Bool) async throws -> String

    public init(consoleDocument: @escaping @Sendable (_ target: JunoCodeRunTarget, _ code: String, _ dark: Bool) async throws -> String) {
        self.consoleDocument = consoleDocument
    }
}

/// A run's picture, for the offscreen snapshot harness, which cannot
/// photograph a `WKWebView`: the output as the web view drew it, and the state
/// the page reported. Production never sets it.
public struct JunoCodeRunStill: Sendable {
    public var image: CGImage
    public var scale: CGFloat
    public var status: JunoCodeRunStatus

    public init(image: CGImage, scale: CGFloat, status: JunoCodeRunStatus) {
        self.image = image
        self.scale = scale
        self.status = status
    }
}

public struct JunoCodeRunStills: Sendable {
    private let still: @MainActor @Sendable (_ language: String, _ code: String, _ dark: Bool) -> JunoCodeRunStill?

    public init(_ still: @escaping @MainActor @Sendable (_ language: String, _ code: String, _ dark: Bool) -> JunoCodeRunStill?) {
        self.still = still
    }

    @MainActor
    public func callAsFunction(_ language: String, _ code: String, _ dark: Bool) -> JunoCodeRunStill? { still(language, code, dark) }
}

public extension EnvironmentValues {
    @Entry var junoCodeRunner: JunoCodeRunner? = nil
    @Entry var junoCodeRunStills: JunoCodeRunStills? = nil
}

/// A run's state, in words — never a dot (owner, 2026-10-09).
public enum JunoCodeRunStatus: String, Sendable {
    case loading, running, done, error

    var word: String {
        switch self {
        case .loading: "Loading"
        case .running: "Running"
        case .done: "Done"
        case .error: "Error"
        }
    }
}

// MARK: - The output

/// A code block's output, drawn as the lower half of the block itself — the
/// web's `CodeRunOutput`: a hairline, a header with the output's name on the
/// left and the state in words and two round keys (Run again, Close) on the
/// right, then the console, which grows with what it prints up to 420pt and
/// scrolls inside past that.
public struct JunoCodeRunOutput: View {
    let target: JunoCodeRunTarget
    let code: String
    /// Bumped by the caller's Run: every new value runs the code again.
    let runToken: Int
    let onClose: () -> Void

    @Environment(\.junoCodeRunner) private var runner
    @Environment(\.junoCodeRunStills) private var stills
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast

    @State private var again = 0
    @State private var status: JunoCodeRunStatus = .loading
    @State private var document: String?
    @State private var failure: String?
    @State private var height: CGFloat = Self.minimumHeight

    static let minimumHeight: CGFloat = 44
    static let maximumHeight: CGFloat = 420

    public init(target: JunoCodeRunTarget, code: String, runToken: Int, onClose: @escaping () -> Void) {
        self.target = target
        self.code = code
        self.runToken = runToken
        self.onClose = onClose
    }

    private var dark: Bool { colorScheme == .dark }

    public var body: some View {
        let still = stills?(target.language, code, dark)
        VStack(alignment: .leading, spacing: 0) {
            Rectangle()
                .fill(Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: contrast == .increased)))
                .frame(height: 1)
            header(status: still?.status ?? (failure == nil ? status : .error))
            if let still {
                Image(decorative: still.image, scale: still.scale)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .frame(height: min(Self.maximumHeight, CGFloat(still.image.height) / still.scale), alignment: .topLeading)
                    .clipped()
            } else if let failure {
                Text(failure)
                    .junoType(.mono)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                console
            }
        }
        .task(id: "\(runToken)-\(again)-\(dark)") { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(target.label) output")
    }

    @ViewBuilder
    private var console: some View {
        #if canImport(WebKit)
        if let document {
            JunoCodeRunWebView(
                html: document,
                onHeight: { height = min(Self.maximumHeight, max(Self.minimumHeight, $0)) },
                onStatus: { status = $0 }
            )
            .frame(height: height)
            .frame(maxWidth: .infinity)
            .animation(JunoMotion.fast, value: height)
        } else {
            Color.clear.frame(height: Self.minimumHeight)
        }
        #else
        EmptyView()
        #endif
    }

    private func header(status: JunoCodeRunStatus) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Text(target.outputTitle)
                .junoType(JunoType(size: 11, lineHeight: 1.45, face: .mono, textStyle: .caption))
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .help(target.language == "sql" ? "Your query runs on SQLite in this app, against a sample of Oracle’s HR schema." : "")
            Spacer(minLength: JunoSpace.snug)
            Text(status.word)
                .junoFont(size: 12, relativeTo: .caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .contentTransition(.opacity)
                .accessibilityLabel("Run state: \(status.word)")
            HStack(spacing: 0) {
                Button { again += 1 } label: { JunoIconView(.rotateCcw, size: 14).contentShape(Circle()) }
                    .buttonStyle(JunoProseIconButtonStyle())
                    .help("Run again")
                    .accessibilityLabel("Run again")
                Button(action: onClose) { JunoIconView(.close, size: 14).contentShape(Circle()) }
                    .buttonStyle(JunoProseIconButtonStyle())
                    .help("Close the output")
                    .accessibilityLabel("Close the output")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, JunoSpace.hairline)
        .frame(height: 36)
    }

    private func load() async {
        status = .loading
        failure = nil
        height = Self.minimumHeight
        guard stills?(target.language, code, dark) == nil else { return }
        guard let runner else {
            failure = "Running code needs a connection to Alevr."
            return
        }
        do {
            // A fresh document each run, even for the same code: the web view
            // reloads on a change of document, so Run again must make one.
            let html = try await runner.consoleDocument(target, code, dark)
            guard !Task.isCancelled else { return }
            document = html + "<!-- run \(runToken)-\(again) -->"
        } catch is CancellationError {
            return
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? "This code couldn’t be run right now."
        }
    }
}

// MARK: - The console's web view

#if canImport(WebKit)
/// The web's console document, in a web view of its own.
///
/// The web runs it in a sandboxed iframe with an opaque origin; this is the
/// same containment from what WebKit gives an app: a **non-persistent** data
/// store, a **nil base URL** (no origin to borrow), **no navigation** beyond
/// the document itself, **no popups**, and a content-rule list that lets the
/// page reach only the CDNs its own policy names for the engines it loads
/// (jsdelivr for Pyodide and sql.js, unpkg for Babel, PyPI for a wheel a
/// script imports). One channel back, main frame only: the height and state
/// the page posts, which the document sends to `parent` and a script at
/// document start forwards.
struct JunoCodeRunWebView {
    let html: String
    let onHeight: (CGFloat) -> Void
    let onStatus: (JunoCodeRunStatus) -> Void

    static let handlerName = "junoCodeRun"

    /// `parent.postMessage` in a top-level page posts to the page itself.
    static let forwarder = """
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type !== 'juno:console-size' && d.type !== 'juno:status') return;
      try {
        window.webkit.messageHandlers.\(handlerName).postMessage({ type: String(d.type), height: Number(d.height) || 0, status: String(d.status || '') });
      } catch (_) {}
    });
    """

    /// Everything over http(s) is blocked but the engines' hosts.
    static let rules = #"""
    [
      {"trigger":{"url-filter":"^https?://.*"},"action":{"type":"block"}},
      {"trigger":{"url-filter":"^https://cdn\\.jsdelivr\\.net/.*"},"action":{"type":"ignore-previous-rules"}},
      {"trigger":{"url-filter":"^https://unpkg\\.com/.*"},"action":{"type":"ignore-previous-rules"}},
      {"trigger":{"url-filter":"^https://pypi\\.org/.*"},"action":{"type":"ignore-previous-rules"}},
      {"trigger":{"url-filter":"^https://files\\.pythonhosted\\.org/.*"},"action":{"type":"ignore-previous-rules"}}
    ]
    """#

    @MainActor private static var compiled: WKContentRuleList?

    @MainActor
    static func ruleList() async -> WKContentRuleList? {
        if let compiled { return compiled }
        let list = try? await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "com.alevr.code-run.network",
            encodedContentRuleList: rules
        )
        compiled = list
        return list
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var onHeight: (CGFloat) -> Void
        var onStatus: (JunoCodeRunStatus) -> Void
        var loaded: String?
        var pending: Task<Void, Never>?

        init(onHeight: @escaping (CGFloat) -> Void, onStatus: @escaping (JunoCodeRunStatus) -> Void) {
            self.onHeight = onHeight
            self.onStatus = onStatus
        }

        func load(_ html: String, into webView: WKWebView) {
            guard html != loaded else { return }
            loaded = html
            pending?.cancel()
            pending = Task { @MainActor [weak webView] in
                if let rules = await JunoCodeRunWebView.ruleList() {
                    webView?.configuration.userContentController.removeAllContentRuleLists()
                    webView?.configuration.userContentController.add(rules)
                } else {
                    // No rule list, no network: the run fails in words rather
                    // than running unfenced.
                    self.onStatus(.error)
                    return
                }
                guard !Task.isCancelled else { return }
                webView?.loadHTMLString(html, baseURL: nil)
            }
        }

        nonisolated func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return }
            let type = body["type"] as? String
            let height = (body["height"] as? NSNumber)?.doubleValue ?? 0
            let status = body["status"] as? String
            MainActor.assumeIsolated {
                if type == "juno:console-size", height > 0 {
                    onHeight(CGFloat(height))
                } else if type == "juno:status", let status, let value = JunoCodeRunStatus(rawValue: status) {
                    onStatus(value)
                }
            }
        }

        func webView(
            _: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            // The document this view loaded, and nothing else.
            let url = navigationAction.request.url
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            let initial = url == nil || url?.scheme == "about"
            decisionHandler(isMainFrame && initial && navigationAction.navigationType == .other ? .allow : .cancel)
        }

        func webView(
            _: WKWebView,
            createWebViewWith _: WKWebViewConfiguration,
            for _: WKNavigationAction,
            windowFeatures _: WKWindowFeatures
        ) -> WKWebView? { nil }

        func webViewWebContentProcessDidTerminate(_: WKWebView) {
            onStatus(.error)
        }
    }

    @MainActor
    func makeCoordinator() -> Coordinator {
        Coordinator(onHeight: onHeight, onStatus: onStatus)
    }

    @MainActor
    func makeWebView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.forwarder, injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        configuration.userContentController.add(WeakHandler(context.coordinator), name: Self.handlerName)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsLinkPreview = false
        #if os(macOS)
        webView.setValue(false, forKey: "drawsBackground")
        #else
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        context.coordinator.load(html, into: webView)
        return webView
    }

    @MainActor
    func update(_ webView: WKWebView, context: Context) {
        context.coordinator.onHeight = onHeight
        context.coordinator.onStatus = onStatus
        context.coordinator.load(html, into: webView)
    }

    @MainActor
    static func teardown(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.pending?.cancel()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: handlerName)
        webView.stopLoading()
    }

    /// The content controller holds its handlers strongly.
    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: (any WKScriptMessageHandler)?
        init(_ target: any WKScriptMessageHandler) { self.target = target }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(controller, didReceive: message)
        }
    }
}

#if os(macOS)
extension JunoCodeRunWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateNSView(_ webView: WKWebView, context: Context) { update(webView, context: context) }
    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) { teardown(webView, coordinator: coordinator) }
}
#else
extension JunoCodeRunWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateUIView(_ webView: WKWebView, context: Context) { update(webView, context: context) }
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) { teardown(webView, coordinator: coordinator) }
}
#endif
#endif

// MARK: - Run, as a control

/// The Run control a code block's header and an exercise carry: a Liquid Glass
/// capsule with the web's play mark.
public struct JunoCodeRunButton: View {
    let label: String
    let action: () -> Void

    public init(label: String = "Run", action: @escaping () -> Void) {
        self.label = label
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                JunoIconView(.play, size: 12)
                Text(label)
            }
            .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
            .contentShape(Capsule())
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
    }
}
