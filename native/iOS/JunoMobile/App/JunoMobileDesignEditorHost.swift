import JunoDesignKit
import SwiftUI
import WebKit

/// Hosts the bundled Juno Design editor in a `WKWebView`, read-only.
///
/// **The drawing on the phone is the same drawing.** The bundle loaded here is
/// the one `scripts/build-design-editor.mjs` produces and the Mac hosts, so the
/// scene model, layout engine and renderer are literally the same code — a
/// document reads the same here, on the Mac, on the web, and in every export.
/// The alternative was a CoreText renderer that would break lines somewhere else
/// and quietly disagree with all three; ``DesignDocument``'s rule that there is
/// one engine is what that alternative violates.
///
/// **Why this is not ``DesktopDesignEditorHost``.** That host owns an editing
/// session: it accepts transactions, re-asserts the document when the editor and
/// the store disagree, and pushes selection back into native chrome. None of
/// that exists on the phone, because the phone does not edit a design — it opens
/// one. So this host speaks the two messages a reader needs (`ready`, and
/// whatever failure follows) and treats every other message as an error worth
/// showing rather than silently accepting an edit it has nowhere to store.
/// Validation itself is not duplicated: ``DesignBridgeValidator`` in
/// `JunoDesignKit` is the same parser both hosts run.
///
/// The boundary is the Mac's, unchanged:
///
///  - **Local only.** `loadFileURL(_:allowingReadAccessTo:)`, scoped to the
///    editor directory alone. Nothing is fetched, so a phone in a tunnel opens
///    the editor that shipped and no remote origin can serve code into a window
///    that holds a bridge to native code.
///  - **Nonpersistent data store.** No cookies, no local storage, no cache
///    survives the screen.
///  - **No credentials in JavaScript.** The web view is never handed a token or
///    a session; it is handed a document and nothing else.
///  - **Navigation pinned.** Anything that is not the editor's own file is
///    cancelled, so a tap cannot turn a design into a browser.
///
/// `@Observable` rather than `ObservableObject`: this host is held in a `@State`
/// on the screen below, and SwiftUI does not subscribe to an `ObservableObject`
/// stored that way — the status would change and the view would never hear about
/// it, leaving the spinner sitting over a canvas that had finished drawing.
@MainActor
@Observable
final class JunoMobileDesignEditorHost: NSObject {
    /// What the screen is currently able to say about itself.
    enum Status: Equatable {
        case loading
        /// The bundle booted and agreed on the protocol version.
        case ready(editorVersion: String)
        /// The bundle is missing from the app, or refused to load.
        case unavailable(String)
        /// The editor reported a failure. Surfaced, never swallowed.
        case failed(String)
    }

    private(set) var status: Status = .loading

    private let document: DesignDocument
    private let nonce = UUID().uuidString
    private var validator: DesignBridgeValidator
    private var webView: WKWebView?

    init(document: DesignDocument) {
        self.document = document
        validator = DesignBridgeValidator(nonce: nonce, revision: document.revision)
        super.init()
    }

    /// Where the bundle lives inside the app.
    ///
    /// Absent in a checkout that has not run the build script — a state a
    /// developer really hits — so it is reported with the command that fixes it
    /// rather than as a blank rectangle.
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
        // Nothing this editor does should outlive the screen.
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        // The canvas is a pan-and-zoom surface the editor implements itself. Left
        // alone, WebKit would also let the page zoom, so a pinch would scale the
        // toolbar and the zoom readout along with the artwork.
        configuration.ignoresViewportScaleLimits = false

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        // The screen behind paints the canvas; an opaque white web view over it
        // would put a hard rectangle inside the artifact's rounded card.
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        // The editor's own scroller is the one that should move. Without this the
        // page rubber-bands underneath it, so dragging on the canvas slides the
        // whole editor and springs back.
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
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
        // Read access is scoped to the editor directory alone — not the app
        // bundle, and certainly not the container.
        view.loadFileURL(directory.appendingPathComponent("index.html"), allowingReadAccessTo: directory)
        return view
    }

    private func send(_ command: DesignHostCommand) {
        guard let webView else { return }
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
                send(.openDocument(nonce: nonce, document: document, readOnly: true))

            case .selection:
                // The phone has no inspector to drive, and the editor draws its
                // own selection. Accepted and dropped rather than treated as an
                // error the reader has to look at.
                break

            case .transaction, .save:
                // Both mean the editor believes it is editable. It was opened
                // read-only, so this is a disagreement about the session rather
                // than a change to store, and storing it is exactly what must not
                // happen here.
                status = .failed("The design editor tried to change a document opened for reading.")

            case .failure(_, let message):
                status = .failed(message)
            }
        } catch {
            status = .failed("\(error)")
        }
    }
}

// MARK: - Navigation policy

extension JunoMobileDesignEditorHost: WKNavigationDelegate, WKUIDelegate {
    // `@MainActor` on the handler is part of the signature under Swift 6 —
    // without it this only *nearly* matches the optional requirement, so it would
    // never be called and every navigation would be allowed by default. The Mac
    // host carries the same note for the same reason.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let directory = Self.bundleDirectory?.standardizedFileURL.path ?? ""
        let isEditorResource = url.isFileURL && !directory.isEmpty && url.standardizedFileURL.path.hasPrefix(directory)
        decisionHandler(isEditorResource ? .allow : .cancel)
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
/// for the life of the process — a leak per design document opened.
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    private weak var host: JunoMobileDesignEditorHost?

    init(host: JunoMobileDesignEditorHost) {
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
struct JunoMobileDesignEditorView: UIViewRepresentable {
    let host: JunoMobileDesignEditorHost

    func makeUIView(context: Context) -> WKWebView {
        host.makeWebView()
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        // The host drives the editor through the bridge; there is nothing to
        // reconcile from SwiftUI's side, and re-loading here would throw away the
        // reader's viewport on every re-render of the screen around it.
    }
}
