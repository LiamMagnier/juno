import AppKit
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import JunoScreenControl

// MARK: - Node

/// One child in the agent tree (DESIGN §5.12), derived from its `subagent`
/// item and the child's own messages in the thread.
public struct CodeV2AgentNode: Identifiable, Equatable, Sendable {
    public var id: String { agentId }
    public var agentId: String
    public var role: CodeV2.AgentRole
    public var roleLabel: String
    /// Plan → Build → Verify: the phase it ran in.
    public var phase: CodeV2.TeamPhase?
    public var selection: CodeV2.ModelSelection
    public var status: CodeV2.SubagentStatus
    public var title: String
    public var task: String
    /// What it is doing now, its closing sentence, or what it waits on.
    public var liveLine: String?
    public var elapsedSeconds: Int?
    public var steps: [CodeV2.TurnItem]

    public init(subagent: CodeV2.Subagent, items: [CodeV2.TurnItem], now: Date = Date(), ordinal: Int? = nil) {
        agentId = subagent.agentId
        role = subagent.role
        phase = subagent.phase
        selection = subagent.model
        status = subagent.status
        let task = subagent.task ?? "Subagent"
        self.task = task
        title = subagent.title ?? subagent.label ?? task.split(separator: "\n").first.map(String.init) ?? task
        let own = items.filter { item in
            item.traceAgentId == subagent.agentId
        }
        steps = own
        let latest: String? = own.last.flatMap { item in
            if case let .assistantMessage(message) = item { return message.text } else { return nil }
        }
        switch subagent.status {
        case .waiting: liveLine = "Waiting for you"
        case .completed, .interrupted: liveLine = subagent.closingText ?? latest
        case .failed: liveLine = subagent.closingText ?? "Stopped after an error."
        case .running: liveLine = subagent.liveLine ?? latest
        }
        let index = ordinal ?? Int(subagent.agentId.filter(\.isNumber)) ?? 1
        switch subagent.role {
        case .worker: roleLabel = subagent.phase == .build ? "Builder \(index)" : "Worker \(index)"
        case .explorer: roleLabel = "Explorer"
        case .reviewer: roleLabel = subagent.phase == .verify ? "Verifier" : "Reviewer"
        case .orchestrator: roleLabel = "Lead"
        case .compaction: roleLabel = "Compaction"
        case .architect: roleLabel = "Architect"
        }
        if let label = subagent.label, !label.isEmpty { roleLabel = label }
        if let elapsed = subagent.elapsedMs { elapsedSeconds = max(0, Int(elapsed / 1_000)) }
        else if let start = CodeV2Dates.parse(subagent.createdAt) {
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
        // A Plan → Build → Verify team says what it did, phase by phase.
        if children.contains(where: { $0.phase != nil }) {
            let phases = CodeV2.TeamPhase.allCases.filter { phase in children.contains { $0.phase == phase } }
            return phases.map(CodeV2Team.phaseTitle).joined(separator: " → ")
        }
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

    /// Panel › Agents before any agent ran, in the words of the thread's team.
    static func empty(team: CodeV2.RolePreset?) -> String {
        switch team {
        case .planBuildVerify?, .leadWorkers?:
            "Team is on. The lead plans, then starts its builders and a verifier when you send a message."
        case .bestOfN?:
            "Best of N is on. Each model starts its own attempt when you send a message."
        case .solo?, nil:
            "No agents in this thread yet. Ask for subagents in your message, or set Team in the composer to run a lead with builders."
        }
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
                    if children.contains(where: { $0.phase != nil }) {
                        ForEach(CodeV2.TeamPhase.allCases, id: \.self) { phase in
                            let members = children.filter { $0.phase == phase }
                            if !members.isEmpty {
                                Text(CodeV2Team.phaseTitle(phase))
                                    .studioType(.small)
                                    .foregroundStyle(Studio.Ink.secondary)
                                    .padding(.top, phase == .plan ? 0 : JunoSpace.tight)
                                    .accessibilityAddTraits(.isHeader)
                                ForEach(members) { child in
                                    CodeV2AgentLine(node: child, isSelected: selected == child.agentId) { select(child.agentId) }
                                }
                            }
                        }
                        ForEach(children.filter { $0.phase == nil }) { child in
                            CodeV2AgentLine(node: child, isSelected: selected == child.agentId) { select(child.agentId) }
                        }
                    } else {
                        ForEach(children) { child in
                            CodeV2AgentLine(node: child, isSelected: selected == child.agentId) { select(child.agentId) }
                        }
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
                Text(node.title)
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
    var message: ((String, String) async -> String?)?
    var stop: ((String) -> Void)?
    /// The thread's team preset, for the empty state's words.
    var team: CodeV2.RolePreset?

    @State private var draft = ""
    @State private var sending = false
    @State private var deliveryError: String?

    public init(
        nodes: [CodeV2AgentNode], selected: Binding<String?>, spend: (spent: Double, limit: Double)? = nil,
        message: ((String, String) async -> String?)? = nil, stop: ((String) -> Void)? = nil,
        team: CodeV2.RolePreset? = nil
    ) {
        self.nodes = nodes
        self._selected = selected
        self.spend = spend
        self.message = message
        self.stop = stop
        self.team = team
    }

    public var body: some View {
        if let id = selected, let node = nodes.first(where: { $0.agentId == id }) {
            detail(node)
        } else if nodes.isEmpty {
            Text(CodeV2AgentCopy.empty(team: team))
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
                        agentSection("Active", nodes.filter { $0.status == .running || $0.status == .waiting })
                        agentSection("Done", nodes.filter { $0.status != .running && $0.status != .waiting })
                    }
                }
            }
        }
    }

    @ViewBuilder private func agentSection(_ title: String, _ members: [CodeV2AgentNode]) -> some View {
        if !members.isEmpty {
            Text("\(title) · \(members.count)").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, JunoSpace.regular).padding(.top, JunoSpace.cozy)
            ForEach(members) { node in
                Button { selected = node.agentId } label: { row(node) }
                    .buttonStyle(CodeV2RowButtonStyle()).contentShape(.rect)
                    .accessibilityHint("Open the full activity trace")
            }
        }
    }

    private func row(_ node: CodeV2AgentNode) -> some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: JunoSpace.tight + 2) {
                    Text(node.title).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
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
                        Text(node.title)
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
                        .contentShape(.rect)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(height: 40)
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    Text("Task from the lead").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    Text(node.task).studioType(.text).foregroundStyle(Studio.Ink.primary).textSelection(.enabled)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(node.steps, id: \.id) { item in
                            if case let .assistantMessage(message) = item {
                                JunoMarkdownText(message.text, streaming: message.streaming)
                            } else if case let .reasoning(reasoning) = item {
                                CodeV2ReasoningSummary(text: reasoning.text, streaming: reasoning.streaming)
                                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                            } else if let row = CodeV2StepRow.make(item) { CodeV2StepRowView(row: row) }
                        }
                        if node.steps.isEmpty {
                            Text(node.status == .running ? "Waiting for activity from the provider…" : "The provider did not share a live trace for this run.")
                                .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                            if let result = node.liveLine, !result.isEmpty {
                                JunoMarkdownText(result)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(JunoSpace.regular)
            }
            if let message, node.status == .running || node.status == .waiting {
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
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send to \(node.roleLabel)")
                }
                .padding(.leading, JunoSpace.cozy + 2)
                .padding(.trailing, JunoSpace.tight)
                .frame(height: 40)
                .junoComposerGlass(cornerRadius: Studio.Radius.bubble)
                .padding(JunoSpace.cozy)
                if let deliveryError {
                    Text(deliveryError).studioType(.small).foregroundStyle(Studio.Ink.secondary)
                        .padding(.horizontal, JunoSpace.cozy).padding(.bottom, JunoSpace.cozy)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
        }
        .onChange(of: selected) { _, _ in draft = ""; deliveryError = nil }
    }

    private func send(_ node: CodeV2AgentNode, _ message: @escaping (String, String) async -> String?) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        deliveryError = nil
        Task { @MainActor in
            let error = await message(node.agentId, text)
            sending = false
            guard selected == node.agentId else { return }
            deliveryError = error
            if error == nil, draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
        }
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
    var inspect: ((String) -> Void)?
    @State private var chosen: String?

    public init(candidates: [CodeV2BestOfNCandidate], keep: @escaping (String) -> Void, inspect: ((String) -> Void)? = nil) {
        self.candidates = candidates
        self.keep = keep
        self.inspect = inspect
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
                            .contentShape(.rect)
                    }
                }
                .padding(JunoSpace.tight + 2)
            }
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            HStack {
                Text("The others' worktrees are removed.").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                Spacer()
                if let index = candidates.firstIndex(where: { $0.id == selected }) {
                    if let inspect {
                        Button("Open trace") { inspect(candidates[index].id) }.buttonStyle(.borderless)
                    }
                    Button("Keep \(letter(index))") { keep(candidates[index].id) }
                        .buttonStyle(CodeV2InkButtonStyle())
                        .disabled(!candidates[index].isFinished)
                        .contentShape(.rect)
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
            // The latest picture, never a placeholder: a step without one
            // (refused, or still running) shows its line only.
            if let last = actions.last(where: { CodeV2Frame.hasImage($0.screenshotRef) }) {
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

/// A screenshot frame: the stored picture behind `ref` (an `alevr-shot://`
/// reference, resolved by the screenshot store, or a file path). Callers show
/// it only when ``hasImage(_:)``; without a picture it is a plain well, never
/// a skeleton that waits for something that will not come.
struct CodeV2Frame: View {
    let ref: String?
    let size: CGSize

    static func image(for ref: String?) -> NSImage? {
        guard let ref, !ref.isEmpty else { return nil }
        if let url = ComputerScreenshotStore.shared.url(for: ref) { return NSImage(contentsOf: url) }
        if ref.hasPrefix("/") { return NSImage(contentsOfFile: ref) }
        return nil
    }

    static func hasImage(_ ref: String?) -> Bool {
        guard let ref, !ref.isEmpty else { return false }
        if let url = ComputerScreenshotStore.shared.url(for: ref) { return FileManager.default.fileExists(atPath: url.path) }
        return ref.hasPrefix("/") && FileManager.default.fileExists(atPath: ref)
    }

    var body: some View {
        Group {
            if let image = Self.image(for: ref) {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                Studio.Surface.muted
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Studio.Surface.hairline))
    }
}

/// This conversation is waiting for another one that has the app it needs.
/// Built from the live holds, so it names the conversation that really has
/// the app, and it is never shown for this conversation itself.
public struct CodeV2ScreenBusy: Equatable, Sendable {
    /// The hold to end on Take over.
    public var holderID: String
    /// The conversation to open.
    public var conversationID: String
    /// "‘Fix the export sheet’".
    public var name: String
    public var app: String?
    /// A Work task or a takeover: it has the whole screen.
    public var wholeScreen: Bool

    public init(holderID: String, conversationID: String, name: String, app: String?, wholeScreen: Bool) {
        self.holderID = holderID
        self.conversationID = conversationID
        self.name = name
        self.app = app
        self.wholeScreen = wholeScreen
    }

    public var title: String { "Waiting for \(name)" }

    public var detail: String {
        if wholeScreen {
            return "It has the whole screen right now. This conversation can carry on when it finishes, or you can take over now."
        }
        let app = self.app ?? "that app"
        return "It is using \(app), which this conversation needs too. Wait for it to finish, or take over to bring \(app) here."
    }

    /// The busy state for `conversationID`'s latest step, or nil: the step
    /// was refused because the app was taken, and another conversation (never
    /// this one) still holds it.
    public static func resolve(conversationID: String, actions: [CodeV2.ComputerAction], holds: [ScreenControlHold]) -> CodeV2ScreenBusy? {
        guard let last = actions.last, last.status == .declined || last.status == .failed else { return nil }
        let reason = last.error ?? last.summary ?? ""
        guard reason.contains(" is using ") || reason.contains("must finish before") else { return nil }
        let wanted = last.app ?? last.target
        let other = holds.first { hold in
            hold.holder.conversationID != conversationID
                && ComputerBridgeExecutor.conversationID(hold.holder.conversationID) != conversationID
                && hold.blocks(app: wanted)
        }
        guard let other else { return nil }
        return CodeV2ScreenBusy(
            holderID: other.holder.id,
            conversationID: ComputerBridgeExecutor.conversationID(other.holder.conversationID),
            name: other.holder.name,
            app: other.holder.appName ?? wanted,
            wholeScreen: other.exclusive
        )
    }
}

/// "Waiting for ‘Fix the export sheet’", what it holds, and the two ways
/// forward: give the app to this conversation, or go to that one.
struct CodeV2ScreenBusyPanel: View {
    let busy: CodeV2ScreenBusy
    var takeOver: (() -> Void)?
    var open: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(busy.title)
                .studioType(.textMedium)
                .foregroundStyle(Studio.Ink.primary)
                .lineLimit(2)
            Text(busy.detail)
                .studioType(.small)
                .foregroundStyle(Studio.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if takeOver != nil || open != nil {
                HStack(spacing: JunoSpace.snug) {
                    if let takeOver {
                        Button("Take over", action: takeOver)
                            .buttonStyle(CodeV2InkButtonStyle())
                            .help("End the other conversation's hold so this one can use \(busy.app ?? "the app")")
                            .contentShape(.rect)
                            .accessibilityIdentifier("alevr.code.screen.take-over")
                    }
                    if let open {
                        Button("Open conversation", action: open)
                            .buttonStyle(.bordered)
                            .help("Go to \(busy.name)")
                            .contentShape(.rect)
                            .accessibilityIdentifier("alevr.code.screen.open-holder")
                    }
                    Spacer(minLength: 0)
                }
                .controlSize(.regular)
                .padding(.top, JunoSpace.tight)
            }
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoGlass(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(busy.title)
    }
}

/// Panel › Screen (TARGET §10.5): the latest frame at full width, the step
/// as a caption, a thin filmstrip of earlier frames. Stop lives in the
/// panel's header. Only real pictures are drawn: a refused or running step
/// has its caption, and a wait for another conversation has its panel.
public struct CodeV2ScreenPane: View {
    let actions: [CodeV2.ComputerAction]
    @Binding var selected: String?
    var busy: CodeV2ScreenBusy?
    var takeOver: (() -> Void)?
    var openConversation: (() -> Void)?

    public init(
        actions: [CodeV2.ComputerAction], selected: Binding<String?>, busy: CodeV2ScreenBusy? = nil,
        takeOver: (() -> Void)? = nil, openConversation: (() -> Void)? = nil
    ) {
        self.actions = actions
        self._selected = selected
        self.busy = busy
        self.takeOver = takeOver
        self.openConversation = openConversation
    }

    private var pictured: [CodeV2.ComputerAction] {
        actions.filter { CodeV2Frame.hasImage($0.screenshotRef) }
    }

    private var current: CodeV2.ComputerAction? {
        actions.first { $0.id == selected } ?? actions.last
    }

    /// The picture for the current step: its own, else the latest before it.
    private var shown: CodeV2.ComputerAction? {
        guard let current else { return pictured.last }
        if CodeV2Frame.hasImage(current.screenshotRef) { return current }
        guard let index = actions.firstIndex(where: { $0.id == current.id }) else { return pictured.last }
        return actions[..<index].last { CodeV2Frame.hasImage($0.screenshotRef) }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let busy {
                CodeV2ScreenBusyPanel(busy: busy, takeOver: takeOver, open: openConversation)
            }
            if let shown {
                GeometryReader { proxy in
                    CodeV2Frame(ref: shown.screenshotRef, size: CGSize(width: proxy.size.width, height: proxy.size.width * 0.625))
                }
                .aspectRatio(1.6, contentMode: .fit)
            }
            if let current, busy == nil || current.status == .completed {
                Text(current.caption).studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if pictured.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: JunoSpace.tight + 2) {
                        ForEach(pictured, id: \.id) { action in
                            Button { selected = action.id } label: {
                                CodeV2Frame(ref: action.screenshotRef, size: CGSize(width: 77, height: 48))
                                    .opacity(action.id == shown?.id ? 1 : 0.6)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(action.caption)
                        }
                    }
                }
                .padding(.top, JunoSpace.tight)
            }
            if current == nil, busy == nil {
                Text("Nothing on screen yet. When an agent uses the computer, its frames appear here.")
                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(JunoSpace.regular)
    }
}


struct CodeV2ReasoningSummary: View {
    let text: String
    let streaming: Bool
    @State private var expanded = true
    var body: some View {
        DisclosureGroup("Reasoning summary", isExpanded: $expanded) {
            JunoMarkdownText(text, streaming: streaming)
        }
    }
}
