import SwiftUI

#if canImport(WebKit)
import WebKit
#endif

/// The Mermaid engine, supplied by the host application.
///
/// **This package ships no JavaScript and fetches none.** Mermaid is ~3 MB of
/// engine; vendoring it here would put a web bundle inside the design system,
/// add an SPM resource to a target that has none, and make every consumer of
/// `JunoDesignSystem` — including the ones that never draw a transcript — carry
/// it. Loading it from a CDN was rejected outright: a transcript that phones out
/// mid-answer is a different product than the one this app claims to be, and it
/// would stop working on a plane.
///
/// So the app registers the engine it already ships, once, at launch:
///
/// ```swift
/// if let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js"),
///     let script = try? String(contentsOf: url, encoding: .utf8) {
///     JunoMermaidEngine.register(script: script)
/// }
/// ```
///
/// Until that happens — and forever, in a build that chooses not to ship it —
/// ``MermaidDiagramView`` shows the labelled source. That is not a broken state.
/// It is the behaviour this package had before diagrams existed, and it is still
/// the truthful one: a diagram nobody can draw is best presented as the text it
/// actually is, rather than as an error or an empty box.
@MainActor
public enum JunoMermaidEngine {
    /// The registered engine, or nil.
    public private(set) static var script: String?

    /// Registers the engine. Idempotent, and last-writer-wins so a test can
    /// swap in a stub and put the real one back.
    public static func register(script: String?) {
        Self.script = script?.isEmpty == true ? nil : script
    }

    /// Whether diagrams will draw. Views read this to choose their shape, so it
    /// is public: a caller that wants to know before laying out can ask.
    public static var isAvailable: Bool { script != nil }
}

/// A ```` ```mermaid ```` fence, drawn as a diagram.
///
/// **Isolated, not embedded.** The WebView gets a non-persistent data store, a
/// `default-src 'none'` CSP, a compiled content-rule list that blocks every
/// scheme-prefixed URL, and a document assembled entirely in Swift. Nothing
/// about the diagram touches the app's cookies, cache, or network, and a
/// diagram cannot navigate: link activations are refused rather than followed,
/// because a diagram node is not a link the reader chose to click.
///
/// **Zoom and pan live in the page**, not in a SwiftUI gesture. A `MagnifyGesture`
/// over a WebView fights the WebView's own gesture recognisers and loses on
/// iOS; more importantly the transform has to apply to the SVG's own coordinate
/// space to stay crisp, and only the page can do that. The native chrome keeps
/// the one control that cannot live in the page — "Reset view" — because a
/// reader who has zoomed into the corner of a flowchart needs a way out that
/// does not involve guessing at scroll gestures.
///
/// **Theme changes re-render in place** rather than reloading, so zoom and pan
/// survive switching appearance. A reload would silently throw the reader's view
/// state away, which reads as the diagram jumping for no reason.
public struct MermaidDiagramView: View {
    /// What the frame is worth before the page has measured itself.
    ///
    /// A placeholder, explicitly **not** zero. A zero-height WebView is
    /// indistinguishable from a failed one, and collapsing the transcript around
    /// a block that is about to appear produces exactly the scroll jump that
    /// measuring exists to avoid. Absent height is unknown height, not no height.
    static let placeholderHeight: CGFloat = 220

    private let source: String

    @Environment(\.colorScheme) private var colorScheme
    @State private var measuredHeight: CGFloat?
    @State private var failure: String?
    @State private var resetToken = 0
    @State private var didCopy = false

    public init(source: String) {
        self.source = source
    }

    private var kind: JunoMermaidDiagramKind {
        JunoMermaidMarkup.diagramKind(of: source)
    }

    public var body: some View {
        VStack(spacing: 0) {
            JunoAIcssBlockHeader(icon: kind.icon, label: kind.label) {
                controls
            }
            content
        }
        .background(Color.junoSurface)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
    }

    // MARK: Chrome

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: JunoSpace.hairline) {
            if isDrawing {
                Button {
                    resetToken += 1
                } label: {
                    JunoIconView(.rotateCcw)
                        .junoFont(size: 12, relativeTo: .footnote)
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.junoPress)
                .help("Reset view")
                .accessibilityLabel("Reset diagram zoom and position")
            }

            Button {
                JunoPasteboard.copy(source)
                didCopy = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    didCopy = false
                }
            } label: {
                JunoIconView(didCopy ? .check : .copy)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.junoPress)
            .help(didCopy ? "Copied" : "Copy diagram source")
            .accessibilityLabel(didCopy ? "Diagram source copied" : "Copy diagram source")
        }
    }

    /// True when a real diagram is on screen — an engine is registered and it
    /// has not reported a failure. The reset control is meaningless otherwise.
    private var isDrawing: Bool {
        #if canImport(WebKit)
        return JunoMermaidEngine.isAvailable && failure == nil
        #else
        return false
        #endif
    }

    @ViewBuilder
    private var content: some View {
        #if canImport(WebKit)
        if let engine = JunoMermaidEngine.script, failure == nil {
            JunoMermaidWebView(
                source: source,
                engine: engine,
                isDark: colorScheme == .dark,
                resetToken: resetToken,
                onHeight: { measuredHeight = $0 },
                onFailure: { failure = $0 }
            )
            .frame(height: measuredHeight ?? Self.placeholderHeight)
            .frame(maxWidth: .infinity)
            // An SVG says nothing to VoiceOver. The source does — it names every
            // node and every edge, in order — so it is offered as the value
            // rather than leaving the reader with a labelled empty rectangle.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(kind.label)
            .accessibilityValue(source)
        } else {
            fallback
        }
        #else
        fallback
        #endif
    }

    /// The source, plainly. Shown when no engine is registered, when the
    /// platform has no WebKit, and when the engine reported a render error —
    /// which is usually a syntax error in the model's diagram, and is precisely
    /// the moment the reader most wants to see what was written.
    @ViewBuilder
    private var fallback: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(sourceLines.enumerated()), id: \.offset) { _, line in
                        Text(line.isEmpty ? " " : line)
                            .junoFont(size: 12.5, relativeTo: .footnote, design: .monospaced)
                            .foregroundStyle(Color.junoForeground)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.cozy)
            }

            if let failure {
                Text("This diagram could not be drawn: \(failure)")
                    .junoCaption()
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.bottom, JunoSpace.cozy)
            } else {
                Text("Shown as source — no diagram engine is available.")
                    .junoCaption()
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.bottom, JunoSpace.cozy)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sourceLines: [String] {
        source.hasSuffix("\n")
            ? String(source.dropLast()).components(separatedBy: "\n")
            : source.components(separatedBy: "\n")
    }
}

extension JunoMermaidDiagramKind {
    /// The website's mark for the block header. Chosen for what the diagram
    /// *is*, so a reader skimming a long answer can find the sequence diagram
    /// without reading the labels.
    var icon: JunoIcon {
        switch self {
        case .flowchart, .stateDiagram, .requirement: .workflow
        case .sequence: .arrowLeftRight
        case .classDiagram, .entityRelationship: .blocks
        case .userJourney, .timeline, .gantt: .chartGantt
        case .pie: .chartPie
        case .quadrant: .grid
        case .gitGraph: .branch
        case .mindmap: .waypoints
        case .unknown: .penTool
        }
    }
}

// MARK: - The isolated WebView

#if canImport(WebKit)

private struct JunoMermaidWebView {
    let source: String
    let engine: String
    let isDark: Bool
    let resetToken: Int
    let onHeight: (CGFloat) -> Void
    let onFailure: (String) -> Void

    /// Identifies the *document*, so a theme flip or a reset does not trigger a
    /// reload. Only a change of diagram or engine does.
    private var documentKey: String {
        "\(source.hashValue):\(engine.count)"
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        var onHeight: (CGFloat) -> Void = { _ in }
        var onFailure: (String) -> Void = { _ in }
        var loadedDocumentKey: String?
        var appliedDark: Bool?
        var appliedResetToken = 0
        var rulesInstalled = false

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let payload = message.body as? [String: Any],
                let kind = payload["kind"] as? String
            else { return }
            switch kind {
            case "height":
                // A non-positive height is not a measurement, it is the page
                // telling us it has not laid out yet. Passing it through would
                // collapse the block.
                if let value = payload["value"] as? Double, value > 0 {
                    onHeight(CGFloat(value.rounded(.up)))
                }
            case "error":
                onFailure(payload["value"] as? String ?? "unknown error")
            default:
                break
            }
        }

        /// A diagram may not navigate. Mermaid nodes can carry `click` links, and
        /// following one would take the transcript somewhere the reader did not
        /// ask to go — inside a view with no address bar and no back button.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            let isDocumentLoad = navigationAction.request.url?.scheme == nil
                || navigationAction.request.url?.absoluteString == "about:blank"
            decisionHandler(isDocumentLoad ? .allow : .cancel)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }
    }

    @MainActor
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    @MainActor
    private func makeWebView(coordinator: Coordinator) -> WKWebView {
        coordinator.onHeight = onHeight
        coordinator.onFailure = onFailure

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(
            coordinator,
            name: JunoMermaidMarkup.messageHandlerName
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        // Transparent, so the diagram sits on the block's own surface instead of
        // punching a white rectangle through a dark transcript.
        #if os(macOS)
        webView.setValue(false, forKey: "drawsBackground")
        #else
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        #endif

        JunoMermaidContentRules.shared.install(into: configuration.userContentController) {
            installed in
            coordinator.rulesInstalled = installed
            guard installed else {
                // Refusing to draw is the right failure. The alternative is a
                // WebView with no network isolation, which is the one thing this
                // whole file is arranged to prevent.
                coordinator.onFailure("network isolation unavailable")
                return
            }
            load(webView, coordinator: coordinator)
        }
        return webView
    }

    @MainActor
    private func load(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.loadedDocumentKey = documentKey
        coordinator.appliedDark = isDark
        webView.loadHTMLString(
            JunoMermaidMarkup.hostDocument(source: source, engine: engine, isDark: isDark),
            baseURL: nil
        )
    }

    @MainActor
    private func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.onHeight = onHeight
        coordinator.onFailure = onFailure
        guard coordinator.rulesInstalled else { return }

        if coordinator.loadedDocumentKey != documentKey {
            load(webView, coordinator: coordinator)
            return
        }
        if coordinator.appliedDark != isDark {
            coordinator.appliedDark = isDark
            webView.evaluateJavaScript(
                "window.junoSetTheme && window.junoSetTheme(\"\(isDark ? "dark" : "default")\")"
            )
        }
        if coordinator.appliedResetToken != resetToken {
            coordinator.appliedResetToken = resetToken
            webView.evaluateJavaScript("window.junoResetView && window.junoResetView()")
        }
    }
}

/// Compiles the block-everything rule list once per process and hands the same
/// immutable list to every diagram.
///
/// Mirrors the artifact preview's isolation deliberately: two WebViews in one
/// app with two different network postures is a posture nobody can reason
/// about. If compilation fails, no diagram loads — the fallback shows the
/// source, which is strictly safer than an un-isolated render.
@MainActor
private final class JunoMermaidContentRules {
    static let shared = JunoMermaidContentRules()

    private let identifier = "com.juno.design-system.mermaid.network-isolation.v1"
    private let ruleListJSON = """
        [
          {
            "trigger": { "url-filter": "^[a-z][a-z0-9+.-]*://.*" },
            "action": { "type": "block" }
          }
        ]
        """
    private var cached: WKContentRuleList?
    private var loading = false
    private var waiters: [(WKContentRuleList?) -> Void] = []

    func install(
        into controller: WKUserContentController,
        completion: @escaping (Bool) -> Void
    ) {
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
            encodedContentRuleList: ruleListJSON
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

#if os(macOS)
extension JunoMermaidWebView: NSViewRepresentable {
    @MainActor
    func makeNSView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    @MainActor
    func updateNSView(_ nsView: WKWebView, context: Context) {
        updateWebView(nsView, coordinator: context.coordinator)
    }
}
#else
extension JunoMermaidWebView: UIViewRepresentable {
    @MainActor
    func makeUIView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    @MainActor
    func updateUIView(_ uiView: WKWebView, context: Context) {
        updateWebView(uiView, coordinator: context.coordinator)
    }
}
#endif

#endif
