import JunoCodeKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Juno Code on the phone: the account's real hosts, the sessions they hold, and
/// a live transcript of the one being watched.
///
/// This is the Remote surface, not a local agent. The phone never runs a coding
/// session — a Mac or Windows host does — so everything here is a view onto that
/// host through the relay, and every control sends a *command* the host will
/// pick up. Nothing on this screen is inert: if a host is offline, the composer
/// says so and refuses rather than queueing a prompt that will never be read.
struct JunoMobileCodeView: View {
    @Bindable var model: CodeRemoteBrowserModel

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading where model.hosts.isEmpty:
                loading
            case .offline where model.hosts.isEmpty:
                unreachable
            case .failed where model.hosts.isEmpty:
                refused
            default:
                if model.hosts.isEmpty {
                    noHosts
                } else {
                    hostList
                }
            }
        }
        .navigationTitle("navigation.code")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadHosts() }
        .refreshable { await model.loadHosts() }
        .accessibilityIdentifier("juno.mobile.code")
    }

    private var hostList: some View {
        List {
            Section {
                ForEach(model.hosts) { host in
                    NavigationLink {
                        JunoMobileCodeSessionList(model: model, host: host)
                    } label: {
                        JunoMobileCodeHostRow(host: host)
                    }
                    // An offline host still opens: its past sessions and their
                    // transcripts are worth reading even when nothing new can be
                    // sent. The composer is what refuses, not the navigation.
                }
            } header: {
                Text("code.hosts.title")
            } footer: {
                Text("code.hosts.footer")
            }

            if let message = model.lastErrorDescription {
                Section { JunoMobileCodeNotice(message: message) }
            }
        }
    }

    private var loading: some View {
        ProgressView("code.loading")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Offline and refused are different conditions with different remedies, so
    /// they get different screens: one invites a retry, the other explains that
    /// retrying cannot help.
    private var unreachable: some View {
        ContentUnavailableView {
            Label("code.offline.title", systemImage: "wifi.slash")
        } description: {
            Text("code.offline.description")
        } actions: {
            Button("code.retry") { Task { await model.loadHosts() } }
                .buttonStyle(.borderedProminent)
        }
    }

    private var refused: some View {
        ContentUnavailableView {
            Label("code.failed.title", systemImage: "exclamationmark.triangle")
        } description: {
            Text(model.lastErrorDescription ?? String(localized: "code.failed.description"))
        }
    }

    private var noHosts: some View {
        ContentUnavailableView {
            Label("code.empty.title", systemImage: "desktopcomputer")
        } description: {
            Text("code.empty.description")
        }
    }
}

/// One host. The online dot is the most important thing on the row — it decides
/// whether anything you do next can actually reach a machine.
private struct JunoMobileCodeHostRow: View {
    let host: CodeRemoteHostSummary

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: host.platform == "windows" ? "pc" : "desktopcomputer")
                .font(.system(size: 20))
                .frame(width: 26)
                .foregroundStyle(.primary)

            VStack(alignment: .leading, spacing: 2) {
                Text(host.name)
                    .font(.system(size: 16, weight: .medium))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: JunoSpace.snug)

            Circle()
                .fill(host.online ? Color.junoSuccess : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            host.online
                ? String(localized: "code.host.online \(host.name)")
                : String(localized: "code.host.offline \(host.name)")
        )
    }

    /// Workspace names when the host published any, otherwise how long since it
    /// was last seen — never an absolute path, which the relay deliberately
    /// stopped returning.
    private var subtitle: String {
        if host.workspaceNames.isEmpty {
            return host.lastSeenAt.formatted(.relative(presentation: .named))
        }
        return host.workspaceNames.joined(separator: " · ")
    }
}

/// The sessions on one host.
private struct JunoMobileCodeSessionList: View {
    @Bindable var model: CodeRemoteBrowserModel
    let host: CodeRemoteHostSummary

    var body: some View {
        Group {
            if model.sessions.isEmpty {
                ContentUnavailableView {
                    Label("code.sessions.empty.title", systemImage: "square.on.square.dashed")
                } description: {
                    Text("code.sessions.empty.description")
                }
            } else {
                List(model.sessions) { session in
                    NavigationLink {
                        JunoMobileCodeSessionView(model: model, host: host, session: session)
                    } label: {
                        JunoMobileCodeSessionRow(session: session)
                    }
                }
            }
        }
        .navigationTitle(host.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadSessions(deviceID: host.id) }
        .refreshable { await model.loadSessions(deviceID: host.id) }
    }
}

private struct JunoMobileCodeSessionRow: View {
    let session: CodeRemoteSessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(session.title)
                .font(.system(size: 16, weight: .medium))
                .lineLimit(1)

            HStack(spacing: JunoSpace.snug) {
                if session.isRunning {
                    Label("code.session.running", systemImage: "circle.fill")
                        .foregroundStyle(Color.junoAccent)
                }
                if session.isAwaitingApproval {
                    Label("code.session.awaiting", systemImage: "hand.raised")
                        .foregroundStyle(Color.junoCaution)
                }
                if session.pendingChangeCount > 0 {
                    Label("\(session.pendingChangeCount)", systemImage: "plusminus")
                        .foregroundStyle(.secondary)
                }
                if let workspace = session.workspaceName {
                    Text(workspace).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(session.lastMessageAt.formatted(.relative(presentation: .named)))
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
            .labelStyle(JunoMobileCompactLabelStyle())
        }
        .padding(.vertical, 2)
    }
}

/// A session's live transcript, plus the controls that act on it.
private struct JunoMobileCodeSessionView: View {
    @Bindable var model: CodeRemoteBrowserModel
    let host: CodeRemoteHostSummary
    let session: CodeRemoteSessionSummary

    @State private var prompt = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    ForEach(model.events, id: \.seq) { event in
                        JunoMobileCodeEventRow(event: event)
                            .id(event.seq)
                    }
                }
                .padding(JunoSpace.regular)
            }
            .onChange(of: model.events.count) { _, _ in
                guard let last = model.events.last?.seq else { return }
                withAnimation { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { composer }
        .task {
            // Resets the transcript first: without it a previous session's
            // events appear under this one's title.
            model.openSession(session.sessionID)
            await poll()
        }
        .accessibilityIdentifier("juno.mobile.code-session")
    }

    /// Polls while the view is on screen. The cursor makes this cheap — each
    /// round asks only for what is newer than the last sequence applied.
    private func poll() async {
        while !Task.isCancelled {
            await model.pollEvents(deviceID: host.id, sessionID: session.sessionID)
            try? await Task.sleep(for: .seconds(2))
        }
    }

    @ViewBuilder
    private var composer: some View {
        VStack(spacing: JunoSpace.snug) {
            if !host.online {
                JunoMobileCodeNotice(message: String(localized: "code.host.unreachable"))
            }

            HStack(spacing: JunoSpace.snug) {
                TextField("code.composer.placeholder", text: $prompt, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .padding(.horizontal, JunoSpace.snug)
                    .disabled(!host.online)
                    .accessibilityIdentifier("juno.mobile.code-composer")

                if session.isRunning {
                    Button {
                        Task {
                            await model.stopGeneration(
                                deviceID: host.id, sessionID: session.sessionID
                            )
                        }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(Color.junoAccent, in: Circle())
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isSendingCommand)
                    .accessibilityLabel("code.stop")
                    .accessibilityIdentifier("juno.mobile.code-stop")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(
                                Color.junoAccent.opacity(sendDisabled ? 0.35 : 1), in: Circle()
                            )
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sendDisabled)
                    .accessibilityLabel("code.send")
                    .accessibilityIdentifier("juno.mobile.code-send")
                }
            }
            .padding(JunoSpace.snug)
            .background(JunoGlassBackground(cornerRadius: JunoCornerRadius.floating))
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }

    /// Sending to an offline host is refused rather than queued: the command
    /// would sit unread and the session would look stuck for no stated reason.
    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !host.online
            || model.isSendingCommand
    }

    private func send() {
        let text = prompt
        prompt = ""
        Task {
            await model.send(deviceID: host.id, sessionID: session.sessionID, text: text)
        }
    }
}

/// One transcript event.
///
/// The relay's event kinds are open-ended — a host can publish one this build
/// has never heard of — so an unknown kind renders as its own name rather than
/// being dropped. A silently missing event is far worse than an ugly one.
private struct JunoMobileCodeEventRow: View {
    let event: CodeRemoteSessionEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let text {
                if event.kind == "user_message" {
                    Text(text)
                        .font(.system(size: 15))
                        .padding(JunoSpace.cozy)
                        .background(Color.junoRowSelected, in: RoundedRectangle(
                            cornerRadius: JunoCornerRadius.message, style: .continuous
                        ))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } else {
                    JunoMarkdownText(text)
                }
            } else {
                Label(event.kind.replacingOccurrences(of: "_", with: " "), systemImage: glyph)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .labelStyle(JunoMobileCompactLabelStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The payload keys the relay uses for human-readable content, in the order
    /// they should be preferred.
    private var text: String? {
        for key in ["text", "delta", "message", "content"] {
            if let value = event.payload[key]?.stringValue, !value.isEmpty { return value }
        }
        return nil
    }

    private var glyph: String {
        switch event.kind {
        case "completed": "checkmark.circle"
        case "error", "failed": "exclamationmark.triangle"
        case "tool_call", "tool_result": "wrench.and.screwdriver"
        case "approval_requested": "hand.raised"
        default: "circle.dashed"
        }
    }
}

private struct JunoMobileCodeNotice: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("juno.mobile.code-notice")
    }
}

/// Icon and title on one line with a tight gap — the default `Label` spacing is
/// too airy for a metadata strip.
private struct JunoMobileCompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}
