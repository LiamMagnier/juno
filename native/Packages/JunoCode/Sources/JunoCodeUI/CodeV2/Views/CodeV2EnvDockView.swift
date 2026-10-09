import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// The inspector dock for an env-server thread: Changes (checkpoint diffs
/// with per-hunk Accept / Reject), Agents (the fan-out, or Best of N side by
/// side) and Screen while computer use has frames.
public struct CodeV2EnvDockView: View {
    let session: CodeV2EnvSession
    @Bindable var dock: CodeV2DockController
    var applier = CodeV2HunkApplier()
    var bestOfN: [CodeV2BestOfNCandidate] = []
    var keepCandidate: ((String) -> Void)?
    var close: (() -> Void)?
    /// Files and Preview: the Studio session that holds the thread's place.
    var workspace: CodeV2DockWorkspace?
    /// Previews and snapshots: a terminal that never starts a shell.
    var previewTerminal: CodeV2EnvTerminal?

    @Environment(\.codeV2Now) private var pinnedNow

    public init(
        session: CodeV2EnvSession, dock: CodeV2DockController,
        bestOfN: [CodeV2BestOfNCandidate] = [], keepCandidate: ((String) -> Void)? = nil,
        close: (() -> Void)? = nil, workspace: CodeV2DockWorkspace? = nil,
        previewTerminal: CodeV2EnvTerminal? = nil
    ) {
        self.session = session
        self.dock = dock
        self.bestOfN = bestOfN
        self.keepCandidate = keepCandidate
        self.close = close
        self.workspace = workspace
        self.previewTerminal = previewTerminal
    }

    private var terminal: CodeV2EnvTerminal? { previewTerminal ?? session.terminal }

    private var snapshot: CodeV2.SessionSnapshot { session.snapshot }

    private var nodes: [CodeV2AgentNode] {
        let now = pinnedNow ?? Date()
        var ordinal = 0
        return snapshot.items.compactMap { item -> CodeV2AgentNode? in
            guard case let .subagent(child) = item else { return nil }
            if child.role == .worker { ordinal += 1 }
            return CodeV2AgentNode(subagent: child, items: snapshot.items, now: now, ordinal: child.role == .worker ? ordinal : nil)
        }
    }

    private var frames: [CodeV2.ComputerAction] {
        snapshot.items.compactMap { item in
            if case let .computerAction(action) = item { return action } else { return nil }
        }
    }

    private var tabs: [CodeV2DockTab] {
        CodeV2DockTabs.visible(
            hasTerminal: terminal != nil, hasWorkspace: workspace != nil, hasFrames: !frames.isEmpty
        )
    }

    private var files: [CodeV2DiffFile] {
        dock.scope == .thread ? session.threadDiff : session.turnDiff
    }

    public var body: some View {
        CodeV2Dock(
            tab: $dock.tab, tabs: tabs,
            counts: [.changes: session.threadDiff.count, .agents: nodes.count],
            close: close
        ) { tab in
            switch tab {
            case .changes:
                AnyView(
                    CodeV2ChangesPane(
                        files: files, scope: $dock.scope, decisions: dock.decisions, focusedPath: dock.focusedPath,
                        decide: { file, hunk, decision in decide(file, hunk, decision) },
                        failure: dock.failure
                    )
                    .task(id: "\(dock.scope)-\(snapshot.items.count)") { await reload() }
                )
            case .agents:
                if snapshot.routing?.preset == .bestOfN, !bestOfN.isEmpty {
                    AnyView(CodeV2BestOfNCompare(candidates: bestOfN, keep: { keepCandidate?($0) }))
                } else {
                    AnyView(CodeV2AgentsPane(nodes: nodes, selected: $dock.selectedAgent))
                }
            case .terminal:
                if let terminal {
                    AnyView(CodeV2TerminalPane(terminal: terminal, autoOpen: previewTerminal == nil))
                } else {
                    AnyView(EmptyView())
                }
            case .files:
                if let workspace {
                    AnyView(CodeV2FilesPane(controller: workspace.controller))
                } else {
                    AnyView(EmptyView())
                }
            case .preview:
                if let workspace, let target = dock.previewTarget(for: workspace) {
                    AnyView(CodePreviewDock(
                        target: target, lease: workspace.controller.previewLease,
                        close: { dock.tab = .changes },
                        openInWindow: { workspace.openPreviewWindow(target) }
                    ))
                } else {
                    AnyView(Text("Open a folder to preview it.").font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary).padding(JunoSpace.regular))
                }
            case .screen:
                AnyView(CodeV2ScreenPane(
                    actions: frames, selected: $dock.selectedFrame,
                    stop: { Task { await session.interrupt() } }
                ))
            }
        }
    }

    private func reload() async {
        guard dock.tab == .changes else { return }
        let latest = snapshot.items.last { if case .checkpoint = $0 { true } else { false } }
        if dock.scope == .turn, case let .checkpoint(checkpoint)? = latest {
            await session.loadDiff(checkpointId: checkpoint.checkpointId)
        } else if dock.scope == .thread {
            await session.loadDiff(checkpointId: nil)
        }
    }

    private func decide(_ file: CodeV2DiffFile, _ hunk: DiffHunk, _ decision: CodeV2HunkDecisions.Decision) {
        let directory = URL(fileURLWithPath: session.cwd)
        Task {
            do {
                try await applier.apply(decision == .accepted ? .accept : .reject, hunk: hunk, path: file.path, in: directory)
                dock.decisions.set(decision, for: hunk)
                dock.failure = nil
            } catch {
                dock.failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
