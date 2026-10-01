import AppKit
import JunoCodeCore
import JunoCodeLocal
import Observation
import SwiftUI
import WebKit

// One page per preview (CODE_AGENT_SPEC §4.1, PV-4). A `PreviewPage` owns the
// single `WKWebView` of a preview: the dock and the pop-out window re-parent
// it, so there is one load, one HMR client, one sign-in and one diagnostics
// buffer. With no surface showing it, the page lives in a host window that is
// never made key, sized to the requested viewport, so a background session's
// agent can still use it (PV-2).
//
// The offscreen-host spike (PROGRESS.md) measured that WebKit marks a page in a
// window off every screen `hidden`: requestAnimationFrame stops and timers run
// at 1 Hz, while snapshots, script evaluation and trusted synthesized events
// keep working. D-025 takes the 1-pt near-transparent on-screen host as the
// fallback for exactly that; the app turns it on with
// `PreviewPage.backgroundHostMode = .onePoint`. Tests keep `.offscreen`, which
// never puts a window on screen.

/// Where a page lives while no pane shows it.
public enum PreviewHostMode: String, Sendable {
    /// A borderless window off every screen, never ordered in.
    case offscreen
    /// A 1-point, near-transparent, click-through window on screen, so WebKit
    /// treats the page as visible (D-025 fallback).
    case onePoint
}

/// The page's size and appearance.
public struct PreviewViewport: Equatable, Sendable {
    public enum Preset: String, CaseIterable, Sendable {
        case responsive, phone, tablet, desktop, custom

        public var title: String {
            switch self {
            case .responsive: "Responsive"
            case .phone: "Phone"
            case .tablet: "Tablet"
            case .desktop: "Desktop"
            case .custom: "Custom"
            }
        }
    }

    public enum ColorScheme: String, CaseIterable, Sendable {
        case system, light, dark

        public var title: String {
            switch self {
            case .system: "System"
            case .light: "Light"
            case .dark: "Dark"
            }
        }
    }

    public var preset: Preset
    /// Nil for responsive: the page follows its pane.
    public var size: CGSize?
    public var colorScheme: ColorScheme

    public init(preset: Preset = .responsive, size: CGSize? = nil, colorScheme: ColorScheme = .system) {
        self.preset = preset
        self.size = size
        self.colorScheme = colorScheme
    }

    public static let responsive = PreviewViewport()

    /// §4.3 presets: phone 390×844 with a mobile user agent and touch, tablet
    /// 820×1180, desktop 1440×900.
    public static func preset(_ preset: Preset, colorScheme: ColorScheme = .system) -> PreviewViewport {
        switch preset {
        case .phone: PreviewViewport(preset: .phone, size: CGSize(width: 390, height: 844), colorScheme: colorScheme)
        case .tablet: PreviewViewport(preset: .tablet, size: CGSize(width: 820, height: 1_180), colorScheme: colorScheme)
        case .desktop: PreviewViewport(preset: .desktop, size: CGSize(width: 1_440, height: 900), colorScheme: colorScheme)
        case .responsive, .custom: PreviewViewport(preset: preset, size: nil, colorScheme: colorScheme)
        }
    }

    public var isMobile: Bool { preset == .phone }

    /// "desktop", "phone", "1024×768": how evidence names the viewport.
    public var label: String {
        switch preset {
        case .responsive: size.map { "\(Int($0.width))×\(Int($0.height))" } ?? "responsive"
        case .custom: size.map { "\(Int($0.width))×\(Int($0.height))" } ?? "custom"
        default: preset.rawValue
        }
    }

    static let mobileUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
}

/// An `alert`, `confirm` or `prompt` the page opened, waiting for an answer.
public struct PreviewDialog: Equatable, Sendable {
    public enum Kind: String, Sendable { case alert, confirm, prompt }
    public var kind: Kind
    public var message: String
    public var defaultText: String?
    public var openedAt: Date
}

/// The single page of one preview.
@MainActor
@Observable
public final class PreviewPage {
    /// Set by the app at launch. Tests leave it offscreen.
    public static var backgroundHostMode: PreviewHostMode = .offscreen
    /// Unanswered dialogs are dismissed after this long (§4.5).
    public static let dialogTimeout: TimeInterval = 30

    public let key: PreviewKey
    public let keepsSignIn: Bool

    /// The server's loopback origin the page belongs to.
    public private(set) var origin: URL?
    /// Origins the page may also show: configured loopback URLs and the
    /// configuration's approved external origins (OAuth round-trips).
    public private(set) var extraOrigins: [URL] = []
    public private(set) var currentURL: URL?
    public private(set) var title = ""
    public private(set) var canGoBack = false
    public private(set) var canGoForward = false
    public private(set) var isLoading = false
    public private(set) var loadError: String?
    /// The main document's HTTP status, from the navigation response.
    public private(set) var mainDocumentStatus: Int?
    /// Bumped by every committed main-frame navigation.
    public private(set) var navigationID = 0
    public private(set) var pendingDialog: PreviewDialog?
    public private(set) var viewport: PreviewViewport = .responsive
    /// True while the agent is acting on the page (the pane's glow and the
    /// "Juno is using the preview" line).
    public private(set) var agentIsDriving = false
    /// The reader pressed Stop or Esc: input actions are refused until they
    /// let Juno use it again.
    public private(set) var agentStopped = false
    /// Whether a pane currently shows the page.
    public private(set) var isShownInPane = false

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored let diagnostics = PreviewDiagnostics()
    @ObservationIgnored private let coordinator: PreviewPageCoordinator
    @ObservationIgnored private let hostWindow: NSWindow
    @ObservationIgnored private let hostContainer: PreviewPageContainerView
    @ObservationIgnored private var containers: [WeakContainer] = []
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var drivingReset: Task<Void, Never>?
    @ObservationIgnored private var dialogTimeoutTask: Task<Void, Never>?
    @ObservationIgnored var dialogCompletion: ((Bool, String?) -> Void)?
    /// A workspace file the next file chooser receives (`upload`).
    @ObservationIgnored var pendingUploadURL: URL?
    /// Where "since the previous action" starts for the agent.
    @ObservationIgnored var actionMark = PreviewDiagnostics.Mark(console: 0, network: 0, events: 0)
    @ObservationIgnored private let mobileTouchScript = WKUserScript(
        source: "try{Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});window.ontouchstart=null;}catch(_){}",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: false
    )

    private struct WeakContainer {
        weak var view: PreviewPageContainerView?
    }

    public init(key: PreviewKey, keepsSignIn: Bool = false) {
        self.key = key
        self.keepsSignIn = keepsSignIn
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = keepsSignIn
            ? WKWebsiteDataStore(forIdentifier: Self.dataStoreIdentifier(for: key))
            : .nonPersistent()
        configuration.preferences.inactiveSchedulingPolicy = .none
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let coordinator = PreviewPageCoordinator()
        configuration.userContentController.addUserScript(WKUserScript(
            source: PreviewDiagnostics.pageShim,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        configuration.userContentController.addUserScript(WKUserScript(
            source: PreviewSnapshotScript.library,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: PreviewSnapshotScript.world
        ))
        configuration.userContentController.add(coordinator, contentWorld: .page, name: PreviewDiagnostics.messageName)
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1_280, height: 800), configuration: configuration)
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = true
        webView.underPageBackgroundColor = NSColor(Studio.Surface.raised)
        self.webView = webView
        self.coordinator = coordinator

        let container = PreviewPageContainerView(frame: CGRect(x: 0, y: 0, width: 1_280, height: 800))
        hostContainer = container
        let window = NSWindow(
            contentRect: CGRect(x: -20_000, y: -20_000, width: 1_280, height: 800),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        window.contentView = container
        hostWindow = window

        coordinator.page = self
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        container.host(webView, viewport: viewport)
        placeHostWindow()
        observe()
    }

    /// A stable data store per checkout, so "Keep sign-in" survives relaunch
    /// and two checkouts never share cookies.
    static func dataStoreIdentifier(for key: PreviewKey) -> UUID {
        let digest = Digests.sha256Hex(key.checkoutRoot)
        let hex = Array(digest.prefix(32))
        let text = "\(String(hex[0..<8]))-\(String(hex[8..<12]))-\(String(hex[12..<16]))-\(String(hex[16..<20]))-\(String(hex[20..<32]))"
        return UUID(uuidString: text) ?? UUID()
    }

    private func observe() {
        observations = [
            webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.currentURL = webView.url }
            },
            webView.observe(\.title, options: [.new]) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.title = webView.title ?? "" }
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.canGoBack = webView.canGoBack }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.canGoForward = webView.canGoForward }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.isLoading = webView.isLoading }
            },
        ]
    }

    // MARK: - Hosting

    private func placeHostWindow() {
        let size = hostContainer.frame.size
        switch Self.backgroundHostMode {
        case .offscreen:
            hostWindow.alphaValue = 1
            hostWindow.setFrame(CGRect(x: -20_000, y: -20_000, width: size.width, height: size.height), display: false)
            hostWindow.orderOut(nil)
        case .onePoint:
            // One point, near-transparent, click-through, above normal
            // windows so it is never occluded; the web view inside keeps its
            // viewport size and is clipped, not scaled.
            let screen = NSScreen.main?.frame ?? .zero
            hostWindow.alphaValue = 0.01
            hostWindow.level = .floating
            hostWindow.setFrame(CGRect(x: screen.minX, y: screen.minY, width: 1, height: 1), display: false)
            hostContainer.frame = CGRect(origin: .zero, size: size)
            hostWindow.orderFrontRegardless()
        }
    }

    /// A pane shows the page: the web view moves into `container`.
    func adopt(into container: PreviewPageContainerView) {
        containers.removeAll { $0.view == nil || $0.view === container }
        containers.append(WeakContainer(view: container))
        container.host(webView, viewport: viewport)
        isShownInPane = true
        hostWindow.orderOut(nil)
    }

    /// A pane stops showing the page: it moves to the previous pane still in
    /// a window, or back to the host window.
    func release(from container: PreviewPageContainerView) {
        containers.removeAll { $0.view == nil || $0.view === container }
        guard webView.superview === container || webView.superview == nil else { return }
        if let previous = containers.last(where: { $0.view?.window != nil })?.view {
            previous.host(webView, viewport: viewport)
            isShownInPane = true
        } else {
            hostContainer.host(webView, viewport: viewport)
            isShownInPane = false
            placeHostWindow()
        }
    }

    /// Releases the web view entirely; the page is going away.
    func tearDown() {
        observations.removeAll()
        drivingReset?.cancel()
        dialogTimeoutTask?.cancel()
        answerDialog(accept: false, text: nil)
        webView.stopLoading()
        webView.removeFromSuperview()
        hostWindow.orderOut(nil)
        hostWindow.contentView = nil
    }

    // MARK: - Loading

    /// Points the page at a server. A new origin loads it; the same origin
    /// keeps whatever route the page is on.
    func open(origin: URL, extraOrigins: [URL] = [], path: String? = nil) {
        let changed = self.origin.map { !PreviewOrigin.sameOrigin($0, origin) } ?? true
        self.origin = origin
        self.extraOrigins = extraOrigins
        if changed || currentURL == nil || path != nil {
            load(Self.url(origin: origin, path: path))
        }
    }

    func load(_ url: URL) {
        loadError = nil
        mainDocumentStatus = nil
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    /// Reload that keeps the route (PV-38): the current page when there is
    /// one, the origin otherwise.
    func reload() {
        let failed = loadError != nil
        loadError = nil
        if let url = webView.url, !failed, url.scheme != "about" {
            webView.reloadFromOrigin()
        } else if let target = currentURL ?? origin {
            load(target)
        }
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }

    /// Whether `url` may be shown: the preview's own server (`localhost` and
    /// `127.0.0.1` are the same machine), a configured origin, or nothing
    /// that is not http(s).
    func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "about" { return true }
        guard scheme == "http" || scheme == "https" else { return false }
        if let origin, PreviewOrigin.sameLoopbackServer(url, origin) || PreviewOrigin.sameOrigin(url, origin) {
            return true
        }
        return extraOrigins.contains { PreviewOrigin.sameOrigin($0, url) }
    }

    /// Whether the page is on its preview's own loopback server, where the
    /// agent may act.
    var isOnPreviewOrigin: Bool {
        guard let origin, let currentURL else { return false }
        return PreviewOrigin.sameLoopbackServer(currentURL, origin) || PreviewOrigin.sameOrigin(currentURL, origin)
    }

    static func url(origin: URL, path: String?) -> URL {
        guard let path, !path.isEmpty else { return origin }
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        let parts = path.split(separator: "?", maxSplits: 1)
        var route = String(parts.first ?? "/")
        if !route.hasPrefix("/") { route = "/" + route }
        components?.path = route
        components?.query = parts.count > 1 ? String(parts[1]) : nil
        return components?.url ?? origin
    }

    // MARK: - Viewport

    func setViewport(_ viewport: PreviewViewport) {
        self.viewport = viewport
        switch viewport.colorScheme {
        case .system: webView.appearance = nil
        case .light: webView.appearance = NSAppearance(named: .aqua)
        case .dark: webView.appearance = NSAppearance(named: .darkAqua)
        }
        let controller = webView.configuration.userContentController
        let hadTouch = controller.userScripts.contains { $0.source == mobileTouchScript.source }
        if viewport.isMobile {
            webView.customUserAgent = PreviewViewport.mobileUserAgent
            if !hadTouch { controller.addUserScript(mobileTouchScript) }
        } else {
            webView.customUserAgent = nil
            if hadTouch {
                let others = controller.userScripts.filter { $0.source != mobileTouchScript.source }
                controller.removeAllUserScripts()
                others.forEach(controller.addUserScript)
            }
        }
        let host = webView.superview as? PreviewPageContainerView ?? hostContainer
        host.host(webView, viewport: viewport)
        if host === hostContainer {
            let size = viewport.size ?? hostContainer.frame.size
            hostContainer.frame = CGRect(origin: .zero, size: size)
            if Self.backgroundHostMode == .offscreen {
                hostWindow.setContentSize(size)
            }
            hostContainer.host(webView, viewport: viewport)
        }
    }

    // MARK: - Agent control

    func beginAgentAction() {
        agentIsDriving = true
        drivingReset?.cancel()
        drivingReset = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.agentIsDriving = false
        }
    }

    /// The reader's Stop (or Esc in the pane).
    public func stopAgent() {
        agentStopped = true
        agentIsDriving = false
        drivingReset?.cancel()
    }

    /// The reader lets Juno use the page again (a new message, or the pane's
    /// button).
    public func allowAgent() {
        agentStopped = false
    }

    // MARK: - Dialogs

    func presentDialog(_ dialog: PreviewDialog, completion: @escaping (Bool, String?) -> Void) {
        answerDialog(accept: false, text: nil)
        pendingDialog = dialog
        PreviewDialogMirror.shared.set(dialog.kind == .alert ? nil : dialog.message)
        dialogCompletion = completion
        diagnostics.recordEvent("The page opened a \(dialog.kind.rawValue): \"\(dialog.message.prefix(300))\"")
        dialogTimeoutTask?.cancel()
        dialogTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.dialogTimeout))
            guard !Task.isCancelled, let self, self.pendingDialog == dialog else { return }
            self.diagnostics.recordEvent("The \(dialog.kind.rawValue) was dismissed after \(Int(Self.dialogTimeout)) seconds without an answer.")
            self.answerDialog(accept: false, text: nil)
        }
    }

    /// Answers the open dialog. Returns false when none is open.
    @discardableResult
    func answerDialog(accept: Bool, text: String?) -> Bool {
        guard let completion = dialogCompletion else { return false }
        dialogCompletion = nil
        pendingDialog = nil
        PreviewDialogMirror.shared.set(nil)
        dialogTimeoutTask?.cancel()
        completion(accept, text)
        return true
    }

    // MARK: - Reporting from the coordinator

    func didStartNavigation() {
        loadError = nil
    }

    func didCommitNavigation() {
        navigationID += 1
    }

    func didFinishNavigation() {
        loadError = nil
    }

    func didFailNavigation(_ message: String) {
        loadError = message
    }

    func didReceiveMainResponse(status: Int?) {
        mainDocumentStatus = status
    }

    func recordDiagnostic(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "console":
            let level = PreviewConsoleEntry.Level(rawValue: body["level"] as? String ?? "log") ?? .log
            diagnostics.recordConsole(level: level, text: body["text"] as? String ?? "", navigationID: navigationID)
        case "network":
            let kind = PreviewNetworkEntry.Kind(rawValue: body["kind"] as? String ?? "resource") ?? .resource
            diagnostics.recordNetwork(
                kind: kind,
                method: body["method"] as? String ?? "GET",
                url: body["url"] as? String ?? "",
                status: (body["status"] as? NSNumber)?.intValue,
                failed: (body["failed"] as? Bool) ?? false,
                error: body["error"] as? String,
                durationMs: (body["durationMs"] as? NSNumber)?.intValue,
                navigationID: navigationID,
                body: body["body"] as? String
            )
        default:
            break
        }
    }
}

/// The view a page's web view sits in: a pane's, or the host window's. With a
/// fixed viewport the web view keeps that size, centred, and the container's
/// bounds are scaled so it fits without changing its CSS size.
final class PreviewPageContainerView: NSView {
    private(set) weak var hosted: WKWebView?
    private var viewport: PreviewViewport = .responsive
    var onWindowChange: ((PreviewPageContainerView) -> Void)?

    override var isFlipped: Bool { true }

    func host(_ webView: WKWebView, viewport: PreviewViewport) {
        self.viewport = viewport
        if webView.superview !== self {
            webView.removeFromSuperview()
            addSubview(webView)
        }
        hosted = webView
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    override func layout() {
        super.layout()
        guard let webView = hosted, webView.superview === self else { return }
        let available = frame.size
        guard let size = viewport.size, available.width > 0, available.height > 0 else {
            setBoundsSize(available)
            setBoundsOrigin(.zero)
            webView.frame = CGRect(origin: .zero, size: available)
            return
        }
        // Fit the fixed viewport, never enlarging it.
        let scale = min(1, available.width / size.width, available.height / size.height)
        let boundsSize = CGSize(width: available.width / scale, height: available.height / scale)
        setBoundsSize(boundsSize)
        setBoundsOrigin(.zero)
        webView.frame = CGRect(
            x: ((boundsSize.width - size.width) / 2).rounded(),
            y: ((boundsSize.height - size.height) / 2).rounded(),
            width: size.width,
            height: size.height
        )
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChange?(self)
    }
}

/// Navigation policy, UI delegate and diagnostics for one page
/// (CODE_AGENT_SPEC §4.5, PV-26, PV-27).
@MainActor
final class PreviewPageCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    weak var page: PreviewPage?

    // MARK: Navigation policy

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let page, let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            page.diagnostics.recordEvent("A download of \(url.absoluteString) was cancelled; the Preview does not download files.")
            decisionHandler(.cancel)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if ["file", "javascript"].contains(scheme) || (scheme == "data" && isMainFrame) {
            page.diagnostics.recordEvent("A \(scheme): navigation was refused.")
            decisionHandler(.cancel)
            return
        }
        // Subframes are page content; the agent never acts inside a
        // cross-origin one anyway.
        guard isMainFrame else {
            decisionHandler(.allow)
            return
        }
        if page.isAllowed(url) || page.origin == nil {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if navigationAction.navigationType == .linkActivated, !page.agentIsDriving, ["http", "https"].contains(scheme) {
            // The reader clicked a link to another site: their browser.
            NSWorkspace.shared.open(url)
            page.diagnostics.recordEvent("Opened \(url.host ?? url.absoluteString) in the default browser.")
        } else {
            page.diagnostics.recordEvent("External navigation to \(url.host ?? url.absoluteString) is not available in the Preview.")
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame {
            let status = (navigationResponse.response as? HTTPURLResponse)?.statusCode
            page?.didReceiveMainResponse(status: status)
            if let url = navigationResponse.response.url {
                page?.diagnostics.recordNetwork(
                    kind: .document,
                    method: "GET",
                    url: url.absoluteString,
                    status: status,
                    failed: false,
                    error: nil,
                    durationMs: nil,
                    navigationID: (page?.navigationID ?? 0) + 1
                )
            }
        }
        if !navigationResponse.canShowMIMEType {
            page?.diagnostics.recordEvent("A download was cancelled; the Preview does not download files.")
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        page?.didStartNavigation()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        page?.didCommitNavigation()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        page?.didFinishNavigation()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        page?.didFailNavigation(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled || nsError.code == 102 { return }
        page?.didFailNavigation(error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        page?.diagnostics.recordEvent("The page's web process ended; Juno reloaded it.")
        webView.reload()
    }

    // MARK: UI delegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let page, let url = navigationAction.request.url else { return nil }
        if page.isAllowed(url) {
            // A same-origin popup or target=_blank loads in place.
            webView.load(navigationAction.request)
            page.diagnostics.recordEvent("A new window for \(url.path.isEmpty ? "/" : url.path) opened in place.")
        } else if !page.agentIsDriving, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
            page.diagnostics.recordEvent("Opened \(url.host ?? url.absoluteString) in the default browser.")
        } else {
            page.diagnostics.recordEvent("A popup to \(url.host ?? url.absoluteString) was blocked; external sites are not available in the Preview.")
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor () -> Void
    ) {
        guard let page else { return completionHandler() }
        page.presentDialog(PreviewDialog(kind: .alert, message: message, defaultText: nil, openedAt: Date())) { _, _ in
            completionHandler()
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (Bool) -> Void
    ) {
        guard let page else { return completionHandler(false) }
        page.presentDialog(PreviewDialog(kind: .confirm, message: message, defaultText: nil, openedAt: Date())) { accept, _ in
            completionHandler(accept)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (String?) -> Void
    ) {
        guard let page else { return completionHandler(nil) }
        page.presentDialog(PreviewDialog(kind: .prompt, message: prompt, defaultText: defaultText, openedAt: Date())) { accept, text in
            completionHandler(accept ? (text ?? defaultText ?? "") : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor ([URL]?) -> Void
    ) {
        guard let page else { return completionHandler(nil) }
        if let file = page.pendingUploadURL {
            page.pendingUploadURL = nil
            completionHandler([file])
            page.diagnostics.recordEvent("The file chooser received \(file.lastPathComponent).")
        } else {
            completionHandler(nil)
            page.diagnostics.recordEvent("The page opened a file chooser; give it a workspace file with preview_browser upload.")
        }
    }

    // MARK: Diagnostics

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == PreviewDiagnostics.messageName,
              let page,
              let body = message.body as? [String: Any]
        else { return }
        // Only frames on the preview's own origin may report (PV-27): a
        // cross-origin iframe cannot forge the page's diagnostics.
        let origin = message.frameInfo.securityOrigin
        guard let previewOrigin = page.origin,
              let frameURL = URL(string: "\(origin.protocol)://\(origin.host)\(origin.port > 0 ? ":\(origin.port)" : "")/"),
              PreviewOrigin.sameLoopbackServer(frameURL, previewOrigin) || PreviewOrigin.sameOrigin(frameURL, previewOrigin)
        else { return }
        page.recordDiagnostic(body)
    }
}

/// Every page, one per preview, alive for as long as its preview is
/// (CODE_AGENT_SPEC §4.1).
@MainActor
final class PreviewPageRegistry {
    static let shared = PreviewPageRegistry()

    private var pages: [PreviewKey: PreviewPage] = [:]

    func page(for key: PreviewKey) -> PreviewPage {
        if let existing = pages[key] { return existing }
        let keepsSignIn = PreviewLocalSettings.shared.project(key.checkoutURL).persistSignIn
        let page = PreviewPage(key: key, keepsSignIn: keepsSignIn)
        pages[key] = page
        return page
    }

    func existing(_ key: PreviewKey) -> PreviewPage? { pages[key] }

    /// Rebuilds the page, for a change that needs a new web view (keeping
    /// sign-in on or off).
    func rebuild(_ key: PreviewKey) -> PreviewPage {
        let old = pages.removeValue(forKey: key)
        let origin = old?.origin
        let extra = old?.extraOrigins ?? []
        let route = old?.currentURL
        old?.tearDown()
        let page = page(for: key)
        if let origin {
            page.open(origin: origin, extraOrigins: extra, path: route.map { $0.path + ($0.query.map { "?" + $0 } ?? "") })
        }
        return page
    }

    func remove(_ key: PreviewKey) {
        pages.removeValue(forKey: key)?.tearDown()
    }

    var all: [PreviewPage] { Array(pages.values) }
}

/// What the app turns on once at launch.
public enum PreviewHost {
    @MainActor private static var configured = false

    /// Background pages use the 1-pt host (D-025: the spike measured that
    /// WebKit throttles a page in a window off every screen), and quitting
    /// stops every server this process started.
    @MainActor
    public static func configureForApp() {
        guard !configured else { return }
        configured = true
        PreviewPage.backgroundHostMode = .onePoint
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { _ in
            JunoCodeLocal.PreviewRegistry.sharedLedger.terminateServersOwnedByThisProcess()
        }
        // Touch the registry so a crashed run's orphans are reaped now.
        _ = JunoCodeLocal.PreviewRegistry.shared
    }
}
