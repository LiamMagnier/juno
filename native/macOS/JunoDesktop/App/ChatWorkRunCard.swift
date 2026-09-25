import AppKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

// MARK: - State

/// One decision a task is waiting on, from whichever side raised it — the
/// follower's own type (``NativeConversationWork/Approval``).
typealias ChatWorkApproval = NativeConversationWork.Approval

/// Everything the chat's task card draws, read once from the chat's follower
/// so a snapshot fixture can build the same thing without a network.
struct ChatWorkRunState {
    let session: WorkSessionSummary
    let status: JunoWorkStatus
    let run: WorkRunSummary?
    let events: [WorkEvent]
    /// Every open question, oldest first; the composer answers the first.
    let questions: [WorkQuestionPrompt]
    let approvals: [ChatWorkApproval]
    var isBusy = false
    /// A pinned "now" for fixtures. Nil ticks with the clock.
    var now: Date? = nil
    /// Who is working when it is one of the account's agents: its name
    /// re-voices the status sentence (the web's `statusSentence(status, actor)`).
    var actor: String? = nil
    /// Whether this card's live step may move. One thing on screen owns the
    /// loop: a streaming reply or a working research row outranks it.
    var ownsLoop = true

    var isLive: Bool { !status.isTerminal && status != .draft }
    var plan: [WorkEventLog.PlanStep] { WorkEventLog.plan(from: events) }
    var currentAction: WorkEventLog.CurrentAction? {
        isLive ? WorkEventLog.currentAction(in: events) : nil
    }
    /// The run's own words — Juno's side only, oldest first. A question
    /// still open is left to its question card below rather than printed
    /// twice (register #68).
    var spoken: [WorkEventLog.Turn] {
        let asking = Set(questions.map(\.text))
        return WorkEventLog.turns(in: events).filter { $0.role == .juno && !asking.contains($0.text) }
    }

    /// The follower's task, as the card draws it.
    @MainActor
    static func read(
        _ work: NativeConversationWork, actor: String? = nil, ownsLoop: Bool = true
    ) -> ChatWorkRunState? {
        guard let session = work.current, let status = work.status else { return nil }
        return ChatWorkRunState(
            session: session,
            status: status,
            run: work.run,
            events: work.events,
            questions: work.openQuestions,
            approvals: work.approvals,
            isBusy: work.isBusy,
            actor: actor,
            ownsLoop: ownsLoop
        )
    }
}

/// What the card's controls do. Closures so a fixture can pass nothing.
struct ChatWorkRunActions {
    var decide: (ChatWorkApproval, JunoWorkApprovalDecision) -> Void = { _, _ in }
    /// Answers a question with one of its own options: question id, text.
    var answer: (String, String) -> Void = { _, _ in }
    var focusComposer: () -> Void = {}
    /// The header's Stop. True when the cancel landed; the button keeps its
    /// spinner until the status drops it.
    var stop: (() async -> Bool)? = nil
    var pause: (() -> Void)? = nil
    var resume: (() -> Void)? = nil
    var tryAgain: (() -> Void)? = nil
    /// Opens the Task panel on this task.
    var showDetails: (() -> Void)? = nil
}

// MARK: - Vocabulary

/// The web's words for a task's status (`work-vocabulary.tsx` `STATUS_META`),
/// verbatim. The legacy window's ``DesktopWorkStatusStyle`` drifted from
/// these in five places; the chat speaks the web's.
enum ChatWorkVocabulary {
    static func label(_ status: JunoWorkStatus) -> String {
        switch status {
        case .draft: "Draft"
        case .queued: "Queued"
        case .preparing: "Preparing"
        case .running: "Running"
        case .waitingInput: "Needs an answer"
        case .waitingApproval: "Needs approval"
        case .paused: "Paused"
        case .completed: "Done"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .interrupted: "Interrupted"
        case .hostOffline: "Mac unreachable"
        case .budgetExceeded: "Out of budget"
        case .timedOut: "Timed out"
        }
    }

    static func sentence(_ status: JunoWorkStatus) -> String {
        switch status {
        case .draft:
            "This task has been written but never started, so nothing is running and nothing is queued."
        case .queued: "Waiting to be picked up. Nothing is running yet."
        case .preparing: "Fetching inputs, resolving permissions and starting up."
        case .running: "Juno is working on this now."
        case .waitingInput: "Juno has asked you something and cannot continue until you answer."
        case .waitingApproval: "Juno is waiting for you to allow or refuse an action."
        case .paused: "You stopped this. It can be resumed."
        case .completed: "This finished."
        case .failed: "This stopped before it finished."
        case .cancelled:
            "This was stopped rather than finished, and it will not be picked up where it left off."
        case .interrupted:
            "The executor stopped reporting and its lease expired. Juno does not restart an interrupted run on its own, because it may already have changed something."
        case .hostOffline:
            "This had to run on a Mac and none was reachable, so it did not start. Wake the Mac and run it again."
        case .budgetExceeded:
            "This stopped because it reached the budget it was running under. The detail on the attempt says which ceiling it was, and when it frees up."
        case .timedOut: "This ran for longer than its time limit allowed and was stopped."
        }
    }

    /// The web's `statusSentence(status, actor)`: only a sentence that opens
    /// with "Juno " is re-voiced with the agent's name.
    static func sentence(_ status: JunoWorkStatus, actor: String?) -> String {
        let sentence = sentence(status)
        guard let actor, !actor.isEmpty, sentence.hasPrefix("Juno ") else { return sentence }
        return actor + sentence.dropFirst("Juno".count)
    }

    /// Where Try Again is offered: an end that was not the task finishing.
    static func canTryAgain(_ status: JunoWorkStatus) -> Bool {
        switch status {
        case .failed, .cancelled, .interrupted, .timedOut, .hostOffline: true
        default: false
        }
    }
}

/// The web's number formats for a run (`work-vocabulary.tsx`, `lib/utils.ts`).
enum ChatWorkFormat {
    /// `formatDuration`: "240ms", "42s", "4m 12s", "1h 5m".
    static func duration(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0s" }
        if seconds < 1 { return "\(Int((seconds * 1_000).rounded()))ms" }
        let whole = Int(seconds.rounded())
        if whole < 60 { return "\(whole)s" }
        let minutes = whole / 60
        if minutes < 60 { return "\(minutes)m \(whole % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    /// `formatMicroUsd`: "$0.00", "$0.42".
    static func cost(microUsd: Int) -> String {
        guard microUsd > 0 else { return "$0.00" }
        return String(format: "$%.2f", Double(microUsd) / 1_000_000)
    }

    /// `formatTokens`: "940", "1.2K", "34K", "1.20M".
    static func tokens(_ count: Int) -> String {
        guard count > 0 else { return "0" }
        if count < 1_000 { return "\(count)" }
        if count < 1_000_000 {
            return String(format: count < 10_000 ? "%.1fK" : "%.0fK", Double(count) / 1_000)
        }
        return String(format: "%.2fM", Double(count) / 1_000_000)
    }

    /// `workTimeAgo`: "just now", "2m ago", "3h ago", "yesterday", "4d ago".
    static func ago(_ date: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days == 1 { return "yesterday" }
        if days < 30 { return "\(days)d ago" }
        let months = days / 30
        return months < 12 ? "\(months)mo ago" : "\(months / 12)y ago"
    }

    /// How long the run has been going, or went.
    static func elapsed(_ run: WorkRunSummary, now: Date) -> TimeInterval {
        guard let started = run.startedAt else { return 0 }
        return max(0, (run.finishedAt ?? now).timeIntervalSince(started))
    }
}

// MARK: - Placement

/// Where a task sits in its chat: the web's `MessageList` rule. After the
/// assistant reply that follows the last user message created at or before
/// the task was composed; with no such message, at the transcript's foot.
enum ChatWorkPlacement {
    struct Turn: Equatable {
        let id: String
        let isUser: Bool
        let createdAt: Date
    }

    /// The id of the message the task follows, or nil for the foot.
    static func anchor(for createdAt: Date, in turns: [Turn]) -> String? {
        var index = -1
        for (offset, turn) in turns.enumerated() where turn.isUser && turn.createdAt <= createdAt {
            index = offset
        }
        guard index >= 0 else { return nil }
        if index + 1 < turns.count, !turns[index + 1].isUser { index += 1 }
        return turns[index].id
    }
}

/// One task in the transcript: the one followed live draws the card, each
/// earlier one a settled row (register #53).
struct ChatWorkRunEntry: Identifiable, Equatable {
    let session: WorkSessionSummary
    let status: JunoWorkStatus
    let isCurrent: Bool
    var id: String { session.sessionID }
    var createdAt: Date { session.createdAt ?? session.lastActivityAt }
}

// MARK: - Card

/// The task the model started, inside the chat that started it (the web's
/// `WorkRunPanel`, spec §6.8 as amended by the Phase 5 brief A5).
///
/// Opaque and flat: `junoCard`, a hairline, radius 20 and an 8pt inset, so the
/// tiles inside sit at 12 on the same centre. Text sits 16 from the edge, the
/// product's one gutter. The only coral is the live dot on the status pill.
///
/// **Signature detail:** the live step is drawn with the same run signature a
/// reply's run line uses, so a task's step and a reply's thought speak one
/// language — and only one of them moves at a time (``ChatWorkRunState/ownsLoop``).
struct ChatWorkRunCard: View {
    let state: ChatWorkRunState
    var actions = ChatWorkRunActions()

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    private var title: String {
        let title = state.session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? state.session.goal : title
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, JunoSpace.snug)
                .padding(.top, JunoSpace.hairline)
                .padding(.bottom, JunoSpace.snug)
            Group {
                if state.isLive { live } else { finished }
            }
            .id(state.isLive)
            .transition(.opacity)
        }
        .padding(JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
        )
        .containerShape(.rect(cornerRadius: JunoRadius.panel))
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: state.isLive)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: reduceMotion))
        .onAppear {
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)) { appeared = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task: \(title)")
        .accessibilityIdentifier("juno.chat.work-card")
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.task, size: 14)
                    Text("Task")
                }
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityHidden(true)
                Text(title)
                    .junoFont(size: 15, relativeTo: .body, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        ChatWorkStatusPill(status: state.status)
                        statusSentence
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        ChatWorkStatusPill(status: state.status)
                        statusSentence
                    }
                }
                .padding(.top, JunoSpace.micro)
                .id(state.status)
                .transition(.opacity)
            }
            Spacer(minLength: JunoSpace.snug)
            HStack(spacing: JunoSpace.hairline) {
                if state.isLive, let stop = actions.stop {
                    ChatWorkStopButton(stop: stop)
                        .transition(.opacity)
                }
                overflow
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: state.status)
    }

    private var statusSentence: some View {
        Text(ChatWorkVocabulary.sentence(state.status, actor: state.actor))
            .junoFont(size: 13, relativeTo: .callout)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var overflow: some View {
        let canResume = state.status == .paused && actions.resume != nil
        let canPause = state.isLive && state.status != .paused && actions.pause != nil
        let canRetry = ChatWorkVocabulary.canTryAgain(state.status) && actions.tryAgain != nil
        if canResume || canPause || canRetry || actions.showDetails != nil {
            Menu {
                if canResume, let resume = actions.resume {
                    Button("Resume", action: resume)
                } else if canPause, let pause = actions.pause {
                    Button("Pause", action: pause)
                }
                if canRetry, let tryAgain = actions.tryAgain {
                    Button("Try Again", action: tryAgain)
                }
                if let showDetails = actions.showDetails {
                    if canResume || canPause || canRetry { Divider() }
                    Button("Show Details", action: showDetails)
                }
            } label: {
                JunoIconView(.more, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(state.isBusy)
            .help("More")
            .accessibilityLabel("More")
            .accessibilityIdentifier("juno.chat.work-card.more")
        }
    }

    // MARK: Live

    private var live: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let action = state.currentAction {
                ChatWorkCurrentAction(action: action, loops: state.ownsLoop, now: state.now)
            }
            let steps = state.plan
            if !steps.isEmpty {
                ChatWorkPlan(steps: steps)
                    .padding(.horizontal, JunoSpace.snug)
            }
            if let run = state.run {
                ChatWorkMeter(run: run, now: state.now)
                    .padding(.horizontal, JunoSpace.snug)
            }
            ChatWorkRunWords(spoken: state.spoken)
                .padding(.horizontal, JunoSpace.snug)
            if !state.questions.isEmpty || !state.approvals.isEmpty {
                needsYou
            }
        }
    }

    private var needsYou: some View {
        VStack(alignment: .leading, spacing: JunoSpace.close) {
            ForEach(Array(state.questions.enumerated()), id: \.element.id) { index, question in
                ChatWorkQuestionCard(
                    question: question,
                    isCurrent: index == 0,
                    isBusy: state.isBusy,
                    now: state.now,
                    answer: { text in actions.answer(question.questionID, text) },
                    replyBelow: actions.focusComposer
                )
            }
            ForEach(state.approvals) { approval in
                ChatWorkApprovalCard(
                    approval: approval.request,
                    isBusy: state.isBusy,
                    decide: { actions.decide(approval, $0) }
                )
            }
        }
    }

    // MARK: Finished (the slice's, until Stage B)

    @ViewBuilder
    private var finished: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let reason = JunoWorkVocabulary.terminalReason(state.run?.terminalReason),
                state.status != .completed
            {
                Text(reason)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoWarningInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let run = state.run {
                ForEach(Array(run.degradation.enumerated()), id: \.offset) { _, note in
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                        JunoIconView(.warning, size: 12)
                        Text(note.explanation)
                            .junoFont(size: 13, relativeTo: .callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(Color.junoWarningInk)
                }
            }
            ChatWorkRunWords(spoken: state.spoken)
            if let run = state.run {
                ChatWorkMeter(run: run, now: state.now)
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.bottom, JunoSpace.hairline)
    }
}

// MARK: - Stop

/// The card's own Stop (the web's `StopButton`): outlined, the composer's stop
/// face beside the word, and a spinner from the press until the header drops
/// the button — a cancel lands a moment before the stream reports it, and a
/// button that came back to life in that gap would read as a stop that did
/// not take. A refusal (said in a toast) gives it back.
struct ChatWorkStopButton: View {
    let stop: () async -> Bool
    @State private var stopping = false

    var body: some View {
        Button {
            stopping = true
            Task {
                if await stop() == false { stopping = false }
            }
        } label: {
            HStack(spacing: JunoSpace.tight) {
                if stopping {
                    ProgressView().controlSize(.mini)
                } else {
                    JunoIconView(.stop, size: 10, weight: .fill)
                }
                Text("Stop")
            }
            .frame(minHeight: 20)
            .contentShape(.rect)
        }
        .buttonStyle(.bordered)
        .tint(nil)
        .controlSize(.small)
        .frame(minHeight: 28)
        .disabled(stopping)
        .help("Stop the task")
        .accessibilityLabel("Stop the task")
        .accessibilityIdentifier("juno.chat.work-card.stop")
    }
}

// MARK: - Current action

/// What the run is doing now (register #55): a neutral tile led by the chat's
/// run signature, never the web's coral one. The title is announced when it
/// changes; the duration ticks in mono beside the detail.
struct ChatWorkCurrentAction: View {
    let action: WorkEventLog.CurrentAction
    var loops = true
    var now: Date? = nil

    private var title: String {
        if let title = action.title { return title }
        switch action.kind {
        case .tool: return DesktopWorkVocabulary.toolPresent(action.tool)
        case .step: return "Working"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.close) {
            JunoRunSignature(phase: action.kind == .tool ? .tool : .thinking, loops: loops)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(title)
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    if let detail = action.detail {
                        Text(detail)
                            .junoFont(size: 11, relativeTo: .caption)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if let now {
                        duration(at: now)
                    } else {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            duration(at: context.date)
                        }
                    }
                }
                .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
        .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.chat.work-card.action")
        .onChange(of: title) { _, title in
            AccessibilityNotification.Announcement(title).post()
        }
    }

    private func duration(at date: Date) -> some View {
        Text(ChatWorkFormat.duration(max(0, date.timeIntervalSince(action.startedAt))))
            .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
            .monospacedDigit()
            .fixedSize()
    }
}

// MARK: - Plan

/// The plan as a list being crossed off (the web's `WorkProgressChecklist`):
/// a filled check and a strike for done, plain for ahead, the active step in
/// full ink with a still ring. No progress bar — the tally says how far.
struct ChatWorkPlan: View {
    let steps: [WorkEventLog.PlanStep]

    var body: some View {
        let tally = WorkEventLog.tally(steps)
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Plan")
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("\(tally.done)/\(tally.total)")
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .monospacedDigit()
                    .accessibilityLabel("\(tally.done) of \(tally.total) steps done")
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ForEach(steps) { step in
                    row(step)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.chat.work-card.plan")
    }

    private func row(_ step: WorkEventLog.PlanStep) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            ChatWorkStepMark(state: step.state)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
            Text(step.title)
                .junoFont(size: 13, relativeTo: .callout, weight: step.state == .active ? .medium : .regular)
                .foregroundStyle(ink(step.state))
                .strikethrough(step.state == .done || step.state == .skipped, color: Color.junoBorder)
                .fixedSize(horizontal: false, vertical: true)
            if step.state == .unreported {
                Text("never finished")
                    .junoFont(size: 11, relativeTo: .caption)
                    .foregroundStyle(Color.junoWarningInk)
                    .fixedSize()
            }
        }
        .frame(minHeight: 18, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(step.title), \(Self.spoken(step.state))")
    }

    private func ink(_ state: WorkEventLog.StepState) -> Color {
        switch state {
        case .done, .skipped, .unreported: Color.junoSecondaryInk
        case .pending: Color.junoForeground.opacity(0.8)
        case .active, .failed: Color.junoForeground
        }
    }

    static func spoken(_ state: WorkEventLog.StepState) -> String {
        switch state {
        case .pending: "not started"
        case .active: "in progress"
        case .done: "done"
        case .skipped: "skipped"
        case .failed: "failed"
        case .unreported: "never finished"
        }
    }
}

/// A plan step's 14pt mark. Neutral ink for done (register #55): coral is not
/// a step colour. Under Differentiate Without Color every state keeps a
/// distinct shape.
struct ChatWorkStepMark: View {
    let state: WorkEventLog.StepState

    var body: some View {
        ZStack {
            switch state {
            case .done:
                Circle().fill(Color.junoForeground)
                JunoIconView(.check, size: 9, weight: .bold)
                    .foregroundStyle(Color.junoCard)
            case .active:
                JunoRunMarker(.running, loops: false)
            case .pending:
                Circle().strokeBorder(Color.junoBorder, lineWidth: 1)
            case .skipped:
                JunoIconView(.minus, size: 11)
                    .foregroundStyle(Color.junoSecondaryInk)
            case .failed:
                Circle().fill(Color.junoDestructive)
                JunoIconView(.close, size: 8, weight: .bold)
                    .foregroundStyle(Color.junoCard)
            case .unreported:
                Circle().strokeBorder(Color.junoWarning, style: StrokeStyle(lineWidth: 1.2, dash: [2, 2]))
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
    }
}

// MARK: - Meter

/// Elapsed · Cost · Tokens (the web's `WorkLiveMeter`), from the run only —
/// never a figure the server did not send.
struct ChatWorkMeter: View {
    let run: WorkRunSummary
    var now: Date? = nil

    var body: some View {
        if run.finishedAt == nil, now == nil, run.startedAt != nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                row(at: context.date)
            }
        } else {
            row(at: now ?? Date())
        }
    }

    private func row(at date: Date) -> some View {
        HStack(spacing: JunoSpace.regular) {
            item(.timer, "Elapsed", ChatWorkFormat.duration(ChatWorkFormat.elapsed(run, now: date)))
            item(.coins, "Cost", ChatWorkFormat.cost(microUsd: run.costMicroUsd))
            item(.sigma, "Tokens", ChatWorkFormat.tokens(run.totalTokens))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.chat.work-card.meter")
    }

    private func item(_ icon: JunoIcon, _ label: String, _ value: String) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(icon, size: 12)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(value)
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoSecondaryInk)
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(value)")
    }
}

// MARK: - The run's words

/// What the task said while it worked: the newest three in the reading rung,
/// anything older folded behind "Earlier updates" (the web's `RunWords`).
struct ChatWorkRunWords: View {
    let spoken: [WorkEventLog.Turn]
    @State private var showsEarlier = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let latest = Array(spoken.suffix(3))
        let earlier = Array(spoken.dropLast(3))
        if !latest.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                if !earlier.isEmpty {
                    Button {
                        withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                            showsEarlier.toggle()
                        }
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            JunoIconView(.chevronRight, size: 11)
                                .rotationEffect(.degrees(showsEarlier ? 90 : 0))
                                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: showsEarlier)
                            Text("Earlier updates")
                            Text("\(earlier.count)")
                                .monospacedDigit()
                        }
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(showsEarlier ? "Expanded" : "Collapsed")
                    if showsEarlier {
                        ForEach(earlier) { turn in
                            words(turn.text)
                        }
                        .transition(.opacity)
                    }
                }
                ForEach(latest) { turn in
                    words(turn.text)
                }
            }
        }
    }

    private func words(_ text: String) -> some View {
        JunoMarkdownText(text)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Status pill

/// A 20pt capsule: the tone at 12% with its own ink, except a live run's,
/// which stays neutral and lets its dot be the one coral thing on the card.
struct ChatWorkStatusPill: View {
    let status: JunoWorkStatus

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    private var isLive: Bool { status == .running || status == .preparing }

    var body: some View {
        let style = DesktopWorkStatusStyle.of(status)
        let tone = isLive ? Color.junoMutedForeground : style.tint
        let label = ChatWorkVocabulary.label(status)
        HStack(spacing: JunoSpace.tight) {
            Circle()
                .fill(isLive ? Color.junoAccent : tone)
                .frame(width: 6, height: 6)
                .opacity(isLive && breathing ? 0.35 : 1)
                .animation(
                    isLive
                        ? JunoMotion.ambient(JunoMotion.breathe(period: JunoMotion.Loop.statusBreathe), when: reduceMotion)
                        : nil,
                    value: breathing
                )
                .onAppear { if isLive { breathing = true } }
            Text(label)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(isLive ? Color.junoForeground : tone)
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 20)
        .background(Capsule(style: .continuous).fill(tone.opacity(0.12)))
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

// MARK: - Settled row

/// An earlier task of this chat (register #53): the resting research row's
/// twin, so a chat's two kinds of background work read alike. One 36pt line at
/// the reading measure — the task glyph, the title, its status, and "Open ›"
/// to the Task panel, which reads it once rather than following it. No card,
/// no fill: a row in the transcript.
struct ChatWorkSettledRow: View {
    let session: WorkSessionSummary
    let status: JunoWorkStatus
    let open: () -> Void

    private var title: String {
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? session.goal : title
    }

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.task, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityHidden(true)
            Text(title)
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .truncationMode(.tail)
            ChatWorkStatusPill(status: status)
            Spacer(minLength: JunoSpace.snug)
            Button(action: open) {
                HStack(spacing: JunoSpace.micro) {
                    Text("Open")
                    JunoIconView(.chevronRight, size: 10)
                }
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(minWidth: 28, minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .help("Open the task")
            .accessibilityLabel("Open the task")
        }
        .frame(minHeight: 36)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task: \(title), \(ChatWorkVocabulary.label(status))")
        .accessibilityIdentifier("juno.chat.work-row")
    }
}

// MARK: - Question

/// A question the run has stopped on (the web's `WorkQuestionCard`): the
/// question, why it asks, its one-press replies, and "Reply below" to the
/// composer — which is in answer mode for exactly this question. A second
/// open question waits its turn.
struct ChatWorkQuestionCard: View {
    let question: WorkQuestionPrompt
    var isCurrent = true
    var isBusy = false
    var now: Date? = nil
    let answer: (String) -> Void
    let replyBelow: () -> Void

    private var asked: String {
        guard let askedAt = question.askedAt else { return "Waiting on you" }
        return "Waiting on you \u{00B7} asked \(ChatWorkFormat.ago(askedAt, now: now ?? Date()))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(asked)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoWarningInk)
            Text(question.text.isEmpty ? "Juno has a question for you." : question.text)
                .junoFont(size: 15, relativeTo: .body)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let why = question.why {
                Text(why)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !question.options.isEmpty {
                JunoChipFlow(spacing: JunoSpace.tight) {
                    ForEach(question.options, id: \.self) { option in
                        Button(option) { answer(option) }
                            .buttonStyle(.bordered)
                            .tint(nil)
                            .frame(minHeight: 28)
                            .contentShape(.rect)
                            .accessibilityIdentifier("juno.chat.work-card.option")
                    }
                }
                .disabled(isBusy)
            }
            if isCurrent {
                Button(action: replyBelow) {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.arrowDown, size: 12)
                        Text("Reply below")
                    }
                    .frame(minHeight: 20)
                    .contentShape(.rect)
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .controlSize(.small)
                .frame(minHeight: 28)
                .help("Reply in the message box below")
                .accessibilityLabel("Reply in the message box below")
            } else {
                Text("Answer the question above it first; this one is next.")
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoSecondary, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoWarning.opacity(0.45), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.chat.work-card.question")
    }
}

// MARK: - Approval (the slice's, until Stage B)

/// A task's approval (§6.9): the risk in its tone, the stored sentence, then
/// "Don't" first and the action's own verb last. Nothing is bound to
/// `.defaultAction`, so Return never approves. A run on this Mac is answered
/// in-process, because only its coordinator can.
struct ChatWorkApprovalCard: View {
    let approval: WorkApprovalRequest
    var isBusy = false
    let decide: (JunoWorkApprovalDecision) -> Void

    private var tint: Color { DesktopWorkVocabulary.riskTint(approval.risk) }
    private var verb: String { Self.verb(for: approval.action) }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.snug) {
                Text(DesktopWorkVocabulary.risk(approval.risk))
                    .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(tint)
                Text(DesktopWorkVocabulary.action(approval.action))
                    .junoCaption()
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                Text(timerInterval: Date()...max(Date(), approval.expiresAt), countsDown: true)
                    .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoMutedForeground)
                    .monospacedDigit()
                    .fixedSize()
            }
            Text(approval.summary)
                .junoFont(size: 15, relativeTo: .body, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: JunoSpace.snug) {
                Button("Don\u{2019}t", role: .destructive) { decide(.denied) }
                    .buttonStyle(.bordered)
                    .contentShape(.rect)
                    .accessibilityIdentifier("juno.work.approval.deny")
                Button(verb) { decide(.allowed) }
                    .buttonStyle(.junoProminent)
                    .contentShape(.rect)
                    .accessibilityIdentifier("juno.work.approval.allow")
                if approval.allowsStandingGrant {
                    Menu("More") {
                        Button("\(verb), and Stop Asking") { decide(.allowedAlways) }
                    }
                    .menuStyle(.button)
                    .buttonStyle(.bordered)
                    .contentShape(.rect)
                    .fixedSize()
                    .accessibilityIdentifier("juno.work.approval.more")
                }
                Spacer(minLength: 0)
            }
            .controlSize(.regular)
            .disabled(isBusy)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.junoCard,
            in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(tint.opacity(0.55), lineWidth: 1)
        )
        .accessibilityIdentifier("juno.work.approval")
    }

    /// The verb on the approving button: what pressing it does.
    static func verb(for action: String) -> String {
        let name = action.lowercased()
        if name.contains("permanently_delete") { return "Delete for Good" }
        if name.contains("send") { return "Send" }
        if name.contains("post") || name.contains("publish") { return "Post" }
        if name.contains("delete") || name.contains("trash") { return "Delete" }
        if name == "apply_changes" { return "Make the Changes" }
        return "Go Ahead"
    }
}
