import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - Node

/// One child in the agent tree (DESIGN §5.12), derived from its `subagent`
/// item and the child's own messages in the thread.
public struct CodeV2AgentNode: Identifiable, Equatable, Sendable {
    public var id: String { agentId }
    public var agentId: String
    public var role: CodeV2.AgentRole
    public var roleLabel: String
    public var selection: CodeV2.ModelSelection
    public var status: CodeV2.SubagentStatus
    public var title: String
    /// What it is doing now, its closing sentence, or what it waits on.
    public var liveLine: String?
    public var elapsedSeconds: Int?
    public var steps: [CodeV2.TurnItem]

    public init(subagent: CodeV2.Subagent, items: [CodeV2.TurnItem], now: Date = Date(), ordinal: Int? = nil) {
        agentId = subagent.agentId
        role = subagent.role
        selection = subagent.model
        status = subagent.status
        let task = subagent.task ?? "Subagent"
        title = task.split(separator: "\n").first.map(String.init) ?? task
        let own = items.filter { item in
            if case let .assistantMessage(message) = item { return message.agentId == subagent.agentId }
            return false
        }
        steps = own
        let latest: String? = own.last.flatMap { item in
            if case let .assistantMessage(message) = item { return message.text } else { return nil }
        }
        switch subagent.status {
        case .waiting: liveLine = "Waiting for you"
        case .completed, .interrupted: liveLine = subagent.closingText ?? latest
        case .failed: liveLine = subagent.closingText ?? "Stopped after an error."
        case .running: liveLine = latest
        }
        let index = ordinal ?? Int(subagent.agentId.filter(\.isNumber)) ?? 1
        switch subagent.role {
        case .worker: roleLabel = "Worker \(index)"
        case .explorer: roleLabel = "Explorer"
        case .reviewer: roleLabel = "Reviewer"
        case .orchestrator: roleLabel = "Lead"
        case .compaction: roleLabel = "Compaction"
        }
        if let start = CodeV2Dates.parse(subagent.createdAt) {
            if subagent.status == .running || subagent.status == .waiting {
                elapsedSeconds = max(0, Int(now.timeIntervalSince(start)))
            } else if let end = own.last?.createdDate {
                elapsedSeconds = max(0, Int(end.timeIntervalSince(start)))
            } else {
                elapsedSeconds = nil
            }
        }
    }

    var glyphState: CodeV2StateGlyph.State {
        switch status {
        case .running: .running
        case .waiting: .waiting
        case .completed: .done
        case .interrupted: .closed
        case .failed: .failed
        }
    }
}

// MARK: - Agents in the thread

enum CodeV2AgentCopy {
    /// "3 workers and an explorer", "2 agents".
    static func headline(_ children: [CodeV2AgentNode]) -> String {
        let workers = children.filter { $0.role == .worker }.count
        let others = children.filter { $0.role != .worker }.map { node -> String in
            switch node.role {
            case .explorer: "an explorer"
            case .reviewer: "a reviewer"
            default: "a helper"
            }
        }
        guard workers > 0 else { return "\(children.count) \(children.count == 1 ? "agent" : "agents")" }
        let main = "\(workers) \(workers == 1 ? "worker" : "workers")"
        return others.isEmpty ? main : main + " and " + others.joined(separator: " and ")
    }

    static func elapsed(_ children: [CodeV2AgentNode]) -> String? {
        children.compactMap(\.elapsedSeconds).max().map(CodeV2Formatting.duration(seconds:))
    }
}

/// A team run in the thread (TARGET §6.1): one group line, "3 workers and
/// an explorer ›" with the run's time, and when open one line per agent:
/// its name, its current or last step, its time. Open while the run is live.
struct CodeV2AgentGroup: View {
    let children: [CodeV2AgentNode]
    var isLive = false
    var selected: String?
    var select: (String) -> Void = { _ in }

    @State private var isOpen: Bool?
    @State private var hovering = false

    private var open: Bool { isOpen ?? isLive }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { isOpen = !open } label: {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight + 1) {
                    Text(CodeV2AgentCopy.headline(children))
                        .studioType(.textMedium)
                        .foregroundStyle(hovering ? Studio.Ink.primary : Studio.Ink.secondary)
                    JunoIconView(.chevronRight, size: 11)
                        .foregroundStyle(Studio.Ink.secondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Spacer(minLength: JunoSpace.snug)
                    if let elapsed = CodeV2AgentCopy.elapsed(children) {
                        Text(elapsed).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                    }
                }
                .frame(minHeight: Studio.Metrics.rowHeight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(children) { child in
                        CodeV2AgentLine(node: child, isSelected: selected == child.agentId) { select(child.agentId) }
                    }
                }
                .padding(.leading, 22)
                .transition(.opacity)
            }
        }
    }
}

/// One agent on one line: "Worker 2" in ink, its step in muted ink (or
/// "Waiting for you" in the signal ink), its time at the right.
struct CodeV2AgentLine: View {
    let node: CodeV2AgentNode
    var isSelected = false
    let select: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: select) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(node.roleLabel)
                    .studioType(.text)
                    .foregroundStyle(Studio.Ink.primary)
                    .underline(hovering || isSelected, color: Studio.Ink.tertiary)
                    .fixedSize()
                CodeV2AgentStep(node: node)
                Spacer(minLength: JunoSpace.snug)
                if let elapsed = node.elapsedSeconds {
                    Text(CodeV2Formatting.duration(seconds: elapsed))
                        .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                }
            }
            .frame(minHeight: Studio.Metrics.rowHeight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// What an agent is doing: live with the shine, waiting in the signal ink,
/// finished in plain muted past tense.
struct CodeV2AgentStep: View {
    let node: CodeV2AgentNode
    var rung: StudioType = .text

    var body: some View {
        let line = node.liveLine ?? node.title
        switch node.status {
        case .waiting:
            Text("Waiting for you").studioType(rung).foregroundStyle(Studio.Signal.ink).lineLimit(1)
        case .running:
            CodeV2ShineText(text: line, rung: rung)
        case .failed:
            Text(line).studioType(rung).foregroundStyle(Studio.Ink.danger).lineLimit(1)
        default:
            Text(line).studioType(rung).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
        }
    }
}

// MARK: - Panel › Agents

/// Panel › Agents (TARGET §10.4): the team's line and its spend, then one
/// two-line row per agent; or one agent followed, with the lead's brief, its
/// own steps and a slim composer to message it.
public struct CodeV2AgentsPane: View {
    let nodes: [CodeV2AgentNode]
    @Binding var selected: String?
    var spend: (spent: Double, limit: Double)?
    var message: ((String, String) -> Void)?
    var stop: ((String) -> Void)?

    @State private var draft = ""

    public init(
        nodes: [CodeV2AgentNode], selected: Binding<String?>, spend: (spent: Double, limit: Double)? = nil,
        message: ((String, String) -> Void)? = nil, stop: ((String) -> Void)? = nil
    ) {
        self.nodes = nodes
        self._selected = selected
        self.spend = spend
        self.message = message
        self.stop = stop
    }

    public var body: some View {
        if let id = selected, let node = nodes.first(where: { $0.agentId == id }) {
            detail(node)
        } else if nodes.isEmpty {
            Text("No agents in this thread yet. Choose Team in the + menu to run a lead with workers.")
                .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(CodeV2AgentCopy.headline(nodes)).studioType(.textMedium).foregroundStyle(Studio.Ink.primary)
                    Spacer()
                    if let spend {
                        Text("\(CodeV2ContextMath.dollars(spend.spent)) of \(CodeV2ContextMath.dollars(spend.limit))")
                            .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                    }
                }
                .padding(.horizontal, JunoSpace.regular)
                .frame(height: 40)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(nodes) { node in
                            Button { selected = node.agentId } label: { row(node) }
                                .buttonStyle(CodeV2RowButtonStyle())
                        }
                    }
                }
            }
        }
    }

    private func row(_ node: CodeV2AgentNode) -> some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: JunoSpace.tight + 2) {
                    Text(node.roleLabel).studioType(.text).foregroundStyle(Studio.Ink.primary)
                    CodeV2Mark(id: CodeV2Marks.markID(model: node.selection.model, instanceId: node.selection.instanceId), size: 13)
                    Text(CodeV2Formatting.modelName(node.selection.model)).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
                CodeV2AgentStep(node: node, rung: .small)
            }
            Spacer(minLength: JunoSpace.snug)
            if let elapsed = node.elapsedSeconds {
                Text(CodeV2Formatting.duration(seconds: elapsed)).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .frame(height: 52)
        .contentShape(.rect)
    }

    private func detail(_ node: CodeV2AgentNode) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Button { selected = nil } label: {
                    HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.chevronLeft, size: 12)
                        Text(node.roleLabel)
                    }
                    .studioType(.textMedium)
                    .foregroundStyle(Studio.Ink.primary)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("All agents")
                CodeV2Mark(id: CodeV2Marks.markID(model: node.selection.model, instanceId: node.selection.instanceId), size: 13)
                Text(CodeV2Formatting.modelName(node.selection.model)).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                Spacer()
                if let stop, node.status == .running || node.status == .waiting {
                    Button("Stop") { stop(node.agentId) }.buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(height: 40)
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    Text("Task from the lead").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    Text(node.title).studioType(.text).foregroundStyle(Studio.Ink.primary)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(node.steps, id: \.id) { item in
                            if let row = CodeV2StepRow.make(item) { CodeV2StepRowView(row: row) }
                        }
                        if node.steps.isEmpty { CodeV2AgentStep(node: node) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(JunoSpace.regular)
            }
            if let message {
                HStack(spacing: JunoSpace.snug) {
                    TextField("Message \(node.roleLabel)", text: $draft)
                        .textFieldStyle(.plain)
                        .studioType(.text)
                        .onSubmit { send(node, message) }
                    Button { send(node, message) } label: {
                        JunoIconView(.arrowUp, size: 12, weight: .bold)
                            .foregroundStyle(Studio.Surface.canvas)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(draft.isEmpty ? Studio.Ink.tertiary : Studio.Ink.primary))
                            .frame(width: 28, height: 28)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(draft.isEmpty)
                    .accessibilityLabel("Send to \(node.roleLabel)")
                }
                .padding(.leading, JunoSpace.cozy + 2)
                .padding(.trailing, JunoSpace.tight)
                .frame(height: 40)
                .junoComposerGlass(cornerRadius: Studio.Radius.bubble)
                .padding(JunoSpace.cozy)
            }
        }
    }

    private func send(_ node: CodeV2AgentNode, _ message: (String, String) -> Void) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        message(node.agentId, text)
        draft = ""
    }
}

// MARK: - Best of N

/// One column of the Best-of-N compare.
public struct CodeV2BestOfNCandidate: Identifiable, Equatable, Sendable {
    public var id: String
    public var selection: CodeV2.ModelSelection
    public var instanceLabel: String
    public var elapsedSeconds: Int
    public var costUsd: Double?
    public var additions: Int
    public var deletions: Int
    public var testsLine: String?
    public var summary: String
    public var isFinished: Bool

    public init(
        id: String, selection: CodeV2.ModelSelection, instanceLabel: String, elapsedSeconds: Int, costUsd: Double?,
        additions: Int, deletions: Int, testsLine: String?, summary: String, isFinished: Bool
    ) {
        self.id = id
        self.selection = selection
        self.instanceLabel = instanceLabel
        self.elapsedSeconds = elapsedSeconds
        self.costUsd = costUsd
        self.additions = additions
        self.deletions = deletions
        self.testsLine = testsLine
        self.summary = summary
        self.isFinished = isFinished
    }
}

/// Panel › Agents under Best of N (TARGET §10.4): one row per candidate,
/// its model, time, tests and diff, its summary under it; one primary
/// action, Keep, for the chosen row.
public struct CodeV2BestOfNCompare: View {
    let candidates: [CodeV2BestOfNCandidate]
    var keep: (String) -> Void
    @State private var chosen: String?

    public init(candidates: [CodeV2BestOfNCandidate], keep: @escaping (String) -> Void) {
        self.candidates = candidates
        self.keep = keep
    }

    private func letter(_ index: Int) -> String { String(UnicodeScalar(UInt8(65 + index))) }

    public var body: some View {
        let selected = chosen ?? candidates.first(where: \.isFinished)?.id
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(candidates.enumerated()), id: \.element.id) { index, candidate in
                        Button { chosen = candidate.id } label: {
                            row(candidate, letter: letter(index), isSelected: selected == candidate.id)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(JunoSpace.tight + 2)
            }
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            HStack {
                Text("The others' worktrees are removed.").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                Spacer()
                if let index = candidates.firstIndex(where: { $0.id == selected }) {
                    Button("Keep \(letter(index))") { keep(candidates[index].id) }
                        .buttonStyle(CodeV2InkButtonStyle())
                        .disabled(!candidates[index].isFinished)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(height: 48)
        }
    }

    private func row(_ candidate: CodeV2BestOfNCandidate, letter: String, isSelected: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Text(letter).studioType(.textMedium).foregroundStyle(Studio.Ink.secondary).frame(width: 14, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(CodeV2Formatting.modelName(candidate.selection.model)).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                    Text(CodeV2Formatting.duration(seconds: candidate.elapsedSeconds)).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                    if let tests = candidate.testsLine {
                        Text(tests).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    }
                    Spacer(minLength: JunoSpace.tight)
                    if candidate.isFinished {
                        CodeV2DiffCounts(additions: candidate.additions, deletions: candidate.deletions)
                    }
                }
                if candidate.isFinished {
                    Text(candidate.summary).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                } else {
                    CodeV2ShineText(text: candidate.summary, rung: .small)
                }
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                .fill(isSelected ? Studio.Surface.selected : Color.clear)
        )
        .contentShape(.rect)
    }
}

// MARK: - Computer use

extension CodeV2.ComputerAction {
    /// "Click 'Save'", "Type 'cart total'", "Open Safari".
    var caption: String {
        if let summary = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty,
           status != .running, status != .pending {
            return summary
        }
        let target = self.target.map { "‘\($0)’" }
        switch action {
        case .screenshot: return "Look" + (target.map { " at \($0)" } ?? "")
        case .click: return "Click " + (target ?? "")
        case .doubleClick: return "Double-click " + (target ?? "")
        case .rightClick: return "Right-click " + (target ?? "")
        case .move: return "Move to " + (target ?? "")
        case .drag: return "Drag " + (target ?? "")
        case .scroll: return "Scroll"
        case .type: return "Type " + (target ?? "")
        case .key: return "Press " + (target ?? "")
        case .wait: return "Wait"
        case .openApp: return "Open " + (self.target ?? "an app")
        case .zoom: return "Zoom in"
        case .axFind: return "Find " + (target ?? "a control")
        case .axPress: return "Press " + (target ?? "a control")
        case .menu: return "Choose " + (target ?? "a menu item")
        }
    }
}

/// Computer use in the thread (TARGET §10.5): one work-log line, "Using
/// Safari" and the current step, with the latest frame as a 120-wide
/// thumbnail under it. Clicking it opens Panel › Screen.
struct CodeV2ComputerLine: View {
    let actions: [CodeV2.ComputerAction]
    var open: (String) -> Void = { _ in }

    private var app: String {
        actions.first { $0.action == .openApp }?.target ?? "the computer"
    }
    private var isActive: Bool { actions.contains { $0.status == .running || $0.status == .pending } }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight + 2) {
                if isActive {
                    CodeV2ShineText(text: "Using \(app)")
                } else {
                    Text("Used \(app)").studioType(.textMedium).foregroundStyle(Studio.Ink.secondary)
                }
                if let last = actions.last {
                    Text(last.caption).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: Studio.Metrics.rowHeight)
            if let last = actions.last {
                Button { open(last.id) } label: {
                    CodeV2Frame(ref: last.screenshotRef, size: CGSize(width: 120, height: 75))
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Open the screen")
                .accessibilityLabel(last.caption)
            }
        }
    }
}

/// A screenshot frame: the image at `ref` (a file path) or a quiet well.
struct CodeV2Frame: View {
    let ref: String?
    let size: CGSize

    var body: some View {
        Group {
            if let ref, let image = NSImage(contentsOfFile: ref) {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    Studio.Surface.muted
                    VStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2).fill(Studio.Surface.hairline).frame(width: size.width * 0.6, height: 6)
                        RoundedRectangle(cornerRadius: 2).fill(Studio.Surface.hairline).frame(width: size.width * 0.4, height: 6)
                    }
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Studio.Surface.hairline))
    }
}

/// Panel › Screen (TARGET §10.5): the live frame at full width, the step
/// as a caption, a thin filmstrip of earlier frames. Stop lives in the
/// panel's header.
public struct CodeV2ScreenPane: View {
    let actions: [CodeV2.ComputerAction]
    @Binding var selected: String?

    public init(actions: [CodeV2.ComputerAction], selected: Binding<String?>) {
        self.actions = actions
        self._selected = selected
    }

    private var current: CodeV2.ComputerAction? {
        actions.first { $0.id == selected } ?? actions.last
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let current {
                GeometryReader { proxy in
                    CodeV2Frame(ref: current.screenshotRef, size: CGSize(width: proxy.size.width, height: proxy.size.width * 0.625))
                }
                .aspectRatio(1.6, contentMode: .fit)
                Text(current.caption).studioType(.small).foregroundStyle(Studio.Ink.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: JunoSpace.tight + 2) {
                        ForEach(actions, id: \.id) { action in
                            Button { selected = action.id } label: {
                                CodeV2Frame(ref: action.screenshotRef, size: CGSize(width: 77, height: 48))
                                    .opacity(action.id == current.id ? 1 : 0.6)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(action.caption)
                        }
                    }
                }
                .padding(.top, JunoSpace.tight)
            } else {
                Text("Nothing on screen yet. When an agent uses the computer, its frames appear here.")
                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(JunoSpace.regular)
    }
}
