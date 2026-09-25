import AppKit
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The Task panel in the chat's trailing dock (register #59): **Activity ·
/// Files · Details**, the choice remembered (`task.tab`).
///
/// Opened from the card's Show Details and from an earlier task's "Open ›".
/// On ``DesktopPanelShell``, the Activity and Research panels' shell: the
/// task's title as the heading, a static status word and the elapsed time —
/// never a shimmer — and close.
///
/// The task the chat is following is read from its follower, live. An earlier
/// task is read once (``NativeWorkClient/snapshot(sessionID:for:)``) and not
/// followed: it is over, and "As of {time}" says when it was read.
///
/// **Signature detail:** Details is the task's receipt in one column —
/// where it ran, how often it asked, what it cost — with its id selectable at
/// the foot, so the question "what exactly happened here" has one place to
/// be answered.
struct ChatWorkPanel: View {
    enum Source {
        /// The chat's current task, from its follower.
        case live(ChatWorkRunState)
        /// An earlier task, read once.
        case snapshot(ChatWorkPanelSnapshot)
    }

    enum Tab: String, Hashable { case activity, files, details }

    let title: String
    let source: Source
    let close: () -> Void
    /// Reads an earlier task again after a failed read.
    var retry: (() -> Void)? = nil
    /// What Details needs from the rest of the app.
    var details = ChatWorkPanelDetails()
    /// The first view drawn, for fixtures; otherwise the remembered one.
    var initialTab: Tab? = nil

    @AppStorage("task.tab") private var storedTab = Tab.activity.rawValue
    @State private var tab: Tab = .activity
    @Environment(\.junoWorkFileActions) private var fileActions
    @Environment(\.junoWorkFiles) private var workFiles

    private var events: [WorkEvent] {
        switch source {
        case .live(let state): state.events
        case .snapshot(let snapshot): snapshot.update?.events ?? []
        }
    }

    private var session: WorkSessionSummary? {
        switch source {
        case .live(let state): state.session
        case .snapshot(let snapshot): snapshot.update?.session
        }
    }

    private var run: WorkRunSummary? {
        switch source {
        case .live(let state): state.run
        case .snapshot(let snapshot): snapshot.update?.run
        }
    }

    private var status: JunoWorkStatus? {
        switch source {
        case .live(let state): state.status
        case .snapshot(let snapshot): snapshot.status
        }
    }

    private var files: [ChatWorkFile] {
        switch source {
        case .live(let state): state.files
        case .snapshot(let snapshot): snapshot.files
        }
    }

    private var now: Date? {
        if case .live(let state) = source { return state.now }
        return details.now
    }

    /// Ticking only while a run is actually going.
    private var ticks: Bool {
        guard now == nil, let run, run.startedAt != nil, run.finishedAt == nil else { return false }
        return !(status?.isTerminal ?? true)
    }

    var body: some View {
        DesktopPanelShell(
            label: title,
            status: { date in statusLine(at: now ?? date) },
            ticks: ticks,
            tabs: [
                JunoSegmented<Tab>.Option(.activity, "Activity"),
                JunoSegmented<Tab>.Option(.files, "Files"),
                JunoSegmented<Tab>.Option(.details, "Details"),
            ],
            tab: $tab,
            close: close,
            actions: { EmptyView() },
            content: { content }
        )
        .onAppear { tab = initialTab ?? Tab(rawValue: storedTab) ?? .activity }
        .onChange(of: tab) { _, tab in
            if initialTab == nil { storedTab = tab.rawValue }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task")
        .accessibilityIdentifier("juno.chat.task-panel")
    }

    /// "Running · 4m 12s": the word and, once it has started, how long.
    private func statusLine(at date: Date) -> String? {
        guard let status else { return nil }
        let word = ChatWorkVocabulary.label(status)
        guard let run, run.startedAt != nil else { return word }
        return "\(word) \u{00B7} \(ChatWorkFormat.duration(ChatWorkFormat.elapsed(run, now: date)))"
    }

    @ViewBuilder
    private var content: some View {
        switch source {
        case .snapshot(let snapshot) where snapshot.isLoading:
            ChatWorkPanelSkeleton()
        case .snapshot(let snapshot) where snapshot.failed:
            JunoEmptyState(
                title: "Couldn\u{2019}t load this task",
                message: "Check your connection and try again.",
                icon: .error,
                actionLabel: retry == nil ? nil : "Try Again",
                action: retry,
                size: .panel,
                tone: .error
            )
            .padding(JunoSpace.regular)
        default:
            switch tab {
            case .activity: scrolling { activity }
            case .files: filesView
            case .details: scrolling { detailsView }
            }
        }
    }

    private func scrolling<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if case .snapshot(let snapshot) = source, let readAt = snapshot.readAt {
                    Text("As of \(readAt.formatted(date: .omitted, time: .shortened))")
                        .junoFont(size: 11, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.bottom, JunoSpace.snug)
                }
                content()
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
    }

    // MARK: Activity

    @ViewBuilder
    private var activity: some View {
        let entries = DesktopWorkLog.entries(in: events)
        if entries.isEmpty {
            Text("Nothing has happened on this task yet.")
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.vertical, JunoSpace.snug)
        } else {
            ForEach(entries) { entry in
                ChatWorkActivityRow(entry: entry)
            }
        }
    }

    // MARK: Files

    @ViewBuilder
    private var filesView: some View {
        let written = DesktopWorkLog.references(in: events).filter { $0.direction == .written }
        if files.isEmpty, written.isEmpty {
            JunoEmptyState(
                title: "No files yet",
                message: "Files the task makes appear here.",
                icon: .file,
                size: .panel
            )
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            scrolling {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: JunoSpace.micro) {
                        ForEach(files) { file in
                            ChatWorkFileRow(file: file)
                        }
                    }
                    if !written.isEmpty {
                        Text("Changed on this Mac")
                            .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                            .foregroundStyle(Color.junoForeground)
                            .accessibilityAddTraits(.isHeader)
                            .padding(.top, files.isEmpty ? 0 : JunoSpace.regular)
                            .padding(.bottom, JunoSpace.tight)
                        ForEach(written) { reference in
                            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                                JunoIconView(.fileDiff, size: 14)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .frame(width: 16)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                                    Text(reference.label)
                                        .junoFont(size: 13, relativeTo: .callout)
                                        .foregroundStyle(Color.junoForeground)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    if let detail = reference.detail {
                                        Text(detail)
                                            .junoFont(size: 11, relativeTo: .caption)
                                            .foregroundStyle(Color.junoSecondaryInk)
                                            .lineLimit(1)
                                    }
                                }
                            }
                            .frame(minHeight: 36, alignment: .leading)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
                .environment(\.junoTranscriptMedia, workFiles)
                .environment(\.junoTranscriptMediaActions, fileActions)
            }
        }
    }

    // MARK: Details

    /// The receipt in three short groups — how it ran, what it cost, when —
    /// split by one hairline each rather than a rule under every row, then
    /// the task's id, selectable.
    private var detailsView: some View {
        let groups = detailGroups.filter { !$0.isEmpty }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.offset) { index, rows in
                if index > 0 {
                    Rectangle()
                        .fill(Color.junoHairline)
                        .frame(height: 1)
                        .padding(.vertical, JunoSpace.snug)
                        .accessibilityHidden(true)
                }
                ForEach(rows, id: \.label) { row in
                    ChatWorkDetailRow(row.label, value: row.value, figure: row.figure)
                }
            }
            if let session {
                Text(session.sessionID)
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .textSelection(.enabled)
                    .padding(.top, JunoSpace.cozy)
                    .accessibilityLabel("Task id \(session.sessionID)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.chat.task-panel.details")
    }

    private struct DetailLine {
        let label: String
        let value: String
        var figure = false
    }

    private var detailGroups: [[DetailLine]] {
        var how: [DetailLine] = []
        if let model = run?.effectiveModel ?? session?.requestedModel {
            how.append(DetailLine(label: "Model", value: junoDisplayModelName(model)))
        }
        if let place = details.whereItRan(run: run, session: session) {
            how.append(DetailLine(label: "Where it ran", value: place))
        }
        if let mode = run?.approvalMode ?? session?.permissionPolicy {
            how.append(DetailLine(label: "How often it asks", value: mode.agentAutonomyLabel))
        }
        if let apps = details.connectedApps {
            how.append(DetailLine(label: "Connected apps", value: apps))
        }
        var spent: [DetailLine] = []
        var when: [DetailLine] = []
        if let run {
            spent = [
                DetailLine(
                    label: "Elapsed", value: ChatWorkFormat.duration(ChatWorkFormat.elapsed(run, now: now ?? Date())),
                    figure: true
                ),
                DetailLine(label: "Cost", value: ChatWorkFormat.cost(microUsd: run.costMicroUsd), figure: true),
                DetailLine(label: "Tokens", value: ChatWorkFormat.tokens(run.totalTokens), figure: true),
            ]
            if let started = run.startedAt {
                when.append(DetailLine(label: "Started", value: started.formatted(date: .abbreviated, time: .shortened)))
            }
            if let finished = run.finishedAt {
                when.append(DetailLine(label: "Finished", value: finished.formatted(date: .abbreviated, time: .shortened)))
            }
        }
        return [how, spent, when]
    }
}

/// What the Task panel's Details reads from outside the task itself.
struct ChatWorkPanelDetails {
    /// This Mac's host id, to say "On this Mac" rather than a name.
    var pairedHostID: String? = nil
    /// The task's connected apps as words, once its context has been read;
    /// nil leaves the row out rather than guessing.
    var connectedApps: String? = nil
    /// A pinned "now" for fixtures.
    var now: Date? = nil

    func whereItRan(run: WorkRunSummary?, session: WorkSessionSummary?) -> String? {
        let target = run?.effectiveTarget ?? session?.effectiveTarget
        switch target.flatMap(JunoWorkTarget.init(rawValue:)) {
        case .cloud: return "In the cloud"
        case .local:
            let host = run?.hostID ?? session?.hostID
            if let host, host == pairedHostID { return "On this Mac" }
            return session?.hostDisplayName ?? "On this Mac"
        default: return nil
        }
    }

    /// "Gmail, Linear" — or "None" for a task allowed no apps at all.
    static func appsLine(_ ids: [String]?, name: (String) -> String) -> String? {
        guard let ids else { return nil }
        return ids.isEmpty ? "None" : ids.map(name).joined(separator: ", ")
    }
}

/// A Details row: the name in the secondary ink, the value trailing; a
/// figure in mono. No rule of its own: the groups are split, not the rows.
struct ChatWorkDetailRow: View {
    let label: String
    let value: String
    var figure = false

    init(_ label: String, value: String, figure: Bool = false) {
        self.label = label
        self.value = value
        self.figure = figure
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Text(label)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize()
            Spacer(minLength: JunoSpace.cozy)
            Text(value)
                .junoFont(size: 13, relativeTo: .callout, design: figure ? .monospaced : .default)
                .foregroundStyle(Color.junoForeground)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, minHeight: 28)
        .accessibilityElement(children: .combine)
        .padding(.vertical, JunoSpace.tight)
    }
}

/// One file in the Files view: a 36pt row — the kind's glyph, the name, and
/// "PDF · 2.4 MB · v2" with the size in mono. A click or Space opens Quick
/// Look; the context menu has Quick Look · Open With Default App · Save As….
struct ChatWorkFileRow: View {
    let file: ChatWorkFile
    @Environment(\.junoTranscriptMediaActions) private var actions
    @State private var hovered = false

    var body: some View {
        let attachment = file.attachment
        Button {
            actions.quickLook(attachment)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(DesktopWorkVocabulary.artifactIcon(file.artifact.kind), size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(file.artifact.title)
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    meta(attachment)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(minHeight: 36)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(hovered ? Color.junoHover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .onKeyPress(.space) {
            actions.quickLook(attachment)
            return .handled
        }
        .contextMenu { TranscriptFileMenu(attachment: attachment, actions: actions) }
        .help(attachment.fileName)
        .accessibilityLabel("Open \(attachment.fileName)")
        .accessibilityValue(attachment.captionMeta)
        .accessibilityIdentifier("juno.chat.task-panel.file")
    }

    private func meta(_ attachment: NativeChatAttachment) -> some View {
        HStack(spacing: 0) {
            Text(attachment.formatLabel)
            if attachment.size > 0 {
                // The tile's caption says the size the same way.
                Text(" \u{00B7} \(attachment.byteLabel)")
            }
            Text(" \u{00B7} v\(file.artifact.currentVersion)")
                .monospacedDigit()
        }
        .junoFont(size: 11, relativeTo: .caption)
        .monospacedDigit()
        .foregroundStyle(Color.junoSecondaryInk)
        .lineLimit(1)
    }
}

/// One line of a task's log in the panel: the Activity panel's row recipe —
/// a 14pt glyph in the entry's tone, the line at 13pt, its detail at 11pt, and
/// when it happened in mono.
struct ChatWorkActivityRow: View {
    let entry: DesktopWorkLog.Entry

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(entry.icon, size: 14)
                .foregroundStyle(entry.tone == .normal ? Color.junoSecondaryInk : entry.tint)
                .frame(width: 16)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(entry.title)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(entry.tone == .quiet ? Color.junoSecondaryInk : Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = entry.detail {
                    Text(detail)
                        .junoFont(size: 11, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            Text(entry.at.formatted(date: .omitted, time: .shortened))
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoSecondaryInk)
                .monospacedDigit()
                .fixedSize()
        }
        .padding(.vertical, JunoSpace.tight)
        .accessibilityElement(children: .combine)
    }
}

/// Skeleton rows while an earlier task is read — the shape of the log, not a
/// spinner.
struct ChatWorkPanelSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            ForEach(0..<5, id: \.self) { index in
                HStack(spacing: JunoSpace.snug) {
                    Circle().fill(Color.junoMuted).frame(width: 14, height: 14)
                    RoundedRectangle(cornerRadius: JunoRadius.micro, style: .continuous)
                        .fill(Color.junoMuted)
                        .frame(width: [180, 240, 150, 210, 120][index], height: 10)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityLabel("Loading this task")
    }
}

/// An earlier task, read once for the panel.
struct ChatWorkPanelSnapshot {
    var update: WorkStreamUpdate?
    var readAt: Date?
    var isLoading = true
    var failed = false
    /// Its files, read with it.
    var files: [ChatWorkFile] = []

    var status: JunoWorkStatus? {
        (update?.run?.status ?? update?.session?.status).flatMap(JunoWorkStatus.init(rawValue:))
    }
}

/// Reads an earlier task once and holds it while its panel is open.
@MainActor
@Observable
final class ChatWorkPanelReader {
    private(set) var snapshots: [String: ChatWorkPanelSnapshot] = [:]

    func snapshot(for sessionID: String) -> ChatWorkPanelSnapshot {
        snapshots[sessionID] ?? ChatWorkPanelSnapshot()
    }

    func read(sessionID: String, client: NativeWorkClient?, accountID: AccountID) async {
        guard let client else {
            snapshots[sessionID] = ChatWorkPanelSnapshot(isLoading: false, failed: true)
            return
        }
        snapshots[sessionID] = ChatWorkPanelSnapshot()
        do {
            let update = try await client.snapshot(sessionID: sessionID, for: accountID)
            // The files are a separate list; a task whose list cannot be read
            // still shows its log, and Files says it has none.
            let artifacts = (try? await client.artifacts(for: sessionID, accountID: accountID)) ?? []
            snapshots[sessionID] = ChatWorkPanelSnapshot(
                update: update, readAt: Date(), isLoading: false,
                files: artifacts.map { ChatWorkFile(artifact: $0) }
            )
        } catch {
            snapshots[sessionID] = ChatWorkPanelSnapshot(isLoading: false, failed: true)
        }
    }

    /// A task's connected apps, read once when Details first shows them.
    private(set) var contexts: [String: WorkSessionContext] = [:]

    func readContext(sessionID: String, client: NativeWorkClient?, accountID: AccountID) async {
        guard contexts[sessionID] == nil, let client,
            let context = try? await client.context(for: sessionID, accountID: accountID)
        else { return }
        contexts[sessionID] = context
    }
}

/// Reports whether the hosting window is visible on screen at all — the
/// occlusion AppKit tracks — so a follower polls only while someone could see
/// what it finds (register #64). JunoWorkKit is shared with the phone and
/// cannot read a window; this is the Mac feeding it.
struct DesktopWindowVisibilityReader: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.changed = changed
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.changed = changed
    }

    final class ProbeView: NSView {
        var changed: ((Bool) -> Void)?
        nonisolated(unsafe) private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard let window else { return }
            observer = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.report() }
            }
            report()
        }

        private func report() {
            guard let window else { return }
            changed?(window.occlusionState.contains(.visible))
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}
