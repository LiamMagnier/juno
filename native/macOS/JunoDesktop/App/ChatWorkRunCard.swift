import AppKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

// MARK: - State

/// One decision a task is waiting on, from whichever side raised it.
///
/// Two sources, because there are two executors and only one of them writes a
/// `WorkApproval` row: a cloud run's question arrives in
/// `NativeWorkModel.pendingApprovals`, while a run executing on this Mac
/// suspends inside `WorkApprovalCoordinator` in this process and only this
/// Mac can answer it (`DesktopWorkHostModel.localApprovals`).
struct ChatWorkApproval: Identifiable {
    let request: WorkApprovalRequest
    let isLocal: Bool
    var id: String { request.id }
}

/// Everything the chat's run card draws, read once from the models so a
/// snapshot fixture can build the same thing without a network.
struct ChatWorkRunState {
    let session: WorkSessionSummary
    let status: JunoWorkStatus
    let run: WorkRunSummary?
    let events: [WorkEvent]
    let question: WorkQuestionPrompt?
    let approvals: [ChatWorkApproval]
    var isBusy = false
    /// "Now", for the elapsed time. Pinned by fixtures.
    var now = Date()

    /// Local first: if both sides name a question for this run, the local
    /// coordinator is the one holding a suspended tool.
    @MainActor
    static func read(
        _ model: NativeWorkModel, host: DesktopWorkHostModel?, session: WorkSessionSummary
    ) -> ChatWorkRunState? {
        guard model.openSession?.sessionID == session.sessionID else { return nil }
        let runID = model.openRun?.runID ?? session.currentRunID
        let local = (host?.localApprovals(forRun: runID) ?? []).map {
            ChatWorkApproval(request: $0, isLocal: true)
        }
        let localIDs = Set(local.map(\.id))
        let remote = model.pendingApprovals
            .filter { $0.isPending && !localIDs.contains($0.id) }
            .map { ChatWorkApproval(request: $0, isLocal: false) }
        return ChatWorkRunState(
            session: model.openSession ?? session,
            status: model.displayStatus(of: model.openSession ?? session),
            run: model.openRun,
            events: model.events,
            question: model.pendingQuestion,
            approvals: local + remote,
            isBusy: model.isMutating
        )
    }

    var isLive: Bool { !status.isTerminal && status != .draft }
}

/// What the card's buttons do. Closures so the fixtures can pass nothing.
struct ChatWorkRunActions {
    var decide: (ChatWorkApproval, JunoWorkApprovalDecision) -> Void = { _, _ in }
    var answer: (String) -> Void = { _ in }
    var focusComposer: () -> Void = {}
    var pause: (() -> Void)? = nil
    var resume: (() -> Void)? = nil
}

// MARK: - Card

/// The task a chat started, inline in its transcript (§6.8, Work card).
///
/// Opaque, one shared recipe with the artifact card: `junoCard` fill, a
/// hairline, radius 20, no shadow, no tint and no glass. The only coral is
/// the live dot. Live, it shows the current action, the plan, one metrics
/// line, the run's last three turns, and whatever it is waiting on — a
/// question with one-press answers, or the approval queue (§6.9). Finished,
/// it shows the outcome. Stop is the composer's disc.
struct ChatWorkRunCard: View {
    let state: ChatWorkRunState
    var actions = ChatWorkRunActions()

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            header
            if state.isLive { live } else { finished }
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
        )
        .containerShape(.rect(cornerRadius: JunoRadius.panel))
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: reduceMotion))
        .onAppear {
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)) { appeared = true }
        }
        .padding(.vertical, JunoSpace.cozy)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.chat.work-card")
    }

    // MARK: Header

    private var header: some View {
        let style = DesktopWorkStatusStyle.of(state.status)
        return VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.task, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text(title)
                    .junoFont(size: 13, relativeTo: .body, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(2)
                Spacer(minLength: JunoSpace.snug)
                ChatWorkStatusPill(status: state.status)
                overflow
            }
            .frame(minHeight: 36)
            Text(style.sentence)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var title: String {
        let title = state.session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? state.session.goal : title
    }

    @ViewBuilder
    private var overflow: some View {
        let canResume = state.status == .paused && actions.resume != nil
        let canPause = state.isLive && state.status != .paused && actions.pause != nil
        if canResume || canPause {
            Menu {
                if state.status == .paused, let resume = actions.resume {
                    Button("Resume", action: resume)
                } else if state.isLive, let pause = actions.pause {
                    Button("Pause", action: pause)
                }
            } label: {
                JunoIconView(.more, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.hidden)
            .contentShape(.rect)
            .fixedSize()
            .help("More")
            .accessibilityLabel("More")
        }
    }

    // MARK: Live

    @ViewBuilder
    private var live: some View {
        // Only while it is actually working: a run waiting on the reader is
        // doing nothing, and a spinner would say otherwise.
        if state.status == .running || state.status == .preparing,
            let action = DesktopWorkLog.currentAction(in: state.events)
        {
            HStack(spacing: JunoSpace.cozy) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 1) {
                    Text(action.title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .lineLimit(1)
                    if let detail = action.detail {
                        Text(detail)
                            .junoCaption()
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .background(
                Color.junoSecondary,
                in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
            )
            .accessibilityIdentifier("juno.chat.work-card.action")
        }
        plan
        metrics
        turns
        if let question = state.question {
            ChatWorkQuestionCard(
                question: question, isBusy: state.isBusy,
                answer: actions.answer, replyBelow: actions.focusComposer
            )
        }
        if !state.approvals.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(state.approvals) { approval in
                    ChatWorkApprovalCard(
                        approval: approval.request,
                        isBusy: state.isBusy,
                        decide: { actions.decide(approval, $0) }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var plan: some View {
        let steps = DesktopWorkLog.plan(from: state.events)
        if !steps.isEmpty {
            let done = steps.filter { $0.state == .done || $0.state == .skipped }.count
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.snug) {
                    Text("Plan")
                        .junoFont(size: 13, relativeTo: .body, weight: .medium)
                    Text("\(done)/\(steps.count)")
                        .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                        .foregroundStyle(Color.junoMutedForeground)
                        .monospacedDigit()
                }
                ProgressView(value: Double(done), total: Double(steps.count))
                    .progressViewStyle(.linear)
                    .tint(Color.junoForeground.opacity(0.55))
                    .accessibilityLabel("\(done) of \(steps.count) steps done")
                ForEach(steps) { step in
                    HStack(alignment: .top, spacing: JunoSpace.snug) {
                        JunoIconView(step.icon, size: 14)
                            .foregroundStyle(step.state == .active ? Color.junoForeground : step.tint)
                            .frame(width: 16, height: 16)
                            .padding(.top, 1)
                        Text(step.title)
                            .junoRowLabel()
                            .foregroundStyle(
                                step.state == .active ? Color.junoForeground : Color.junoMutedForeground
                            )
                            .fontWeight(step.state == .active ? .medium : .regular)
                            .strikethrough(step.state == .done || step.state == .skipped)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .accessibilityIdentifier("juno.chat.work-card.plan")
        }
    }

    @ViewBuilder
    private var metrics: some View {
        if let run = state.run {
            Text(Self.metricsLine(run: run, now: state.now))
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoMutedForeground)
                .monospacedDigit()
        }
    }

    /// Elapsed · spent, the web's `WorkLiveMeter` on one line.
    static func metricsLine(run: WorkRunSummary, now: Date) -> String {
        let seconds = run.startedAt.map { max(0, Int((run.finishedAt ?? now).timeIntervalSince($0))) } ?? 0
        let elapsed = seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
        let cost = String(format: "$%.2f", Double(run.costMicroUsd) / 1_000_000)
        return "\(elapsed) \u{00B7} \(cost)"
    }

    @ViewBuilder
    private var turns: some View {
        let words = DesktopWorkLog.turns(in: state.events).filter { $0.role == .juno }.suffix(3)
        if !words.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(Array(words)) { turn in
                    JunoMarkdownText(turn.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    // MARK: Finished

    @ViewBuilder
    private var finished: some View {
        if let reason = JunoWorkVocabulary.terminalReason(state.run?.terminalReason),
            state.status != .completed
        {
            Text(reason)
                .junoCaption()
                .foregroundStyle(Color.junoCaution)
        }
        if let run = state.run {
            ForEach(Array(run.degradation.enumerated()), id: \.offset) { _, note in
                HStack(alignment: .top, spacing: JunoSpace.tight) {
                    JunoIconView(.warning, size: 12)
                    Text(note.explanation)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(Color.junoCaution)
            }
        }
        if let answer = DesktopWorkLog.finalAnswer(in: state.events) {
            JunoMarkdownText(answer)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("juno.chat.work-card.result")
        }
        metrics
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
            Text(style.label)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(isLive ? Color.junoForeground : tone)
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 20)
        .background(Capsule(style: .continuous).fill(tone.opacity(0.12)))
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(style.label)
        .help(style.sentence)
    }
}

// MARK: - Question

/// A question the run has stopped on, answerable in one press when it offered
/// replies, or in the composer ("Reply Below").
struct ChatWorkQuestionCard: View {
    let question: WorkQuestionPrompt
    var isBusy = false
    let answer: (String) -> Void
    let replyBelow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("Waiting on you")
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoCaution)
            Text(question.text.isEmpty ? "Juno has a question for you." : question.text)
                .junoBody()
                .junoInk()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let why = question.why {
                Text(why)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
            JunoChipFlow(spacing: JunoSpace.snug) {
                ForEach(question.options, id: \.self) { option in
                    Button(option) { answer(option) }
                        .buttonStyle(.bordered)
                        .contentShape(.rect)
                        .accessibilityIdentifier("juno.chat.work-card.option")
                }
                Button {
                    replyBelow()
                } label: {
                    JunoIconLabel("Reply Below", icon: .arrowDown, size: 12)
                }
                .buttonStyle(.borderless)
                .contentShape(.rect)
                .help("Reply in the message box below")
            }
            .controlSize(.regular)
            .disabled(isBusy)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.junoSecondary,
            in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoCaution.opacity(0.45), lineWidth: 1)
        )
        .accessibilityIdentifier("juno.chat.work-card.question")
    }
}

// MARK: - Approval

/// A task's approval (§6.9): the risk in its tone, the stored sentence, then
/// "Don't" first and the action's own verb last. Nothing is bound to
/// `.defaultAction`, so Return never approves. A run on this Mac is answered
/// in-process (`decideLocally`), because only its coordinator can.
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
                    .buttonStyle(.borderedProminent)
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
            in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
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
