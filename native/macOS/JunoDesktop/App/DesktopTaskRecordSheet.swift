import AppKit
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoWorkKit
import QuickLook
import SwiftUI

// MARK: - A task with no conversation

/// A task the old Work window started, which has no chat to report in
/// (register #63): its record in a sheet over the Chat window, still live and
/// still answerable.
///
/// Reached from Search › Tasks and from a notification's `/work/{id}` whose
/// task has no conversation; a task with a conversation opens its chat
/// instead. The follower is keyed on the task
/// (``NativeConversationWork/init(sessionID:session:client:accountID:)``), so
/// approvals decide in place — in this process for a run on this Mac — and
/// Stop, Pause, Resume and Try Again work as they do on the chat's card.
struct DesktopTaskRecordSheet: View {
    let work: NativeConversationWork
    /// Where the task's files come from, so a deliverable opens and saves as
    /// it does in a chat.
    var files: ChatWorkFiles? = nil
    /// This Mac's host, which decides whether a run is this Mac's to carry.
    var pairedHostID: String? = nil
    let close: () -> Void

    /// Why the last action did not land. A sheet covers the window's toast
    /// host, so it is said in the sheet's own footer.
    @State private var failure: String?
    @State private var quickLookURL: URL?
    @State private var pendingUnvalidatedSave: NativeChatAttachment?
    @State private var systemPermissions = DesktopWorkSystemPermissions.current

    var body: some View {
        DesktopTaskRecordView(
            content: content,
            actions: actions,
            failure: failure,
            retry: { work.reconnect() },
            close: close
        )
        .environment(\.junoWorkFiles, files)
        .environment(\.junoWorkFileActions, fileActions)
        .quickLookPreview($quickLookURL)
        .junoConfirmation(Binding(
            get: {
                pendingUnvalidatedSave.map { attachment in
                    JunoConfirmation(
                        title: ChatWorkFileSaving.unvalidatedTitle,
                        message: ChatWorkFileSaving.unvalidatedMessage,
                        confirmTitle: "Save Anyway",
                        role: nil
                    ) {
                        guard let files else { return }
                        ChatWorkFileSaving.save(attachment, from: files) { failure = $0 }
                    }
                }
            },
            set: { if $0 == nil { pendingUnvalidatedSave = nil } }
        ))
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            let current = DesktopWorkSystemPermissions.current
            if current != systemPermissions { systemPermissions = current }
        }
        .task { await work.run() }
        .onDisappear { work.close() }
    }

    private var content: DesktopTaskRecordContent {
        if work.hasReadLog,
            let state = ChatWorkRunState.read(work, files: files, blockers: blockers(for: work.run))
        {
            return .ready(state)
        }
        return work.isUnreachable ? .failed(work.current) : .loading(work.current)
    }

    /// The permissions a run on this Mac is missing: only for a run this
    /// Mac's host is carrying, as on the chat's card (B4).
    private func blockers(for run: WorkRunSummary?) -> [ChatWorkLocalBlocker] {
        guard let run, let pairedHostID else { return [] }
        let runsHere = run.hostID == pairedHostID && run.effectiveTarget != JunoWorkTarget.cloud.rawValue
        return ChatWorkLocalBlocker.of(systemPermissions, runsHere: runsHere)
    }

    /// A deliverable's click, menu and drag, as in a chat: Quick Look, Open
    /// With and Save As, asking first for a file the validator never opened.
    private var fileActions: TranscriptMediaActions {
        var actions = TranscriptMediaActions()
        guard let files else { return actions }
        let said: @MainActor (any Error) -> Void = { failure = NativeFailureMessage.presentable($0) }
        actions.quickLook = { attachment in
            Task {
                do { quickLookURL = try await files.fileURL(for: attachment) } catch { said(error) }
            }
        }
        actions.openWithDefaultApp = { attachment in
            Task {
                do { _ = NSWorkspace.shared.open(try await files.fileURL(for: attachment)) } catch { said(error) }
            }
        }
        actions.saveAs = { attachment in
            Task {
                do { _ = try await files.fileURL(for: attachment) } catch {
                    said(error)
                    return
                }
                if files.isUnvalidated(attachment) {
                    pendingUnvalidatedSave = attachment
                } else {
                    ChatWorkFileSaving.save(attachment, from: files) { failure = $0 }
                }
            }
        }
        return actions
    }

    /// The card's controls, each saying in the footer when it did not land.
    private var actions: ChatWorkRunActions {
        let work = work
        let report: (NativeConversationWork.Outcome) -> Void = { outcome in
            failure = outcome.succeeded ? nil : outcome.message
        }
        return ChatWorkRunActions(
            decide: { approval, decision, reason in
                Task { report(await work.decide(approval, decision, reason: reason)) }
            },
            decideAll: { approvals in Task { report(await work.decideAll(approvals)) } },
            answer: { questionID, text in
                Task { report(await work.answer(questionID: questionID, text: text)) }
            },
            reply: { questionID, text in
                let outcome = await work.answer(questionID: questionID, text: text)
                report(outcome)
                return outcome.succeeded
            },
            stop: {
                let outcome = await work.stop()
                report(outcome)
                return outcome.succeeded
            },
            pause: { Task { report(await work.pause()) } },
            resume: { Task { report(await work.resume()) } },
            tryAgain: { Task { report(await work.tryAgain()) } }
        )
    }
}

/// What the sheet has to show: the task not read yet, not reachable, or read.
enum DesktopTaskRecordContent {
    /// The task as a list last saw it, when one did.
    case loading(WorkSessionSummary?)
    case failed(WorkSessionSummary?)
    case ready(ChatWorkRunState)

    var session: WorkSessionSummary? {
        switch self {
        case .loading(let session), .failed(let session): session
        case .ready(let state): state.session
        }
    }

    var status: JunoWorkStatus? {
        switch self {
        case .ready(let state): state.status
        case .loading(let session), .failed(let session):
            session.flatMap { JunoWorkStatus(rawValue: $0.status) }
        }
    }
}

/// The sheet itself, drawn from its content alone so a fixture can build it.
///
/// Opaque, 640 × 600, on the sheet ground. Three rungs: the title at 18pt
/// semibold, the status pill and its sentence, then the lede at 13pt
/// secondary. The body is the chat's task card in its standalone mode; the
/// footer is "Done". **Signature detail:** the current question carries its
/// own field and "Reply", since there is no composer under a sheet.
struct DesktopTaskRecordView: View {
    let content: DesktopTaskRecordContent
    var actions = ChatWorkRunActions()
    var failure: String?
    var retry: (() -> Void)?
    let close: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let size = CGSize(width: 640, height: 600)
    static let lede = "This task was started before tasks lived in chats, so it has no conversation to report in."

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, JunoSpace.section)
                .padding(.top, JunoSpace.section)
                .padding(.bottom, JunoSpace.regular)
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            main
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            footer
                .padding(.horizontal, JunoSpace.section)
                .padding(.vertical, JunoSpace.regular)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: failure)
        .junoSheetSurface(.fitted)
        .accessibilityIdentifier("juno.work.task-sheet")
    }

    // MARK: Header

    private var title: String? {
        guard let session = content.session else { return nil }
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? session.goal : title
    }

    private var header: some View {
        HStack(alignment: .top, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                if let title {
                    Text(title)
                        .junoFont(size: 18, relativeTo: .title3, weight: .semibold)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityAddTraits(.isHeader)
                } else if case .failed = content {
                    // Known only by id, and not reachable: the card's own word.
                    Text("Task")
                        .junoFont(size: 18, relativeTo: .title3, weight: .semibold)
                        .foregroundStyle(Color.junoForeground)
                        .accessibilityAddTraits(.isHeader)
                } else {
                    // The shape of a title while the task is read by id.
                    RoundedRectangle(cornerRadius: JunoRadius.micro, style: .continuous)
                        .fill(Color.junoMuted)
                        .frame(width: 280, height: 14)
                        .padding(.vertical, 4)
                        .accessibilityLabel("Loading this task")
                }
                if let status = content.status {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            ChatWorkStatusPill(status: status)
                            sentence(status)
                        }
                        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                            ChatWorkStatusPill(status: status)
                            sentence(status)
                        }
                    }
                    .id(status)
                    .transition(.opacity)
                }
                // Said only of a task this Mac has read and found without a
                // chat; one known only by id may not be one.
                if content.session != nil {
                    Text(Self.lede)
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, JunoSpace.tight)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            if case .ready(let state) = content {
                ChatWorkRunControls(state: state, actions: actions)
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: content.status)
    }

    private func sentence(_ status: JunoWorkStatus) -> some View {
        Text(ChatWorkVocabulary.sentence(status))
            .junoFont(size: 13, relativeTo: .callout)
            .foregroundStyle(Color.junoForeground)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Body

    @ViewBuilder
    private var main: some View {
        switch content {
        case .loading:
            // The panel's skeleton brings its own 16; this puts its rows on
            // the header's 24.
            ChatWorkPanelSkeleton()
                .padding(.horizontal, JunoSpace.snug)
        case .failed:
            JunoEmptyState(
                title: "Couldn\u{2019}t load this task",
                message: "Check your connection and try again.",
                icon: .error,
                actionLabel: retry == nil ? nil : "Try Again",
                action: retry,
                size: .panel,
                tone: .error
            )
            .padding(JunoSpace.section)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready(let state):
            ScrollView {
                ChatWorkRunCard(state: state, actions: actions, standalone: true)
                    .padding(.horizontal, JunoSpace.section)
                    .padding(.vertical, JunoSpace.regular)
            }
            // A live task opens on what it waits for — its question, its
            // approvals — which the card draws last; a finished one on what
            // it made, which it draws first.
            .defaultScrollAnchor(state.isLive ? .bottom : .top, for: .initialOffset)
            .scrollEdgeEffectStyle(.soft, for: .top)
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(alignment: .center, spacing: JunoSpace.regular) {
            if let failure {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    JunoIconView(.error, size: 13)
                        .accessibilityHidden(true)
                    Text(failure)
                        .junoFont(size: 13, relativeTo: .callout)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .foregroundStyle(Color.junoDestructiveInk)
                .transition(.opacity)
                .accessibilityIdentifier("juno.work.task-sheet.failure")
            }
            Spacer(minLength: 0)
            Button(action: close) {
                Text("Done").frame(minWidth: 44, minHeight: 20).contentShape(.rect)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .frame(minHeight: 28)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("juno.work.task-sheet.done")
        }
    }
}

/// One task's sheet on screen, with the follower it reads — held by the
/// window so a redraw does not start a second one.
struct DesktopTaskRecordPresentation: Identifiable {
    let id = UUID()
    let work: NativeConversationWork
    let files: ChatWorkFiles
}
