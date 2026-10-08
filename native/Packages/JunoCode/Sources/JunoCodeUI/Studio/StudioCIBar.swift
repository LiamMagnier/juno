import AppKit
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

// The rows Lane E puts above the composer and in the thread (CODE_AGENT_SPEC
// §5.3, §1.12, §5.7): CI for the session's pull request with Fix it and
// Auto-fix, Resume for a run Juno quit in the middle of, and where a session
// in its own worktree is working. Words only, in the Studio style: no
// pills, no status dots. Owned by Lane E.

/// "CI for #42: 3 of 4 checks passed; `test (ubuntu)` failed", in the thread.
struct StudioCIStatusRow: View {
    let event: CIStatusEvent

    var body: some View {
        Text(StudioRunRow.markdown(Self.caption(for: event)))
            .font(Studio.Font.meta)
            .foregroundStyle(Studio.Ink.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 17)
    }

    static func caption(for event: CIStatusEvent) -> String {
        let prefix = event.pullRequestNumber.map { "CI for #\($0): " } ?? "CI: "
        return prefix + CIStatusWords.summary(event.checks)
    }
}

/// Everything Lane E shows above the composer, top to bottom: Resume for an
/// interrupted run, the worktree a session works in, and its CI.
public struct StudioShipBar: View {
    let controller: SessionController

    public init(controller: SessionController) {
        self.controller = controller
    }

    public var body: some View {
        VStack(spacing: JunoSpace.snug) {
            if controller.isInterrupted, !controller.isRunning {
                StudioInterruptedRow(
                    unknownCalls: controller.interruptedCallSummaries,
                    resume: { await controller.resumeInterrupted() }
                )
            }
            StudioWorktreeLine(controller: controller)
            StudioCIBar(pullRequest: controller.reviewQueue.pullRequest)
        }
    }
}

/// "Juno quit while this was running", with Resume.
struct StudioInterruptedRow: View {
    let unknownCalls: [String]
    let resume: () async -> Bool

    @State private var isResuming = false
    @State private var problem: String?

    var body: some View {
        StudioShipCard {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text("Alevr quit while this was running.")
                        .font(Studio.Font.labelEmphasis)
                        .foregroundStyle(Studio.Ink.primary)
                    Spacer(minLength: JunoSpace.snug)
                    Button(isResuming ? "Resuming…" : "Resume") {
                        isResuming = true
                        problem = nil
                        Task {
                            if !(await resume()) {
                                problem = "Alevr could not resume: the session is busy."
                            }
                            isResuming = false
                        }
                    }
                    .buttonStyle(StudioPrimaryButtonStyle())
                    .contentShape(Capsule())
                    .disabled(isResuming)
                    .help("Carry on from where it stopped, with no new message")
                }
                if !unknownCalls.isEmpty {
                    Text("Running when it quit, outcome unknown: " + unknownCalls.joined(separator: ", "))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let problem {
                    Text(problem).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                }
            }
        }
    }
}

/// CI for the session's pull request, with Fix it and the Auto-fix switch.
public struct StudioCIBar: View {
    let pullRequest: PullRequestModel

    public init(pullRequest: PullRequestModel) {
        self.pullRequest = pullRequest
    }

    public var body: some View {
        if let text = pullRequest.barText {
            StudioShipCard {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    HStack(alignment: .center, spacing: JunoSpace.snug) {
                        Text(StudioRunRow.markdown(text))
                            .font(Studio.Font.label)
                            .foregroundStyle(Studio.Ink.primary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: JunoSpace.snug)
                        if let ref = pullRequest.pullRequest, let url = URL(string: ref.url) {
                            Button("#\(ref.number)") { NSWorkspace.shared.open(url) }
                                .buttonStyle(StudioQuietButtonStyle())
                                .contentShape(.rect)
                                .help("Open the pull request on GitHub")
                        }
                        if pullRequest.canFix {
                            Button(pullRequest.isFixing ? "Starting…" : "Fix it") {
                                Task { await pullRequest.fixIt() }
                            }
                            .buttonStyle(StudioSecondaryButtonStyle())
                            .contentShape(Capsule())
                            .help("Read the failing logs and work until CI passes. Every push asks you first.")
                        }
                        Toggle("Auto-fix", isOn: Binding(
                            get: { pullRequest.autoFix.isEnabled },
                            set: { pullRequest.setAutoFix($0) }
                        ))
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                        .font(Studio.Font.meta)
                        .help("When CI fails, start a fix automatically, at most \(CIAutoFixPolicy.maximumAttempts) times for this pull request. Every push still asks.")
                    }
                    if pullRequest.autoFix.isEnabled, pullRequest.pullRequest != nil {
                        Text(autoFixLine)
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.secondary)
                    }
                    if let problem = pullRequest.problem {
                        Text(problem).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(text)
        }
    }

    private var autoFixLine: String {
        if pullRequest.autoFixStopped {
            return "Auto-fix tried \(CIAutoFixPolicy.maximumAttempts) times. Fix it by hand, or ask Alevr."
        }
        let left = pullRequest.attemptsLeft
        return "Auto-fix is on: \(left == 1 ? "1 attempt" : "\(left) attempts") left. Every push asks you first."
    }
}

/// Where a session in its own worktree is working, its setup if it is
/// waiting, and Bring changes back.
struct StudioWorktreeLine: View {
    let controller: SessionController

    @State private var info: SessionWorktreeInfo?
    @State private var setup: String?
    @State private var problem: String?
    @State private var isBringingBack = false

    /// - Parameters:
    ///   - info, setup: what to show before the session's own are read; for
    ///     previews and snapshots, whose session has no worktree to read.
    init(controller: SessionController, info: SessionWorktreeInfo? = nil, setup: String? = nil) {
        self.controller = controller
        _info = State(initialValue: info)
        _setup = State(initialValue: setup)
    }

    var body: some View {
        Group {
            if let info {
                StudioShipCard {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        HStack(spacing: JunoSpace.snug) {
                            Text(StudioRunRow.markdown(info.headline))
                                .font(Studio.Font.meta)
                                .foregroundStyle(Studio.Ink.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: JunoSpace.snug)
                            Button("Bring changes back…") { isBringingBack = true }
                                .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                                .contentShape(.rect)
                                .font(Studio.Font.meta)
                        }
                        if let setup {
                            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                                // The exact bytes the approval remembers, drawn
                                // verbatim: never as Markdown, which could hide
                                // part of the command behind formatting.
                                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                                    Text("This worktree's setup has not run:")
                                        .font(Studio.Font.meta)
                                        .foregroundStyle(Studio.Ink.secondary)
                                    Text(verbatim: setup)
                                        .font(Studio.Font.monoSmall)
                                        .foregroundStyle(Studio.Ink.primary)
                                        .textSelection(.enabled)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: JunoSpace.snug)
                                Button("Allow and run") {
                                    Task {
                                        let result = await controller.reviewQueue.sessionActions?.runSetup(setup)
                                        if case let .refused(reason)? = result { problem = reason }
                                        self.setup = controller.reviewQueue.sessionActions?.pendingSetup()
                                    }
                                }
                                .buttonStyle(StudioSecondaryButtonStyle())
                                .contentShape(Capsule())
                                .help("Remembers these exact bytes for this project; an edited command asks again")
                            }
                        }
                        if let problem {
                            Text(problem).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                        }
                    }
                }
            }
        }
        .task(id: controller.sessionID) {
            guard controller.session.executionRootPath != nil,
                  let actions = controller.reviewQueue.sessionActions
            else { return }
            info = await actions.worktreeInfo()
            setup = actions.pendingSetup()
        }
        .sheet(isPresented: $isBringingBack) {
            StudioBringBackSheet(controller: controller) { isBringingBack = false }
                .junoSheetSurface(.fitted)
        }
    }
}

/// Bringing a worktree's changes back: each step with its exact command,
/// confirmed on its own.
struct StudioBringBackSheet: View {
    let controller: SessionController
    let dismiss: () -> Void

    @State private var method: WorktreeBringBackMethod = .merge
    @State private var steps: [WorktreeBringBackStep] = []
    @State private var done: Set<String> = []
    @State private var message: String?
    @State private var isWorking = false

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Bring changes back")
                .font(Studio.Font.title)
            Text("Each step runs only when you choose it.")
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
            Picker("How", selection: $method) {
                Text("Merge").tag(WorktreeBringBackMethod.merge)
                Text("Cherry-pick").tag(WorktreeBringBackMethod.cherryPick)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if steps.isEmpty {
                Text("Nothing to bring back: the worktree has no changes.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
            }
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                VStack(alignment: .leading, spacing: JunoSpace.hairline + 1) {
                    HStack {
                        Text("\(index + 1). \(step.title)")
                            .font(Studio.Font.label)
                        Spacer()
                        if done.contains(step.id) {
                            Text("Done").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                        } else {
                            Button("Run this step") { run(step) }
                                .buttonStyle(StudioSecondaryButtonStyle())
                                .contentShape(Capsule())
                                .disabled(isWorking || !isNext(step))
                        }
                    }
                    Text(step.command)
                        .font(Studio.Font.monoSmall)
                        .foregroundStyle(Studio.Ink.secondary)
                        .textSelection(.enabled)
                }
            }
            if let message {
                Text(message).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
            }
            HStack {
                Spacer()
                Button("Close", action: dismiss)
                    .buttonStyle(StudioSecondaryButtonStyle())
                    .contentShape(Capsule())
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 520)
        .task(id: method) { await load() }
    }

    private func isNext(_ step: WorktreeBringBackStep) -> Bool {
        steps.first { !done.contains($0.id) }?.id == step.id
    }

    private func load() async {
        guard let actions = controller.reviewQueue.sessionActions else { return }
        switch await actions.bringBackPlan(method) {
        case let .success(plan):
            steps = plan
            done = []
            message = nil
        case let .failure(error):
            steps = []
            message = error.localizedDescription
        }
    }

    private func run(_ step: WorktreeBringBackStep) {
        guard let actions = controller.reviewQueue.sessionActions else { return }
        isWorking = true
        Task {
            let result = await actions.performBringBack(step)
            isWorking = false
            switch result {
            case .done:
                done.insert(step.id)
                message = nil
            case let .refused(reason):
                message = reason
            }
        }
    }
}

/// The raised card the ship rows sit in, matching the approval card.
struct StudioShipCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                    .fill(Studio.Surface.raised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                    .strokeBorder(Studio.Surface.hairline)
            )
    }
}
