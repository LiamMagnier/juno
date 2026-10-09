import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// What the thread asks its host to do: open something in the dock, revert.
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

/// The thread (DESIGN §1.1, §5.1–§5.4): one column of what the agents did.
/// Completed turns fold to "Worked for 4m 12s"; the answer and the
/// receipt stay visible under the fold. Running turns, and turns that
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
        LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
            ForEach(turns) { turn in
                CodeV2TurnView(
                    turn: turn,
                    items: items,
                    isExpanded: Binding(
                        get: { !turn.canFold || expanded.contains(turn.id) },
                        set: { open in if open { expanded.insert(turn.id) } else { expanded.remove(turn.id) } }
                    ),
                    selectedAgent: selectedAgent,
                    budget: budget,
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
    var budget: (spent: Double, limit: Double)?
    let now: Date
    let actions: CodeV2ThreadActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var steps: [CodeV2StepRow] {
        let list = turn.steps.filter { item in
            // Pending requests live in the composer takeover, not the thread.
            switch item {
            case let .approvalRequest(request): request.status != .pending
            case let .userInputRequest(request): request.status != .pending
            default: true
            }
        }
        return list.enumerated().compactMap { index, item in
            CodeV2StepRow.make(item, nextDate: index + 1 < list.count ? list[index + 1].createdDate : nil, now: now)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            ForEach(turn.userMessages, id: \.id) { message in
                StudioUserMessage(text: message.text, caption: message.delivery == .steer ? "Steered" : nil) { _ in EmptyView() }
            }
            if turn.canFold, let seconds = turn.durationSeconds {
                CodeV2FoldHeader(title: CodeV2TurnFolding.durationLabel(seconds: seconds), isExpanded: $isExpanded)
            }
            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(steps) { row in
                        CodeV2StepRowView(row: row, open: { open(row) })
                    }
                }
                .transition(.opacity)
            }
            if let answer = turn.answer, !(turn.isRunning && answer.text.isEmpty) {
                StudioAssistantMessage(text: answer.text, streaming: answer.streaming)
            }
            if !turn.subagents.isEmpty {
                CodeV2AgentTree(
                    children: turn.subagents.map { CodeV2AgentNode(subagent: $0, items: items, now: now) },
                    selected: selectedAgent,
                    budget: budget,
                    select: actions.selectAgent
                )
            }
            if !turn.computerActions.isEmpty {
                CodeV2ComputerStrip(actions: turn.computerActions, open: actions.openFrame)
            }
            if !turn.isRunning, !turn.changedFiles.isEmpty {
                CodeV2Receipt(
                    files: turn.changedFiles,
                    review: { actions.review(turn.id) },
                    undo: turn.checkpoint.flatMap { checkpoint in actions.undo.map { undo in { undo(checkpoint.checkpointId) } } },
                    openFile: actions.openFile
                )
            }
            if let checkpoint = turn.checkpoint, !turn.isRunning {
                CodeV2CheckpointDivider(checkpoint: checkpoint, editFromHere: actions.editFromHere.map { edit in { edit(checkpoint.checkpointId) } })
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: isExpanded)
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

/// "› Worked for 4m 12s ———": the fold line.
struct CodeV2FoldHeader: View {
    let title: String
    @Binding var isExpanded: Bool
    @State private var hovering = false

    var body: some View {
        Button { isExpanded.toggle() } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.chevronRight, size: 12)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                Text(title).font(Studio.Font.label).monospacedDigit()
                Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            }
            .foregroundStyle(hovering ? Studio.Ink.primary : Studio.Ink.secondary)
            .frame(minHeight: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(title)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }
}

/// One step (DESIGN §5.1): 28 tall, a muted glyph, the verb in ink, the
/// object in mono, the count or elapsed time on the right. A running step's
/// glyph is the spinner; a failure says so in the destructive ink, with no
/// container.
struct CodeV2StepRowView: View {
    let row: CodeV2StepRow
    var open: () -> Void = {}
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: open) {
                HStack(spacing: JunoSpace.close) {
                    glyph
                    Text(row.verb)
                        .font(Studio.Font.label)
                        .foregroundStyle(row.isFailure ? Studio.Ink.danger : Studio.Ink.primary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let object = row.object {
                        Text(object)
                            .font(Studio.Font.mono)
                            .foregroundStyle(Studio.Ink.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if let detail = row.detail {
                        Text(detail).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    }
                    if let additions = row.additions, let deletions = row.deletions {
                        CodeV2DiffCounts(additions: additions, deletions: deletions, font: Studio.Font.mono)
                    }
                    Spacer(minLength: JunoSpace.snug)
                    if let trailing = row.trailing {
                        Text(trailing).font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                    }
                }
                .frame(minHeight: Studio.Metrics.rowHeight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            if !row.outputTail.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(row.outputTail.enumerated()), id: \.offset) { _, line in
                        Text(line).font(Studio.Font.monoSmall).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    }
                }
                .padding(.leading, 30)
                .padding(.bottom, JunoSpace.tight)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var glyph: some View {
        switch row.state {
        case .running: CodeV2StateGlyph(state: .running)
        case .waiting: CodeV2StateGlyph(state: .waiting)
        case .failed: CodeV2StateGlyph(state: .failed)
        case .done:
            JunoIconView(row.glyph.icon, size: 16)
                .foregroundStyle(hovering ? Studio.Ink.primary : Studio.Ink.secondary)
                .frame(width: 20, height: 20)
        }
    }
}

/// The changed-files receipt at the end of a turn (DESIGN §5.2).
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
                JunoIconView(.diff, size: 16).foregroundStyle(Studio.Ink.secondary)
                Text("Changed \(files.count) \(files.count == 1 ? "file" : "files")").font(Studio.Font.labelEmphasis)
                CodeV2DiffCounts(additions: additions, deletions: deletions, font: Studio.Font.labelDigits)
                Spacer()
                if let undo {
                    Button(action: undo) {
                        HStack(spacing: JunoSpace.tight) { JunoIconView(.undo, size: 13); Text("Undo") }
                    }
                    .buttonStyle(StudioQuietButtonStyle())
                }
                Button("Review", action: review).buttonStyle(CodeV2OutlineButtonStyle(compact: true))
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 44)
            let visible = showsAll || files.count <= 5 ? files : Array(files.prefix(4))
            ForEach(visible, id: \.path) { file in
                Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                Button { openFile(file.path) } label: {
                    HStack {
                        CodeV2PathText(path: file.path)
                        Spacer()
                        CodeV2DiffCounts(additions: file.additions ?? 0, deletions: file.deletions ?? 0, font: Studio.Font.mono)
                    }
                    .padding(.horizontal, JunoSpace.cozy)
                    .frame(height: 32)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            if files.count > 5, !showsAll {
                Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                Button("Show \(files.count - 4) more") { showsAll = true }
                    .buttonStyle(StudioQuietButtonStyle())
                    .frame(height: 32)
            }
        }
        .background(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).fill(Studio.Surface.raised))
        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).strokeBorder(Studio.Surface.hairline))
    }
}

/// A path in mono: the directory muted, the file name in ink.
struct CodeV2PathText: View {
    let path: String
    var body: some View {
        let name = (path as NSString).lastPathComponent
        let directory = String(path.dropLast(name.count))
        Text("\(Text(directory).foregroundStyle(Studio.Ink.secondary))\(Text(name).foregroundStyle(Studio.Ink.primary))")
            .font(Studio.Font.mono)
            .lineLimit(1)
            .truncationMode(.head)
    }
}

/// A hairline between turns: "Checkpoint 4" at the left, "Edit from here"
/// on hover at the right.
struct CodeV2CheckpointDivider: View {
    let checkpoint: CodeV2.Checkpoint
    var editFromHere: (() -> Void)?
    @State private var hovering = false

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("Checkpoint \(checkpoint.turnOrdinal)").font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            if let editFromHere {
                Button("Edit from here", action: editFromHere)
                    .buttonStyle(StudioQuietButtonStyle())
                    .opacity(hovering ? 1 : 0)
            }
        }
        .frame(minHeight: 24)
        .contentShape(.rect)
        .onHover { hovering = $0 }
    }
}
