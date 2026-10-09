// Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
// (WorkLog row geometry, the "Worked for" turn fold, the live-step shine and
// the changed-files card).
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// What the thread asks its host to do: open something in the panel, revert.
public struct CodeV2ThreadActions {
    public var openFile: (String) -> Void = { _ in }
    public var openCommand: (String) -> Void = { _ in }
    public var selectAgent: (String) -> Void = { _ in }
    public var openFrame: (String) -> Void = { _ in }
    public var review: (String) -> Void = { _ in }
    public var undo: ((String) -> Void)? = nil
    public var editFromHere: ((String) -> Void)? = nil
    public var retry: (() -> Void)? = nil

    public init() {}
}

/// The thread (code-v4 TARGET §5, §6): the reader's bubble, then the work.
/// A settled turn folds every step behind "Worked for 4m 13s"; the answer
/// and the changed-files card stay under it. Running turns, and turns that
/// failed or wait on the reader, never fold.
public struct CodeV2ThreadView: View {
    let items: [CodeV2.TurnItem]
    let activeTurnId: String?
    var selectedAgent: String?
    var budget: (spent: Double, limit: Double)?
    var actions = CodeV2ThreadActions()

    @State private var expanded: Set<String> = []
    @Environment(\.codeV2Now) private var pinnedNow

    public init(
        items: [CodeV2.TurnItem],
        activeTurnId: String?,
        selectedAgent: String? = nil,
        budget: (spent: Double, limit: Double)? = nil,
        actions: CodeV2ThreadActions = CodeV2ThreadActions()
    ) {
        self.items = items
        self.activeTurnId = activeTurnId
        self.selectedAgent = selectedAgent
        self.budget = budget
        self.actions = actions
    }

    public var body: some View {
        let turns = CodeV2TurnFolding.turns(from: items, activeTurnId: activeTurnId)
        LazyVStack(alignment: .leading, spacing: 28) {
            ForEach(turns) { turn in
                CodeV2TurnView(
                    turn: turn,
                    items: items,
                    isExpanded: Binding(
                        // A turn that ended without an answer (stopped, paused at a
                        // limit) shows its work: there is nothing else to read.
                        get: { !turn.canFold || turn.answer == nil || expanded.contains(turn.id) },
                        set: { open in if open { expanded.insert(turn.id) } else { expanded.remove(turn.id) } }
                    ),
                    selectedAgent: selectedAgent,
                    now: pinnedNow ?? Date(),
                    actions: actions
                )
                .id(turn.id)
            }
        }
        .frame(maxWidth: Studio.Metrics.measure, alignment: .leading)
    }
}

struct CodeV2TurnView: View {
    let turn: CodeV2Turn
    let items: [CodeV2.TurnItem]
    @Binding var isExpanded: Bool
    var selectedAgent: String?
    let now: Date
    let actions: CodeV2ThreadActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var steps: [CodeV2.TurnItem] {
        turn.steps.filter { item in
            // Pending requests live in the composer takeover, not the thread.
            switch item {
            case let .approvalRequest(request): request.status != .pending
            case let .userInputRequest(request): request.status != .pending
            default: true
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(turn.userMessages, id: \.id) { message in
                StudioUserMessage(
                    text: message.text,
                    caption: message.delivery == .steer ? "Steered" : nil
                ) { hovered in
                    if hovered, let checkpoint = turn.checkpoint, let edit = actions.editFromHere {
                        Button("Revert to here") { edit(checkpoint.checkpointId) }
                            .buttonStyle(StudioQuietButtonStyle())
                            .contentShape(.rect)
                    }
                }
            }
            if turn.canFold, let seconds = turn.durationSeconds {
                CodeV2FoldHeader(
                    title: CodeV2TurnFolding.durationLabel(seconds: seconds),
                    time: turn.endedAt,
                    isExpanded: $isExpanded
                )
            }
            if isExpanded {
                workLog
                    .transition(.opacity)
            }
            if let answer = turn.answer, !(turn.isRunning && answer.text.isEmpty) {
                StudioAssistantMessage(text: answer.text, streaming: answer.streaming)
            }
            if !turn.isRunning, !turn.changedFiles.isEmpty {
                CodeV2Receipt(
                    files: turn.changedFiles,
                    review: { actions.review(turn.id) },
                    undo: turn.checkpoint.flatMap { checkpoint in actions.undo.map { undo in { undo(checkpoint.checkpointId) } } },
                    openFile: actions.openFile
                )
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: isExpanded)
    }

    /// One line per step, the team as one group line, the computer as one
    /// line with its latest frame. Settled teams and screens fold with the
    /// rest of the work.
    private var workLog: some View {
        VStack(alignment: .leading, spacing: 0) {
            let list = steps
            ForEach(Array(list.enumerated()), id: \.element.id) { index, item in
                if case let .plan(plan) = item {
                    CodeV2PlanChecklist(plan: plan)
                        .padding(.vertical, JunoSpace.tight)
                } else if let row = CodeV2StepRow.make(item, nextDate: index + 1 < list.count ? list[index + 1].createdDate : nil, now: now) {
                    CodeV2StepRowView(row: row, open: { open(row) }, openFile: actions.openFile)
                }
            }
            if !turn.subagents.isEmpty {
                CodeV2AgentGroup(
                    children: orderedAgents,
                    isLive: turn.isRunning,
                    selected: selectedAgent,
                    select: actions.selectAgent
                )
            }
            if !turn.computerActions.isEmpty {
                CodeV2ComputerLine(actions: turn.computerActions, open: actions.openFrame)
            }
        }
    }

    private var orderedAgents: [CodeV2AgentNode] {
        var ordinal = 0
        return turn.subagents.map { child in
            if child.role == .worker { ordinal += 1 }
            return CodeV2AgentNode(subagent: child, items: items, now: now, ordinal: child.role == .worker ? ordinal : nil)
        }
    }

    private func open(_ row: CodeV2StepRow) {
        switch row.glyph {
        case .edit: if let path = row.object { actions.openFile(path) }
        case .terminal: actions.openCommand(row.id)
        case .error: actions.retry?()
        default: break
        }
    }
}

/// "Worked for 4m 13s ›" and a hairline to the edge; the time of day on hover.
struct CodeV2FoldHeader: View {
    let title: String
    var time: Date?
    @Binding var isExpanded: Bool
    @State private var hovering = false

    var body: some View {
        Button { isExpanded.toggle() } label: {
            HStack(spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.tight + 1) {
                    Text(title).studioType(.text).monospacedDigit()
                    JunoIconView(.chevronRight, size: 11)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .foregroundStyle(hovering ? Studio.Ink.primary : Studio.Ink.secondary)
                CodeV2Rule()
                if let time {
                    Text(time, format: .dateTime.hour().minute())
                        .studioType(.small)
                        .foregroundStyle(Studio.Ink.secondary)
                        .opacity(hovering ? 1 : 0)
                }
            }
            .frame(minHeight: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(title)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }
}

/// The live label's shine (TARGET §1.5): a light band crossing the words in
/// 30 steps over 2.2s; static muted words under Reduce Motion.
struct CodeV2ShineText: View {
    let text: String
    var rung: StudioType = .textMedium
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let base = Text(text).studioType(rung).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
        if reduceMotion {
            base
        } else {
            TimelineView(.periodic(from: .distantPast, by: 2.2 / 30)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.2) / 2.2
                base.overlay {
                    GeometryReader { proxy in
                        let width = proxy.size.width
                        LinearGradient(
                            colors: [Studio.Ink.primary.opacity(0), Studio.Ink.primary, Studio.Ink.primary.opacity(0)],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: 64)
                        .offset(x: -64 + (width + 128) * phase)
                    }
                    .mask(base)
                }
            }
            .accessibilityLabel(text)
        }
    }
}

/// One step (TARGET §6): the verb in 14/500 muted, the object in 14/400 (a
/// file name in ink, a command in mono), counts in the diff inks. No glyph
/// and no timer, except the live row's elapsed time. Click to see detail.
struct CodeV2StepRowView: View {
    let row: CodeV2StepRow
    var open: () -> Void = {}
    var openFile: (String) -> Void = { _ in }
    @State private var hovering = false
    @State private var showsDetail = false

    private var isNarration: Bool { row.glyph == .message }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                if !row.outputTail.isEmpty { showsDetail.toggle() } else { open() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight + 2) {
                    if row.state == .running, !isNarration {
                        CodeV2ShineText(text: row.verb)
                    } else {
                        Text(row.verb)
                            .studioType(isNarration ? .text : .textMedium)
                            .foregroundStyle(row.isFailure ? Studio.Ink.danger : Studio.Ink.secondary)
                            .lineLimit(1)
                    }
                    object
                    if let detail = row.detail {
                        Text(detail).studioType(.text).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    }
                    if let additions = row.additions, let deletions = row.deletions, additions + deletions > 0 {
                        CodeV2DiffCounts(additions: additions, deletions: deletions)
                    }
                    Spacer(minLength: JunoSpace.snug)
                    if row.state == .running, let trailing = row.trailing {
                        Text(trailing).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                    }
                }
                .frame(minHeight: Studio.Metrics.rowHeight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            if !row.outputTail.isEmpty, showsDetail || row.state == .running {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(row.outputTail.enumerated()), id: \.offset) { _, line in
                        Text(line).studioType(.code).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    }
                }
                .padding(.leading, 22)
                .padding(.bottom, JunoSpace.tight)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var object: some View {
        if let object = row.object {
            switch row.glyph {
            case .terminal:
                Text(object).studioType(.code).foregroundStyle(Studio.Ink.secondary).lineLimit(1).truncationMode(.middle)
            case .edit, .file:
                Text((object as NSString).lastPathComponent)
                    .studioType(.text)
                    .foregroundStyle(hovering ? Studio.Ink.primary : Studio.Ink.primary.opacity(0.9))
                    .underline(hovering, color: Studio.Ink.tertiary)
                    .lineLimit(1)
                    .help(object)
            default:
                Text(object).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1).truncationMode(.middle)
            }
        }
    }
}

/// A plan in the thread: its title, then a checklist with plain circles.
/// No frame; approving it happens in the composer.
struct CodeV2PlanChecklist: View {
    let plan: CodeV2.Plan

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight + 2) {
            if !plan.text.isEmpty {
                Text(plan.text).studioType(.text).foregroundStyle(Studio.Ink.prose)
            }
            ForEach(Array((plan.steps ?? []).enumerated()), id: \.offset) { _, step in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    JunoIconView(step.status == .completed ? .circleCheck : .circle, size: 14)
                        .foregroundStyle(Studio.Ink.secondary)
                    Text(step.text)
                        .studioType(.text)
                        .foregroundStyle(step.status == .completed ? Studio.Ink.secondary : Studio.Ink.prose)
                        .strikethrough(step.status == .completed, color: Studio.Ink.tertiary)
                }
            }
        }
    }
}

/// The changed-files card (TARGET §5): the one box in a turn. "Changed 3
/// files +16 −4" with Undo and Review, then up to four files.
struct CodeV2Receipt: View {
    let files: [CodeV2.FileChangeEntry]
    let review: () -> Void
    var undo: (() -> Void)?
    var openFile: (String) -> Void = { _ in }
    @State private var showsAll = false

    private var additions: Int { files.reduce(0) { $0 + ($1.additions ?? 0) } }
    private var deletions: Int { files.reduce(0) { $0 + ($1.deletions ?? 0) } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Text("Changed \(files.count) \(files.count == 1 ? "file" : "files")")
                    .studioType(.textMedium).foregroundStyle(Studio.Ink.primary)
                CodeV2DiffCounts(additions: additions, deletions: deletions)
                Spacer()
                if let undo {
                    Button("Undo", action: undo).buttonStyle(.borderless)
                        .contentShape(.rect)
                }
                Button("Review", action: review).buttonStyle(.bordered)
                    .contentShape(.rect)
            }
            .controlSize(.small)
            .padding(.leading, JunoSpace.cozy + 2)
            .padding(.trailing, JunoSpace.cozy)
            .frame(height: 44)
            let visible = showsAll || files.count <= 4 ? files : Array(files.prefix(4))
            VStack(spacing: 0) {
                ForEach(visible, id: \.path) { file in
                    Button { openFile(file.path) } label: {
                        CodeV2RowFace(height: 30, horizontal: JunoSpace.cozy + 2) {
                            HStack(spacing: JunoSpace.snug) {
                                Text((file.path as NSString).lastPathComponent)
                                    .studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                                Text((file.path as NSString).deletingLastPathComponent)
                                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                                    .lineLimit(1).truncationMode(.head)
                                Spacer(minLength: JunoSpace.snug)
                                CodeV2DiffCounts(additions: file.additions ?? 0, deletions: file.deletions ?? 0)
                            }
                        }
                    }
                    .buttonStyle(CodeV2RowButtonStyle())
                }
                if files.count > 4, !showsAll {
                    Button("Show all \(files.count)") { showsAll = true }
                        .buttonStyle(StudioQuietButtonStyle())
                        .contentShape(.rect)
                        .padding(.vertical, 3)
                }
            }
            .padding(.bottom, JunoSpace.tight + 2)
        }
        .background(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).fill(Studio.Surface.raised))
        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).strokeBorder(Studio.Surface.hairline))
    }
}

/// A plain row that takes the hover fill.
struct CodeV2RowButtonStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed || hovering ? Studio.Surface.hover : Color.clear)
            .onHover { hovering = $0 }
    }
}

/// A path: the directory muted, the file name in ink, UI type.
struct CodeV2PathText: View {
    let path: String
    var body: some View {
        let name = (path as NSString).lastPathComponent
        let directory = String(path.dropLast(name.count))
        Text("\(Text(name).foregroundStyle(Studio.Ink.primary)) \(Text(directory).foregroundStyle(Studio.Ink.secondary))")
            .studioType(.text)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}
