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

/// An agent's computer, full screen (DIRECTION.md: the computer is a place
/// you can look into, not a tab). Opened from the thread's Computer button
/// and from the profile's Open.
///
/// It wakes the computer if it is resting, mints a one-time watch handoff
/// (`POST /api/agents/{id}/computer/view` with `handoff: true`) and shows it
/// in a non-persistent `WKWebView` pinned to the app's own origin. Take
/// control mints a control handoff; Hand back returns the computer to the
/// agent. A heartbeat keeps the session open while it is on screen.
struct NativeAgentComputerScreen: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let close: () -> Void

    @State private var session: HandoffSession?
    @State private var isWorking = false
    @State private var failed = false
    @Environment(\.scenePhase) private var scenePhase

    struct HandoffSession: Identifiable, Equatable {
        let id = UUID()
        let url: URL
        let mode: String
    }

    private var computer: NativeAgentCloudComputer? { model.computer(for: agent.id) }
    private var controlling: Bool { session?.mode == "control" }

    var body: some View {
        VStack(spacing: 0) {
            bar
            ZStack {
                Color.junoSecondary
                content
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        #if os(macOS)
        .frame(minWidth: 960, idealWidth: 1_240, minHeight: 640, idealHeight: 820)
        #endif
        .junoSheetSurface(.page)
        .task { await open(mode: "watch") }
        .task(id: session?.id) {
            guard let session else { return }
            while !Task.isCancelled {
                await model.computerHeartbeat(agentID: agent.id, mode: session.mode)
                try? await Task.sleep(for: .seconds(20))
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { finish() }
        }
        .accessibilityIdentifier("juno.agents.computer")
    }

    private var bar: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            NativeAgentPresence(avatar: agent.avatar, state: agent.state, size: JunoAgentFaceSize.sm)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(agent.name)’s computer")
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                Text(stateSentence)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.snug)
            if controlling {
                Button("Hand back", action: handBack)
                    .buttonStyle(.junoProminent)
                    .contentShape(.rect)
                    .disabled(isWorking)
            } else if session != nil {
                Button("Take control") { Task { await open(mode: "control") } }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .contentShape(.rect)
                    .disabled(isWorking)
            }
            Button("Close", action: finish)
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    @ViewBuilder
    private var content: some View {
        if let session {
            NativeAgentComputerHandoffWebView(url: session.url, isActive: scenePhase == .active)
        } else if failed {
            VStack(spacing: JunoSpace.cozy) {
                Text("Juno couldn’t open \(agent.name)’s computer.")
                    .junoType(.bodyLarge)
                    .foregroundStyle(Color.junoForeground)
                Button("Try again") { Task { await open(mode: "watch") } }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .contentShape(.rect)
            }
            .multilineTextAlignment(.center)
            .padding(JunoSpace.section)
        } else {
            VStack(spacing: JunoSpace.cozy) {
                ProgressView()
                    .controlSize(.small)
                Text("Opening \(agent.name)’s computer")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }

    private var stateSentence: String {
        if controlling {
            return "You have control. \(agent.name) waits until you hand it back."
        }
        guard let computer else { return "Asleep. It wakes when \(agent.name) starts working." }
        return NativeAgentComputerWords.sentence(for: computer, name: agent.name)
    }

    private func open(mode: String) async {
        isWorking = true
        failed = false
        defer { isWorking = false }
        if let status = computer?.status, ["asleep", "off", "resting", "error"].contains(status) {
            _ = await model.computerAction(agentID: agent.id, action: "wake")
        }
        guard let raw = await model.computerHandoffURL(agentID: agent.id, mode: mode), let url = URL(string: raw) else {
            failed = session == nil
            model.clearError()
            return
        }
        session = HandoffSession(url: url, mode: mode)
    }

    private func handBack() {
        Task {
            isWorking = true
            await model.computerHandBack(agentID: agent.id)
            isWorking = false
            await open(mode: "watch")
        }
    }

    private func finish() {
        if controlling {
            Task { await model.computerHandBack(agentID: agent.id) }
        }
        session = nil
        close()
    }
}

/// How a computer's state is said, in words.
enum NativeAgentComputerWords {
    static func sentence(for computer: NativeAgentCloudComputer, name: String) -> String {
        switch computer.status {
        case "asleep", "off":
            return "Asleep. It wakes when \(name) starts working."
        case "resting":
            return "Resting. It opens instantly."
        case "starting", "waking":
            return "Waking up"
        case "awake":
            if let summary = computer.usingNowSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                return "\(name) is using it: \(summary)"
            }
            return "Awake. It rests after a few idle minutes."
        case "error":
            return computer.error ?? "Juno couldn’t reach it."
        default:
            return "Asleep. It wakes when \(name) starts working."
        }
    }
}

extension View {
    /// Presents an agent's computer full screen: a large sheet on the Mac, a
    /// full-screen cover on the phone.
    func nativeAgentComputerPresentation(
        isPresented: Binding<Bool>,
        model: NativeAgentsModel,
        agent: NativeAgent
    ) -> some View {
        #if os(macOS)
        sheet(isPresented: isPresented) {
            NativeAgentComputerScreen(model: model, agent: agent) { isPresented.wrappedValue = false }
        }
        #else
        fullScreenCover(isPresented: isPresented) {
            NativeAgentComputerScreen(model: model, agent: agent) { isPresented.wrappedValue = false }
        }
        #endif
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
