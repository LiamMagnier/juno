import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import Observation

/// A session's command centre: the slash-command registry with project and
/// user commands, the sheets the verbs open, `/loop`s, and the session's
/// background sub-agents (CODE_AGENT_SPEC §5.2, §5.4, §5.16).
///
/// Owned by Lane F. `SessionController` holds one per session, so switching
/// sessions never carries one session's sheet, loop or sub-agent into
/// another.
@MainActor
@Observable
public final class CommandCenterModel {
    /// The session's background sub-agents (§5.2): `delegate_task` launches
    /// into it, the follow-up tools read it, Stop cancels it.
    public let backgroundSubagents = BackgroundSubagentRegistry()

    /// Every command the composer offers here, built-ins included.
    public private(set) var library: CodeSlashCommandLibrary = .builtIn
    /// The sheet a verb opened, or nil.
    public var activeSheet: CommandSheet?
    /// A question a verb needs answered first ("Replace the current goal?").
    public var confirmation: Confirmation?
    /// `/btw`: the side question and, once it comes, its answer.
    public var aside: Aside?
    /// The loops running in this session.
    public private(set) var loops: [SessionLoop] = []
    /// Handlers other lanes take over (§6.6).
    public var routes = SlashCommandRoutes()
    /// The models the reader can switch to, for `/model`.
    public var availableModels: [ModelOption] = []
    /// What answers `@preview:/route` mentions: the session's Preview, once
    /// the Preview lane provides one (§5.12).
    public var previewMentions: (any PreviewMentionProviding)?

    public init() {}

    // MARK: Types

    public struct Confirmation: Identifiable, Equatable {
        public enum Action: Equatable {
            case replaceGoal(String)
        }

        public let id = UUID()
        public let title: String
        public let message: String
        public let confirmLabel: String
        public let action: Action

        public static func == (lhs: Confirmation, rhs: Confirmation) -> Bool { lhs.id == rhs.id }
    }

    public struct Aside: Equatable {
        public let question: String
        /// Nil while the model is answering.
        public let answer: String?
    }

    /// One `/loop`: a prompt sent again on an interval while the session is
    /// idle, until Stop, the session closing, or a week has passed.
    public struct SessionLoop: Identifiable, Equatable {
        public let id: UUID
        public let prompt: String
        public let interval: TimeInterval
        /// True when the reader gave no interval and Juno chose it.
        public let isPacedByJuno: Bool
        public let startedAt: Date
        public let expiresAt: Date
        public internal(set) var runs: Int

        /// The loop in a line: "Looping every 10 min: check the deploy".
        public var line: String {
            "Looping every \(Self.describe(interval)): \(prompt)"
        }

        static func describe(_ interval: TimeInterval) -> String {
            switch interval {
            case ..<120: "\(Int(interval)) s"
            case ..<7_200: "\(Int((interval / 60).rounded())) min"
            case ..<172_800: "\(Int((interval / 3_600).rounded())) h"
            default: "\(Int((interval / 86_400).rounded())) days"
            }
        }
    }

    private var loopTasks: [UUID: Task<Void, Never>] = [:]

    // MARK: Library

    /// Reads the project's and the reader's commands again.
    public func reload(context: WorkspaceContext?) async {
        guard let context else {
            library = .builtIn
            return
        }
        library = .merged(
            workspace: await context.slashCommands(),
            user: context.userSlashCommands()
        )
    }

    /// Why a command cannot run now, for its dimmed menu row: a replaced
    /// command, or a verb that needs the session still while it is busy.
    public func unavailableReason(_ command: CodeSlashCommand, isBusy: Bool) -> String? {
        if let replacedBy = command.replacedBy {
            return "Replaced by \(replacedBy)"
        }
        guard let action = command.action, isBusy else { return nil }
        switch action {
        case .compact, .rewind, .fork, .initProject, .review:
            return "Available when Juno finishes"
        default:
            return nil
        }
    }

    // MARK: Running

    /// Runs a chosen or typed command. Returns false when it could not run
    /// now, so its typed argument stays in the composer.
    ///
    /// A prompt command is already in the composer by the time this runs; a
    /// Claude Code command that was off is turned on, since choosing it is the
    /// reader turning it on.
    @discardableResult
    public func run(
        _ command: CodeSlashCommand,
        argument: String,
        host: any SlashCommandHost,
        view: SlashCommandViewActions = SlashCommandViewActions(),
        imports: UserExtensionPolicyStore? = nil
    ) -> Bool {
        guard let action = command.action else {
            if !command.isEnabled, case .claudeImport = command.source {
                try? imports?.setEnabled(true, kind: CodeSlashCommand.importKind, name: command.name)
            }
            return true
        }
        switch SlashCommandParser.intent(for: action, argument: argument) {
        case let .failure(error):
            host.commandNotice(error.message)
            return false
        case let .success(intent):
            if intent.needsIdleSession, host.commandSessionIsBusy {
                host.commandNotice("/\(command.name) is available when Juno finishes.")
                return false
            }
            Task { await SlashCommandHandlers.perform(intent, host: host, center: self, view: view) }
            return true
        }
    }

    /// Runs a parsed verb and waits for it: tests, and callers that must
    /// know it finished (the App Intent setting a goal).
    func perform(_ intent: SlashCommandIntent, host: any SlashCommandHost, view: SlashCommandViewActions = SlashCommandViewActions()) async {
        await SlashCommandHandlers.perform(intent, host: host, center: self, view: view)
    }

    /// Answers a confirmation the reader was asked.
    public func confirm(_ confirmation: Confirmation, host: any SlashCommandHost) async {
        self.confirmation = nil
        switch confirmation.action {
        case let .replaceGoal(objective):
            if let problem = await host.commandClearGoal() {
                host.commandNotice(problem)
                return
            }
            await SlashCommandHandlers.startGoal(objective, host: host)
        }
    }

    public func present(_ sheet: CommandSheet) {
        activeSheet = sheet
    }

    // MARK: Loops

    /// Starts a loop. Refused past ten in a session.
    func startLoop(every interval: TimeInterval?, prompt: String, host: any SlashCommandHost, now: Date = Date()) {
        guard loops.count < SlashCommandParser.maximumLoopsPerSession else {
            host.commandNotice("A session runs at most \(SlashCommandParser.maximumLoopsPerSession) loops. Stop one with /loop stop.")
            return
        }
        let pace = interval ?? SlashCommandParser.defaultLoopInterval
        let loop = SessionLoop(
            id: UUID(),
            prompt: prompt,
            interval: pace,
            isPacedByJuno: interval == nil,
            startedAt: now,
            expiresAt: now.addingTimeInterval(SlashCommandParser.maximumLoopInterval),
            runs: 0
        )
        loops.append(loop)
        host.commandNotice(loop.line + (loop.isPacedByJuno ? " (Juno's pace)." : "."))
        loopTasks[loop.id] = Task { [weak self, weak host] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(pace))
                guard !Task.isCancelled, let self, let host else { return }
                guard Date() < loop.expiresAt else {
                    self.stopLoop(loop.id)
                    return
                }
                // A tick while the session is busy waits for the next one:
                // a loop never steers or queues into a run.
                guard !host.commandSessionIsBusy else { continue }
                if let index = self.loops.firstIndex(where: { $0.id == loop.id }) {
                    self.loops[index].runs += 1
                }
                if let problem = await host.commandSend(prompt, behavior: nil) {
                    host.commandNotice("The loop could not send: \(problem)")
                }
            }
        }
    }

    public func stopLoop(_ id: UUID) {
        loopTasks[id]?.cancel()
        loopTasks[id] = nil
        loops.removeAll { $0.id == id }
    }

    public func stopLoops() {
        for id in loops.map(\.id) { stopLoop(id) }
    }

    /// The session's Stop: every loop and every background sub-agent.
    public func stopEverything() async {
        stopLoops()
        await backgroundSubagents.cancelAll()
    }
}

extension CommandCenterModel {
    /// The model `/model <name>` means: an exact id, the id without its
    /// provider, or a display name, ignoring case.
    func model(matching query: String) -> ModelOption? {
        let needle = query.lowercased()
        return availableModels.first { $0.modelID.lowercased() == needle }
            ?? availableModels.first { $0.modelID.lowercased().split(separator: ":").last.map(String.init) == needle }
            ?? availableModels.first { $0.displayName.lowercased() == needle }
            ?? availableModels.first { $0.displayName.lowercased().replacingOccurrences(of: " ", with: "-") == needle }
    }
}
