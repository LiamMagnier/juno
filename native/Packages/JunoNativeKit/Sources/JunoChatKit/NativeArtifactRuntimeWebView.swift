import Foundation
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The web view a running artifact lives in — the native counterpart of the
/// web's sandboxed iframe (`SandboxFrame`, `sandbox-frame.tsx`).
///
/// **What isolates it.** The web's boundary is the iframe's opaque origin;
/// this one is built from the pieces WebKit gives an app:
///
/// * a **non-persistent** data store, so nothing the page stores survives it
///   or reaches another artifact;
/// * a **nil base URL**, so the document has no origin to borrow;
/// * **no network**: a content-rule list that blocks every hierarchical
///   scheme but the app's own `juno-runtime:` — `https:` and `file:`
///   included — with `data:` and `blob:` left to the page's policy
///   (``ArtifactRuntimeNetwork``);
/// * **no navigation**: only the document this view loads; a link the reader
///   clicks opens in the browser, anything else is cancelled;
/// * **no popups**: `window.open` returns nothing;
/// * **two channels back**: the run's status and its console
///   (``ArtifactRuntimeMessage``), main frame only.
///
/// Alerts, confirms and prompts become sheets on the window, because the web's
/// frame carries `allow-modals`; a file the page offers for download goes
/// through the save panel, because it carries `allow-downloads`.
struct NativeArtifactRuntimeWebView {
    let html: String
    let runtime: ArtifactRuntimeModel?

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        var runtime: ArtifactRuntimeModel?
        var lastHTML = ""
        var rulesInstalled = false
        #if os(macOS)
        private var downloadDestinations: [ObjectIdentifier: URL] = [:]
        #endif

        init(runtime: ArtifactRuntimeModel?) {
            self.runtime = runtime
        }

        func receive(_ body: Any) {
            guard let message = ArtifactRuntimeMessage.decode(body) else { return }
            runtime?.apply(message)
        }

        func load(_ html: String, into webView: WKWebView) {
            lastHTML = html
            runtime?.reset()
            webView.loadHTMLString(html, baseURL: nil)
        }

        // MARK: Navigation

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            preferences: WKWebpagePreferences,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
        ) {
            preferences.allowsContentJavaScript = true
            if navigationAction.shouldPerformDownload {
                decisionHandler(.download, preferences)
                return
            }
            let url = navigationAction.request.url
            let scheme = url?.scheme?.lowercased()
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if isMainFrame {
                // The document this view loaded, and nothing else.
                if url == nil || url?.absoluteString == "about:blank" || scheme == "about" {
                    decisionHandler(.allow, preferences)
                    return
                }
                if navigationAction.navigationType == .linkActivated,
                    let url, scheme == "http" || scheme == "https"
                {
                    Self.openExternally(url)
                }
                decisionHandler(.cancel, preferences)
                return
            }
            // A frame the page embeds: what its `frame-src` allows.
            let allowed: Set<String> = ["http", "https", "data", "blob", "about"]
            decisionHandler(scheme.map(allowed.contains) ?? true ? .allow : .cancel, preferences)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
        ) {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        /// A crashed content process leaves a blank page that still claims to
        /// be running; reload the same document instead.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard rulesInstalled, !lastHTML.isEmpty else { return }
            load(lastHTML, into: webView)
        }

        // MARK: Popups and dialogs

        /// No popups. A `target="_blank"` link the reader clicked still opens,
        /// in the browser; `window.open` from script does nothing.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.navigationType == .linkActivated,
                let url = navigationAction.request.url,
                let scheme = url.scheme?.lowercased(),
                scheme == "http" || scheme == "https"
            {
                Self.openExternally(url)
            }
            return nil
        }

        #if os(macOS)
        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor () -> Void
        ) {
            let alert = Self.alert(message)
            alert.addButton(withTitle: "OK")
            present(alert, in: webView) { _ in completionHandler() }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor (Bool) -> Void
        ) {
            let alert = Self.alert(message)
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            present(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn) }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor (String?) -> Void
        ) {
            let alert = Self.alert(prompt)
            let field = NSTextField(frame: CGRect(x: 0, y: 0, width: 260, height: 24))
            field.stringValue = defaultText ?? ""
            alert.accessoryView = field
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            present(alert, in: webView) { response in
                completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
            }
        }

        private static func alert(_ message: String) -> NSAlert {
            let alert = NSAlert()
            alert.messageText = "This artifact says:"
            alert.informativeText = String(message.prefix(2_000))
            alert.alertStyle = .informational
            return alert
        }

        /// A sheet on the artifact's window; with no window to hang it from,
        /// the page gets the answer a dismissed dialog gives.
        private func present(
            _ alert: NSAlert,
            in webView: WKWebView,
            completion: @escaping @MainActor (NSApplication.ModalResponse) -> Void
        ) {
            guard let window = webView.window else {
                completion(.alertSecondButtonReturn)
                return
            }
            alert.beginSheetModal(for: window) { response in
                MainActor.assumeIsolated { completion(response) }
            }
        }
        #endif

        // MARK: Downloads

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String,
            completionHandler: @escaping @MainActor (URL?) -> Void
        ) {
            #if os(macOS)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedFilename
            panel.canCreateDirectories = true
            let key = ObjectIdentifier(download)
            panel.begin { [weak self] result in
                MainActor.assumeIsolated {
                    guard result == .OK, let url = panel.url else {
                        completionHandler(nil)
                        return
                    }
                    // WebKit refuses to overwrite; the panel already asked.
                    try? FileManager.default.removeItem(at: url)
                    self?.downloadDestinations[key] = url
                    completionHandler(url)
                }
            }
            #else
            completionHandler(nil)
            #endif
        }

        func downloadDidFinish(_ download: WKDownload) {
            #if os(macOS)
            downloadDestinations[ObjectIdentifier(download)] = nil
            #endif
        }

        func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
            #if os(macOS)
            downloadDestinations[ObjectIdentifier(download)] = nil
            #endif
        }

        static func openExternally(_ url: URL) {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            UIApplication.shared.open(url)
            #endif
        }
    }

    @MainActor
    func makeCoordinator() -> Coordinator {
        Coordinator(runtime: runtime)
    }

    @MainActor
    func makeWebView(coordinator: Coordinator) -> WKWebView {
        coordinator.runtime = runtime
        return Self.makeSandboxedWebView(html: html, coordinator: coordinator)
    }

    /// The one place the sandbox is configured: used by the view, and by
    /// ``ArtifactRuntimeSandbox`` so a test runs a page in exactly the web view
    /// the transcript does.
    @MainActor
    static func makeSandboxedWebView(html: String, coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(
            ArtifactRuntimeSchemeHandler.shared,
            forURLScheme: NativeArtifactRuntimeDocument.runtimeScheme
        )
        let controller = configuration.userContentController
        controller.addUserScript(WKUserScript(
            source: NativeArtifactRuntimeDocument.bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.add(
            ArtifactRuntimeMessageProxy(coordinator),
            name: NativeArtifactRuntimeDocument.messageHandlerName
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        #if os(iOS)
        webView.scrollView.bounces = false
        #endif
        coordinator.lastHTML = html
        ArtifactRuntimeContentRules.shared.install(into: controller) { installed in
            coordinator.rulesInstalled = installed
            coordinator.load(
                installed ? coordinator.lastHTML : NativeArtifactSandbox.previewUnavailableDocument,
                into: webView
            )
        }
        return webView
    }

    @MainActor
    func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.runtime = runtime
        guard coordinator.lastHTML != html else { return }
        coordinator.lastHTML = html
        if coordinator.rulesInstalled {
            coordinator.load(html, into: webView)
        }
    }

    @MainActor
    static func dismantle(_ webView: WKWebView) {
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeArtifactRuntimeDocument.messageHandlerName
        )
    }
}

#if os(macOS)
extension NativeArtifactRuntimeWebView: NSViewRepresentable {
    @MainActor
    func makeNSView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    @MainActor
    func updateNSView(_ nsView: WKWebView, context: Context) {
        updateWebView(nsView, coordinator: context.coordinator)
    }

    @MainActor
    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        dismantle(nsView)
    }
}
#else
extension NativeArtifactRuntimeWebView: UIViewRepresentable {
    @MainActor
    func makeUIView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    @MainActor
    func updateUIView(_ uiView: WKWebView, context: Context) {
        updateWebView(uiView, coordinator: context.coordinator)
    }

    @MainActor
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        dismantle(uiView)
    }
}
#endif

/// The artifact sandbox outside SwiftUI: a web view configured exactly as the
/// transcript's runtime is — closed network, non-persistent store, the status
/// and console channels — for a test to load a page into and read back what
/// its scripts did.
@MainActor
public final class ArtifactRuntimeSandbox {
    public let webView: WKWebView
    public let runtime: ArtifactRuntimeModel
    private let coordinator: NativeArtifactRuntimeWebView.Coordinator

    public init(html: String) {
        runtime = ArtifactRuntimeModel()
        coordinator = NativeArtifactRuntimeWebView.Coordinator(runtime: runtime)
        webView = NativeArtifactRuntimeWebView.makeSandboxedWebView(html: html, coordinator: coordinator)
    }

    /// Whether the network rules compiled and the page was handed to WebKit.
    public var isLoaded: Bool { coordinator.rulesInstalled }
}

/// Holds the coordinator weakly: `WKUserContentController` retains its
/// handlers, and a strong reference would keep every closed artifact's web
/// view alive for the life of the configuration.
@MainActor
private final class ArtifactRuntimeMessageProxy: NSObject, WKScriptMessageHandler {
    private weak var coordinator: NativeArtifactRuntimeWebView.Coordinator?

    init(_ coordinator: NativeArtifactRuntimeWebView.Coordinator) {
        self.coordinator = coordinator
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // The main frame only: a frame the artifact embeds is somebody else's
        // page, and it does not get to report this one's status.
        guard message.frameInfo.isMainFrame else { return }
        coordinator?.receive(message.body)
    }
}

// MARK: - Network posture

/// What a running artifact may reach.
public enum ArtifactRuntimeNetwork {
    /// Whether the sandbox reaches the web. **Closed**, per the Phase 2
    /// brief's addendum of 2026-09-23: the Mac runs a page's own scripts in a
    /// sandbox with no network, and the runtimes the web fetches from CDNs —
    /// React, ReactDOM, Babel, Tailwind Play, Mermaid — are bundled and served
    /// over `juno-runtime:` instead. Opening it — the web's reach, with remote
    /// fonts, pictures and libraries and Pyodide — needs the owner's sign-off,
    /// and is this one switch: the rule list and the page policy both follow
    /// it.
    public static let isOpen = false

    /// Blocks every hierarchical scheme, then lets the app's own
    /// `juno-runtime:` back through (and `http(s)` too, when the network is
    /// open). `data:` and `blob:` never match the first rule, so the page's
    /// policy alone governs them. WebKit's rule regex has no alternation,
    /// hence one rule per scheme.
    public static var contentRuleListJSON: String {
        let web = isOpen
            ? #", { "trigger": { "url-filter": "^https?://.*" }, "action": { "type": "ignore-previous-rules" } }"#
            : ""
        return """
        [
          { "trigger": { "url-filter": "^[a-z][a-z0-9+.-]*://.*" }, "action": { "type": "block" } },
          { "trigger": { "url-filter": "^juno-runtime://.*" }, "action": { "type": "ignore-previous-rules" } }\(web)
        ]
        """
    }
}

/// Compiles ``ArtifactRuntimeNetwork/contentRuleListJSON`` once per process.
/// If WebKit cannot compile it, no artifact loads — the view shows
/// "Preview unavailable" rather than running without the file-scheme block.
@MainActor
final class ArtifactRuntimeContentRules {
    static let shared = ArtifactRuntimeContentRules()

    private let identifier = ArtifactRuntimeNetwork.isOpen
        ? "com.juno.artifact-runtime.network.open.v1"
        : "com.juno.artifact-runtime.network.closed.v1"
    private var cached: WKContentRuleList?
    private var loading = false
    private var waiters: [(WKContentRuleList?) -> Void] = []

    func install(into controller: WKUserContentController, completion: @escaping (Bool) -> Void) {
        load { rule in
            if let rule { controller.add(rule) }
            completion(rule != nil)
        }
    }

    private func load(_ completion: @escaping (WKContentRuleList?) -> Void) {
        if let cached {
            completion(cached)
            return
        }
        waiters.append(completion)
        guard !loading else { return }
        loading = true
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: identifier,
            encodedContentRuleList: ArtifactRuntimeNetwork.contentRuleListJSON
        ) { [weak self] rule, _ in
            guard let self else { return }
            cached = rule
            loading = false
            let pending = waiters
            waiters.removeAll()
            for waiter in pending { waiter(rule) }
        }
    }
}

// MARK: - Bundled runtime files

/// Serves `juno-runtime://<file>` from the app's `ArtifactRuntime` folder:
/// Mermaid, React and ReactDOM, Babel standalone and Tailwind Play (the
/// folder's README lists versions and checksums).
///
/// A flat namespace of plain file names — no directories, no dot files, no
/// traversal — so the scheme can hand out exactly what the app bundled and
/// nothing beside it. A build that bundles nothing answers 404, and the page
/// says it could not load the engine.
///
/// Every answer carries `Access-Control-Allow-Origin: *`. A page's document
/// has an opaque origin, so each bundled script is cross-origin to it, and a
/// `<script crossorigin>` — which is how pages copied from React's docs load
/// it — is a CORS request that WebKit refuses without the header (the script
/// never runs). The files are public builds, and `connect-src 'none'` keeps
/// a page from reading them any other way.
public final class ArtifactRuntimeSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    public static let shared = ArtifactRuntimeSchemeHandler(
        root: Bundle.main.url(forResource: "ArtifactRuntime", withExtension: nil)
    )

    private let root: URL?

    public init(root: URL?) {
        self.root = root
    }

    /// The file a runtime URL names, or nil when it names anything else.
    public func fileURL(for url: URL) -> URL? {
        guard url.scheme?.lowercased() == NativeArtifactRuntimeDocument.runtimeScheme, let root else { return nil }
        // `juno-runtime://mermaid.min.js` puts the name in the host;
        // `juno-runtime:///mermaid.min.js` in the path. Exactly one component.
        let parts = ([url.host ?? ""] + url.path.split(separator: "/").map(String.init)).filter { !$0.isEmpty }
        guard parts.count == 1, let name = parts.first,
            name.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil,
            !name.contains("..")
        else { return nil }
        let file = root.appendingPathComponent(name)
        guard file.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL,
            FileManager.default.fileExists(atPath: file.path)
        else { return nil }
        return file
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let url = urlSchemeTask.request.url ?? URL(string: "juno-runtime://missing")!
        guard let file = fileURL(for: url), let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            let response = HTTPURLResponse(
                url: url,
                statusCode: 404,
                httpVersion: "HTTP/1.1",
                headerFields: ["Access-Control-Allow-Origin": "*"]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didFinish()
            return
        }
        let type = switch file.pathExtension.lowercased() {
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json": "application/json"
        case "wasm": "application/wasm"
        default: "application/octet-stream"
        }
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": type,
                "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*",
            ]
        )!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}
