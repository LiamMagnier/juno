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
        case .waiting: liveLine = "Waiting for you: wants to run a command"
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

// MARK: - Tree

/// The fan-out in the thread: a head line with the run's time and spend
/// against its budget, then each child on a hairline spine. Running, waiting
/// and failed children are open; finished ones fold to one line.
struct CodeV2AgentTree: View {
    let children: [CodeV2AgentNode]
    var selected: String?
    var budget: (spent: Double, limit: Double)?
    var select: (String) -> Void = { _ in }

    private var headline: (String, String?) {
        let workers = children.filter { $0.role == .worker }.count
        let others = children.filter { $0.role != .worker }
        let main = workers > 0 ? "\(workers) \(workers == 1 ? "worker" : "workers")" : "\(children.count) agents"
        let extra = workers > 0 && !others.isEmpty
            ? "and " + others.map { $0.role == .explorer ? "an explorer" : ($0.role == .reviewer ? "a reviewer" : "a helper") }.joined(separator: ", ")
            : nil
        return (main, extra)
    }

    private var trailing: String {
        let elapsed = children.compactMap(\.elapsedSeconds).max().map(CodeV2Formatting.duration(seconds:)) ?? ""
        guard let budget else { return elapsed }
        return "\(elapsed) · \(CodeV2ContextMath.dollars(budget.spent)) of \(CodeV2ContextMath.dollars(budget.limit))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.agents, size: 16).foregroundStyle(Studio.Ink.secondary).frame(width: 20)
                Text(headline.0).font(Studio.Font.labelEmphasis)
                if let extra = headline.1 { Text(extra).font(Studio.Font.label).foregroundStyle(Studio.Ink.secondary) }
                Spacer()
                Text(trailing).font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
            }
            .frame(minHeight: 30)
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                ForEach(children) { child in
                    CodeV2AgentChildRow(node: child, isSelected: selected == child.agentId, select: { select(child.agentId) })
                }
            }
            .padding(.leading, 10)
            .overlay(alignment: .leading) {
                Rectangle().fill(Studio.Surface.hairline).frame(width: 1).padding(.bottom, 14)
            }
        }
    }
}

struct CodeV2AgentChildRow: View {
    let node: CodeV2AgentNode
    let isSelected: Bool
    let select: () -> Void
    @State private var hovering = false

    private var isOpen: Bool { node.status != .completed && node.status != .interrupted }

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                Rectangle().fill(Studio.Surface.hairline).frame(width: 14, height: 1).padding(.top, 11)
                CodeV2StateGlyph(state: node.glyphState)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(node.title)
                            .font(Studio.Font.labelEmphasis)
                            .foregroundStyle(Studio.Ink.primary)
                            .underline(isSelected, color: Studio.Ink.secondary)
                            .lineLimit(1)
                        Spacer()
                        if let elapsed = node.elapsedSeconds {
                            Text(CodeV2Formatting.duration(seconds: elapsed)).font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                        }
                    }
                    HStack(spacing: JunoSpace.tight) {
                        Text(node.roleLabel)
                        Text("·")
                        CodeV2Mark(id: CodeV2Marks.markID(model: node.selection.model, instanceId: node.selection.instanceId), size: 13)
                        Text(CodeV2Formatting.modelName(node.selection.model))
                    }
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                    if isOpen || hovering || isSelected, let line = node.liveLine {
                        liveLine(line)
                    } else if let line = node.liveLine {
                        Text(line).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    }
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private func liveLine(_ line: String) -> some View {
        if node.status == .waiting, line.hasPrefix("Waiting for you:") {
            let rest = String(line.dropFirst("Waiting for you:".count))
            Text("\(Text("Waiting for you:").foregroundStyle(Studio.Signal.ink))\(Text(rest).foregroundStyle(Studio.Ink.secondary))")
                .font(Studio.Font.meta)
        } else if node.status == .running {
            JunoShimmerText(line)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .lineLimit(1)
        } else {
            Text(line).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(2)
        }
    }
}

// MARK: - Dock › Agents

/// Dock › Agents: the children as a list, or one child followed: who runs
/// it, the brief from the lead, its own steps, and a field to message it.
public struct CodeV2AgentsPane: View {
    let nodes: [CodeV2AgentNode]
    @Binding var selected: String?
    var message: ((String, String) -> Void)?
    var stop: ((String) -> Void)?

    @State private var draft = ""

    public init(nodes: [CodeV2AgentNode], selected: Binding<String?>, message: ((String, String) -> Void)? = nil, stop: ((String) -> Void)? = nil) {
        self.nodes = nodes
        self._selected = selected
        self.message = message
        self.stop = stop
    }

    public var body: some View {
        if let id = selected, let node = nodes.first(where: { $0.agentId == id }) {
            detail(node)
        } else if nodes.isEmpty {
            Text("No subagents in this thread yet. Choose Lead + workers in Orchestrate to fan out.")
                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    ForEach(nodes) { node in
                        CodeV2AgentChildRow(node: node, isSelected: false, select: { selected = node.agentId })
                    }
                }
                .padding(JunoSpace.regular)
            }
        }
    }

    private func detail(_ node: CodeV2AgentNode) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Button { selected = nil } label: { JunoIconView(.chevronLeft, size: 13) }
                    .buttonStyle(StudioIconButtonStyle()).contentShape(.rect)
                    .accessibilityLabel("All agents")
                CodeV2Mark(id: CodeV2Marks.markID(model: node.selection.model, instanceId: node.selection.instanceId), size: 16)
                Text(node.roleLabel).font(Studio.Font.labelEmphasis)
                Text(CodeV2Formatting.modelName(node.selection.model)).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                Spacer()
                if let stop, node.status == .running || node.status == .waiting {
                    Button("Stop") { stop(node.agentId) }.buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 44)
            .studioHairline(.bottom)
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    Text("Task from the lead").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    Text(node.title).studioReadingFont().foregroundStyle(Studio.Ink.primary)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(node.steps, id: \.id) { item in
                            if let row = CodeV2StepRow.make(item) { CodeV2StepRowView(row: row) }
                        }
                        if let line = node.liveLine, node.steps.isEmpty {
                            Text(line).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(JunoSpace.regular)
            }
            if let message {
                HStack(spacing: JunoSpace.snug) {
                    TextField("Message \(node.roleLabel)", text: $draft)
                        .textFieldStyle(.plain)
                        .font(Studio.Font.label)
                        .onSubmit { send(node, message) }
                    Button { send(node, message) } label: {
                        JunoIconView(.arrowUp, size: 13, weight: .bold)
                            .foregroundStyle(Studio.Surface.canvas)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(draft.isEmpty ? Studio.Ink.tertiary : Studio.Ink.primary))
                            .frame(width: 28, height: 28)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(draft.isEmpty)
                    .accessibilityLabel("Send to \(node.roleLabel)")
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous).fill(Studio.Surface.raised))
                .overlay(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous).strokeBorder(Studio.Surface.hairline))
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

/// Dock › Agents under Best of N: one column per candidate, each with its
/// model, time, cost, diff size and test line, and "Keep this one".
public struct CodeV2BestOfNCompare: View {
    let candidates: [CodeV2BestOfNCandidate]
    var keep: (String) -> Void

    public init(candidates: [CodeV2BestOfNCandidate], keep: @escaping (String) -> Void) {
        self.candidates = candidates
        self.keep = keep
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Each candidate ran in its own worktree. Keep one; the others are deleted.")
                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: JunoSpace.snug) {
                    ForEach(candidates) { candidate in column(candidate) }
                }
            }
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func column(_ candidate: CodeV2BestOfNCandidate) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                CodeV2Mark(id: CodeV2Marks.markID(model: candidate.selection.model, instanceId: candidate.selection.instanceId), size: 16)
                VStack(alignment: .leading, spacing: 0) {
                    Text(CodeV2Formatting.modelName(candidate.selection.model)).font(Studio.Font.labelEmphasis).lineLimit(1)
                    Text(candidate.instanceLabel).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
            }
            Text([CodeV2Formatting.duration(seconds: candidate.elapsedSeconds), candidate.costUsd.map(CodeV2ContextMath.dollars)]
                .compactMap { $0 }.joined(separator: " · "))
                .font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
            if candidate.isFinished {
                CodeV2DiffCounts(additions: candidate.additions, deletions: candidate.deletions, font: Studio.Font.mono)
            }
            if let tests = candidate.testsLine {
                Text(tests).font(Studio.Font.meta).foregroundStyle(Studio.Ink.primary)
            }
            if candidate.isFinished {
                Text(candidate.summary).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                HStack(spacing: JunoSpace.tight) {
                    CodeV2StateGlyph(state: .running, size: 14)
                    JunoShimmerText(candidate.summary).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            Button("Keep this one") { keep(candidate.id) }
                .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                .disabled(!candidate.isFinished)
        }
        .padding(JunoSpace.cozy)
        .frame(width: 196, alignment: .topLeading)
        .frame(minHeight: 230, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).fill(Studio.Surface.raised))
        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous).strokeBorder(Studio.Surface.hairline))
    }
}

// MARK: - Computer use

extension CodeV2.ComputerAction {
    /// "Click 'Save'", "Type 'cart total'", "Open Safari".
    var caption: String {
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
        }
    }
}

/// The computer-use timeline in the thread (DESIGN §5.15): a step row with
/// the app, then a filmstrip of frames captioned with their action, the
/// latest one larger. Clicking a frame opens Dock › Screen.
struct CodeV2ComputerStrip: View {
    let actions: [CodeV2.ComputerAction]
    var open: (String) -> Void = { _ in }

    private var app: String {
        actions.first { $0.action == .openApp }?.target ?? "the computer"
    }
    private var isActive: Bool { actions.contains { $0.status == .running || $0.status == .pending } }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.close) {
                if isActive { CodeV2StateGlyph(state: .running) } else {
                    JunoIconView(.monitor, size: 16).foregroundStyle(Studio.Ink.secondary).frame(width: 20, height: 20)
                }
                Text(isActive ? "Using the computer" : "Used the computer").font(Studio.Font.label)
                Text(app).font(Studio.Font.mono).foregroundStyle(Studio.Ink.secondary)
            }
            .frame(minHeight: Studio.Metrics.rowHeight)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .bottom, spacing: JunoSpace.snug) {
                    ForEach(Array(actions.enumerated()), id: \.element.id) { index, action in
                        let latest = index == actions.count - 1
                        Button { open(action.id) } label: {
                            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                                CodeV2Frame(ref: action.screenshotRef, size: latest ? CGSize(width: 240, height: 150) : CGSize(width: 120, height: 75))
                                Text(action.caption).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                                    .frame(width: latest ? 240 : 120, alignment: .leading)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(action.caption)
                    }
                }
                .padding(.leading, 30)
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

/// Dock › Screen: the selected frame fit to width, a scrubber of frames, and
/// Pause / Take over / Stop (Esc).
public struct CodeV2ScreenPane: View {
    let actions: [CodeV2.ComputerAction]
    @Binding var selected: String?
    var pause: (() -> Void)?
    var takeOver: (() -> Void)?
    var stop: (() -> Void)?

    public init(actions: [CodeV2.ComputerAction], selected: Binding<String?>, pause: (() -> Void)? = nil, takeOver: (() -> Void)? = nil, stop: (() -> Void)? = nil) {
        self.actions = actions
        self._selected = selected
        self.pause = pause
        self.takeOver = takeOver
        self.stop = stop
    }

    private var current: CodeV2.ComputerAction? {
        actions.first { $0.id == selected } ?? actions.last
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let current {
                GeometryReader { proxy in
                    CodeV2Frame(ref: current.screenshotRef, size: CGSize(width: proxy.size.width, height: proxy.size.width * 0.625))
                }
                .aspectRatio(1.6, contentMode: .fit)
                Text(current.caption).font(Studio.Font.label)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: JunoSpace.tight) {
                        ForEach(actions, id: \.id) { action in
                            Button { selected = action.id } label: {
                                CodeV2Frame(ref: action.screenshotRef, size: CGSize(width: 64, height: 40))
                                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .strokeBorder(action.id == current.id ? Studio.Ink.primary : Color.clear, lineWidth: 1.5))
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(action.caption)
                        }
                    }
                }
                HStack(spacing: JunoSpace.snug) {
                    if let pause { Button("Pause", action: pause).buttonStyle(CodeV2OutlineButtonStyle(compact: true)) }
                    if let takeOver { Button("Take over", action: takeOver).buttonStyle(CodeV2OutlineButtonStyle(compact: true)) }
                    Spacer()
                    if let stop {
                        Button(action: stop) { HStack(spacing: JunoSpace.tight) { Text("Stop"); CodeV2Keycap(keys: "Esc") } }
                            .buttonStyle(CodeV2InkButtonStyle()).contentShape(.rect)
                    }
                }
            } else {
                Text("Nothing on screen yet. When an agent uses the computer, its frames appear here.")
                    .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(JunoSpace.regular)
    }
}
