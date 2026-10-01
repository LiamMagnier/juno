import Foundation
import Testing
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Every verb in CODE_AGENT_SPEC §5.4 resolves to a handler that does what it
/// says through the session, watched here through a recording host.
@MainActor
struct SlashCommandRegistryTests {
    /// The verbs §5.4 lists, with an argument each takes.
    private static let specVerbs: [(String, String)] = [
        ("goal", "ship the settings menu"), ("verify", ""), ("review", "branch"), ("context", ""),
        ("cost", ""), ("compact", "keep the API"), ("rewind", ""), ("resume", ""), ("model", "fast"),
        ("init", ""), ("memory", ""), ("permissions", ""), ("agents", ""), ("mcp", ""), ("hooks", ""),
        ("tasks", ""), ("fork", "try the other approach"), ("loop", "10m check the deploy"), ("export", ""),
        ("btw", "what does the lexer do?"),
    ]

    @Test
    func everyVerbInTheSpecResolvesToAHandler() async throws {
        let library = CodeSlashCommandLibrary.builtIn
        #expect(Set(Self.specVerbs.map(\.0)) == Set(CodeSlashCommand.Action.allCases.map(\.rawValue)))
        for (name, argument) in Self.specVerbs {
            let command = try #require(library.command(named: name), "\(name)")
            let action = try #require(command.action, "\(name) is a verb")
            let intent = SlashCommandParser.intent(for: action, argument: argument)
            guard case let .success(intent) = intent else {
                Issue.record("/\(name) \(argument) did not parse: \(intent)")
                continue
            }
            let host = RecordingHost()
            let center = CommandCenterModel()
            center.availableModels = [ModelOption(modelID: "google:gemini-fast", displayName: "Fast")]
            var rewound = false
            var reviewOpened = false
            await center.perform(
                intent,
                host: host,
                view: SlashCommandViewActions(openRewind: { rewound = true }, openReview: { _ in reviewOpened = true })
            )
            center.stopLoops()
            let did = host.log.joined(separator: " | ")
            switch name {
            case "goal": #expect(host.log.contains("createGoal:ship the settings menu") && host.log.contains("send:ship the settings menu"), "\(did)")
            case "verify": #expect(host.log.contains("check:swift test"), "\(did)")
            case "review": #expect(reviewOpened && host.log.contains { $0.hasPrefix("send:Review this branch") }, "\(did)")
            case "context": #expect(center.activeSheet == .context)
            case "cost": #expect(center.activeSheet == .cost)
            case "compact": #expect(host.log.contains("compact:keep the API"))
            case "rewind": #expect(rewound)
            case "resume": #expect(center.activeSheet == .resume)
            case "model": #expect(host.log.contains("model:google:gemini-fast"), "\(did)")
            case "init": #expect(host.log.contains { $0.hasPrefix("send:Scan this project") }, "\(did)")
            case "memory": #expect(center.activeSheet == .memory)
            case "permissions": #expect(center.activeSheet == .permissions)
            case "agents": #expect(center.activeSheet == .agents)
            case "mcp": #expect(center.activeSheet == .mcp)
            case "hooks": #expect(center.activeSheet == .hooks)
            case "tasks": #expect(center.activeSheet == .tasks)
            case "fork": #expect(host.log.contains("fork:try the other approach"))
            case "loop": #expect(host.notices.last?.hasPrefix("Looping every 10 min: check the deploy") == true, "\(host.notices)")
            case "export": #expect(host.log.contains("export:clipboard"))
            case "btw": #expect(center.aside?.answer == "An aside.")
            default: Issue.record("unhandled \(name)")
            }
        }
    }

    @Test
    func usageIsCostAndTheGoalVerbsAliasesClear() throws {
        #expect(CodeSlashCommandLibrary.builtIn.command(named: "usage")?.action == .cost)
        #expect(CodeSlashCommandLibrary.builtIn.matches("usa").first?.name == "cost")
        for word in ["clear", "stop", "off", "cancel"] {
            #expect(SlashCommandParser.intent(for: .goal, argument: word) == .success(.goal(.clear)), "\(word)")
        }
        // More than the word is an objective.
        #expect(SlashCommandParser.intent(for: .goal, argument: "stop the flaky test") == .success(.goal(.set("stop the flaky test"))))
        #expect(SlashCommandParser.intent(for: .goal, argument: "") == .success(.goal(.show)))
        #expect(SlashCommandParser.intent(for: .goal, argument: "pause") == .success(.goal(.pause)))
        #expect(SlashCommandParser.intent(for: .goal, argument: String(repeating: "x", count: 4_001))
            == .failure(SlashCommandError("A goal can be at most 4,000 characters.")))
    }

    @Test
    func reviewScopesAndFix() {
        #expect(SlashCommandParser.intent(for: .review, argument: "") == .success(.review(.uncommitted, fix: false)))
        #expect(SlashCommandParser.intent(for: .review, argument: "last-turn --fix") == .success(.review(.lastTurn, fix: true)))
        #expect(SlashCommandParser.intent(for: .review, argument: "1feb392c") == .success(.review(.commit("1feb392c"), fix: false)))
        guard case .failure = SlashCommandParser.intent(for: .review, argument: "everything") else {
            Issue.record("an unknown scope parsed")
            return
        }
        let prompt = SlashCommandHandlers.reviewPrompt(.branch, fix: false, canDelegate: true)
        #expect(prompt.contains("agent \"reviewer\""))
        #expect(prompt.contains("Change nothing."))
        #expect(SlashCommandHandlers.reviewPrompt(.uncommitted, fix: true, canDelegate: true).contains("fix the P0 and P1"))
        #expect(!SlashCommandHandlers.reviewPrompt(.uncommitted, fix: false, canDelegate: false).contains("delegate_task"))
    }

    @Test
    func loopBounds() {
        #expect(SlashCommandParser.intent(for: .loop, argument: "10m check the deploy") == .success(.loop(.start(interval: 600, prompt: "check the deploy"))))
        #expect(SlashCommandParser.intent(for: .loop, argument: "2h tidy") == .success(.loop(.start(interval: 7_200, prompt: "tidy"))))
        #expect(SlashCommandParser.intent(for: .loop, argument: "check the deploy") == .success(.loop(.start(interval: nil, prompt: "check the deploy"))))
        #expect(SlashCommandParser.intent(for: .loop, argument: "stop") == .success(.loop(.stop)))
        #expect(SlashCommandParser.intent(for: .loop, argument: "30s too often") == .failure(SlashCommandError("A loop runs at most once a minute.")))
        #expect(SlashCommandParser.intent(for: .loop, argument: "8d too rare") == .failure(SlashCommandError("A loop runs at least once a week.")))
        guard case .failure = SlashCommandParser.intent(for: .loop, argument: "") else {
            Issue.record("an empty loop parsed")
            return
        }
    }

    @Test
    func aSessionRunsAtMostTenLoopsAndStopEndsThem() async {
        let host = RecordingHost()
        let center = CommandCenterModel()
        for index in 0..<11 {
            center.startLoop(every: 3_600, prompt: "check \(index)", host: host)
        }
        #expect(center.loops.count == 10)
        #expect(host.notices.last?.contains("at most 10 loops") == true)
        await center.stopEverything()
        #expect(center.loops.isEmpty)
    }

    @Test
    func aLoopNeverSendsIntoABusySessionAndSendsWhenIdle() async throws {
        let host = RecordingHost()
        host.busy = true
        let center = CommandCenterModel()
        center.startLoop(every: 0.05, prompt: "check the deploy", host: host)
        try await Task.sleep(for: .milliseconds(200))
        #expect(!host.log.contains("send:check the deploy"))
        host.busy = false
        try await Task.sleep(for: .milliseconds(200))
        #expect(host.log.contains("send:check the deploy"))
        center.stopLoops()
    }

    @Test
    func aVerbThatNeedsTheSessionStillWaitsAndKeepsItsArgument() {
        let host = RecordingHost()
        host.busy = true
        let center = CommandCenterModel()
        let compact = CodeSlashCommandLibrary.builtIn.command(named: "compact")!
        #expect(!center.run(compact, argument: "keep it", host: host))
        #expect(host.notices.last == "/compact is available when Juno finishes.")
        // A sheet opens whatever the session is doing.
        #expect(center.run(CodeSlashCommandLibrary.builtIn.command(named: "cost")!, argument: "", host: host))
        // A parse error keeps the argument too.
        #expect(!center.run(CodeSlashCommandLibrary.builtIn.command(named: "btw")!, argument: "", host: RecordingHost()))
    }

    @Test
    func settingAGoalOverAnOpenOneAsksFirst() async throws {
        let host = RecordingHost()
        host.goal = SessionGoal(objective: "Old goal", steps: [GoalStep(title: "Old goal", createdAt: Date())], createdAt: Date())
        let center = CommandCenterModel()
        await center.perform(.goal(.set("New goal")), host: host)
        let confirmation = try #require(center.confirmation)
        #expect(confirmation.title == "Replace the current goal?")
        #expect(!host.log.contains("createGoal:New goal"), "nothing happens before the reader answers")
        await center.confirm(confirmation, host: host)
        #expect(host.log == ["clearGoal", "createGoal:New goal", "send:New goal"])
    }

    @Test
    func anUnknownModelOpensThePicker() async {
        let host = RecordingHost()
        let center = CommandCenterModel()
        center.availableModels = [ModelOption(modelID: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5")]
        await center.perform(.model("gpt-99"), host: host)
        #expect(center.activeSheet == .model)
        #expect(!host.log.contains { $0.hasPrefix("model:") })
        await center.perform(.model("claude-sonnet-5"), host: host)
        #expect(host.log.contains("model:anthropic:claude-sonnet-5"))
        #expect(host.notices.last?.contains("without the cache") == true)
    }

    @Test
    func routesReplaceADefaultHandler() async {
        let host = RecordingHost()
        let center = CommandCenterModel()
        var routed: SlashCommandIntent.Verify?
        center.routes.verify = { verify, _, _ in routed = verify }
        await center.perform(.verify(.setup), host: host)
        #expect(routed == .setup)
        #expect(host.log.isEmpty)
    }

    @Test
    func projectCommandsWinOverTheReadersAndBothAreListed() {
        let project = CodeSlashCommand(name: "ship", summary: "Project", prompt: "p", source: .workspace(".juno/commands/ship.md"))
        let mine = CodeSlashCommand(name: "ship", summary: "Mine", prompt: "m", source: .user("~/.juno/commands/ship.md"))
        let only = CodeSlashCommand(name: "notes", summary: "Mine", prompt: "n", source: .user("~/.juno/commands/notes.md"))
        let dormant = CodeSlashCommand(
            name: "deploy", summary: "Claude's", prompt: "d",
            source: .claudeImport("~/.claude/commands/deploy.md"), isEnabled: false
        )
        let library = CodeSlashCommandLibrary.merged(workspace: [project], user: [mine, only, dormant])
        #expect(library.command(named: "ship")?.summary == "Project")
        #expect(library.command(named: "notes")?.source == .user("~/.juno/commands/notes.md"))
        #expect(library.command(named: "deploy") == nil, "an import that is off does not run")
        let replaced = library.overridden.first { $0.name == "ship" }
        #expect(replaced?.replacedBy == "this project's /ship")
        #expect(library.overridden.contains { $0.name == "deploy" && !$0.isEnabled })
        let names = library.matches("").map(\.name)
        #expect(names.filter { $0 == "ship" }.count == 2, "both are listed")
        #expect(names.first == "ship", "the one that runs first")
        #expect(CommandCenterModel().unavailableReason(replaced!, isBusy: false) == "Replaced by this project's /ship")
    }

    @Test
    func choosingAnImportedCommandTurnsItOn() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("juno-imports-\(UUID().uuidString)/.juno")
        defer { try? FileManager.default.removeItem(at: home.deletingLastPathComponent()) }
        let policy = UserExtensionPolicyStore(junoHome: home)
        let dormant = CodeSlashCommand(
            name: "deploy", summary: "", prompt: "d", source: .claudeImport("~/.claude/commands/deploy.md"), isEnabled: false
        )
        #expect(CommandCenterModel().run(dormant, argument: "", host: RecordingHost(), imports: policy))
        #expect(policy.isEnabled(kind: CodeSlashCommand.importKind, name: "deploy"))
    }

    @Test
    func theExportIsTheConversationInMarkdown() {
        let events: [SessionEvent] = [
            SessionEvent(sessionID: CodeSessionID(), sequence: 1, timestamp: Date(), payload: .userPrompt(UserPromptEvent(text: "Fix the menu"))),
            SessionEvent(sessionID: CodeSessionID(), sequence: 2, timestamp: Date(), payload: .assistantMessage(AssistantMessageEvent(text: "Fixed."))),
        ]
        let markdown = SessionMarkdownExport.markdown(title: "Menu", events: events, pullRequestURL: "https://example.com/pr/1")
        #expect(markdown == "# Menu\n\n**You:** Fix the menu\n\nFixed.\n\nPull request: https://example.com/pr/1")
        #expect(SessionMarkdownExport.fileName(title: "Fix: the menu!") == "Fix--the-menu.md")
        #expect(SessionMarkdownExport.recentText(events: events, maximumCharacters: 10).hasPrefix("…"))
    }
}

/// A session as a verb sees it, recording what each verb asked of it.
@MainActor
final class RecordingHost: SlashCommandHost {
    var log: [String] = []
    var notices: [String] = []
    var busy = false
    var goal: SessionGoal?
    var behavior: AgentBehavior = .code

    var commandSessionIsBusy: Bool { busy }
    var commandHasProject: Bool { true }
    var commandBehavior: AgentBehavior { behavior }
    var commandGoal: SessionGoal? { goal }
    var commandCheckCommands: [String] { ["swift test"] }

    func commandSend(_ prompt: String, behavior _: AgentBehavior?) async -> String? {
        log.append("send:\(prompt)")
        return nil
    }

    func commandCompact(focus: String?) async { log.append("compact:\(focus ?? "")") }
    func commandSetModel(_ modelID: String) async { log.append("model:\(modelID)") }
    func commandNotice(_ message: String?) { if let message { notices.append(message) } }

    func commandCreateGoal(objective: String) async -> String? {
        log.append("createGoal:\(objective)")
        return nil
    }

    func commandClearGoal() async -> String? {
        log.append("clearGoal")
        goal = nil
        return nil
    }

    func commandSetGoalLifecycle(_ lifecycle: GoalLifecycle) async { log.append("lifecycle:\(lifecycle.rawValue)") }
    func commandRediscoverChecks() async -> [String] { ["swift test"] }
    func commandRunCheck(_ command: String) async { log.append("check:\(command)") }
    func commandTranscriptMarkdown() -> String { "# Session" }

    func commandDeliverExport(_: String, toFile: Bool) async -> String? {
        log.append(toFile ? "export:file" : "export:clipboard")
        return nil
    }

    func commandFork(prompt: String?) async -> String? {
        log.append("fork:\(prompt ?? "")")
        return nil
    }

    func commandAskAside(_: String) async -> String { "An aside." }
}
