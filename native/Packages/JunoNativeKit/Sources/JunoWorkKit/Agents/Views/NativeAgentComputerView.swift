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
/// Renders the poster or frame, the plain-text state sentence, and one primary
/// action per state: **Wake**, then **Watch** or **Take control** (Take
/// control leads when the agent is waiting for the person), then **Hand
/// back**. Opening Watch or Take control mints a one-time `/computer-view?c=…`
/// handoff URL (`POST /api/agents/{id}/computer/view` with `handoff: true`)
/// and presents it in a non-persistent `WKWebView` pinned to the app's own
/// origin: a sheet on the Mac, full screen on the iPhone.
///
/// Control follows one rule on every platform: it is real once the viewer
/// says its control stream is up, Close while in control asks "Hand back to
/// …?", and going to the background keeps it (the server's window and the
/// heartbeats cover a trip to an authenticator app). Hand back answers only
/// the question pinned at Take control (``NativeComputerHandBack``).
struct NativeAgentComputerView: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let computer: NativeAgentCloudComputer?

    @State private var posterImage: Image?
    @State private var isWorking = false
    @State private var confirmingEnable = false
    @State private var activeHandoff: HandoffSession?
    /// True only once the viewer reported that its control stream is up.
    @State private var controlling = false

    struct HandoffSession: Identifiable, Equatable {
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
        .task(id: "\(agent.id)-\(computer?.status ?? "")") {
            // Who holds control, and the rest time, come with a computer read.
            guard computer?.enabled == true else { return }
            await model.refreshComputer(agentID: agent.id)
        }
        #if os(iOS)
        .fullScreenCover(item: $activeHandoff) { session in
            handoffSheet(session)
        }
        #else
        .sheet(item: $activeHandoff) { session in
            handoffSheet(session)
        }
        #endif
    }

    private func handoffSheet(_ session: HandoffSession) -> some View {
        NativeAgentComputerHandoffSheet(
            model: model,
            agentID: agent.id,
            agentName: agent.name,
            session: session,
            onConnected: { mode in
                controlling = mode == "control"
            },
            onControlEnded: {
                controlling = false
            },
            onDismiss: {
                controlling = false
                activeHandoff = nil
            }
        )
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
                .contentTransition(.opacity)
                .animation(JunoMotion.base, value: stateSentence(for: computer))

            HStack(spacing: JunoSpace.snug) {
                actions(computer)
            }
        }
    }

    /// One primary action per state.
    @ViewBuilder
    private func actions(_ computer: NativeAgentCloudComputer) -> some View {
        switch computer.status {
        case "asleep", "error":
            Button {
                performAction("wake")
            } label: {
                Text(computer.status == "error" ? "Try again" : "Wake")
                    .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
            }
            .buttonStyle(.junoProminent)
            .disabled(isWorking)

            if computer.status == "error" {
                Button {
                    performAction("reset")
                } label: {
                    Text("Reset")
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoGlass)
                .disabled(isWorking)
            }

        case "resting", "awake":
            if controlling {
                Button {
                    Task {
                        isWorking = true
                        if await model.computerHandBack(agentID: agent.id) { controlling = false }
                        isWorking = false
                    }
                } label: {
                    Text("Hand back")
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoProminent)
                .disabled(isWorking)
            } else {
                // The agent waiting on the person is the moment to take over;
                // otherwise watching is the thing to do.
                let takeoverFirst = agent.state == .waiting
                let heldByOtherDevice = model.computerTakeovers[agent.id]?.active == true
                    && model.computerTakeovers[agent.id]?.holderKind == .app
                Button {
                    takeoverFirst ? takeControl() : openViewer(mode: "watch")
                } label: {
                    Text(takeoverFirst ? "Take control" : "Watch")
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoProminent)
                .disabled(isWorking || (takeoverFirst && heldByOtherDevice))

                Button {
                    takeoverFirst ? openViewer(mode: "watch") : takeControl()
                } label: {
                    Text(takeoverFirst ? "Watch" : "Take control")
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoGlass)
                .disabled(isWorking || (!takeoverFirst && heldByOtherDevice))
            }

        default:
            ProgressView()
                .controlSize(.small)
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
                    // A new poster fades in over the old one: opacity only, so
                    // it reads the same with Reduce Motion on.
                    .transition(.opacity)
            } else {
                VStack(spacing: JunoSpace.tight) {
                    JunoIconView(.monitor, size: 20)
                        .foregroundStyle(Color.junoMutedForeground)
                    Text(computer.status == "awake" ? "Desktop awake" : "Linux desktop")
                        .junoCaption()
                }
                .transition(.opacity)
            }
        }
        .animation(JunoMotion.base, value: posterImage == nil)
        .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .frame(maxWidth: 420)
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                .strokeBorder(controlling ? Color.junoPresence : Color.junoBorder, lineWidth: controlling ? 2 : 1)
        )
        .animation(JunoMotion.base, value: controlling)
    }

    private func stateSentence(for computer: NativeAgentCloudComputer) -> String {
        if controlling {
            return NativeAgentComputerSentence.controlHere(agentName: agent.name)
        }
        if computer.status == "awake", let takeover = model.computerTakeovers[agent.id], takeover.active {
            return takeover.holderKind == .app
                ? NativeAgentComputerSentence.heldByOtherDevice
                : NativeAgentComputerSentence.heldByWeb
        }
        return NativeAgentComputerSentence.sentence(
            status: computer.status,
            agentName: agent.name,
            restMinutes: model.computerRestMinutes[agent.id],
            usingNow: computer.usingNowSummary
        )
    }

    private func performAction(_ action: String) {
        Task {
            isWorking = true
            _ = await model.computerAction(agentID: agent.id, action: action)
            isWorking = false
        }
    }

    /// Take control pins the question this takeover is for, then opens the
    /// control view. Control itself starts when the viewer says it is up.
    private func takeControl() {
        model.pinComputerTakeover(agentID: agent.id)
        openViewer(mode: "control")
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
                activeHandoff = HandoffSession(url: url, mode: mode)
            } else if mode == "control" {
                // No link, no takeover: nothing to answer later.
                model.dropComputerTakeoverPin(agentID: agent.id)
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

/// The sentences the computer says about itself: the same table as the web
/// (src/lib/agents/computer-state-copy.json), checked against it by
/// `NativeAgentComputerHandBackTests`.
enum NativeAgentComputerSentence {
    static let starting = "Waking up"
    static let resting = "Resting. Opens instantly."
    static let stopping = "Going to sleep"
    static let idleUnknown = "Idle. It rests after a few minutes."
    static let error = "Couldn’t reach the computer."
    static let heldByOtherDevice = "Another of your devices has control. Hand back there first."
    static let heldByWeb = "A browser has control right now."
    static let handedBack = "Handed back"

    static func asleep(agentName: String) -> String {
        "Asleep. It wakes when \(agentName) starts working."
    }

    static func idle(restMinutes: Double?) -> String {
        guard let restMinutes, restMinutes.isFinite, restMinutes > 0 else { return idleUnknown }
        let minutes = max(1, Int(restMinutes.rounded()))
        return minutes == 1 ? "Idle. It rests after 1 minute." : "Idle. It rests after \(minutes) minutes."
    }

    static func using(agentName: String, summary: String) -> String {
        "\(agentName) is using it: \(summary)"
    }

    static func takenBack(agentName: String) -> String {
        "\(agentName) took the computer back."
    }

    /// "Your iPhone has control. …" on the phone, "Your Mac has control. …" on the Mac.
    static func controlHere(agentName: String) -> String {
        #if os(iOS)
        "Your iPhone has control. \(agentName) waits until you hand back."
        #else
        "Your Mac has control. \(agentName) waits until you hand back."
        #endif
    }

    /// Only the statuses the server sends (`ComputerStatus`); anything else reads as asleep.
    static func sentence(status: String, agentName: String, restMinutes: Double?, usingNow: String?) -> String {
        switch status {
        case "awake":
            if let usingNow, !usingNow.isEmpty { return using(agentName: agentName, summary: usingNow) }
            return idle(restMinutes: restMinutes)
        case "starting": return starting
        case "resting": return resting
        case "stopping": return stopping
        case "error": return error
        default: return asleep(agentName: agentName)
        }
    }
}

// MARK: - Handoff Viewer Sheet

private struct NativeAgentComputerHandoffSheet: View {
    let model: NativeAgentsModel
    let agentID: String
    let agentName: String
    let session: NativeAgentComputerView.HandoffSession
    let onConnected: (String) -> Void
    let onControlEnded: () -> Void
    let onDismiss: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    /// The link on screen: the first one, or a fresh one after the stream dropped.
    @State private var url: URL?
    @State private var mode: String

    init(
        model: NativeAgentsModel,
        agentID: String,
        agentName: String,
        session: NativeAgentComputerView.HandoffSession,
        onConnected: @escaping (String) -> Void,
        onControlEnded: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.model = model
        self.agentID = agentID
        self.agentName = agentName
        self.session = session
        self.onConnected = onConnected
        self.onControlEnded = onControlEnded
        self.onDismiss = onDismiss
        _url = State(initialValue: session.url)
        _mode = State(initialValue: session.mode)
    }
    @State private var connected = false
    @State private var confirmingClose = false
    @State private var handingBack = false
    @State private var notice: String?
    @State private var beatWarning = false
    @State private var reopenAttempts = 0
    @State private var waitingToReopen = false

    private var inControl: Bool { mode == "control" }

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            if let url {
                NativeAgentComputerHandoffWebView(url: url) { message in
                    handle(message)
                }
                #if os(macOS)
                .frame(minWidth: 640, minHeight: 420)
                #endif
                .id(url)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.junoCanvas)
        .interactiveDismissDisabled(inControl)
        .task(id: "\(session.id)-\(mode)") {
            while !Task.isCancelled {
                // Control is only this sheet's once the viewer said so.
                if !inControl || connected {
                    await beat()
                }
                try? await Task.sleep(for: .seconds(20))
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Going to the background keeps control: the server's window and
            // the heartbeats cover a trip to an authenticator or a password
            // manager. Coming back reopens a stream that dropped meanwhile.
            if phase == .active, waitingToReopen {
                waitingToReopen = false
                Task { await reopen() }
            }
        }
        .confirmationDialog(
            "Hand back to \(agentName)?",
            isPresented: $confirmingClose,
            titleVisibility: .visible
        ) {
            Button("Hand back") {
                Task { await handBack() }
            }
            Button("Keep control", role: .cancel) {}
        } message: {
            Text("You have control of \(agentName)’s computer. It waits until you hand back.")
        }
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(agentName)’s computer")
                    .font(.headline)
                    .junoInk()
                    .lineLimit(1)
                Text(statusLine)
                    .junoCaption()
                    .lineLimit(2)
                    .contentTransition(.opacity)
                    .animation(JunoMotion.base, value: statusLine)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(0)

            if inControl {
                Button {
                    Task { await handBack() }
                } label: {
                    Text("Hand back")
                        .lineLimit(1)
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoProminent)
                .disabled(handingBack)
                .fixedSize()
            }

            Button {
                close()
            } label: {
                Text("Close")
                    .lineLimit(1)
                    .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
            }
            .buttonStyle(.junoGlass)
            .keyboardShortcut(.cancelAction)
            .fixedSize()
        }
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.cozy)
    }

    private var statusLine: String {
        if let notice { return notice }
        if inControl {
            if beatWarning { return "Control may lapse, reconnecting" }
            return connected ? NativeAgentComputerSentence.controlHere(agentName: agentName) : "Taking control…"
        }
        return connected ? "Watching live desktop." : "Connecting…"
    }

    private func handle(_ message: NativeAgentComputerHandoffWebView.ViewerMessage) {
        switch message {
        case .connected(let connectedMode):
            connected = true
            reopenAttempts = 0
            if connectedMode == mode {
                onConnected(connectedMode)
                if connectedMode == "control" { notice = nil }
            }
        case .disconnected:
            connected = false
            guard !handingBack else { return }
            if scenePhase == .active {
                Task { await reopen() }
            } else {
                waitingToReopen = true
            }
        }
    }

    /// The stream dropped: a fresh one-time link, in the mode this sheet is
    /// in. Control is asked for again only while the server still says this
    /// device holds it, so a Hand back from elsewhere is never undone.
    private func reopen() async {
        guard reopenAttempts < 3 else {
            notice = "Couldn’t reconnect. Close and open the computer again."
            return
        }
        reopenAttempts += 1
        if inControl {
            switch await model.computerHeartbeat(agentID: agentID, mode: "control") {
            case .heldElsewhere(let sentence):
                loseControl(sentence)
                return
            case .landed(takeoverActive: false):
                loseControl(NativeAgentComputerSentence.takenBack(agentName: agentName))
                return
            case .landed, .failed:
                break
            }
        }
        try? await Task.sleep(for: .seconds(Double(reopenAttempts)))
        if let raw = await model.computerHandoffURL(agentID: agentID, mode: mode), let next = URL(string: raw) {
            url = next
        } else {
            // No link: a phone back from an authenticator often has no
            // network for a moment. Try again, and after the last try say so,
            // instead of "Taking control…" while no stream sends heartbeats
            // and control quietly lapses.
            await reopen()
        }
    }

    private func beat() async {
        let result = await model.computerHeartbeat(agentID: agentID, mode: mode)
        guard inControl else { return }
        switch result {
        case .landed(takeoverActive: false):
            loseControl(NativeAgentComputerSentence.takenBack(agentName: agentName))
        case .landed:
            beatWarning = false
        case .heldElsewhere(let sentence):
            loseControl(sentence)
        case .failed:
            beatWarning = true
        }
    }

    /// Control ended without a Hand back from here: say so, answer nothing,
    /// and keep watching.
    private func loseControl(_ sentence: String) {
        model.dropComputerTakeoverPin(agentID: agentID)
        onControlEnded()
        notice = sentence
        beatWarning = false
        mode = "watch"
        connected = false
        reopenAttempts = 0
        Task {
            if let raw = await model.computerHandoffURL(agentID: agentID, mode: "watch"), let next = URL(string: raw) {
                url = next
            }
        }
    }

    private func close() {
        if inControl {
            confirmingClose = true
        } else {
            onDismiss()
        }
    }

    /// Hand back answers the pinned takeover question (and nothing when
    /// unsure), and the view closes: the control stream ends with it.
    private func handBack() async {
        handingBack = true
        let handed = await model.computerHandBack(agentID: agentID)
        handingBack = false
        guard handed else {
            notice = model.lastErrorDescription
            return
        }
        onControlEnded()
        onDismiss()
    }
}

/// Non-persistent `WKWebView` pinned to the app's own origin for the one-time
/// `/computer-view?c=…` handoff URL (BRIEF.md §4.9). The page tells the app
/// when its stream is up, and when it dropped, through the `alevrComputer`
/// message handler; nothing else is read from it.
struct NativeAgentComputerHandoffWebView {
    let url: URL
    let onMessage: @MainActor (ViewerMessage) -> Void

    enum ViewerMessage: Equatable {
        case connected(String)
        case disconnected
    }

    static let messageHandlerName = "alevrComputer"

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let allowedHost: String?
        let allowedScheme: String?
        var loadedURL: URL?
        var onMessage: @MainActor (ViewerMessage) -> Void

        init(url: URL, onMessage: @escaping @MainActor (ViewerMessage) -> Void) {
            self.allowedHost = url.host?.lowercased()
            self.allowedScheme = url.scheme?.lowercased()
            self.onMessage = onMessage
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

        /// The viewer's `connect` and `disconnect`, from the app's own origin
        /// and main frame only.
        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.frameInfo.isMainFrame,
                message.frameInfo.securityOrigin.host.lowercased() == allowedHost,
                message.frameInfo.securityOrigin.`protocol`.lowercased() == allowedScheme,
                let body = message.body as? [String: Any],
                let type = body["type"] as? String
            else { return }
            switch type {
            case "connected":
                let mode = (body["mode"] as? String) == "control" ? "control" : "watch"
                onMessage(.connected(mode))
            case "disconnected":
                onMessage(.disconnected)
            default:
                break
            }
        }
    }

    @MainActor
    func makeCoordinator() -> Coordinator {
        Coordinator(url: url, onMessage: onMessage)
    }

    @MainActor
    func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // A weak hop: the content controller retains its handlers.
        configuration.userContentController.add(WeakScriptMessageHandler(coordinator), name: Self.messageHandlerName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        #if os(iOS)
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #endif

        coordinator.loadedURL = url
        webView.load(URLRequest(url: url))
        return webView
    }

    @MainActor
    func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.onMessage = onMessage
        if coordinator.loadedURL != url {
            coordinator.loadedURL = url
            webView.load(URLRequest(url: url))
        }
    }

    @MainActor
    static func unload(_ webView: WKWebView) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: messageHandlerName)
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }
}

/// Holds the coordinator weakly so the web view's content controller does not
/// keep the SwiftUI coordinator (and the sheet's closures) alive.
@MainActor
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
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
