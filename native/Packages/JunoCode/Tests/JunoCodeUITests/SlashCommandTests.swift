import Foundation
import Testing
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeUI

/// Saved prompts, and the rule for when the menu is allowed to appear.
///
/// The detection rule is the part worth pinning down. Too eager and the menu
/// covers the composer every time a prompt mentions `/usr/bin` or "2/3"; too
/// lazy and the feature looks like it does not exist. Neither failure is visible
/// from reading the code — both are only found by typing into the app, which is
/// exactly what a test should replace here.
struct CodeSlashTokenTests {
    // MARK: - When the menu opens

    @Test
    func aLeadingSlashStartsACommand() {
        let token = CodeSlashToken(composerText: "/rev")
        #expect(token?.query == "rev")
        #expect(token?.isNamingCommand == true)
        #expect(token?.argument == "")
    }

    @Test
    func aBareSlashOffersEverything() {
        let token = CodeSlashToken(composerText: "/")
        #expect(token?.query == "")
        #expect(token?.isNamingCommand == true)
    }

    /// A stray space before the slash is a typo, not a decision.
    @Test
    func leadingWhitespaceIsForgiven() {
        #expect(CodeSlashToken(composerText: "  /test")?.query == "test")
    }

    // MARK: - When it must not

    @Test
    func aSlashInsideProseIsNotACommand() {
        #expect(CodeSlashToken(composerText: "look in /usr/bin for it") == nil)
        #expect(CodeSlashToken(composerText: "the ratio was 2/3") == nil)
    }

    /// The single most likely false positive: a reader pasting an absolute path
    /// as the first thing in the composer.
    @Test
    func anAbsolutePathIsNotACommand() {
        // `/Users/...` is indistinguishable from a command by shape alone, so it
        // is treated as one while being typed — but a path with a separator in
        // it has moved past the command word and the menu closes.
        let token = CodeSlashToken(composerText: "/Users/liam/project")
        #expect(token?.query.contains("/") == true || token == nil)
    }

    @Test
    func aDoubleSlashIsNeverACommand() {
        #expect(CodeSlashToken(composerText: "//TODO") == nil)
    }

    @Test
    func aSlashFollowedByANonLetterIsNotACommand() {
        #expect(CodeSlashToken(composerText: "/2x") == nil)
        #expect(CodeSlashToken(composerText: "/.hidden") == nil)
    }

    @Test
    func aSecondLineMeansTheReaderHasMovedOn() {
        #expect(CodeSlashToken(composerText: "/review\nand also check the tests") == nil)
    }

    // MARK: - Arguments

    /// Once past the name the menu closes, but the argument is still captured so
    /// the command can be expanded around it.
    @Test
    func aSpaceEndsTheNameAndStartsTheArgument() {
        let token = CodeSlashToken(composerText: "/explain the outbox drainer")
        #expect(token?.query == "explain")
        #expect(token?.argument == "the outbox drainer")
        #expect(token?.isNamingCommand == false)
    }
}

struct CodeSlashCommandExpansionTests {
    private let withToken = CodeSlashCommand(
        name: "explain",
        summary: "",
        prompt: "Explain this:\n\n$ARGUMENTS"
    )
    private let withoutToken = CodeSlashCommand(
        name: "review",
        summary: "",
        prompt: "Review the working changes."
    )

    @Test
    func theArgumentReplacesThePlaceholder() {
        #expect(withToken.expanded(argument: "the sync loop") == "Explain this:\n\nthe sync loop")
    }

    @Test
    func anEmptyArgumentLeavesThePlaceholderEmpty() {
        #expect(withToken.expanded(argument: "") == "Explain this:\n\n")
    }

    /// The reader's words are never silently discarded: a command with no
    /// placeholder still has to carry what they typed after it.
    @Test
    func anArgumentWithNoPlaceholderIsAppended() {
        #expect(
            withoutToken.expanded(argument: "focus on the tests")
                == "Review the working changes.\n\nfocus on the tests"
        )
    }

    @Test
    func aCommandWithNoArgumentIsUnchanged() {
        #expect(withoutToken.expanded(argument: "   ") == "Review the working changes.")
    }
}

struct CodeSlashCommandParsingTests {
    @Test
    func frontmatterSuppliesTheDescriptionAndBehaviour() {
        let file = """
            ---
            description: Review like we review
            behavior: ask
            ---
            Review the diff against our conventions.
            """
        let command = CodeSlashCommand.parse(
            name: "review",
            contents: file,
            path: ".juno/commands/review.md"
        )
        #expect(command?.summary == "Review like we review")
        #expect(command?.behavior == .ask)
        #expect(command?.prompt == "Review the diff against our conventions.")
        #expect(command?.source == .workspace(".juno/commands/review.md"))
    }

    @Test
    func reconnaissanceFrontmatterSelectsSurveyMode() {
        let command = CodeSlashCommand.parse(
            name: "map",
            contents: "---\nbehavior: recon\n---\nMap the runtime boundaries.",
            path: ".juno/commands/map.md"
        )
        #expect(command?.behavior == .survey)
    }

    /// These files are shared with other tools. Refusing to load one because it
    /// carries a key Juno does not read would make the feature useless on any
    /// repository that already has commands.
    @Test
    func unknownFrontmatterKeysAreIgnoredRatherThanFatal() {
        let file = """
            ---
            description: Ship it
            allowed-tools: Bash, Read
            model: something-else
            ---
            Do the release.
            """
        let command = CodeSlashCommand.parse(name: "ship", contents: file, path: "p")
        #expect(command?.summary == "Ship it")
        #expect(command?.prompt == "Do the release.")
    }

    @Test
    func aFileWithNoFrontmatterUsesItsFirstLineAsTheSummary() {
        let command = CodeSlashCommand.parse(
            name: "tidy",
            contents: "# Tidy the imports\n\nRemove unused imports across the module.",
            path: "p"
        )
        #expect(command?.summary == "Tidy the imports")
        #expect(command?.prompt.hasPrefix("# Tidy the imports") == true)
    }

    /// A command that would insert nothing is not a command.
    @Test
    func anEmptyBodyIsRejected() {
        #expect(CodeSlashCommand.parse(name: "empty", contents: "", path: "p") == nil)
        #expect(
            CodeSlashCommand.parse(
                name: "empty",
                contents: "---\ndescription: nothing\n---\n\n   \n",
                path: "p"
            ) == nil
        )
    }

    @Test
    func namesAreCaseInsensitive() {
        #expect(CodeSlashCommand(name: "Review", summary: "", prompt: "x").name == "review")
    }
}

struct CodeSlashCommandLibraryTests {
    private let workspaceReview = CodeSlashCommand(
        name: "review",
        summary: "Our review",
        prompt: "House style.",
        source: .workspace(".juno/commands/review.md")
    )

    /// The repository knows more about how it wants to be reviewed than Juno's
    /// defaults do.
    @Test
    func aWorkspaceCommandOverridesTheBuiltInOfTheSameName() {
        let library = CodeSlashCommandLibrary.merged(workspace: [workspaceReview])
        let review = library.command(named: "review")
        #expect(review?.prompt == "House style.")
        #expect(review?.source.isWorkspace == true)
        // …and does not duplicate it.
        #expect(library.commands.filter { $0.name == "review" }.count == 1)
    }

    @Test
    func workspaceCommandsSortAboveBuiltIns() {
        let library = CodeSlashCommandLibrary.merged(
            workspace: [
                CodeSlashCommand(name: "zzz", summary: "", prompt: "x", source: .workspace("p"))
            ]
        )
        #expect(library.commands.first?.name == "zzz")
    }

    @Test
    func builtInsAreStillThereWithNoWorkspaceCommands() {
        let library = CodeSlashCommandLibrary.merged(workspace: [])
        #expect(library.command(named: "review") != nil)
        #expect(library.command(named: "test") != nil)
        #expect(library.command(named: "survey")?.behavior == .survey)
    }

    // MARK: - Matching

    @Test
    func prefixMatchesRankAboveSubstringMatches() {
        let library = CodeSlashCommandLibrary(commands: [
            CodeSlashCommand(name: "create-release", summary: "", prompt: "x"),
            CodeSlashCommand(name: "review", summary: "", prompt: "x"),
        ])
        #expect(library.matches("re").first?.name == "review")
    }

    @Test
    func anEmptyQueryOffersEverything() {
        #expect(CodeSlashCommandLibrary.builtIn.matches("").count
            == CodeSlashCommandLibrary.builtIn.commands.count)
    }

    @Test
    func matchingIsCaseInsensitiveAndSearchesSummaries() {
        let library = CodeSlashCommandLibrary(commands: [
            CodeSlashCommand(name: "tidy", summary: "Clean up imports", prompt: "x")
        ])
        #expect(library.matches("TIDY").count == 1)
        #expect(library.matches("imports").count == 1)
    }

    @Test
    func aQueryThatMatchesNothingReturnsNothing() {
        #expect(CodeSlashCommandLibrary.builtIn.matches("zzzzz").isEmpty)
    }
}

struct CodeSkillDiscoveryContractTests {
    /// Skills use the same prompt parser as command files, so repository
    /// authors can move a prompt between .claude/skills and .juno/commands
    /// without changing its visible behavior.
    @Test
    func aSkillMarkdownFileHasTheSameExpansionContractAsACommand() {
       let skill = CodeSlashCommand.parse(
            name: "ship-check",
           contents: "---\ndescription: Verify a release\n---\nInspect the release checklist and run the relevant checks.\n$ARGUMENTS",
            path: ".claude/skills/ship-check/SKILL.md"
        )
        #expect(skill?.summary == "Verify a release")
        #expect(skill?.source == .workspace(".claude/skills/ship-check/SKILL.md"))
        #expect(
            skill?.expanded(argument: "for version 2.0")
                == "Inspect the release checklist and run the relevant checks.\nfor version 2.0"
        )
    }

    @Test
    func workspaceDiscoveryReadsCommandsAndSkillsThroughContainedPaths() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-slash-discovery-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let commands = root.appendingPathComponent(".claude/commands", isDirectory: true)
        let skills = root.appendingPathComponent(".juno/skills/release", isDirectory: true)
        try FileManager.default.createDirectory(at: commands, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: skills, withIntermediateDirectories: true)
        try "---\ndescription: Review locally\n---\nReview this change. $ARGUMENTS"
            .write(to: commands.appendingPathComponent("review.md"), atomically: true, encoding: .utf8)
        try "---\ndescription: Ship safely\n---\nCheck the release. $ARGUMENTS"
            .write(to: skills.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)

        let id = WorkspaceID()
        let access = try WorkspaceAccess(workspaceID: id, grantedURL: root)
        let descriptor = WorkspaceDescriptor(
            id: id,
            displayName: root.lastPathComponent,
            localPathHint: root.path,
            isGitRepository: false,
            lastOpenedAt: Date()
        )
        let context = WorkspaceContext(
            record: WorkspaceRecord(
                descriptor: descriptor,
                bookmarkData: Data()
            ),
            access: access,
            storageRoot: root.appendingPathComponent("storage", isDirectory: true)
        )

        let discovered = await context.slashCommands()
        #expect(discovered.contains { $0.name == "review" })
        #expect(discovered.contains { $0.name == "release" })
        #expect(discovered.first { $0.name == "release" }?.prompt.contains("Check the release") == true)
    }
}

/// `/compact` is a verb on the session, not a prompt for the composer.
struct CodeSlashActionTests {
    @Test
    func compactIsABuiltInAction() {
        let command = CodeSlashCommandLibrary.builtIn.command(named: "compact")
        #expect(command?.action == .compact)
        #expect(command?.prompt.isEmpty == true)
        #expect(CodeSlashCommandLibrary.builtIn.matches("comp").map(\.name) == ["compact"])
    }

    @Test
    func aWorkspaceCommandCannotBecomeAnAction() {
        let parsed = CodeSlashCommand.parse(
            name: "compact",
            contents: "Summarise the conversation so far.",
            path: ".juno/commands/compact.md"
        )
        #expect(parsed?.action == nil)
        let merged = CodeSlashCommandLibrary.merged(workspace: [parsed!])
        // The workspace file wins the name, and turns the verb back into a
        // prompt — a repository may not silently hijack a session action.
        #expect(merged.command(named: "compact")?.action == nil)
    }
}

struct CodeBuiltInCommandsVerificationTests {
    @Test
    func builtInLibraryContainsGoalBoostAndTeamworkPreview() {
        let library = CodeSlashCommandLibrary.builtIn
        let goal = library.command(named: "goal")
        let boost = library.command(named: "boost")
        let teamworkPreview = library.command(named: "teamwork-preview")

        #expect(goal != nil)
        #expect(goal?.summary.contains("goal") == true)
        #expect(goal?.prompt.contains("update_goal") == true)

        #expect(boost != nil)
        #expect(boost?.summary.contains("Boost") == true)
        #expect(boost?.prompt.contains("maximum rigor") == true)

        #expect(teamworkPreview != nil)
        #expect(teamworkPreview?.summary.contains("worktrees") == true)
        #expect(teamworkPreview?.prompt.contains("worktrees") == true)
    }
}

