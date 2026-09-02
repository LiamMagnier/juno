import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The scrolling record of what the agent did — the centre of gravity of the
/// product. Everything else in the window is reference material that serves this
/// one column.
///
/// Opaque, always. Long-form prose over glass loses contrast as the window moves,
/// and a transcript is the longest-form thing in the app; the composer floating
/// over it is what carries the material.
public struct TranscriptView: View {
    let controller: SessionController
    /// Model identifiers are opaque outside the workbench, so the display names
    /// come in from the caller that knows them.
    let modelDisplayNames: [String: String]
    var focus: FocusState<Bool>.Binding?

    /// The auto-scroll below is the only motion this view owns, and it is
    /// travel — the transcript is the largest moving surface in the window, so
    /// it is exactly the kind of animation Reduce Motion exists for. Nothing in
    /// this file read the setting before.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The transcript shares a measure with the composer. Long-form prose still
    /// needs a readable line length, but the old 720pt column left the task
    /// visually detached from a wide desktop window and from the controls below.
    static let measure: CGFloat = CodeSessionLayout.measure

    /// Whether the reader is still at the end of the record.
    ///
    /// **Auto-scroll only happens while this is true.** A transcript that
    /// scrolls itself while the reader is 400 lines up reading a tool result is
    /// not being helpful; it is taking the window away from them, and during a
    /// long run it does so every few hundred milliseconds. Once they scroll up
    /// the transcript freezes, and "Jump to latest" is how they come back —
    /// which is also the only honest way to say "there is more below", because
    /// the alternative is a view that silently disagrees with where they are
    /// looking.
    @State private var isPinnedToBottom = true
    /// Geometry can report a provisional offset while LazyVStack is still
    /// mounting the tail. Do not interpret that first layout as an intentional
    /// reader scroll; the initial positioning task owns the first pass.
    @State private var hasCompletedInitialPositioning = false

    /// How close to the end still counts as being at the end. A line's height,
    /// roughly: a reader one pixel off the bottom has not chosen to leave.
    private static let pinThreshold: CGFloat = 24

    public init(
        controller: SessionController,
        modelDisplayNames: [String: String] = [:],
        focus: FocusState<Bool>.Binding? = nil
    ) {
        self.controller = controller
        self.modelDisplayNames = modelDisplayNames
        self.focus = focus
    }

    public var body: some View {
        // Both derivations walk the whole event list, so they are computed once
        // per pass rather than once per use.
        let events = visibleEvents
        let rowContext = context
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
                    if events.isEmpty {
                        PreRunSuggestions(controller: controller, focus: focus)
                    } else {
                        ForEach(events) { event in
                            TranscriptRow(event: event, context: rowContext)
                                .id(event.id)
                        }
                    }
                    // The live tail is its own view so that a token arriving
                    // invalidates only the tail, not the whole event list.
                    TranscriptTail(
                        controller: controller,
                        proxy: proxy,
                        isPinnedToBottom: isPinnedToBottom
                    )
                }
                .padding(.horizontal, JunoSpace.snug)
                .padding(.top, JunoSpace.section)
                .padding(.bottom, JunoSpace.regular)
                .frame(maxWidth: Self.measure, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, CodeSessionLayout.inset)
            }
            .environment(\.codeModelDisplayNames, modelDisplayNames)
            .task(id: controller.sessionID) {
                // A reopened task should land on its latest evidence. Without
                // an explicit first-layout scroll, LazyVStack reports its
                // initial geometry before the tail exists and the surface opens
                // at the top with a misleading "Jump to latest" affordance.
                hasCompletedInitialPositioning = false
                isPinnedToBottom = true
                await Task.yield()
                guard !Task.isCancelled else { return }
                // Give the scroll view one layout pass to resolve the tail
                // before asking ScrollViewReader to position it. Calling
                // `scrollTo` before that pass is a no-op when LazyVStack has
                // not mounted the tail yet.
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
                proxy.scrollTo(TranscriptTail.id, anchor: .bottom)
                await Task.yield()
                guard !Task.isCancelled else { return }
                hasCompletedInitialPositioning = true
                isPinnedToBottom = true
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - Self.pinThreshold
            } action: { _, pinned in
                guard hasCompletedInitialPositioning else { return }
                isPinnedToBottom = pinned
            }
            // Anchored on the tail rather than on the last event, so a run that
            // ends with streaming text, a tool row or a status line all settle in
            // the same place — and so this stays correct without re-deriving the
            // visible list inside the handler.
            .onChange(of: controller.events.count) {
                guard isPinnedToBottom else { return }
                // `fast` (0.12), not the 0.15 literal that was here: a
                // near-miss off the ladder, close enough to look intentional
                // and far enough to desynchronise from every other 0.12 in the
                // window.
                withAnimation(
                    JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)
                ) {
                    proxy.scrollTo(TranscriptTail.id, anchor: .bottom)
                }
            }
            .overlay(alignment: .bottom) {
                if !isPinnedToBottom {
                    TranscriptJumpToLatest {
                        isPinnedToBottom = true
                        withAnimation(
                            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)
                        ) {
                            proxy.scrollTo(TranscriptTail.id, anchor: .bottom)
                        }
                    }
                    .padding(.bottom, JunoSpace.cozy)
                    .transition(.junoOverlay)
                }
            }
            .animation(
                JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
                value: isPinnedToBottom
            )
        }
    }

    private var context: TranscriptContext {
        TranscriptContext(
            events: controller.events,
            pendingApprovalIDs: Set(controller.pendingApprovals.map(\.id)),
            loadSubAgent: { [controller] childID in
                await controller.subAgentTranscript(childID)
            },
            loadDiff: { [controller] path in
                await controller.diff(for: path)
            },
            subagents: controller.subagents,
            subagentActivity: controller.subagentActivity,
            retryLastTurn: { [controller] in
                await controller.retryLastTurn()
            }
        )
    }

    /// What the reader sees, out of everything the record holds.
    ///
    /// Four kinds of event are structural rather than narrative and never
    /// appear: session creation, status transitions, tool start, and approval
    /// resolution — each is already visible as the state of the row it belongs
    /// to. Streamed tool output is folded into its own tool row. A *pending*
    /// approval is excluded because it is rendered as the pinned card above the
    /// composer; the same event reappears here as a resolved row the moment it
    /// is answered.
    private var visibleEvents: [SessionEvent] {
        let pendingApprovalIDs = Set(controller.pendingApprovals.map(\.id))
        var result: [SessionEvent] = []
        var lastContract: TurnConfigurationEvent?
        for event in controller.events {
            switch event.payload {
            case .sessionCreated, .statusChanged, .toolOutput, .toolStarted,
                 .approvalResolved, .userInstructionApplied:
                continue
            case let .turnConfiguration(configuration):
                // The record carries a contract for every turn so a past turn's
                // permissions are always recoverable; the transcript shows it
                // only when it changed, so an unchanged contract is not restated
                // above every message.
                guard configuration != lastContract else { continue }
                lastContract = configuration
            case let .approvalRequested(request):
                if pendingApprovalIDs.contains(request.id) { continue }
            default:
                break
            }
            result.append(event)
        }
        return result
    }
}

// MARK: - The live tail

/// The end of the transcript while a run is in flight: the reply as it arrives,
/// or an honest statement that the agent is working.
///
/// Text streams into `liveAssistantText` and is replaced by the persisted
/// `assistantMessage` event when the turn ends, so the reply never appears
/// twice. Reasoning summaries, tool calls and file changes are already appended
/// as they happen — the transcript has always moved during a run — but the
/// prose used to arrive in one block at the end of the turn.
struct TranscriptTail: View {
    let controller: SessionController
    let proxy: ScrollViewProxy
    /// Streaming text follows the reader only while the reader is still at the
    /// end. Otherwise the tail grows silently and the "Jump to latest" control
    /// above is what says so.
    let isPinnedToBottom: Bool

    static let id = "juno.code.transcript.tail"

    private var isStopping: Bool { controller.session.status == .stopping }

    /// Only when there is genuinely nothing else to look at: a running tool
    /// already draws its own spinner, and a pending approval has the card.
    private var showsWorkingRow: Bool {
        controller.session.status == .running
            && controller.liveAssistantText.isEmpty
            && CodeToolDigest.runningToolCallIDs(in: controller.events).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if !controller.liveAssistantText.isEmpty {
                JunoMarkdownText(controller.liveAssistantText, streaming: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Juno is writing: \(controller.liveAssistantText)")
            }
            if isStopping {
                statusRow("Stopping…")
            } else if showsWorkingRow {
                statusRow("Juno is working…", showsElapsed: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(Self.id)
        .onChange(of: controller.liveAssistantText) {
            guard isPinnedToBottom else { return }
            proxy.scrollTo(Self.id, anchor: .bottom)
        }
    }

    private func statusRow(_ title: String, showsElapsed: Bool = false) -> some View {
        HStack(spacing: JunoSpace.snug) {
            ProgressView()
                .controlSize(.small)
                .frame(width: 18)
            Text(title)
                .font(.callout)
                .junoSecondaryInk()
            if showsElapsed {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    if let elapsed = controller.elapsedSeconds {
                        Text(durationText(elapsed))
                            .junoCaption()
                            .monospacedDigit()
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }

    private func durationText(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// The way back to the end of a record that is still growing.
///
/// The one piece of floating chrome the transcript carries, and therefore the
/// one thing in this column that is glass. It appears only when the reader has
/// left the bottom, which is the only moment it says anything they do not
/// already know.
struct TranscriptJumpToLatest: View {
    let jump: () -> Void

    var body: some View {
        Button(action: jump) {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(.arrowDown, size: 13)
                    .foregroundStyle(Color.junoAccent)
                Text("Jump to latest").junoRowLabel()
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: CodeRowMetrics.minHeight)
            .contentShape(.capsule)
        }
        .buttonStyle(.junoPress)
        .background(Color.junoSurface, in: Capsule(style: .continuous))
        .overlay {
            Capsule(style: .continuous)
                .stroke(Color.junoHairline, lineWidth: 1)
                .allowsHitTesting(false)
        }
        .accessibilityIdentifier("juno.code.transcript.jump-to-latest")
    }
}

// MARK: - Before the first turn

/// The session's opening state: what this mode may do, and four real ways to
/// start.
///
/// Left-aligned and top-anchored on the transcript's own measure, so the first
/// reply lands exactly where the suggestions were instead of the canvas
/// reflowing from centred to left the moment a run starts. The starters fill the
/// composer rather than launching immediately — a one-click launch of a prompt
/// the reader has not read is how a session starts in the wrong direction.
struct PreRunSuggestions: View {
    let controller: SessionController
    var focus: FocusState<Bool>.Binding?

    private var behavior: AgentBehavior { controller.session.configuration.behavior }

    private var description: String {
        switch behavior {
        case .ask:
            return "Ask Juno to inspect and explain this project. This session cannot edit files or run commands."
        case .survey:
            return "Ask Juno to build a read-only map of this project. It can split independent reconnaissance into inspectable sub-agents, but it cannot edit files or run commands."
        case .plan:
            return "Describe an outcome and Juno will inspect the project, then write a read-only implementation plan."
        case .code:
            let level = PermissionModeLabel.shortText(
                for: controller.session.configuration.permissionMode
            )
            return "Ask Juno to examine or change this project. Every edit is checkpointed, and this session is set to \(level)."
        }
    }

    /// Only starters this session can actually carry out: a plan prompt in Plan,
    /// a review prompt only in a repository, a test prompt only when a toolchain
    /// was detected.
    private var suggestions: [StarterPrompt] {
        var items = [StarterPrompt.tour]
        if behavior == .survey {
            items.append(.survey)
        } else {
            items.append(behavior == .plan ? .plan : .findBug)
        }
        if controller.isGitRepository {
            items.append(.reviewUncommitted)
        }
        if let suggestion = controller.testSuggestions.first {
            items.append(.runTests(command: suggestion.command))
        }
        return items
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(controller.isGitRepository ? .branch : .projects, size: 14)
                        .foregroundStyle(Color.junoAccent)
                    Text(controller.workspaceDisplayName)
                        .junoFont(size: 18, relativeTo: .title3, weight: .semibold)
                        .junoInk()
                        .lineLimit(1)
                        .truncationMode(.head)
                }

                Text(description)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }

            StarterPromptList(starters: suggestions) { prompt in
                controller.composerText = prompt
                focus?.wrappedValue = true
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One way to start, as a real prompt the reader can read and edit before
/// sending. Never a one-click launch: a session that begins with a prompt nobody
/// read begins in the wrong direction.
struct StarterPrompt: Identifiable {
    var id: String { title }
    let title: String
    let icon: JunoIcon
    let prompt: String

    static let tour = StarterPrompt(
        title: "Explain this codebase",
        icon: .knowledge,
        prompt: "Give me a tour of this codebase: structure, key modules, and how they fit together."
    )
    static let plan = StarterPrompt(
        title: "Plan a change",
        icon: .sliders,
        prompt: """
        I want to change:

        Investigate the project first, then write an ordered implementation plan \
        with the files involved, the risks, and how to validate it.
        """
    )
    static let survey = StarterPrompt(
        title: "Survey this project",
        icon: .research,
        prompt: "Survey this project: map its entry points, main modules, runtime boundaries, recent changes, and highest-risk unknowns. Use read-only inspection and cite the evidence."
    )
    static let findBug = StarterPrompt(
        title: "Find a likely bug",
        icon: .error,
        prompt: "Look for likely bugs in the most recently changed files and explain what you find."
    )
    static let reviewUncommitted = StarterPrompt(
        title: "Review my uncommitted work",
        icon: .branch,
        prompt: "Review my uncommitted changes: correctness, regressions, and anything missing tests."
    )

    static func runTests(command: String) -> StarterPrompt {
        StarterPrompt(
            title: "Run the tests",
            icon: .check,
            prompt: "Run `\(command)`. If anything fails, explain the failure."
        )
    }
}

/// The starters as refined glass items.
struct StarterPromptList: View {
    let starters: [StarterPrompt]
    let select: (String) -> Void

    var body: some View {
        VStack(spacing: JunoSpace.snug) {
            ForEach(starters) { starter in
                Button {
                    select(starter.prompt)
                } label: {
                    HStack(spacing: JunoSpace.snug) {
                        JunoIconView(starter.icon, size: 15)
                            .junoSecondaryInk()
                            .frame(width: 20)
                        Text(starter.title)
                            .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                            .junoInk()
                        Spacer(minLength: 0)
                        JunoIconView(.external, size: 12)
                            .junoMetaInk()
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(minWidth: 44, minHeight: 44)
                    .junoPanel(cornerRadius: JunoRadius.well)
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                            .strokeBorder(Color.junoBorder.opacity(0.5))
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Puts this prompt in the composer")
            }
        }
    }
}
