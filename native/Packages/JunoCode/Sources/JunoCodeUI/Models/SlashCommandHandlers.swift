import Foundation
import JunoCodeCore
import JunoCodeRuntime

// The session's slash verbs as handlers (CODE_AGENT_SPEC §5.4): each verb is
// parsed into an intent, and the intent is carried out against the session
// through `SlashCommandHost`. Parsing is pure so every verb's grammar is
// pinned by a test; carrying out goes through the host so a test can watch
// it without a window, a model or a workspace.
//
// A verb the reader types is the reader acting: `/goal fix the build` needs
// no approval card for the goal itself, the way pressing Pause needs none.
// What the verb then makes happen — a turn, a check, a review — runs under
// the session's mode and approvals exactly as if the reader had asked for it
// in words. No verb widens a permission.

// MARK: - Intents

/// What a typed verb asks for, once parsed.
public enum SlashCommandIntent: Equatable, Sendable {
    public enum Goal: Equatable, Sendable {
        case set(String)
        case show
        case pause
        case resume
        case edit
        case clear
    }

    public enum Verify: Equatable, Sendable {
        /// Every check the project has, every kind.
        case all
        /// Look for the project's checks again and show them.
        case setup
        /// Only these checks, by id or command.
        case checks([String])
    }

    public enum ReviewScope: Equatable, Sendable {
        case uncommitted
        case branch
        case lastTurn
        case commit(String)

        /// The scope in the reader's words.
        public var label: String {
            switch self {
            case .uncommitted: "the uncommitted changes"
            case .branch: "this branch against its merge base"
            case .lastTurn: "what the last turn changed"
            case let .commit(sha): "commit \(sha)"
            }
        }
    }

    public enum Loop: Equatable, Sendable {
        /// Run `prompt` every `interval` seconds; nil lets Juno pace it.
        case start(interval: TimeInterval?, prompt: String)
        case stop
    }

    case goal(Goal)
    case verify(Verify)
    case review(ReviewScope, fix: Bool)
    case sheet(CommandSheet)
    case compact(focus: String?)
    case rewind
    case model(String)
    case initProject
    case fork(prompt: String?)
    case loop(Loop)
    case export(toFile: Bool)
    case btw(String)

    /// Whether the verb needs the session to be still: anything that starts
    /// a turn, folds or forks the history. Sheets and loops do not.
    public var needsIdleSession: Bool {
        switch self {
        case .goal(.set), .verify(.all), .verify(.checks), .review, .compact, .rewind, .initProject, .fork:
            true
        case .goal, .verify(.setup), .sheet, .model, .loop, .export, .btw:
            false
        }
    }
}

/// The sheets the verbs open.
public enum CommandSheet: String, Identifiable, CaseIterable, Sendable {
    case context
    case cost
    case permissions
    case agents
    case mcp
    case hooks
    case tasks
    case memory
    case resume
    case model
    case goal
    case verify

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .context: "Context"
        case .cost: "Cost"
        case .permissions: "Permissions"
        case .agents: "Agents"
        case .mcp: "MCP servers"
        case .hooks: "Hooks"
        case .tasks: "Background work"
        case .memory: "Instruction files"
        case .resume: "Sessions"
        case .model: "Model"
        case .goal: "Goal"
        case .verify: "Checks"
        }
    }
}

/// Why a verb could not be parsed, in the reader's words.
public struct SlashCommandError: Error, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}

// MARK: - Parsing

public enum SlashCommandParser {
    /// `/loop`'s bounds (§5.16): at least a minute apart, for at most a week,
    /// at most ten at once in a session.
    public static let minimumLoopInterval: TimeInterval = 60
    public static let maximumLoopInterval: TimeInterval = 7 * 86_400
    public static let maximumLoopsPerSession = 10
    /// The pace of a loop given no interval, until the model can schedule its
    /// own wake-ups.
    public static let defaultLoopInterval: TimeInterval = 10 * 60

    public static func intent(
        for action: CodeSlashCommand.Action,
        argument rawArgument: String
    ) -> Result<SlashCommandIntent, SlashCommandError> {
        let argument = rawArgument.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = argument.split(whereSeparator: \.isWhitespace).map(String.init)
        switch action {
        case .goal:
            switch words.first?.lowercased() {
            case nil: return .success(.goal(.show))
            case "pause" where words.count == 1: return .success(.goal(.pause))
            case "resume" where words.count == 1: return .success(.goal(.resume))
            case "edit" where words.count == 1: return .success(.goal(.edit))
            case "clear", "stop", "off", "cancel":
                guard words.count == 1 else { return .success(.goal(.set(argument))) }
                return .success(.goal(.clear))
            default:
                guard argument.count <= 4_000 else {
                    return .failure(SlashCommandError("A goal can be at most 4,000 characters."))
                }
                return .success(.goal(.set(argument)))
            }

        case .verify:
            switch words.first?.lowercased() {
            case nil: return .success(.verify(.all))
            case "setup" where words.count == 1: return .success(.verify(.setup))
            default: return .success(.verify(.checks(words)))
            }

        case .review:
            let fix = words.contains("--fix")
            let rest = words.filter { $0 != "--fix" }
            guard rest.count <= 1 else {
                return .failure(SlashCommandError("/review takes one scope: uncommitted, branch, last-turn or a commit."))
            }
            switch rest.first?.lowercased() {
            case nil, "uncommitted": return .success(.review(.uncommitted, fix: fix))
            case "branch": return .success(.review(.branch, fix: fix))
            case "last-turn", "lastturn", "last": return .success(.review(.lastTurn, fix: fix))
            case let .some(word):
                guard isCommitish(word) else {
                    return .failure(SlashCommandError("\(word) is not a scope. Use uncommitted, branch, last-turn or a commit hash."))
                }
                return .success(.review(.commit(rest[0]), fix: fix))
            }

        case .context: return .success(.sheet(.context))
        case .cost: return .success(.sheet(.cost))
        case .permissions: return .success(.sheet(.permissions))
        case .agents: return .success(.sheet(.agents))
        case .mcp: return .success(.sheet(.mcp))
        case .hooks: return .success(.sheet(.hooks))
        case .tasks: return .success(.sheet(.tasks))
        case .memory: return .success(.sheet(.memory))
        case .resume: return .success(.sheet(.resume))
        case .compact: return .success(.compact(focus: argument.isEmpty ? nil : argument))
        case .rewind: return .success(.rewind)
        case .model: return .success(argument.isEmpty ? .sheet(.model) : .model(words[0]))
        case .initProject: return .success(.initProject)
        case .fork: return .success(.fork(prompt: argument.isEmpty ? nil : argument))
        case .export: return .success(.export(toFile: words.first?.lowercased() == "file"))
        case .btw:
            guard !argument.isEmpty else {
                return .failure(SlashCommandError("/btw needs a question."))
            }
            return .success(.btw(argument))
        case .loop:
            return loop(words: words)
        }
    }

    static func loop(words: [String]) -> Result<SlashCommandIntent, SlashCommandError> {
        guard let first = words.first else {
            return .failure(SlashCommandError("/loop needs a prompt, and optionally an interval first: /loop 10m check the deploy."))
        }
        if words.count == 1, ["stop", "off", "cancel", "clear"].contains(first.lowercased()) {
            return .success(.loop(.stop))
        }
        if let interval = interval(first) {
            let prompt = words.dropFirst().joined(separator: " ")
            guard !prompt.isEmpty else {
                return .failure(SlashCommandError("/loop needs a prompt after the interval."))
            }
            guard interval >= minimumLoopInterval else {
                return .failure(SlashCommandError("A loop runs at most once a minute."))
            }
            guard interval <= maximumLoopInterval else {
                return .failure(SlashCommandError("A loop runs at least once a week."))
            }
            return .success(.loop(.start(interval: interval, prompt: prompt)))
        }
        return .success(.loop(.start(interval: nil, prompt: words.joined(separator: " "))))
    }

    /// `90s`, `10m`, `2h`, `1d`; a bare number is minutes.
    public static func interval(_ token: String) -> TimeInterval? {
        let lowered = token.lowercased()
        let units: [(String, TimeInterval)] = [
            ("sec", 1), ("s", 1), ("min", 60), ("m", 60), ("h", 3_600), ("hr", 3_600), ("d", 86_400),
        ]
        if let value = Double(lowered), value > 0 { return value * 60 }
        for (suffix, scale) in units.sorted(by: { $0.0.count > $1.0.count }) where lowered.hasSuffix(suffix) {
            guard let value = Double(lowered.dropLast(suffix.count)), value > 0 else { return nil }
            return value * scale
        }
        return nil
    }

    /// A short or full hexadecimal commit hash.
    static func isCommitish(_ word: String) -> Bool {
        (7...40).contains(word.count) && word.allSatisfy(\.isHexDigit)
    }
}

// MARK: - Carrying out

/// What a verb needs from the session it runs in. `SessionController`
/// answers in production (`SessionController+Commands.swift`); a test answers
/// with a recording fake.
@MainActor
public protocol SlashCommandHost: AnyObject {
    /// A run, a fold or a rewind holds the session.
    var commandSessionIsBusy: Bool { get }
    var commandHasProject: Bool { get }
    var commandBehavior: AgentBehavior { get }
    /// The current goal, if any.
    var commandGoal: SessionGoal? { get }
    /// The project's known check commands.
    var commandCheckCommands: [String] { get }

    /// Starts a turn with `prompt` as the reader's message, under the
    /// session's mode (after switching behaviour, when given). Returns why
    /// it could not, or nil.
    func commandSend(_ prompt: String, behavior: AgentBehavior?) async -> String?
    func commandCompact(focus: String?) async
    func commandSetModel(_ modelID: String) async
    /// Says something to the reader, in the thread's notice line.
    func commandNotice(_ message: String?)

    func commandCreateGoal(objective: String) async -> String?
    func commandClearGoal() async -> String?
    func commandSetGoalLifecycle(_ lifecycle: GoalLifecycle) async
    func commandRediscoverChecks() async -> [String]
    /// Runs one check the reader asked for, through the session's approvals.
    func commandRunCheck(_ command: String) async
    /// The conversation as Markdown.
    func commandTranscriptMarkdown() -> String
    /// Puts text on the pasteboard, or writes it to a file the reader picks.
    func commandDeliverExport(_ markdown: String, toFile: Bool) async -> String?
    /// A new session with this conversation, its first message `prompt`.
    func commandFork(prompt: String?) async -> String?
    /// One side question to the model, answered outside the conversation.
    func commandAskAside(_ question: String) async -> String
}

/// The handlers a lane may take over, by verb (§6.6). Each starts as the
/// behaviour Juno has today and is replaced when the owning lane lands: the
/// goal runtime's sheet and start card (Lane A), the verify recipe and the
/// reviewer pass (Lane B), session forks (Lane E). Replacing one changes what
/// the verb does, never whether it is allowed.
@MainActor
public struct SlashCommandRoutes {
    public var goal: (@MainActor (SlashCommandIntent.Goal, any SlashCommandHost, CommandCenterModel) async -> Void)?
    public var verify: (@MainActor (SlashCommandIntent.Verify, any SlashCommandHost, CommandCenterModel) async -> Void)?
    public var review: (@MainActor (SlashCommandIntent.ReviewScope, Bool, any SlashCommandHost, CommandCenterModel) async -> Void)?
    public var fork: (@MainActor (String?, any SlashCommandHost, CommandCenterModel) async -> Void)?

    public init() {}
}

/// What the view holding the composer does for a verb: the pickers it owns.
@MainActor
public struct SlashCommandViewActions {
    public var openRewind: (() -> Void)?
    public var openReview: ((String?) -> Void)?

    public init(openRewind: (() -> Void)? = nil, openReview: ((String?) -> Void)? = nil) {
        self.openRewind = openRewind
        self.openReview = openReview
    }
}

@MainActor
enum SlashCommandHandlers {
    /// Carries out one parsed verb.
    static func perform(
        _ intent: SlashCommandIntent,
        host: any SlashCommandHost,
        center: CommandCenterModel,
        view: SlashCommandViewActions
    ) async {
        switch intent {
        case let .goal(goal):
            if let route = center.routes.goal {
                await route(goal, host, center)
            } else {
                await performGoal(goal, host: host, center: center)
            }

        case let .verify(verify):
            if let route = center.routes.verify {
                await route(verify, host, center)
            } else {
                await performVerify(verify, host: host, center: center)
            }

        case let .review(scope, fix):
            view.openReview?(nil)
            if let route = center.routes.review {
                await route(scope, fix, host, center)
            } else {
                await performReview(scope, fix: fix, host: host)
            }

        case let .sheet(sheet):
            center.present(sheet)

        case let .compact(focus):
            await host.commandCompact(focus: focus)

        case .rewind:
            if let openRewind = view.openRewind {
                openRewind()
            } else {
                host.commandNotice("There is nothing to rewind to yet.")
            }

        case let .model(query):
            // An id the catalog does not know would leave the session on a
            // model nobody can answer as.
            guard center.availableModels.isEmpty || center.model(matching: query) != nil else {
                host.commandNotice("No model is called \(query). Choose one from the list.")
                center.present(.model)
                return
            }
            let id = center.model(matching: query)?.modelID ?? query
            await host.commandSetModel(id)
            host.commandNotice("Switched to \(center.model(matching: id)?.displayName ?? id). The next turn reads the whole conversation again, without the cache.")

        case .initProject:
            if let problem = await host.commandSend(Self.initPrompt, behavior: .code) {
                host.commandNotice(problem)
            }

        case let .fork(prompt):
            if let route = center.routes.fork {
                await route(prompt, host, center)
            } else if let problem = await host.commandFork(prompt: prompt) {
                host.commandNotice(problem)
            }

        case let .loop(loop):
            switch loop {
            case let .start(interval, prompt):
                center.startLoop(every: interval, prompt: prompt, host: host)
            case .stop:
                let count = center.loops.count
                center.stopLoops()
                host.commandNotice(count == 0 ? "No loop is running." : "Stopped \(count == 1 ? "the loop" : "\(count) loops").")
            }

        case let .export(toFile):
            let markdown = host.commandTranscriptMarkdown()
            if let problem = await host.commandDeliverExport(markdown, toFile: toFile) {
                host.commandNotice(problem)
            } else {
                host.commandNotice(toFile ? "Saved the conversation as Markdown." : "Copied the conversation as Markdown.")
            }

        case let .btw(question):
            center.aside = CommandCenterModel.Aside(question: question, answer: nil)
            let answer = await host.commandAskAside(question)
            center.aside = CommandCenterModel.Aside(question: question, answer: answer)
        }
    }

    // MARK: Goal (until the goal runtime lands)

    static func performGoal(
        _ goal: SlashCommandIntent.Goal,
        host: any SlashCommandHost,
        center: CommandCenterModel
    ) async {
        switch goal {
        case let .set(objective):
            if let current = host.commandGoal, current.lifecycle != .completed {
                center.confirmation = CommandCenterModel.Confirmation(
                    title: "Replace the current goal?",
                    message: "“\(current.objective)” will be cleared and stay readable in the thread.",
                    confirmLabel: "Replace",
                    action: .replaceGoal(objective)
                )
                return
            }
            await startGoal(objective, host: host)
        case .show, .edit:
            center.present(.goal)
        case .pause:
            guard host.commandGoal != nil else {
                host.commandNotice("This session has no goal. Set one with /goal and what you want done.")
                return
            }
            await host.commandSetGoalLifecycle(.paused)
        case .resume:
            guard host.commandGoal != nil else {
                host.commandNotice("This session has no goal. Set one with /goal and what you want done.")
                return
            }
            await host.commandSetGoalLifecycle(.active)
        case .clear:
            guard host.commandGoal != nil else {
                host.commandNotice("This session has no goal to clear.")
                return
            }
            if let problem = await host.commandClearGoal() {
                host.commandNotice(problem)
            } else {
                host.commandNotice("Cleared the goal.")
            }
        }
    }

    /// Sets the goal and starts the first turn with the objective as the
    /// directive, as Claude Code does. The reader typing it is the approval.
    static func startGoal(_ objective: String, host: any SlashCommandHost) async {
        if let problem = await host.commandCreateGoal(objective: objective) {
            host.commandNotice(problem)
            return
        }
        if let problem = await host.commandSend(objective, behavior: .code) {
            host.commandNotice(problem)
        }
    }

    // MARK: Verify (until the verify recipe lands)

    static func performVerify(
        _ verify: SlashCommandIntent.Verify,
        host: any SlashCommandHost,
        center: CommandCenterModel
    ) async {
        switch verify {
        case .setup:
            let found = await host.commandRediscoverChecks()
            center.present(.verify)
            host.commandNotice(found.isEmpty
                ? "Juno found no checks in this project."
                : "Juno found \(found.count == 1 ? "one check" : "\(found.count) checks"): \(found.joined(separator: ", ")).")
        case .all:
            let commands = host.commandCheckCommands
            guard !commands.isEmpty else {
                host.commandNotice("Juno knows no checks for this project yet. Try /verify setup.")
                return
            }
            for command in commands {
                await host.commandRunCheck(command)
            }
        case let .checks(names):
            let commands = host.commandCheckCommands.filter { command in
                names.contains { command.localizedCaseInsensitiveContains($0) }
            }
            guard !commands.isEmpty else {
                host.commandNotice("No check matches \(names.joined(separator: " ")). /verify setup lists them.")
                return
            }
            for command in commands {
                await host.commandRunCheck(command)
            }
        }
    }

    // MARK: Review (until the reviewer pass lands)

    static func performReview(_ scope: SlashCommandIntent.ReviewScope, fix: Bool, host: any SlashCommandHost) async {
        let prompt = reviewPrompt(scope, fix: fix, canDelegate: host.commandBehavior == .code || fix)
        if let problem = await host.commandSend(prompt, behavior: fix ? .code : nil) {
            host.commandNotice(problem)
        }
    }

    /// The review turn's message. In Code the review goes to the built-in
    /// reviewer agent, read-only in a fresh context (§1.9); elsewhere the
    /// session reviews it itself, read-only.
    static func reviewPrompt(_ scope: SlashCommandIntent.ReviewScope, fix: Bool, canDelegate: Bool) -> String {
        let gather: String
        switch scope {
        case .uncommitted: gather = "Read the uncommitted changes (git status and git diff, staged and unstaged)."
        case .branch: gather = "Read this branch's changes against its merge base with the default branch."
        case .lastTurn: gather = "Read the files the last turn changed and their diffs."
        case let .commit(sha): gather = "Read commit \(sha) (git show \(sha))."
        }
        let how = canDelegate
            ? "Delegate the review with delegate_task to the agent \"reviewer\", giving it the diff and what the change was for, so it reads the change in a fresh context."
            : "Review it yourself, read-only."
        let report = """
            Report only correctness problems, security problems and requirements the change does not meet, \
            each with a priority (P0 to P3), a confidence, the file and line, and a one-line title. \
            A clean review is a valid answer.
            """
        let after = fix
            ? "Then fix the P0 and P1 findings, run the checks that cover them, and say what you changed."
            : "Change nothing."
        return "Review \(scope.label). \(gather) \(how) \(report) \(after)"
    }

    /// `/init`: a normal turn that proposes the project's instructions,
    /// checks and launch file as diffs for review (§5.4).
    static let initPrompt = """
        Scan this project and propose the files that help an agent work in it, as changes I can review:
        1. AGENTS.md (or update JUNO.md if it exists): what the project is, how it is laid out, how to build, \
        test and run it, and the conventions to follow. Keep it short and factual; cite real paths.
        2. .juno/verify.json: the project's checks, each with an id, a kind (build, test, lint or typecheck), \
        the exact command and the paths it covers.
        3. .juno/launch.json: how to start the app or dev server, if it has one.
        Read before you write, do not invent commands you have not seen in the project, and change nothing else.
        """
}
