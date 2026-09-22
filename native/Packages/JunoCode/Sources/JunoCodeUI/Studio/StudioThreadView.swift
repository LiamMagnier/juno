import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The session's thread: prompts, replies, and folded work, in one column.
public struct StudioThreadView: View {
    let controller: SessionController
    let openReview: (String?) -> Void

    @State private var expanded: Set<String> = []
    @State private var isPinnedToBottom = true
    @State private var hasPositioned = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var preferences: StudioPreferences { .shared }

    static let tailID = "juno.studio.thread.tail"

    public init(controller: SessionController, openReview: @escaping (String?) -> Void) {
        self.controller = controller
        self.openReview = openReview
    }

    private var items: [StudioThreadItem] {
        StudioThreadItems.build(
            events: controller.events,
            groups: controller.narrativeGroups,
            pendingApprovalIDs: Set(controller.pendingApprovals.map(\.id)),
            showReasoning: preferences.showReasoning || preferences.density == .detailed
        )
    }

    public var body: some View {
        let items = self.items
        let turnIDs = Set(controller.rewindTurns.map(\.id))
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
                    ForEach(items) { item in
                        row(item, rewindable: turnIDs.contains(item.id))
                            .id(item.id)
                            .transition(.opacity)
                    }
                    // The live text is read only inside the tail, so a token
                    // arriving re-renders the tail and not every row above it.
                    StudioThreadTail(controller: controller) { follow(proxy) }
                        .id(Self.tailID)
                }
                .frame(maxWidth: Studio.Metrics.measure, alignment: .leading)
                .padding(.horizontal, Studio.Metrics.gutter)
                .padding(.top, JunoSpace.section)
                .padding(.bottom, JunoSpace.region)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.automatic)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 32
            } action: { _, pinned in
                guard hasPositioned else { return }
                isPinnedToBottom = pinned
            }
            .task(id: controller.sessionID) {
                hasPositioned = false
                isPinnedToBottom = true
                try? await Task.sleep(for: .milliseconds(80))
                guard !Task.isCancelled else { return }
                proxy.scrollTo(Self.tailID, anchor: .bottom)
                hasPositioned = true
            }
            .onChange(of: controller.events.count) {
                follow(proxy)
            }
            .overlay(alignment: .bottom) {
                if !isPinnedToBottom {
                    Button {
                        isPinnedToBottom = true
                        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                            proxy.scrollTo(Self.tailID, anchor: .bottom)
                        }
                    } label: {
                        JunoIconView(.arrowDown, size: 13)
                            .foregroundStyle(Studio.Ink.secondary)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Studio.Surface.raised))
                            .overlay(Circle().strokeBorder(Studio.Surface.hairline))
                            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
                    }
                    .buttonStyle(.plain)
                    .help("Jump to the latest")
                    .accessibilityLabel("Jump to the latest")
                    .padding(.bottom, JunoSpace.cozy)
                    .transition(.junoOverlay)
                }
            }
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: isPinnedToBottom)
        }
    }

    private func follow(_ proxy: ScrollViewProxy) {
        guard isPinnedToBottom, hasPositioned else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
            proxy.scrollTo(Self.tailID, anchor: .bottom)
        }
    }

    private func binding(_ id: String, defaultExpanded: Bool = false) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(id) != defaultExpanded },
            set: { value in
                if value != defaultExpanded { expanded.insert(id) } else { expanded.remove(id) }
            }
        )
    }

    /// - Parameter rewindable: the row is one of the reader's messages that
    ///   opened a turn. A steer or queued message the run never took in is
    ///   not, and offers no rewind.
    @ViewBuilder
    private func row(_ item: StudioThreadItem, rewindable: Bool) -> some View {
        switch item {
        case let .user(id, text):
            StudioUserMessage(text: text) { hovered in
                if rewindable {
                    StudioRewindButton(controller: controller, turnID: id, isRowHovered: hovered)
                }
            }
            .padding(.top, JunoSpace.snug)
        case let .instruction(id, text, kind):
            StudioUserMessage(text: text, caption: kind == .steer ? "Sent while working" : "Queued") { hovered in
                if rewindable {
                    StudioRewindButton(controller: controller, turnID: id, isRowHovered: hovered)
                }
            }
        case let .assistant(_, text):
            StudioAssistantMessage(text: text)
        case let .reasoning(id, text):
            StudioReasoningRow(text: text, isExpanded: binding(id))
        case let .activity(group, reasoning):
            StudioActivityRow(
                group: group,
                reasoning: reasoning,
                density: preferences.density,
                isExpanded: binding(group.id, defaultExpanded: preferences.density == .detailed),
                openFile: { openReview($0) }
            )
            .accessibilityIdentifier("juno.code.transcript.work-log")
        case let .decision(_, summary, allowed):
            StudioDecisionRow(summary: summary, allowed: allowed)
        case let .plan(_, goal):
            StudioPlanCard(goal: controller.session.goal ?? goal)
                .accessibilityIdentifier("juno.code.plan")
        case let .subagent(id, update):
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                StudioSubagentRow(update: update, isExpanded: binding(id))
                StudioSubagentControls(controller: controller, update: update)
            }
        case let .tests(_, run):
            StudioTestsRow(run: run)
        case let .error(_, message):
            StudioErrorRow(message: message, retry: isLastError(item) ? { Task { await controller.retryLastTurn() } } : nil)
        case let .compaction(_, event):
            StudioDividerCaption(text: event.requestedByUser ? "Context compacted" : "Context compacted automatically")
        case let .modeChange(_, text):
            StudioDividerCaption(text: text)
        case let .summary(_, run, turn):
            StudioRunSummary(run: run, turn: turn) { openReview(nil) }
        }
    }

    /// Retry is offered on the most recent failure only, and only while the
    /// session is not already running again.
    private func isLastError(_ item: StudioThreadItem) -> Bool {
        guard !controller.session.status.isActive else { return false }
        return items.last { if case .error = $0 { return true } else { return false } }?.id == item.id
    }
}

/// The end of the thread while a run is live: the reply as it streams, or a
/// single quiet line saying what the agent is doing.
struct StudioThreadTail: View {
    let controller: SessionController
    /// Keeps the newest text in view as it streams, when the reader is at the end.
    var follow: () -> Void = {}

    private var status: SessionStatus { controller.session.status }

    /// The step in flight, in words — never a tool id.
    private var activity: String {
        switch controller.executionState {
        case let .executing(summary):
            let trimmed = summary.trimmingCharacters(in: CharacterSet(charactersIn: "…. "))
            // The projection's in-flight phrases can carry a registry name
            // ("Running run_command"); those read as "Working" here.
            guard !trimmed.isEmpty, !trimmed.contains("_"), trimmed != "Working" else {
                return "Working"
            }
            return trimmed
        case .planning:
            return "Planning"
        case .verifying:
            return "Checking the result"
        default:
            return "Working"
        }
    }

    private var showsWorkingLine: Bool {
        status.isActive
            && status != .waitingForApproval
            && controller.pendingApprovals.isEmpty
            && controller.liveAssistantText.isEmpty
            && !(controller.narrativeGroups.last?.status == .running)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if !controller.liveAssistantText.isEmpty {
                StudioAssistantMessage(text: controller.liveAssistantText, streaming: true)
            }
            if status == .stopping {
                Text("Stopping…")
                    .font(Studio.Font.label)
                    .foregroundStyle(Studio.Ink.tertiary)
            } else if showsWorkingLine {
                HStack(spacing: JunoSpace.snug) {
                    JunoShimmerText(activity, font: Studio.Font.label, active: true)
                    if let started = controller.runStartedAt {
                        TimelineView(.periodic(from: started, by: 1)) { context in
                            Text(StudioFormat.duration(context.date.timeIntervalSince(started)))
                                .font(Studio.Font.metaDigits)
                                .foregroundStyle(Studio.Ink.tertiary)
                        }
                    }
                }
                .transition(.opacity)
            }
            if let error = controller.transientError {
                Text(error)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 1)
        .onChange(of: controller.liveAssistantText.count / 80) { follow() }
    }
}
