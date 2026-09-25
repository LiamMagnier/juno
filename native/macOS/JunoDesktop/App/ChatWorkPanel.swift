import AppKit
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The Task panel in the chat's trailing dock (register #59) — first cut.
///
/// Opened from the card's Show Details and from an earlier task's "Open ›".
/// On ``DesktopPanelShell``, the Activity and Research panels' shell: the
/// task's title as the heading, a static status word, close. Stage A draws the
/// Activity view; Stage B adds Files and Details, and the panel's other states.
///
/// The task the chat is following is read from its follower, live. An earlier
/// task is read once (``NativeWorkClient/snapshot(sessionID:for:)``) and not
/// followed: it is over, and "As of {time}" says when it was read.
struct ChatWorkPanel: View {
    enum Source {
        /// The chat's current task, from its follower.
        case live(ChatWorkRunState)
        /// An earlier task, read once.
        case snapshot(ChatWorkPanelSnapshot)
    }

    let title: String
    let source: Source
    let close: () -> Void
    /// Reads an earlier task again after a failed read.
    var retry: (() -> Void)? = nil

    @State private var tab: Tab = .activity

    enum Tab: Hashable { case activity }

    private var events: [WorkEvent] {
        switch source {
        case .live(let state): state.events
        case .snapshot(let snapshot): snapshot.update?.events ?? []
        }
    }

    private var statusWord: String? {
        switch source {
        case .live(let state): ChatWorkVocabulary.label(state.status)
        case .snapshot(let snapshot):
            snapshot.status.map(ChatWorkVocabulary.label)
        }
    }

    var body: some View {
        DesktopPanelShell(
            label: title,
            status: { _ in statusWord },
            tabs: [JunoSegmented<Tab>.Option(.activity, "Activity")],
            tab: $tab,
            close: close,
            actions: { EmptyView() },
            content: { content }
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task")
        .accessibilityIdentifier("juno.chat.task-panel")
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
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if case .snapshot(let snapshot) = source, let readAt = snapshot.readAt {
                        Text("As of \(readAt.formatted(date: .omitted, time: .shortened))")
                            .junoFont(size: 11, relativeTo: .caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .padding(.bottom, JunoSpace.snug)
                    }
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
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.cozy)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
        }
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
            snapshots[sessionID] = ChatWorkPanelSnapshot(update: update, readAt: Date(), isLoading: false)
        } catch {
            snapshots[sessionID] = ChatWorkPanelSnapshot(isLoading: false, failed: true)
        }
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
