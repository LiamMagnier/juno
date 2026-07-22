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

public struct NativeArtifactPreview: View {
    private let kind: NativeArtifactKind
    private let content: String
    private let mode: NativeArtifactDisplayMode

    public init(
        kind: NativeArtifactKind,
        content: String,
        mode: NativeArtifactDisplayMode
    ) {
        self.kind = kind
        self.content = content
        self.mode = mode
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
                    html: NativeArtifactSandbox.document(kind: kind, content: content),
                    allowsJavaScript: kind == .html
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
    public static func document(kind: NativeArtifactKind, content: String) -> String {
        switch kind {
        case .svg:
            svgDocument(content)
        case .html:
            htmlDocument(content)
        case .react, .code, .markdown, .mermaid:
            escapedSourceDocument(content)
        }
    }

    private static let head = """
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
    """

    private static func svgDocument(_ content: String) -> String {
        """
        <!doctype html><html><head>\(head)<style>
        html,body{margin:0;height:100%}
        body{display:grid;place-items:center;background:#fff;padding:16px;box-sizing:border-box}
        svg{max-width:100%;max-height:100%}
        </style></head><body>\(content)</body></html>
        """
    }

    private static func htmlDocument(_ content: String) -> String {
        if content.range(
            of: #"<html[\s>]"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil {
            return content
        }
        return """
        <!doctype html><html><head>\(head)<style>
        body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#111;background:#fff}
        </style></head><body>\(content)</body></html>
        """
    }

    private static func escapedSourceDocument(_ content: String) -> String {
        let escaped = content
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!doctype html><html><head>\(head)<style>
        body{margin:0;background:#fff;color:#111;font:12.5px/1.6 ui-monospace,Menlo,monospace;padding:16px}
        pre{margin:0;white-space:pre-wrap;word-break:break-word}
        </style></head><body><pre>\(escaped)</pre></body></html>
        """
    }
}

private struct NativeArtifactWebPreview {
    let html: String
    let allowsJavaScript: Bool

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var allowsJavaScript: Bool
        var lastHTML = ""

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
        webView.loadHTMLString(html, baseURL: nil)
        return webView
    }

    @MainActor
    private func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.allowsJavaScript = allowsJavaScript
        if coordinator.lastHTML != html {
            coordinator.lastHTML = html
            webView.loadHTMLString(html, baseURL: nil)
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
