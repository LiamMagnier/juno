import Foundation
import JunoDesignSystem
import Testing

@testable import JunoDesktop

/// The Chat menu's actions (Phase 3 brief A3): what Copy Last Response and
/// Copy Last Code Block find and say, when Regenerate and Stop may act, and
/// how the menu bar resolves each item in each window.
struct ChatCommandsTests {
    private func reply(_ content: String, pending: Bool = false, error: Bool = false, attachments: Bool = false)
        -> ChatCommandTurn
    {
        ChatCommandTurn(
            isAssistant: true, content: content, isPending: pending, hasError: error, hasAttachments: attachments
        )
    }

    private func question(_ content: String) -> ChatCommandTurn {
        ChatCommandTurn(isAssistant: false, content: content)
    }

    // MARK: Copy Last Response

    @Test
    func thereIsNoResponseToCopyBeforeAReply() {
        #expect(ChatCommands.lastResponse(in: []) == nil)
        #expect(ChatCommands.lastResponse(in: [question("Hello?")]) == nil)
        let toast = ChatCommands.copyLastResponse(from: [question("Hello?")]) { _ in true }
        #expect(toast.title == "No response to copy yet.")
        #expect(toast.tone == nil)
    }

    @Test
    func theNewestReplyWithWordsIsCopiedWithoutItsMemories() {
        let turns = [
            question("One"),
            reply("The first answer."),
            question("Two"),
            reply("The second answer.\n<juno:memory>Prefers short answers</juno:memory>\n\n"),
        ]
        #expect(ChatCommands.lastResponse(in: turns) == "The second answer.")
    }

    @Test
    func aReplyWithOnlyAMemoryFallsBackToTheOneBefore() {
        let turns = [
            reply("Here is the plan."),
            question("Remember that"),
            reply("<juno:memory>Lives in Lisbon</juno:memory>"),
        ]
        #expect(ChatCommands.lastResponse(in: turns) == "Here is the plan.")
    }

    @Test
    func copyingSaysWhatHappened() {
        let turns = [reply("Done.")]
        var written: String?
        let copied = ChatCommands.copyLastResponse(from: turns) { written = $0; return true }
        #expect(written == "Done.")
        #expect(copied.title == "Copied the last response.")
        #expect(copied.tone == .success)
        let refused = ChatCommands.copyLastResponse(from: turns) { _ in false }
        #expect(refused.title == "Couldn\u{2019}t copy.")
        #expect(refused.tone == .error)
    }

    // MARK: Copy Last Code Block

    @Test
    func aReplyWithNoCodeHasNoBlockToCopy() {
        let turns = [question("Hi"), reply("Just words, and `inline code` that is not a block.")]
        #expect(ChatCommands.lastCodeBlock(in: turns) == nil)
        let toast = ChatCommands.copyLastCodeBlock(from: turns) { _ in true }
        #expect(toast.title == "No code block in this conversation yet.")
        #expect(toast.tone == nil)
    }

    @Test
    func theLastOfSeveralBlocksIsCopied() {
        let content = """
            First:

            ```swift
            let a = 1
            ```

            Then:

            ```python
            print("b")
            ```

            That is all.
            """
        #expect(ChatCommands.codeBlocks(in: content) == ["let a = 1", "print(\"b\")"])
        #expect(ChatCommands.lastCodeBlock(in: [reply(content)]) == "print(\"b\")")
    }

    @Test
    func theNewestReplyWithABlockIsTheOneRead() {
        let turns = [
            reply("```sh\nnpm test\n```"),
            question("Thanks"),
            reply("You are welcome."),
        ]
        #expect(ChatCommands.lastCodeBlock(in: turns) == "npm test")
    }

    @Test
    func memoriesAndFiguresAreNotCodeBlocks() {
        let content = """
            ```js
            run()
            ```

            ```mermaid
            graph TD; A-->B
            ```

            <juno:memory>```never copied```</juno:memory>
            """
        #expect(ChatCommands.codeBlocks(in: content) == ["run()"])
    }

    @Test
    func aMermaidFenceStillStreamingIsCode() {
        #expect(ChatCommands.codeBlocks(in: "```mermaid\ngraph TD; A-->B") == ["graph TD; A-->B"])
    }

    @Test
    func copyingACodeBlockSaysWhatHappenedInTheWebsWords() {
        let turns = [reply("```\nls -la\n```")]
        let copied = ChatCommands.copyLastCodeBlock(from: turns) { $0 == "ls -la" }
        #expect(copied.title == "Copied the last code block.")
        #expect(copied.tone == .success)
        let refused = ChatCommands.copyLastCodeBlock(from: turns) { _ in false }
        #expect(refused.title == "Could not copy.")
        #expect(refused.tone == .error)
    }

    // MARK: Regenerate

    @Test
    func onlyASettledNewestReplyCanBeRegenerated() {
        let settled = [question("Q"), reply("A")]
        #expect(ChatCommands.canRegenerate(turns: settled, isGenerating: false, isPrivate: false))
        #expect(!ChatCommands.canRegenerate(turns: settled, isGenerating: true, isPrivate: false))
        #expect(!ChatCommands.canRegenerate(turns: settled, isGenerating: false, isPrivate: true))
        #expect(!ChatCommands.canRegenerate(turns: [question("Q")], isGenerating: false, isPrivate: false))
        #expect(!ChatCommands.canRegenerate(turns: [], isGenerating: false, isPrivate: false))
        #expect(!ChatCommands.canRegenerate(
            turns: [question("Q"), reply("A", pending: true)], isGenerating: false, isPrivate: false
        ))
        // A failed answer has Try Again on its error instead.
        #expect(!ChatCommands.canRegenerate(
            turns: [question("Q"), reply("", error: true)], isGenerating: false, isPrivate: false
        ))
        // A reply that is only a picture has no Regenerate, as on its row.
        #expect(!ChatCommands.canRegenerate(
            turns: [question("Draw"), reply("", attachments: true)], isGenerating: false, isPrivate: false
        ))
        #expect(ChatCommands.canRegenerate(
            turns: [question("Draw"), reply("Here it is.", attachments: true)], isGenerating: false, isPrivate: false
        ))
    }

    @Test
    func theConfirmationCountsTheArtifacts() {
        #expect(ChatCommands.regenerateMessage(artifactCount: 1) == "Its 1 artifact will be replaced.")
        #expect(ChatCommands.regenerateMessage(artifactCount: 3) == "Its 3 artifacts will be replaced.")
    }

    // MARK: Stop

    /// ⌘. stops exactly what the disc's Stop face would: the run in steer
    /// mode, the reply otherwise — and whenever the face would be Stop.
    @Test
    func stopFollowsTheDiscsPrecedence() {
        for isGenerating in [false, true] {
            for steering in [false, true] {
                let disc = ChatComposerDisc.resolve(
                    isGenerating: isGenerating,
                    hasDraft: false,
                    blockedReason: nil,
                    waitingReason: nil,
                    steering: steering ? ("Add this to the running task", "Stop the task") : nil
                )
                let target = ChatCommands.stopTarget(isGenerating: isGenerating, inSteerMode: steering)
                #expect((disc.face == .stop) == (target != nil), "generating \(isGenerating), steering \(steering)")
                if steering { #expect(target == .run) }
                if !steering && isGenerating { #expect(target == .reply) }
            }
        }
    }

    /// Typing a correction turns the face to Send; ⌘. still stops.
    @Test
    func aDraftDoesNotTakeStopAway() {
        let disc = ChatComposerDisc.resolve(
            isGenerating: true, hasDraft: true, blockedReason: nil, waitingReason: nil,
            steering: ("Add this to the running task", "Stop generating")
        )
        #expect(disc.face == .send)
        #expect(ChatCommands.stopTarget(isGenerating: true, inSteerMode: true) == .run)
    }

    // MARK: Resolving the menu bar

    private func workspace(_ product: DesktopProductMode, commandMenu: (() -> Void)? = {}) -> DesktopWorkspaceActions {
        DesktopWorkspaceActions(
            newItem: {}, newChat: {}, openSearch: {}, switchProduct: { _ in },
            currentProduct: product, openCommandMenu: commandMenu
        )
    }

    private func code(stop: (() -> Void)? = {}, hasSession: Bool = true, palette: @escaping () -> Void = {})
        -> DesktopCodeActions
    {
        DesktopCodeActions(
            openPalette: palette, previousSession: {}, nextSession: {}, toggleReview: {}, toggleConsole: {},
            toggleInspector: {}, togglePreview: {}, openFile: {}, openFolder: {}, createPullRequest: nil,
            stop: stop, hasSession: hasSession
        )
    }

    private var chat: DesktopChatCommandActions {
        var chat = DesktopChatCommandActions()
        chat.attachFiles = {}
        chat.focusComposer = {}
        chat.copyLastResponse = {}
        chat.copyLastCodeBlock = {}
        chat.regenerate = ChatRegenerateCommand(artifactCount: 0) {}
        return chat
    }

    @Test
    func inChatTheChatItemsActAndCodesStopDoesNot() {
        let context = DesktopCommandContext(
            workspace: workspace(.chat), code: nil, shell: nil, chat: chat,
            composerStop: ChatComposerStopCommand {}
        )
        #expect(!context.showsSessionMenu)
        for id in [JunoShortcutID.attachFiles, .focusComposer, .stopGenerating, .regenerate,
                   .copyLastResponse, .copyLastCodeBlock, .commandMenu, .search] {
            #expect(context.action(for: id) != nil, "\(id)")
        }
        #expect(context.action(for: .codeStop) == nil)
        #expect(context.action(for: .attachScreenshot) == nil)
        #expect(context.title(for: JunoShortcutRegistry.entry(.newChat)) == "New Chat")
        #expect(context.isOn(.productChat) == true)
        #expect(context.isOn(.productCode) == false)
    }

    @Test
    func inCodeOnlyCodesStopAnswersCommandPeriod() {
        var opened = false
        let context = DesktopCommandContext(
            workspace: workspace(.code, commandMenu: nil),
            code: code(palette: { opened = true }),
            shell: nil,
            chat: chat,
            composerStop: ChatComposerStopCommand {}
        )
        #expect(context.showsSessionMenu)
        #expect(context.action(for: .codeStop) != nil)
        #expect(context.action(for: .stopGenerating) == nil)
        #expect(context.action(for: .regenerate) == nil)
        #expect(context.action(for: .copyLastResponse) == nil)
        #expect(context.title(for: JunoShortcutRegistry.entry(.newChat)) == "New Task")
        // ⌘K opens Code's own palette while Code is showing (decision 2).
        context.action(for: .commandMenu)?()
        #expect(opened)
    }

    @Test
    func stopWaitsForSomethingToStop() {
        let chatWindow = DesktopCommandContext(workspace: workspace(.chat), chat: chat, composerStop: nil)
        #expect(chatWindow.action(for: .stopGenerating) == nil)
        // A composer outside the Chat window's commands never answers ⌘.
        let stray = DesktopCommandContext(workspace: workspace(.chat), chat: nil, composerStop: ChatComposerStopCommand {})
        #expect(stray.action(for: .stopGenerating) == nil)
        let idleCode = DesktopCommandContext(workspace: workspace(.code), code: code(stop: nil))
        #expect(idleCode.action(for: .codeStop) == nil)
        let noSession = DesktopCommandContext(workspace: workspace(.code), code: code(hasSession: false))
        #expect(noSession.action(for: .codeChanges) == nil)
        #expect(noSession.action(for: .codePreviousSession) != nil)
    }

    @Test
    func withNothingFocusedTheAppStillOpensAWindowAndAPrivateChat() {
        var opened = false
        var privateOpened = false
        let context = DesktopCommandContext(
            openMainWindow: { opened = true },
            newPrivateChatWithoutWindow: { privateOpened = true }
        )
        #expect(context.title(for: JunoShortcutRegistry.entry(.newChat)) == JunoDesktopWindow.newWindowMenuTitle)
        context.action(for: .newChat)?()
        context.action(for: .newPrivateChat)?()
        #expect(opened)
        #expect(privateOpened)
        for id in [JunoShortcutID.regenerate, .stopGenerating, .toggleTheme, .search, .commandMenu,
                   .findInConversation, .productChat, .codeStop] {
            #expect(context.action(for: id) == nil, "\(id)")
        }
        for id in [JunoShortcutID.askJuno, .keyboardShortcuts, .help, .roadmap] {
            #expect(context.action(for: id) != nil, "\(id)")
        }
    }

    @Test
    func theThemeItemIsNamedForWhereItGoes() {
        let entry = JunoShortcutRegistry.entry(.toggleTheme)
        let light = DesktopCommandContext(shell: shell(isDark: false))
        let dark = DesktopCommandContext(shell: shell(isDark: true))
        #expect(light.title(for: entry) == "Switch to Dark Mode")
        #expect(light.glyph(for: entry) == .moon)
        #expect(dark.title(for: entry) == "Switch to Light Mode")
        #expect(dark.glyph(for: entry) == .sun)
        #expect(dark.action(for: .toggleTheme) != nil)
        let noSettings = DesktopCommandContext(
            shell: DesktopShellActions(newPrivateChat: {}, openLegacyTasks: {}, isShowingLegacyTasks: false)
        )
        #expect(noSettings.action(for: .toggleTheme) == nil)
    }

    private func shell(isDark: Bool) -> DesktopShellActions {
        DesktopShellActions(
            newPrivateChat: {}, openLegacyTasks: {}, isShowingLegacyTasks: false,
            toggleTheme: DesktopShellActions.ThemeToggle(isDark: isDark) {}
        )
    }

    @Test
    func everyMenuItemResolves() {
        // Everything the registry places in a menu has a title and a glyph in
        // every context, so no item is ever drawn blank.
        let contexts = [
            DesktopCommandContext(),
            DesktopCommandContext(workspace: workspace(.chat), chat: chat),
            DesktopCommandContext(workspace: workspace(.code), code: code()),
        ]
        for context in contexts {
            for entry in JunoShortcutRegistry.entries where entry.menu != nil {
                #expect(!context.title(for: entry).isEmpty, "\(entry.id)")
                #expect(context.glyph(for: entry) != nil, "\(entry.id)")
            }
        }
    }
}
