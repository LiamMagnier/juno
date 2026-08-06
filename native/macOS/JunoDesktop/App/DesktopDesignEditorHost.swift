import Combine
import JunoDesignKit
import SwiftUI
import WebKit

/// Hosts the bundled Juno Design editor in a `WKWebView`.
///
/// **The editor is one implementation, not two.** The bundle loaded here is
/// built from the same TypeScript the website runs (`scripts/build-design-editor.mjs`),
/// so the scene model, operation layer, layout engine and renderer are literally
/// the same code on both platforms. Swift owns the document contract
/// (``DesignDocument``), persistence, and the boundary — it does not own a
/// second scene graph, and there is no Swift editor to drift from the web one.
///
/// The boundary is deliberately narrow:
///
///  - **Local only.** Resources are read from the app bundle with
///    `loadFileURL(_:allowingReadAccessTo:)` scoped to the editor directory.
///    Nothing is fetched, so an offline Mac opens the editor that shipped, and
///    no remote origin can ever serve code into a window that holds a bridge to
///    native code.
///  - **Nonpersistent data store.** `.nonPersistent()` means no cookies, no
///    local storage, no cache survives the window — the editor cannot
///    accumulate state the user cannot see or clear.
///  - **No native credentials in JavaScript.** The web view is never given a
///    token, a session, or a cookie jar. The host fetches on the editor's behalf
///    and hands back only a document.
///  - **Every message validated.** `DesignBridgeValidator` checks type, session
///    nonce, revision ordering and the document itself before anything acts on
///    it. A replayed or stale transaction is refused, not applied twice.
///  - **Navigation pinned.** Any attempt to leave the editor's own file URL is
///    cancelled, so a stray link cannot turn the pane into a browser.
@MainActor
final class DesktopDesignEditorHost: NSObject, ObservableObject {
    /// What the pane is currently able to say about itself.
    enum Status: Equatable {
        case loading
        /// The bundle booted and agreed on the protocol version.
        case ready(editorVersion: String)
        /// The bundle is missing from the app, or refused to load.
        case unavailable(String)
        /// The editor reported a failure. Surfaced, never swallowed.
        case failed(String)
    }

    @Published private(set) var status: Status = .loading
    @Published private(set) var selection: [String] = []
    /// The document as last committed by the editor and accepted here.
    @Published private(set) var document: DesignDocument
    /// The most recent refused message, for diagnostics. Not surfaced as a
    /// failure: a stale frame that has been corrected is a resolved
    /// disagreement, not a broken editor.
    @Published private(set) var lastRefusal: String?

    /// Called with each accepted transaction so the shell can persist it.
    var onTransaction: ((DesignDocument, String, String) -> Void)?

    private let nonce = UUID().uuidString
    private var validator: DesignBridgeValidator
    private let readOnly: Bool
    private(set) var webView: WKWebView?

    init(document: DesignDocument, readOnly: Bool) {
        self.document = document
        self.readOnly = readOnly
        self.validator = DesignBridgeValidator(nonce: nonce, revision: document.revision)
        super.init()
    }

    /// Where the bundle lives inside the app.
    ///
    /// Absent in a source checkout that has not run the build script, which is a
    /// real state a developer hits — so it is reported with the command that
    /// fixes it rather than as a blank panel.
    static var bundleDirectory: URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "DesignEditor")?
            .deletingLastPathComponent()
    }

    func makeWebView() -> WKWebView {
        if let existing = webView { return existing }

        let controller = WKUserContentController()
        controller.add(MessageProxy(host: self), name: DesignBridge.messageHandlerName)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        // Nothing this editor does should outlive the window.
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // Artifact content is rendered as inert SVG by the shared renderer, so
        // nothing user-authored executes here. A user-executable preview, when
        // one is added, belongs in an isolated child frame — which is why frames
        // are permitted and top-level navigation is not.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.setValue(false, forKey: "drawsBackground") // the pane paints the canvas
        view.allowsBackForwardNavigationGestures = false
        webView = view

        guard let directory = Self.bundleDirectory else {
            status = .unavailable(
                """
                The design editor is not bundled with this build. \
                Run `node scripts/build-design-editor.mjs`, then rebuild the app.
                """
            )
            return view
        }
        // Read access is scoped to the editor directory alone — not to the app
        // bundle, and certainly not to the user's home.
        view.loadFileURL(directory.appendingPathComponent("index.html"), allowingReadAccessTo: directory)
        return view
    }

    /// Push a document the host now considers authoritative.
    func adopt(_ next: DesignDocument) {
        document = next
        validator = DesignBridgeValidator(nonce: nonce, revision: next.revision)
        send(.adoptDocument(nonce: nonce, document: next))
    }

    func setSelection(_ nodeIDs: [String]) {
        send(.setSelection(nonce: nonce, nodeIDs: nodeIDs))
    }

    func setReadOnly(_ readOnly: Bool) {
        send(.setReadOnly(nonce: nonce, readOnly: readOnly))
    }

    private func send(_ command: DesignHostCommand) {
        guard let webView, case .ready = status else { return }
        do {
            webView.evaluateJavaScript(try command.javaScript())
        } catch {
            status = .failed("Juno could not send the document to the editor: \(error.localizedDescription)")
        }
    }

    // MARK: Bridge

    fileprivate func handle(_ body: Any) {
        do {
            switch try validator.validate(body) {
            case .ready(_, let editorVersion):
                status = .ready(editorVersion: editorVersion)
                // Only now is the document handed over: before `ready`, the
                // bundle has not agreed on a protocol version.
                send(.openDocument(nonce: nonce, document: document, readOnly: readOnly))

            case .transaction(_, _, _, let transactionID, let summary, let next):
                document = next
                onTransaction?(next, transactionID, summary)

            case .selection(_, _, let nodeIDs):
                selection = nodeIDs

            case .save:
                // Every transaction is already committed as it happens; an
                // explicit save is a no-op rather than a second write path.
                break

            case .failure(_, let message):
                status = .failed(message)
            }
        } catch {
            // A refused message means the editor and the host disagree about the
            // document. Dropping it silently would leave the canvas drawing a
            // scene that was never stored — the exact divergence the revision
            // check exists to catch — so the host re-asserts its own copy and
            // the editor snaps back to it.
            //
            // `adopt` is only correct for the two cases that actually indicate
            // divergence. A malformed or unknown message is a bug, not a
            // disagreement, and re-pushing the document would hide it.
            switch error {
            case DesignBridgeError.staleRevision, DesignBridgeError.badField:
                lastRefusal = "\(error)"
                adopt(document)
            default:
                status = .failed("\(error)")
            }
        }
    }

}

// MARK: - Navigation policy

extension DesktopDesignEditorHost: WKNavigationDelegate, WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel, preferences) }
        // The editor's own local files, and nothing else — not http, not
        // file:// elsewhere on disk, not a data: document.
        let directory = Self.bundleDirectory?.standardizedFileURL.path ?? ""
        let isEditorResource = url.isFileURL && !directory.isEmpty && url.standardizedFileURL.path.hasPrefix(directory)
        decisionHandler(isEditorResource ? .allow : .cancel, preferences)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        status = .unavailable(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        status = .unavailable(error.localizedDescription)
    }

    /// No new windows, ever. A design document has no business opening one.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }
}

/// Breaks the retain cycle `WKUserContentController` would otherwise create.
///
/// The controller retains its handlers and the web view retains the controller,
/// so a host that registered itself directly would keep its own web view alive
/// for the life of the process — which for a pane that opens per artifact is a
/// leak per artifact.
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    private weak var host: DesktopDesignEditorHost?

    init(host: DesktopDesignEditorHost) {
        self.host = host
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == DesignBridge.messageHandlerName else { return }
        let body = message.body
        Task { @MainActor [weak host] in host?.handle(body) }
    }
}

// MARK: - SwiftUI

/// The editor, as a SwiftUI view.
struct DesktopDesignEditorView: NSViewRepresentable {
    let host: DesktopDesignEditorHost

    func makeNSView(context: Context) -> WKWebView {
        host.makeWebView()
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        // The host drives the editor through the bridge; there is nothing to
        // reconcile from SwiftUI's side, and re-loading here would discard the
        // user's viewport on every re-render.
    }
}
