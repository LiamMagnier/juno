import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI
import WebKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The cloud computer section on an agent's Now tab (BRIEF.md §4.9).
///
/// Renders the poster or frame, the plain-text state sentence, and the
/// **Wake**, **Watch**, **Take control** and **Hand back** actions. Opening
/// Watch or Take control mints a one-time `/computer-view?c=…` handoff URL
/// (`POST /api/agents/{id}/computer/view` with `handoff: true`) and presents
/// it in a sheet backed by a non-persistent `WKWebView` pinned to the app's
/// own origin.
struct NativeAgentComputerView: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let computer: NativeAgentCloudComputer?

    @State private var posterImage: Image?
    @State private var isWorking = false
    @State private var confirmingEnable = false
    @State private var activeHandoff: HandoffSession?
    @State private var controlling = false

    struct HandoffSession: Identifiable {
        let id = UUID()
        let url: URL
        let mode: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            NativeAgentHeading(title: "Its computer")

            if let computer, computer.enabled {
                enabledContent(computer)
            } else {
                disabledContent
            }
        }
        .task(id: "\(agent.id)-\(computer?.hasPoster == true)-\(computer?.lastActiveAt?.timeIntervalSince1970 ?? 0)") {
            guard computer?.hasPoster == true else {
                posterImage = nil
                return
            }
            if let data = await model.computerPoster(agentID: agent.id) {
                posterImage = Self.decodeImage(data)
            }
        }
        .sheet(item: $activeHandoff) { session in
            NativeAgentComputerHandoffSheet(
                model: model,
                agentID: agent.id,
                agentName: agent.name,
                session: session,
                onHandBack: {
                    Task {
                        await model.computerHandBack(agentID: agent.id)
                        controlling = false
                        activeHandoff = nil
                    }
                },
                onClose: {
                    if session.mode == "control" {
                        Task {
                            await model.computerHandBack(agentID: agent.id)
                            controlling = false
                        }
                    }
                    activeHandoff = nil
                }
            )
        }
    }

    private var disabledContent: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("\(agent.name) doesn’t have a computer yet. With one, it can sign in to sites, run code and keep files.")
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)

            if confirmingEnable {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    Text("Give \(agent.name) its own Linux desktop? It stays between tasks and rests when idle.")
                        .font(.callout)
                        .junoInk()
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: JunoSpace.snug) {
                        Button {
                            confirmingEnable = false
                            performAction("enable")
                        } label: {
                            Text("Give it a computer")
                                .frame(minHeight: NativeAgentMetrics.target)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.junoProminent)
                        .disabled(isWorking)

                        Button {
                            confirmingEnable = false
                        } label: {
                            Text("Not now")
                                .frame(minHeight: NativeAgentMetrics.target)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.junoGlass)
                        .disabled(isWorking)
                    }
                }
            } else {
                Button {
                    confirmingEnable = true
                } label: {
                    Text("Give it a computer")
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoProminent)
                .disabled(isWorking)
            }
        }
    }

    @ViewBuilder
    private func enabledContent(_ computer: NativeAgentCloudComputer) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            posterFrame(computer)

            Text(stateSentence(for: computer))
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: JunoSpace.snug) {
                switch computer.status {
                case "asleep", "off":
                    Button {
                        performAction("wake")
                    } label: {
                        Text("Wake")
                            .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                    }
                    .buttonStyle(.junoProminent)
                    .disabled(isWorking)

                case "resting", "awake":
                    Button {
                        openViewer(mode: "watch")
                    } label: {
                        Text("Watch")
                            .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                    }
                    .buttonStyle(.junoProminent)
                    .disabled(isWorking)

                    Button {
                        openViewer(mode: "control")
                    } label: {
                        Text("Take control")
                            .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                    }
                    .buttonStyle(.junoGlass)
                    .disabled(isWorking)

                    if controlling {
                        Button {
                            Task {
                                isWorking = true
                                await model.computerHandBack(agentID: agent.id)
                                controlling = false
                                isWorking = false
                            }
                        } label: {
                            Text("Hand back")
                                .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                        }
                        .buttonStyle(.junoGlass)
                        .disabled(isWorking)
                    }

                case "error":
                    Button {
                        performAction("wake")
                    } label: {
                        Text("Wake")
                            .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                    }
                    .buttonStyle(.junoProminent)
                    .disabled(isWorking)

                    Button {
                        performAction("reset")
                    } label: {
                        Text("Reset")
                            .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                    }
                    .buttonStyle(.junoGlass)
                    .disabled(isWorking)

                default:
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
    }

    @ViewBuilder
    private func posterFrame(_ computer: NativeAgentCloudComputer) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                .fill(Color.junoRaised)

            if let posterImage {
                posterImage
                    .resizable()
                    .scaledToFit()
                    .opacity(computer.status == "asleep" ? 0.55 : 1.0)
                    .clipShape(RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous))
            } else {
                VStack(spacing: JunoSpace.tight) {
                    JunoIconView(.monitor, size: 20)
                        .foregroundStyle(Color.junoMutedForeground)
                    Text(computer.status == "awake" ? "Desktop awake" : "Linux desktop")
                        .junoCaption()
                }
            }
        }
        .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .frame(maxWidth: 420)
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
    }

    private func stateSentence(for computer: NativeAgentCloudComputer) -> String {
        if controlling {
            return "You have control. \(agent.name) waits until you hand back."
        }
        switch computer.status {
        case "asleep", "off":
            return "Asleep. It wakes when \(agent.name) starts working."
        case "resting":
            return "Resting. Opens instantly."
        case "starting", "waking":
            return "Waking up…"
        case "awake":
            if let summary = computer.usingNowSummary, !summary.isEmpty {
                return "\(agent.name) is using it: \(summary)"
            }
            return "Idle. Rests after 3 minutes."
        case "error":
            return computer.error ?? "Couldn’t reach the computer."
        default:
            return "Asleep. It wakes when \(agent.name) starts working."
        }
    }

    private func performAction(_ action: String) {
        Task {
            isWorking = true
            _ = await model.computerAction(agentID: agent.id, action: action)
            isWorking = false
        }
    }

    private func openViewer(mode: String) {
        Task {
            isWorking = true
            if computer?.status == "asleep" || computer?.status == "resting" {
                _ = await model.computerAction(agentID: agent.id, action: "wake")
            }
            if let rawURL = await model.computerHandoffURL(agentID: agent.id, mode: mode),
                let url = URL(string: rawURL)
            {
                if mode == "control" {
                    controlling = true
                }
                activeHandoff = HandoffSession(url: url, mode: mode)
            }
            isWorking = false
        }
    }

    private static func decodeImage(_ data: Data) -> Image? {
        #if canImport(UIKit)
        guard let uiImage = UIImage(data: data) else { return nil }
        return Image(uiImage: uiImage)
        #elseif canImport(AppKit)
        guard let nsImage = NSImage(data: data) else { return nil }
        return Image(nsImage: nsImage)
        #else
        return nil
        #endif
    }
}

// MARK: - Handoff Viewer Sheet

private struct NativeAgentComputerHandoffSheet: View {
    let model: NativeAgentsModel
    let agentID: String
    let agentName: String
    let session: NativeAgentComputerView.HandoffSession
    let onHandBack: () -> Void
    let onClose: () -> Void

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(agentName)’s computer")
                        .font(.headline)
                        .junoInk()
                    Text(
                        session.mode == "control"
                            ? "You have control. \(agentName) waits until you hand back."
                            : "Watching live desktop."
                    )
                    .junoCaption()
                }
                Spacer(minLength: JunoSpace.snug)

                if session.mode == "control" {
                    Button {
                        onHandBack()
                    } label: {
                        Text("Hand back")
                            .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                    }
                    .buttonStyle(.junoProminent)
                }

                Button {
                    onClose()
                } label: {
                    Text("Close")
                        .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
                }
                .buttonStyle(.junoGlass)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.cozy)

            Divider()

            NativeAgentComputerHandoffWebView(url: session.url, isActive: scenePhase == .active)
                .frame(minWidth: 640, minHeight: 420)
        }
        .task(id: session.id) {
            while !Task.isCancelled {
                await model.computerHeartbeat(agentID: agentID, mode: session.mode)
                try? await Task.sleep(for: .seconds(20))
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .background {
                onClose()
            }
        }
    }
}

/// Non-persistent `WKWebView` pinned to the app's own origin for the one-time
/// `/computer-view?c=…` handoff URL (BRIEF.md §4.9).
struct NativeAgentComputerHandoffWebView {
    let url: URL
    let isActive: Bool

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let allowedHost: String?
        let allowedScheme: String?
        var loadedURL: URL?

        init(url: URL) {
            self.allowedHost = url.host?.lowercased()
            self.allowedScheme = url.scheme?.lowercased()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            preferences: WKWebpagePreferences,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
        ) {
            preferences.allowsContentJavaScript = true
            guard let targetURL = navigationAction.request.url else {
                decisionHandler(.cancel, preferences)
                return
            }
            let scheme = targetURL.scheme?.lowercased()
            if scheme == "about" || targetURL.absoluteString == "about:blank" {
                decisionHandler(.allow, preferences)
                return
            }
            let host = targetURL.host?.lowercased()
            if scheme == allowedScheme, host == allowedHost {
                decisionHandler(.allow, preferences)
                return
            }
            decisionHandler(.cancel, preferences)
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
        Coordinator(url: url)
    }

    @MainActor
    func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        #if os(iOS)
        webView.scrollView.bounces = false
        #endif

        coordinator.loadedURL = url
        webView.load(URLRequest(url: url))
        return webView
    }

    @MainActor
    func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        if !isActive {
            Self.unload(webView)
            return
        }
        if coordinator.loadedURL != url {
            coordinator.loadedURL = url
            webView.load(URLRequest(url: url))
        }
    }

    @MainActor
    static func unload(_ webView: WKWebView) {
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }
}

#if os(macOS)
extension NativeAgentComputerHandoffWebView: NSViewRepresentable {
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
        unload(nsView)
    }
}
#else
extension NativeAgentComputerHandoffWebView: UIViewRepresentable {
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
        unload(uiView)
    }
}
#endif
