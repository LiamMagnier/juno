import Foundation
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

public enum NativeArtifactDisplayMode: String, CaseIterable, Identifiable, Sendable {
    case preview
    case source

    public var id: String { rawValue }
}

/// How much executable behaviour an artifact preview is allowed to retain.
///
/// Document previews may run inline HTML scripts, but remain network-isolated.
/// Gallery thumbnails are inert: JavaScript is disabled and motion is frozen so
/// merely opening the library cannot execute every visible artifact.
public enum NativeArtifactPreviewPolicy: Sendable, Equatable {
    case document
    case thumbnail
}

public struct NativeArtifactPreview: View {
    private let kind: NativeArtifactKind
    private let content: String
    private let mode: NativeArtifactDisplayMode
    private let policy: NativeArtifactPreviewPolicy

    public init(
        kind: NativeArtifactKind,
        content: String,
        mode: NativeArtifactDisplayMode,
        policy: NativeArtifactPreviewPolicy = .document
    ) {
        self.kind = kind
        self.content = content
        self.mode = mode
        self.policy = policy
    }

    public var body: some View {
        Group {
            if mode == .source || !kind.supportsRenderedPreview {
                ScrollView([.horizontal, .vertical]) {
                    Text(content)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
            } else if kind == .markdown {
                ScrollView {
                    Text(markdown)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(20)
                }
            } else {
                NativeArtifactWebPreview(
                    html: NativeArtifactSandbox.document(
                        kind: kind,
                        content: content,
                        policy: policy
                    ),
                    allowsJavaScript: kind == .html && policy == .document
                )
            }
        }
        .accessibilityIdentifier("juno.artifact-preview")
    }

    private var markdown: AttributedString {
        (try? AttributedString(
            markdown: content,
            options: .init(interpretedSyntax: .full)
        )) ?? AttributedString(content)
    }
}

public enum NativeArtifactSandbox {
    /// A WebKit content-rule list that blocks every URL with a hierarchical
    /// scheme (`https://`, `wss://`, `ftp://`, `file://`, and custom schemes).
    /// Inline `data:` and `blob:` assets remain available because they do not
    /// match this shape and are separately constrained by the CSP.
    ///
    /// The CSP embedded in each document is the first boundary. This independent
    /// WebKit boundary is defense in depth for malformed or browser-normalized
    /// markup that might otherwise move a policy tag out of the document head.
    static let networkContentRuleListJSON = """
    [
      {
        "trigger": { "url-filter": "^[a-z][a-z0-9+.-]*://.*" },
        "action": { "type": "block" }
      }
    ]
    """

    public static func document(
        kind: NativeArtifactKind,
        content: String,
        policy: NativeArtifactPreviewPolicy = .document
    ) -> String {
        switch kind {
        case .svg:
            svgDocument(content, policy: policy)
        case .html:
            htmlDocument(content, policy: policy)
        case .react, .code, .markdown, .mermaid, .design:
            // A design document opens in the editor, never in this sandbox. Where
            // the editor is unavailable, its JSON body is at least honest source.
            escapedSourceDocument(content, policy: policy)
        }
    }

    /// Shown when the network-deny rules could not be compiled, in place of the
    /// artifact. Internal rather than file-private because ``ArtifactCanvasView``
    /// fails closed through the same document: two "preview unavailable" screens
    /// would drift, and only one of them would keep the JavaScript disabled.
    static var previewUnavailableDocument: String {
        """
        <!doctype html><html><head>\(securityHead(
            allowsJavaScript: false,
            freezesMotion: true
        ))<style>
        html,body{margin:0;height:100%}
        body{display:grid;place-items:center;background:#fff;color:#666;
             font:13px ui-sans-serif,system-ui,sans-serif;text-align:center}
        </style></head><body>Preview unavailable</body></html>
        """
    }

    private static let head = """
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
    """

    private static func securityHead(
        allowsJavaScript: Bool,
        freezesMotion: Bool
    ) -> String {
        let scriptSource = allowsJavaScript ? "'unsafe-inline'" : "'none'"
        let policy = [
            "default-src 'none'",
            "base-uri 'none'",
            "connect-src 'none'",
            "font-src data:",
            "form-action 'none'",
            "frame-src 'none'",
            "img-src data: blob:",
            "media-src data: blob:",
            "object-src 'none'",
            "script-src \(scriptSource)",
            "style-src 'unsafe-inline'",
            "worker-src 'none'",
        ].joined(separator: "; ")
        let inertStyle = freezesMotion
            ? """
              <style id="juno-inert-preview">
              *,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
              html{pointer-events:none!important}
              </style>
              """
            : ""
        return """
        \(head)
        <meta http-equiv="Content-Security-Policy" content="\(policy)"/>
        <meta name="referrer" content="no-referrer"/>
        \(inertStyle)
        """
    }

    private static func svgDocument(
        _ content: String,
        policy: NativeArtifactPreviewPolicy
    ) -> String {
        """
        <!doctype html><html><head>\(securityHead(
            allowsJavaScript: false,
            freezesMotion: policy == .thumbnail
        ))<style>
        html,body{margin:0;height:100%}
        body{display:grid;place-items:center;background:#fff;padding:16px;box-sizing:border-box}
        svg{max-width:100%;max-height:100%}
        </style></head><body>\(content)</body></html>
        """
    }

    private static func htmlDocument(
        _ content: String,
        policy: NativeArtifactPreviewPolicy
    ) -> String {
        let security = securityHead(
            allowsJavaScript: policy == .document,
            freezesMotion: policy == .thumbnail
        )
        if content.range(
            of: #"<html[\s>]"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil {
            return injecting(security, intoFullHTML: content)
        }
        return """
        <!doctype html><html><head>\(security)<style>
        body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#111;background:#fff}
        </style></head><body>\(content)</body></html>
        """
    }

    private static func escapedSourceDocument(
        _ content: String,
        policy: NativeArtifactPreviewPolicy
    ) -> String {
        let escaped = content
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!doctype html><html><head>\(securityHead(
            allowsJavaScript: false,
            freezesMotion: policy == .thumbnail
        ))<style>
        body{margin:0;background:#fff;color:#111;font:12.5px/1.6 ui-monospace,Menlo,monospace;padding:16px}
        pre{margin:0;white-space:pre-wrap;word-break:break-word}
        </style></head><body><pre>\(escaped)</pre></body></html>
        """
    }

    /// Inserts security metadata before any artifact-provided head content.
    ///
    /// A second CSP supplied by the artifact can only make the effective policy
    /// stricter; policies do not replace one another. If the document omitted a
    /// head, one is created immediately after the opening html element.
    private static func injecting(_ security: String, intoFullHTML content: String) -> String {
        if let head = content.range(
            of: #"<head(?:\s[^>]*)?>"#,
            options: [.regularExpression, .caseInsensitive]
        ) {
            var secured = content
            secured.insert(contentsOf: security, at: head.upperBound)
            return secured
        }
        if let html = content.range(
            of: #"<html(?:\s[^>]*)?>"#,
            options: [.regularExpression, .caseInsensitive]
        ) {
            var secured = content
            secured.insert(contentsOf: "<head>\(security)</head>", at: html.upperBound)
            return secured
        }
        // Defensive fallback for parser edge cases. `htmlDocument` normally calls
        // this only after finding an html element.
        return "<!doctype html><html><head>\(security)</head><body>\(content)</body></html>"
    }
}

private struct NativeArtifactWebPreview {
    let html: String
    let allowsJavaScript: Bool

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var allowsJavaScript: Bool
        var lastHTML = ""
        var networkRulesInstalled = false

        init(allowsJavaScript: Bool) {
            self.allowsJavaScript = allowsJavaScript
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            preferences: WKWebpagePreferences,
            decisionHandler: @escaping @MainActor (
                WKNavigationActionPolicy,
                WKWebpagePreferences
            ) -> Void
        ) {
            preferences.allowsContentJavaScript = allowsJavaScript
            if let url = navigationAction.request.url,
                let scheme = url.scheme?.lowercased(),
                scheme == "http" || scheme == "https",
                navigationAction.targetFrame?.isMainFrame ?? true
            {
                if navigationAction.navigationType == .linkActivated {
                    Self.openExternally(url)
                }
                decisionHandler(.cancel, preferences)
                return
            }
            decisionHandler(.allow, preferences)
        }

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

        private static func openExternally(_ url: URL) {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            UIApplication.shared.open(url)
            #endif
        }
    }

    @MainActor
    func makeCoordinator() -> Coordinator {
        Coordinator(allowsJavaScript: allowsJavaScript)
    }

    @MainActor
    private func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = allowsJavaScript
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        #if os(iOS)
        webView.scrollView.bounces = false
        webView.isOpaque = true
        #endif
        coordinator.allowsJavaScript = allowsJavaScript
        coordinator.lastHTML = html
        NativeArtifactContentRules.shared.install(
            into: configuration.userContentController
        ) { installed in
            coordinator.networkRulesInstalled = installed
            let document = installed
                ? coordinator.lastHTML
                : NativeArtifactSandbox.previewUnavailableDocument
            webView.loadHTMLString(document, baseURL: nil)
        }
        return webView
    }

    @MainActor
    private func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.allowsJavaScript = allowsJavaScript
        if coordinator.lastHTML != html {
            coordinator.lastHTML = html
            if coordinator.networkRulesInstalled {
                webView.loadHTMLString(html, baseURL: nil)
            }
        }
    }
}

/// Compiles the network-deny rules once per process and installs the same
/// immutable rule list into every artifact WebView before its first document
/// load. If WebKit cannot compile the list, the artifact never loads; the
/// WebView receives a non-executable local error document instead.
///
/// Internal, not file-private, so ``ArtifactCanvasView`` shares this exact cache.
/// A second compiler would produce a second `WKContentRuleList` under a second
/// identifier — the same rules, compiled twice, with two chances for one of them
/// to be edited and the other forgotten. Sharing means the canvas cannot be less
/// isolated than the inline preview.
@MainActor
final class NativeArtifactContentRules {
    static let shared = NativeArtifactContentRules()

    private let identifier = "com.juno.artifact-preview.network-isolation.v1"
    private var cached: WKContentRuleList?
    private var loading = false
    private var waiters: [(WKContentRuleList?) -> Void] = []

    func install(
        into controller: WKUserContentController,
        completion: @escaping (Bool) -> Void
    ) {
        load { rule in
            if let rule {
                controller.add(rule)
            }
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
            encodedContentRuleList: NativeArtifactSandbox.networkContentRuleListJSON
        ) { [weak self] rule, _ in
            guard let self else { return }
            cached = rule
            loading = false
            let pending = waiters
            waiters.removeAll()
            for waiter in pending {
                waiter(rule)
            }
        }
    }
}

#if os(macOS)
extension NativeArtifactWebPreview: NSViewRepresentable {
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
extension NativeArtifactWebPreview: UIViewRepresentable {
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
