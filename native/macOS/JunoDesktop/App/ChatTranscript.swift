import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// The chat column's reading measure — **one number, read by both halves of it**.
///
/// The transcript clamped to 768 and the composer to 720. Because the composer
/// also insets its field by `JunoSpace.snug`, the two text edges landed 32pt
/// apart on every window wider than about 830pt: a reader's own sentence and the
/// reply to it were typeset to two different columns, with the composer's the
/// narrower of the two, so the eye had to reset its line start every time it
/// moved between them. Nothing chose those numbers against each other — 768 is
/// the web's `max-w-3xl` and 720 was freehand — which is exactly why they had to
/// stop being two numbers.
///
/// The 8pt that remains between the composer's *field* and the transcript's text
/// is the composer's own chrome inset, and that one is deliberate: the composer
/// is a bordered control on a glass platter, so its text sits inside its rim the
/// way any control's does. A measure and a control's padding are different
/// things; only the measure was ever in disagreement.
enum DesktopChatMeasure {
    /// The web's `max-w-3xl` — the one reading measure every product shares.
    static let reading: CGFloat = JunoReadingMeasure.reading
    /// The gutter the column keeps from the window edge before the measure
    /// binds, at a column wide enough for the widest rung.
    static let gutter: CGFloat = JunoSpace.region

    /// §6.1: the gutter narrows with the column — 16 below 640pt, 24 from
    /// 640, 32 from 1024 — so a column squeezed by the canvas dock or a narrow
    /// window gives its words the room rather than its margins. A width not
    /// measured yet (zero) takes the widest rung, as the column did before.
    static func gutter(forColumnWidth width: CGFloat) -> CGFloat {
        if width <= 0 || width >= 1024 { return JunoSpace.region }
        if width >= 640 { return JunoSpace.section }
        return JunoSpace.regular
    }
}

extension EnvironmentValues {
    /// The transcript's reading measure, as the transcript measured it: the
    /// width its rows are laid out in, never more than
    /// ``DesktopChatMeasure/reading``. The reader's bubble is at most 85% of it.
    @Entry var junoMeasure: CGFloat = DesktopChatMeasure.reading
    /// Forces a turn's hover on — its action cluster, and later its media's
    /// hover controls. The offscreen snapshot harness's stand-in for a pointer
    /// it cannot move; production never sets it.
    @Entry var junoSnapshotHover = false
    /// Forces a turn's Copy into its confirming check, for the same harness:
    /// the two seconds a real copy holds it are not a state a still can catch.
    @Entry var junoSnapshotCopied = false
}

/// The transcript's reading column: the web's `max-w-3xl` (768pt), centred,
/// with the gutter the column keeps from the window edge — and the width it
/// actually got, handed down as ``SwiftUI/EnvironmentValues/junoMeasure``.
///
/// One modifier for the transcript and for the snapshot fixtures, so a fixture
/// is laid out in exactly the column a conversation is (at 832 the 768pt
/// measure binds inside a 24pt gutter). The gutter follows the column's own
/// width (``DesktopChatMeasure/gutter(forColumnWidth:)``).
struct TranscriptColumn: ViewModifier {
    @State private var measure: CGFloat = DesktopChatMeasure.reading
    /// The whole column, gutters included — what picks the gutter's rung.
    @State private var columnWidth: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: DesktopChatMeasure.reading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                if width > 0 { measure = width }
            }
            .environment(\.junoMeasure, measure)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, DesktopChatMeasure.gutter(forColumnWidth: columnWidth))
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                columnWidth = width
            }
    }
}

struct DesktopTranscript: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    /// Turns this column shows that have no row in the store: a private chat's
    /// (§5.8), or the stand-in for a new chat's first turn while the store is
    /// still creating it (§10.1). Drawn by the same row as everything else.
    var localMessages: [NativeChatMessage] = []
    /// Whether ``localMessages`` are a private chat's turns — which can be
    /// copied, read aloud and quoted — rather than a first turn's stand-in,
    /// which has nothing behind it to act on yet.
    var localTurnsArePrivate = false
    /// A private chat's failure, where its reply would have been.
    var localError: String? = nil
    /// Whether the store's own state — approvals, follow-ups, research, its
    /// errors — belongs to this column. Not in a private chat, which has no
    /// conversation for any of them to describe.
    var showsStoreState = true
    /// The live spoken turns, if a call is running. Kept apart from
    /// `model.selectedMessages` rather than merged into the store: these belong
    /// to the call, not to the conversation, and a store that held them would
    /// have to decide when to take them out again.
    let voiceMessages: [NativeChatMessage]
    let messageActions: NativeMessageActionsClient?
    let accountID: AccountID
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    /// Asks the conversation column to dock the canvas. A row cannot own that
    /// panel — see ``DesktopConversationView/openArtifact``.
    let openArtifact: (NativeMessageContent.ArtifactReference) -> Void
    /// The window's Share — publish, copy, and say so in the Share popover;
    /// nil when the account has no share service. Reached from every reply's
    /// More menu, as on the web, not only from the toolbar.
    let share: (() -> Void)?
    /// Starts a private chat from the transcript up to a message — Fork
    /// Privately. Nil where there is no private chat to start.
    var forkPrivately: (([NativePrivateChatModel.Turn]) -> Void)? = nil
    /// Seeds the composer with a reply, quoted — Quote in Composer.
    var quote: ((String) -> Void)? = nil
    /// A new value asks the last message you sent to open for editing — ↑ in
    /// the composer's empty field (§5.9). The row owns its editor; this only
    /// says "now".
    var editLastRequest: UUID? = nil
    /// ⌘F: what is found, and which match is current.
    var find: TranscriptFindModel? = nil
    /// Opens the Activity panel on a reply's run — by message, and on a call
    /// when one is given.
    var openActivity: ((String, String?) -> Void)? = nil
    /// Opens the Research panel on a run, by id.
    var openResearch: ((String) -> Void)? = nil
    /// "Research this": sends a question as a Research request.
    var researchThis: ((String) -> Void)? = nil
    /// The chat's current task, as its follower has it (§6.8, Phase 5 A5).
    var workRun: ChatWorkRunState? = nil
    /// Every task of this chat, current and earlier, placed by the web's rule
    /// (Phase 5 A4): the current one draws ``workRun``'s card, each earlier
    /// one a settled row.
    var workRuns: [ChatWorkRunEntry] = []
    var workActions = ChatWorkRunActions()
    /// Opens the Task panel on a task, by session id.
    var openTask: ((String) -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The window's toast host (§7.7): where a failed action on a reply, and
    /// a confirmation with no other evidence, are said.
    @Environment(\.junoToast) private var toast
    /// A failed action on a reply — a rating that did not save, Read Aloud
    /// that could not start. Set, it is posted to the window's toast host and
    /// cleared.
    @State private var actionError: String?
    /// Where the transcript is scrolled. It starts at the newest turn and
    /// follows the stream only while the reader is there (spec §6.13).
    @State private var position = ScrollPosition(edge: .bottom)
    /// The reader is within 24pt of the end.
    @State private var atBottom = true
    /// New content keeps the view at the end: true until the reader scrolls
    /// away, and again when they come back or send.
    @State private var follows = true
    /// The reader's hand is on the scroll view, so a change of position is
    /// theirs rather than the stream's.
    @State private var userScrolling = false
    @State private var speechPlayback = DesktopSpeechPlayback()
    /// The reply a Branch ▸ Into a New Saved Chat is on its way from.
    @State private var branchingMessageID: String?
    /// The index from which rows rise in, so opening a conversation does not
    /// replay every entrance it ever had. See ``noteMessages(from:to:)``.
    @State private var animateFrom = Int.max
    /// The conversation whose count `animateFrom` was last seeded against.
    @State private var settledConversationID: String?
    /// The same gate for ``localMessages``. It starts at zero, because the
    /// transcript is only ever built with local turns in it at the handoff —
    /// and those are the turns that rise, a beat after the greeting leaves.
    @State private var localAnimateFrom = 0
    /// The phases the announcer has spoken for the live run, and when it last
    /// spoke one.
    @State private var announcedPhases = Set<String>()
    @State private var lastPhaseAnnouncementAt = Date.distantPast

    /// The web's `max-w-3xl` reading column. See ``DesktopChatMeasure``.
    static let readingWidth: CGFloat = DesktopChatMeasure.reading

    /// The reply whose actions stay visible and which alone can be
    /// regenerated: the transcript's last turn, when it is an answer.
    private var newestReplyID: String? {
        guard let last = model.selectedMessages.last, last.role == .assistant else { return nil }
        return last.id
    }

    private var lastUserMessageID: String? {
        model.selectedMessages.last(where: { $0.role == .user && !$0.isPending })?.id
    }

    /// The account catalog's name for a canonical model id.
    ///
    /// Falls back to the shared humanizer when the catalog has no entry, which
    /// happens for a model the account has since lost access to — "Claude
    /// Sonnet 4.6", never "anthropic:claude-sonnet-4-6".
    private func displayName(forModelID id: String) -> String {
        model.model(withID: id)?.displayName ?? junoDisplayModelName(id)
    }

    /// The Regenerate menu's Switch Model list: every chat model this account
    /// can send to, grouped by provider.
    private var switchableModels: [DesktopRegenerateModel] {
        DesktopRegenerateModel.switchable(from: model.selectableModels)
    }

    var body: some View {
        ScrollView {
            // The web's reading column, metric for metric: `max-w-3xl`
            // (768pt) at `space-y-6` (24pt) — see `message-list.tsx`.
            LazyVStack(alignment: .leading, spacing: JunoSpace.section) {
                ForEach(Array(model.selectedMessages.enumerated()), id: \.element.id) {
                    index, message in
                    storeRow(message)
                        .modifier(DesktopMessageRise(rises: index >= animateFrom))
                        .environment(\.junoFindHighlight, find?.highlight(for: message.id))
                        .id(message.id)
                    // A research run follows the question it answers.
                    if message.role == .user {
                        ForEach(researchRuns.filter { $0.userMessageID == message.id }) { run in
                            researchRow(run)
                        }
                    }
                    // A task follows the reply after the turn that started it.
                    ForEach(workPlacement[message.id] ?? []) { entry in
                        workRow(entry)
                    }
                }

                // Runs whose question is not on screen follow the transcript.
                ForEach(researchRuns.filter { run in
                    !model.selectedMessages.contains { $0.id == run.userMessageID && $0.role == .user }
                }) { run in
                    researchRow(run)
                }

                // A task no turn on screen started: at the foot, as the web
                // places one with no earlier question.
                ForEach(workAtFoot) { entry in
                    workRow(entry)
                }

                // A private chat's turns, or a first turn on its way to
                // the store. Those present when the transcript is built are
                // the handoff's (§10.1), and rise a beat after it starts.
                ForEach(Array(localMessages.enumerated()), id: \.element.id) { index, message in
                    localRow(message, isNewest: localTurnsArePrivate && message.id == localMessages.last?.id
                        && message.role == .assistant)
                        .modifier(
                            DesktopMessageRise(
                                rises: index >= localAnimateFrom,
                                delay: localAnimateFrom == 0 ? DesktopChoreography.firstTurnBeat : 0
                            )
                        )
                        .environment(\.junoFindHighlight, find?.highlight(for: message.id))
                        .id(message.id)
                }

                // A private chat's failure, where its reply would have been.
                if let localError {
                    DesktopTurnError(message: localError)
                }

                // Approvals are drawn inside the reply they block. One
                // recovered from `/api/approvals` with no reply on screen to
                // hold it yet — a cold launch mid-wait — waits here, still
                // answerable.
                if showsStoreState, newestReplyID == nil, let conversationID = model.selectedConversationID {
                    ForEach(model.chatApprovals(for: conversationID).filter(\.isPending)) { approval in
                        approvalCard(approval)
                    }
                }

                // The call, in the transcript it belongs to. Same rows, same
                // reading column, appended after the persisted turns — the
                // web's arrangement, and the reason it has no transcript
                // pane: a spoken conversation is the conversation, not a
                // second view of one.
                ForEach(voiceMessages) { message in
                    DesktopMessageRow(
                        message: message,
                        isVoice: true,
                        isNewest: false,
                        modelDisplayName: nil,
                        switchableModels: [],
                        // A spoken turn has no row anywhere until the call
                        // is hung up and filed: nothing to act on yet.
                        actions: MessageRowActions(),
                        branchPosition: nil,
                        isGenerating: model.isGenerating
                    )
                    // A line the recognizer has not finalized is a
                    // hypothesis it is still rewriting several times a
                    // second, and it is frequently wrong. Dimmed, it reads
                    // as something being heard; at full strength it reads as
                    // something that was said.
                    .opacity(message.isPending ? 0.55 : 1)
                    .id(message.id)
                }

                // A failure no reply is carrying — rare now that the store
                // writes its error onto the reply it ended.
                if showsStoreState, let error = orphanedError {
                    DesktopTurnError(
                        message: error,
                        retry: model.canRetrySelectedConversation ? {
                            guard let id = model.selectedConversationID else { return }
                            model.retryLastMessage(conversationID: id)
                        } : nil
                    )
                }

            }
            .scrollTargetLayout()
            .modifier(TranscriptColumn())
            .padding(.bottom, JunoSpace.section)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        // Said in the window's toast host, then let go: the host keeps it for
        // its four seconds, and the next failure is a new post.
        .onChange(of: actionError) { _, message in
            guard let message else { return }
            toast(.error(message))
            actionError = nil
        }
        .contentMargins(.top, JunoSpace.section, for: .scrollContent)
        .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
        .onScrollGeometryChange(for: Bool.self) { geometry in
            Self.isAtBottom(geometry)
        } action: { _, isAtBottom in
            atBottom = isAtBottom
            if userScrolling { follows = isAtBottom }
        }
        // The stream growing the reply: kept in view only while following.
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
            guard follows, !userScrolling, new > old else { return }
            position.scrollTo(edge: .bottom)
        }
        .onScrollPhaseChange { _, phase in
            switch phase {
            case .tracking, .interacting, .decelerating:
                userScrolling = true
            case .idle, .animating:
                if userScrolling { follows = atBottom }
                userScrolling = false
            @unknown default:
                userScrolling = false
            }
        }
        .overlay(alignment: .bottom) {
            ScrollToLatestButton(isShown: !atBottom && !model.selectedMessages.isEmpty) {
                follows = true
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    position.scrollTo(edge: .bottom)
                }
            }
            .padding(.bottom, 12)
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: atBottom)
        }
        .onChange(of: model.selectedMessages, initial: true) { previous, current in
            noteMessages(from: previous.count, to: current.count)
            // A turn arriving is the reader's own send, or its reply's
            // placeholder: back to the end, animated. Tokens growing a reply
            // are the geometry handler's.
            guard current.count != previous.count else { return }
            follows = true
            // History landing — a conversation opening, a sync catching up —
            // is placed at its end at once; travelling through it from a
            // position the reader never saw reads as the page moving on its
            // own. Only a turn arriving is animated.
            if previous.isEmpty || current.count - previous.count > 2 {
                position.scrollTo(edge: .bottom)
            } else {
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    position.scrollTo(edge: .bottom)
                }
            }
        }
        .onChange(of: model.selectedConversationID) { _, _ in
            follows = true
            position.scrollTo(edge: .bottom)
        }
        // A partial spoken line lands several times a second: unanimated.
        .onChange(of: voiceMessages) { _, _ in
            guard follows else { return }
            position.scrollTo(edge: .bottom)
        }
        // A private turn arriving, or a private reply growing.
        .onChange(of: localMessages) { previous, current in
            if current.count != previous.count {
                localAnimateFrom = current.count < previous.count ? current.count : previous.count
                follows = true
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                    position.scrollTo(edge: .bottom)
                }
            }
        }
        // ⌘F's current match, brought into view.
        .onChange(of: find?.currentMatch) { _, match in
            guard let match else { return }
            follows = false
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                position.scrollTo(id: match.messageID, anchor: .center)
            }
        }
        // "Response complete, N words." on the edge from writing to done —
        // the web's announcer.
        .onChange(of: model.isGenerating) { wasGenerating, isGenerating in
            announcedPhases = []
            guard wasGenerating, !isGenerating,
                let last = model.selectedMessages.last, last.role == .assistant,
                last.errorDescription == nil
            else { return }
            let words = NativeMessageContent.plainText(of: last.content)
                .split(whereSeparator: \.isWhitespace).count
            // The summary's words first (SPEC §7.12), then the web's line.
            let view = NativeRunView.build(activity: last.activity, reasoning: last.reasoning, sources: last.sources)
            let summary = NativeToolPresentation.summaryLine(view, workedMs: view.timing.workedMs, sourceCount: last.sources.count)
                .text.replacingOccurrences(of: " · ", with: ", ")
            let lead = view.hasContent(sourceCount: last.sources.count) && !summary.isEmpty ? "\(summary). " : ""
            Self.announce("\(lead)Response complete, \(words) \(words == 1 ? "word" : "words").")
        }
        // The run's phase boundaries, spoken once each and at least three
        // seconds apart; waiting for an approval jumps the queue (SPEC §7.12).
        .onChange(of: livePhaseAnnouncement) { _, announcement in
            guard let announcement, !announcedPhases.contains(announcement.key) else { return }
            let now = Date()
            guard announcement.urgent || now.timeIntervalSince(lastPhaseAnnouncementAt) >= 3 else { return }
            announcedPhases.insert(announcement.key)
            lastPhaseAnnouncementAt = now
            Self.announce(announcement.text)
        }
        .onDisappear { speechPlayback.stop() }
    }

    /// Within 24pt of the end of the content, above the composer's inset.
    static func isAtBottom(_ geometry: ScrollGeometry) -> Bool {
        let visibleBottom = geometry.contentOffset.y + geometry.containerSize.height - geometry.contentInsets.bottom
        return visibleBottom >= geometry.contentSize.height - 24
    }

    /// The store's error, when no reply on screen carries it and it is not a
    /// reconnect in progress (whose own line says so).
    private var orphanedError: String? {
        guard let error = model.chatErrorDescription, model.chatPhase != .reconnecting,
            !model.isGenerating
        else { return nil }
        let messages = model.selectedMessages
        if messages.contains(where: { $0.errorDescription != nil }) { return nil }
        if let lastUser = messages.last(where: { $0.role == .user }),
            model.isUnsentMessage(lastUser.id, in: lastUser.conversationID)
        {
            return nil
        }
        return error
    }

    // MARK: The announcer

    struct PhaseAnnouncement: Equatable {
        let key: String
        let text: String
        let urgent: Bool
    }

    /// What the live run is doing, in the announcer's words: "Thinking",
    /// "Searching the web", "Reading sources", a tool's running phrase, and
    /// "Waiting for your approval…".
    private var livePhaseAnnouncement: PhaseAnnouncement? {
        guard let live = model.selectedMessages.last, live.role == .assistant, live.isPending else { return nil }
        let view = NativeRunView.build(activity: live.activity, reasoning: live.reasoning, sources: live.sources)
        let phase = NativeRunPhase.derive(
            view: view, live: true, failed: false, finishReason: nil,
            answerStarted: live.answerStartedAt != nil,
            awaitingApproval: false
        )
        switch phase {
        case .thinking: return PhaseAnnouncement(key: "thinking", text: "Thinking", urgent: false)
        case .searching: return PhaseAnnouncement(key: "searching", text: "Searching the web", urgent: false)
        case .reading: return PhaseAnnouncement(key: "reading", text: "Reading sources", urgent: false)
        case .tool:
            guard let call = view.calls.last(where: \.status.isActive) else { return nil }
            return PhaseAnnouncement(key: "tool:\(call.callID)", text: NativeToolPresentation.runningLine(call).text, urgent: false)
        case .waiting:
            return PhaseAnnouncement(
                key: "waiting:\(view.pendingApprovalIDs.joined())",
                text: "Waiting for your approval. The approval is below the answer.",
                urgent: true
            )
        default:
            return nil
        }
    }

    // MARK: Tasks

    /// Where each task sits: the id of the message it follows (the web's
    /// `MessageList` rule, ``ChatWorkPlacement``).
    private var workPlacement: [String: [ChatWorkRunEntry]] {
        guard showsStoreState, !workRuns.isEmpty else { return [:] }
        let turns = model.selectedMessages.map {
            ChatWorkPlacement.Turn(id: $0.id, isUser: $0.role == .user, createdAt: $0.createdAt)
        }
        var placed: [String: [ChatWorkRunEntry]] = [:]
        for entry in workRuns {
            guard let anchor = ChatWorkPlacement.anchor(for: entry.createdAt, in: turns) else { continue }
            placed[anchor, default: []].append(entry)
        }
        return placed
    }

    /// The tasks with no turn on screen to follow.
    private var workAtFoot: [ChatWorkRunEntry] {
        guard showsStoreState else { return [] }
        let turns = model.selectedMessages.map {
            ChatWorkPlacement.Turn(id: $0.id, isUser: $0.role == .user, createdAt: $0.createdAt)
        }
        return workRuns.filter { ChatWorkPlacement.anchor(for: $0.createdAt, in: turns) == nil }
    }

    /// The task's live step moves only when nothing else on screen does: a
    /// reply being written, or a research row that owns the loop, wins.
    private var workOwnsLoop: Bool {
        !model.isGenerating && loopingResearchRunID == nil
    }

    /// The card's state for the current task, with the loop given up when
    /// something else on screen owns it.
    private func currentWorkState(_ entry: ChatWorkRunEntry) -> ChatWorkRunState? {
        guard entry.isCurrent, var state = workRun, state.session.sessionID == entry.id else { return nil }
        state.ownsLoop = state.ownsLoop && workOwnsLoop
        return state
    }

    @ViewBuilder
    private func workRow(_ entry: ChatWorkRunEntry) -> some View {
        if let state = currentWorkState(entry) {
            ChatWorkRunCard(state: state, actions: workActions)
                .id("work:\(entry.id)")
        } else {
            ChatWorkSettledRow(
                session: entry.session,
                status: entry.status,
                open: { openTask?(entry.id) }
            )
            .id("work:\(entry.id)")
        }
    }

    // MARK: Research

    /// This conversation's background research runs (SPEC §9.11.3).
    private var researchRuns: [NativeResearchRun] {
        guard showsStoreState else { return [] }
        // A run first seen finished is its completion message: no row.
        return model.researchRuns(for: model.selectedConversationID).filter(\.seenLive)
    }

    /// The newest live run owns the loop — only while no chat run works
    /// (SPEC §7.9.1, priority 4).
    private var loopingResearchRunID: String? {
        guard !model.isGenerating else { return nil }
        return researchRuns.last { $0.phase.isWorking }?.id
    }

    @ViewBuilder
    private func researchRow(_ run: NativeResearchRun) -> some View {
        if run.phase == .awaitingStart, let conversationID = model.selectedConversationID {
            DesktopResearchPlanCard(
                run: run,
                atTail: model.selectedMessages.last?.id == run.userMessageID || run.userMessageID == nil,
                busy: model.researchBusyRunIDs.contains(run.id),
                error: model.researchErrors[run.id],
                start: { Task { await model.decideResearchPlan(runID: run.id, start: true, conversationID: conversationID) } },
                cancel: { Task { await model.decideResearchPlan(runID: run.id, start: false, conversationID: conversationID) } }
            )
            .id("research:\(run.id)")
        } else {
            DesktopResearchRow(
                run: run,
                ownsLoop: loopingResearchRunID == run.id,
                open: { openResearch?(run.id) }
            )
            .id("research:\(run.id)")
        }
    }

    private func approvalCard(_ approval: NativeChatApproval) -> some View {
        DesktopApprovalCard(
            approval: approval,
            isBusy: model.chatApprovalInFlightID == approval.id,
            errorMessage: model.chatApprovalError(for: approval.id),
            canAllowScope: model.canAllowChatApprovalScope(approval),
            decide: { decision in
                Task { await model.decideChatApproval(approval, decision: decision) }
            }
        )
    }

    /// The approvals a reply is blocked on: every pending one, and those
    /// raised since its question — the ones that belong to this turn.
    private func approvals(for message: NativeChatMessage) -> MessageRowApprovals {
        guard showsStoreState, message.id == newestReplyID,
            let conversationID = model.selectedConversationID
        else { return MessageRowApprovals() }
        let asked = model.selectedMessages.last(where: { $0.role == .user })?.createdAt ?? .distantPast
        let approvals = model.chatApprovals(for: conversationID).filter {
            $0.isPending || $0.createdAt >= asked
        }
        guard !approvals.isEmpty else { return MessageRowApprovals() }
        return MessageRowApprovals(
            approvals: approvals,
            inFlightID: model.chatApprovalInFlightID,
            error: { model.chatApprovalError(for: $0) },
            canAllowScope: { model.canAllowChatApprovalScope($0) },
            decide: { approval, decision in
                Task { await model.decideChatApproval(approval, decision: decision) }
            }
        )
    }

    // MARK: Rows

    private func storeRow(_ message: NativeChatMessage) -> some View {
        DesktopMessageRow(
            message: message,
            isVoice: false,
            isNewest: message.id == newestReplyID,
            modelDisplayName: message.model.map(displayName(forModelID:)),
            currentModelID: message.model ?? model.selectedConversation?.model,
            switchableModels: message.id == newestReplyID ? switchableModels : [],
            actions: storeActions(for: message),
            branchPosition: branchPosition(for: message),
            isGenerating: model.isGenerating,
            isSpeaking: speechPlayback.playingMessageID == message.id,
            isBranching: branchingMessageID == message.id,
            isUnsent: model.isUnsentMessage(message.id, in: message.conversationID),
            editRequest: message.id == lastUserMessageID ? editLastRequest : nil,
            approvals: approvals(for: message),
            isRecovering: message.isPending && model.chatPhase == .reconnecting
        )
    }

    private func localRow(_ message: NativeChatMessage, isNewest: Bool) -> some View {
        DesktopMessageRow(
            message: message,
            // The first turn's stand-in has nothing behind it yet; a private
            // turn has words to copy, read and quote.
            isVoice: !localTurnsArePrivate,
            isPrivate: localTurnsArePrivate,
            isNewest: isNewest,
            modelDisplayName: message.model.map(displayName(forModelID:)),
            switchableModels: [],
            actions: localTurnsArePrivate ? privateActions(for: message) : MessageRowActions(),
            branchPosition: nil,
            isGenerating: message.isPending,
            isSpeaking: speechPlayback.playingMessageID == message.id
        )
    }

    /// Whether a store row is the server's, rather than a turn still on its
    /// way there: the only rows that can be rated, branched, shared or linked.
    private func isSaved(_ message: NativeChatMessage) -> Bool {
        !message.conversationID.isEmpty && !message.id.hasPrefix("local-")
    }

    private func storeActions(for message: NativeChatMessage) -> MessageRowActions {
        let saved = isSaved(message)
        let isNewest = message.id == newestReplyID
        var actions = MessageRowActions()
        actions.copy = { content in Self.copyToPasteboard(NativeMessageContent.copyableMarkdown(of: content)) }
        if messageActions != nil {
            actions.readAloud = { content in readAloud(message, content: content) }
            actions.stopReading = { speechPlayback.stop() }
            if saved {
                actions.setFeedback = { setFeedback($0, for: message) }
                actions.branch = { branch(from: message) }
            }
        }
        if message.role == .assistant, let openActivity {
            actions.openActivity = { callID in openActivity(message.id, callID) }
        }
        if message.role == .assistant {
            actions.openResearch = openResearch
            if isNewest { actions.researchThis = researchThis }
        }
        if isNewest, message.role == .assistant, message.errorDescription != nil,
            model.canRetrySelectedConversation
        {
            actions.retry = {
                guard let conversationID = model.selectedConversationID else { return }
                model.retryLastMessage(conversationID: conversationID)
            }
        }
        if isNewest, message.role == .assistant {
            actions.regenerate = { request in regenerate(request) }
            if model.canContinueSelectedConversation {
                actions.continueResponse = {
                    guard let conversationID = model.selectedConversationID else { return }
                    _ = model.continueLastResponse(conversationID: conversationID)
                }
            }
        }
        if forkPrivately != nil {
            actions.forkPrivately = { forkPrivately(through: message) }
        }
        if saved {
            actions.share = share
            actions.copyLink = { copyLink(to: message) }
        }
        if let quote {
            actions.quote = { content in quote(NativeMessageContent.copyableMarkdown(of: content)) }
        }
        if saved, message.versionCount > 0 {
            let messageID = message.id
            actions.loadVersions = { try await model.messageVersions(messageID: messageID) }
        }
        actions.reportFailure = { actionError = $0 }
        if model.isUnsentMessage(message.id, in: message.conversationID) {
            actions.retrySend = {
                model.retryLastMessage(conversationID: message.conversationID)
            }
        }
        actions.stepBranch = { offset in stepBranch(from: message, offset: offset) }
        if message.role == .user, !message.isPending, saved {
            actions.editMessage = { newContent in editMessage(message, newContent: newContent) }
        }
        actions.openArtifact = openArtifact
        return actions
    }

    /// A private turn: words to copy, read and quote, and nothing else.
    private func privateActions(for message: NativeChatMessage) -> MessageRowActions {
        var actions = MessageRowActions()
        actions.copy = { content in Self.copyToPasteboard(NativeMessageContent.copyableMarkdown(of: content)) }
        if messageActions != nil {
            actions.readAloud = { content in readAloud(message, content: content) }
            actions.stopReading = { speechPlayback.stop() }
        }
        if let quote {
            actions.quote = { content in quote(NativeMessageContent.copyableMarkdown(of: content)) }
        }
        return actions
    }

    /// Decides which rows are new enough to rise in.
    ///
    /// The web seeds the same index at mount and calls it `animateFrom`
    /// (`message-list.tsx`) — it gets away with one line because its list mounts
    /// with the messages already in hand. A store that loads asynchronously does
    /// not: selecting a conversation sets the id first and the transcript arrives
    /// a moment later, so "everything that appeared since the last render" would
    /// mean the entire history every time a chat is opened.
    private func noteMessages(from previous: Int, to current: Int) {
        guard settledConversationID == model.selectedConversationID else {
            // A conversation that has only just been selected has not loaded yet,
            // so whatever arrives first is its history — however short — and
            // history must not replay. It is not recorded as settled until
            // something actually lands, or an empty first pass would count as the
            // load and the real one would animate.
            if current > 0 { settledConversationID = model.selectedConversationID }
            animateFrom = current
            return
        }
        // A send appends the reader's own turn and then the reply's placeholder,
        // one at a time. Anything larger is a block landing — a sync catching up,
        // a branch being read — and that is history again.
        animateFrom = current - previous > 2 ? current : previous
    }

    // MARK: Actions

    private static func copyToPasteboard(_ content: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
    }

    /// Try Again, Switch Model, More Concise and Add Details, all through the
    /// store's one regenerate path.
    private func regenerate(_ request: MessageRegenerateRequest) {
        guard let conversationID = model.selectedConversationID else { return }
        switch request {
        case .again:
            model.retryLastMessage(conversationID: conversationID, modelID: nil, instruction: nil)
        case .model(let id):
            model.retryLastMessage(conversationID: conversationID, modelID: id, instruction: nil)
        case .instruction(let instruction):
            model.retryLastMessage(conversationID: conversationID, modelID: nil, instruction: instruction)
        }
    }

    /// An optimistic thumb: set at once, rolled back if the server refuses.
    private func setFeedback(
        _ feedback: NativeChatFeedback?,
        for message: NativeChatMessage
    ) {
        guard let messageActions else { return }
        let previous = message.feedback
        model.applyFeedback(
            feedback,
            messageID: message.id,
            conversationID: message.conversationID
        )
        actionError = nil
        Task {
            do {
                try await messageActions.setFeedback(
                    messageID: message.id,
                    feedback: feedback.map {
                        $0 == .up ? .up : .down
                    },
                    for: accountID
                )
            } catch {
                model.applyFeedback(
                    previous,
                    messageID: message.id,
                    conversationID: message.conversationID
                )
                actionError = "Could not save your feedback."
            }
        }
    }

    /// Where `message` sits among its revisions, or nil when it has none.
    ///
    /// Asked of the store per row rather than cached on the message: a position
    /// is a fact about the tree, and one copied onto a message would keep
    /// reading `2 / 3` after the reader's next edit made it `2 / 4`.
    private func branchPosition(
        for message: NativeChatMessage
    ) -> NativeMessageBranchPosition? {
        model.branchPosition(for: message.id, in: message.conversationID)
    }

    private func stepBranch(from message: NativeChatMessage, offset: Int) {
        Task {
            await model.stepBranch(
                from: message.id,
                in: message.conversationID,
                offset: offset
            )
        }
    }

    /// Re-asks a prompt as a new branch beside the original.
    ///
    /// The model is resolved the same way the composer resolves its own on
    /// opening a conversation — the account's pick for this conversation,
    /// falling back to the first model it can still use.
    private func editMessage(_ message: NativeChatMessage, newContent: String) {
        let modelID = DesktopChatSelection.resolvedModelID(
            current: "",
            conversationModel: model.selectedConversation?.model ?? "",
            selectable: model.selectableModels
        )
        guard !modelID.isEmpty else { return }
        Task {
            await model.editUserMessage(
                messageID: message.id,
                conversationID: message.conversationID,
                newContent: newContent,
                modelID: modelID
            )
        }
    }

    /// Branch ▸ Into a New Saved Chat. The More trigger wears the wait, and is
    /// disabled, until the server answers.
    private func branch(from message: NativeChatMessage) {
        guard let messageActions, branchingMessageID == nil else { return }
        actionError = nil
        branchingMessageID = message.id
        Task {
            defer { branchingMessageID = nil }
            do {
                let id = try await messageActions.branch(
                    conversationID: message.conversationID,
                    atMessageID: message.id,
                    for: accountID
                )
                await syncModel?.refresh()
                await model.reload()
                model.isDraftingNewConversation = false
                model.selectedConversationID = id
                toast(.success("Branched into a new chat."))
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    /// Branch ▸ Fork Privately: the transcript up to this message, carried into
    /// a new private chat — the web's `handleFork` (`chat-view.tsx`). Only
    /// settled turns with words in them travel.
    private func forkPrivately(through message: NativeChatMessage) {
        guard let forkPrivately, !model.isGenerating,
            let index = model.selectedMessages.firstIndex(where: { $0.id == message.id })
        else { return }
        let turns = model.selectedMessages[...index].compactMap { turn -> NativePrivateChatModel.Turn? in
            guard turn.errorDescription == nil, !turn.isPending,
                turn.role == .user || turn.role == .assistant
            else { return nil }
            let content = NativeMessageContent.copyableMarkdown(of: turn.content)
            guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return NativePrivateChatModel.Turn(
                role: turn.role == .user ? .user : .assistant,
                content: content,
                model: turn.model
            )
        }
        guard !turns.isEmpty else { return }
        forkPrivately(turns)
        toast(.success("Forked from message \(index + 1)"))
    }

    /// Copy Link: the web's own address for this message,
    /// `{origin}/chat/{conversation}?m={message}`.
    private func copyLink(to message: NativeChatMessage) {
        var components = URLComponents(url: JunoBackend.productionURL, resolvingAgainstBaseURL: false)
        components?.path = "/chat/\(message.conversationID)"
        components?.queryItems = [URLQueryItem(name: "m", value: message.id)]
        guard let link = components?.url?.absoluteString else {
            toast(.error("Couldn’t copy the link."))
            return
        }
        Self.copyToPasteboard(link)
        toast(.success("Link copied."))
    }

    /// Reads `content` — the words the turn is showing, which may be an
    /// earlier version's — aloud, as this message's playback.
    private func readAloud(_ message: NativeChatMessage, content raw: String) {
        guard let messageActions else { return }
        let content = NativeMessageContent.spoken(of: raw)
        actionError = nil
        Task {
            do {
                let audio = try await messageActions.speech(
                    text: content,
                    voiceID: nil,
                    for: accountID
                )
                try speechPlayback.play(audio: audio, fallbackText: content, messageID: message.id)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    /// Something VoiceOver should hear that has no toast of its own: the end
    /// of a reply, a phase of the run.
    private static func announce(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }
}

/// The web's `rise-in`, applied to a message that has just arrived.
///
/// `rises` is what keeps a scrolled history still. A `LazyVStack` builds a row
/// the moment it comes into view and destroys it again when it leaves, so a
/// transition driven by appearance alone replays for every old message the reader
/// scrolls back to — the row genuinely *is* appearing, it is simply not new. The
/// index gate answers the question appearance cannot.
struct DesktopMessageRise: ViewModifier {
    let rises: Bool
    /// How long to wait before rising, in seconds. The handoff's first bubble
    /// waits a beat, so the greeting is visibly leaving before it arrives.
    var delay: TimeInterval = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var risen: Bool

    /// A row that is not rising starts *already* risen rather than being set
    /// there by `onAppear`. Seeded the other way it spent its first frame at zero
    /// opacity, which on a lazily-built stack means every old message flickers as
    /// the reader scrolls back through the conversation.
    init(rises: Bool, delay: TimeInterval = 0) {
        self.rises = rises
        self.delay = delay
        _risen = State(initialValue: !rises)
    }

    func body(content: Content) -> some View {
        content
            .opacity(risen ? 1 : 0)
            // Under Reduce Motion the travel is dropped and the fade keeps its
            // timing — the tint tier — so a new turn still arrives rather than
            // appearing.
            .offset(y: risen ? 0 : JunoMotion.shift(DesktopChoreography.riseDistance, reduceMotion: reduceMotion))
            .onAppear {
                guard rises else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)?.delay(delay)) {
                    risen = true
                }
            }
    }
}
