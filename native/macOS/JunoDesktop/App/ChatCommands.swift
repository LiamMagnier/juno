import AppKit
import JunoChatKit
import JunoDesignSystem
import SwiftUI

// MARK: - What the Chat menu can do

/// The Chat menu's actions for the conversation on screen (Phase 3 brief A2,
/// A3), published by ``DesktopChatWorkspace`` while its window is focused.
///
/// Every action is nil when it cannot act, which disables its menu item — and
/// a disabled item does not claim its chord, so ⌘R reaches a page's own
/// Refresh wherever no reply can be regenerated.
struct DesktopChatCommandActions {
    /// The saved chat on screen, for the menu's conversation items. Nil on a
    /// draft, a private chat or a page.
    var conversation: NativeConversation?
    var projects: [NativeProject] = []
    var conversationActions: DesktopConversationActions?
    /// ⌘U: the composer's file picker.
    var attachFiles: (() -> Void)?
    /// ⇧⌘U: a screenshot into the composer.
    var attachScreenshot: (() -> Void)?
    /// ⇧⎋: the caret into the composer, at the end of what is there.
    var focusComposer: (() -> Void)?
    /// ⌘R: the newest reply's own Try Again.
    var regenerate: ChatRegenerateCommand?
    /// ⇧⌘C and ⇧⌘; — the web's global copy keys.
    var copyLastResponse: (() -> Void)?
    var copyLastCodeBlock: (() -> Void)?
    /// ⌘.: filled in by the menu bar from the composer's own publication
    /// (``ChatComposerStopCommand``), because only the composer knows what its
    /// Stop face would stop.
    var stop: (() -> Void)?
}

/// Regenerate, and how much it would replace.
struct ChatRegenerateCommand {
    /// The artifacts the newest reply wrote. Regenerating deletes them on the
    /// server, so more than none asks first — as the reply's own Try Again does.
    let artifactCount: Int
    let perform: () -> Void
}

/// The composer's Stop, published while there is something to stop.
struct ChatComposerStopCommand {
    let perform: () -> Void
}

private struct DesktopChatCommandActionsKey: FocusedValueKey {
    typealias Value = DesktopChatCommandActions
}

private struct ChatComposerStopCommandKey: FocusedValueKey {
    typealias Value = ChatComposerStopCommand
}

extension FocusedValues {
    var junoChatCommands: DesktopChatCommandActions? {
        get { self[DesktopChatCommandActionsKey.self] }
        set { self[DesktopChatCommandActionsKey.self] = newValue }
    }

    var junoComposerStop: ChatComposerStopCommand? {
        get { self[ChatComposerStopCommandKey.self] }
        set { self[ChatComposerStopCommandKey.self] = newValue }
    }
}

// MARK: - The rules

/// One turn as the Chat menu reads it: a saved message or a private turn.
struct ChatCommandTurn: Equatable, Sendable {
    var isAssistant: Bool
    var content: String
    var isPending = false
    var hasError = false
    var hasAttachments = false

    init(
        isAssistant: Bool,
        content: String,
        isPending: Bool = false,
        hasError: Bool = false,
        hasAttachments: Bool = false
    ) {
        self.isAssistant = isAssistant
        self.content = content
        self.isPending = isPending
        self.hasError = hasError
        self.hasAttachments = hasAttachments
    }

    init(_ message: NativeChatMessage) {
        self.init(
            isAssistant: message.role == .assistant,
            content: message.content,
            isPending: message.isPending,
            hasError: message.errorDescription != nil,
            hasAttachments: !message.attachments.isEmpty
        )
    }

    init(_ turn: NativePrivateChatModel.Turn) {
        self.init(isAssistant: turn.role == .assistant, content: turn.content)
    }
}

/// The Chat menu's rules, pure, so they can be tested without a window.
enum ChatCommands {
    // MARK: Copy Last Response (⇧⌘C)

    /// The newest reply with words in it, as the reply's own Copy puts it on
    /// the pasteboard: memories stripped, trailing space trimmed (the web's
    /// `stripMemoryTags(…).trimEnd()`). A reply still streaming counts, as on
    /// the web: what has arrived is what is copied.
    static func lastResponse(in turns: [ChatCommandTurn]) -> String? {
        for turn in turns.reversed() where turn.isAssistant {
            let text = NativeMessageContent.copyableMarkdown(of: turn.content)
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        }
        return nil
    }

    // MARK: Copy Last Code Block (⇧⌘;)

    /// The last fenced block of the newest reply that has one.
    static func lastCodeBlock(in turns: [ChatCommandTurn]) -> String? {
        for turn in turns.reversed() where turn.isAssistant {
            if let block = codeBlocks(in: turn.content).last { return block }
        }
        return nil
    }

    /// A reply's code blocks, in order, read through the same parser the
    /// transcript draws prose with (``NativeMessageContent/parts(of:)`` then
    /// ``JunoMarkdown/blocks(from:)``) — never a regex over the text, which
    /// would find fences inside an artifact's body or a quoted fence.
    ///
    /// A fence drawn as a figure is not a code block to copy: a finished
    /// Mermaid diagram, and the web's inline visual languages (`markdown.tsx`,
    /// `isVisualLang`).
    static func codeBlocks(in content: String) -> [String] {
        NativeMessageContent.parts(of: content).flatMap { part -> [String] in
            guard case .text(let text) = part else { return [] }
            return JunoMarkdown.blocks(from: text).compactMap { block -> String? in
                guard case .code(let language, let source, let isClosed) = block,
                    !isDrawnAsFigure(language: language, isClosed: isClosed)
                else { return nil }
                let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
        }
    }

    private static let visualLanguages: Set<String> = [
        "juno-visual", "juno-ui", "juno-block", "visual", "visual-block",
    ]

    private static func isDrawnAsFigure(language: String?, isClosed: Bool) -> Bool {
        guard let language = language?.lowercased() else { return false }
        if visualLanguages.contains(language) { return true }
        return language == "mermaid" && isClosed
    }

    // MARK: Regenerate (⌘R)

    /// A settled newest reply with nothing streaming, in a saved chat: the
    /// rule the reply's own Regenerate follows (`MessageMenuModel`). An
    /// answer that failed has Try Again on its error instead, and one that is
    /// only a picture or a file has no Regenerate at all.
    static func canRegenerate(turns: [ChatCommandTurn], isGenerating: Bool, isPrivate: Bool) -> Bool {
        guard !isPrivate, !isGenerating,
            let newest = turns.last, newest.isAssistant, !newest.isPending, !newest.hasError
        else { return false }
        let hasWords = !NativeMessageContent.plainText(of: newest.content)
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasWords || !newest.hasAttachments
    }

    /// The artifacts a reply wrote, counted as its row counts them
    /// (``DesktopMessageRow/parts(of:)``): regenerating replaces them.
    static func artifactCount(of message: NativeChatMessage) -> Int {
        Set(DesktopMessageRow.parts(of: message).compactMap { part -> String? in
            if case .artifact(let artifact) = part { return artifact.id }
            return nil
        }).count
    }

    /// The confirmation's sentence, the reply's own (`MessageRow.swift`).
    static func regenerateMessage(artifactCount: Int) -> String {
        artifactCount == 1
            ? "Its 1 artifact will be replaced."
            : "Its \(artifactCount) artifacts will be replaced."
    }

    // MARK: Stop Generating (⌘.)

    /// What Stop ends: the run the composer is steering, or the reply.
    enum StopTarget: Equatable {
        /// The steered run's own Stop — which ends the reply first while one
        /// streams, then the research run or the task (`ChatComposerSteering`).
        case run
        /// The reply in flight.
        case reply
    }

    /// The disc's precedence, shared by the disc and the menu: in steer mode
    /// the run's Stop, otherwise the reply while one streams, otherwise
    /// nothing.
    ///
    /// Unlike the disc's face, the draft does not matter here: typing a
    /// correction turns the disc to Send, and ⌘. must still stop what is
    /// running (the web's Esc stops whatever is in the field).
    static func stopTarget(isGenerating: Bool, inSteerMode: Bool) -> StopTarget? {
        if inSteerMode { return .run }
        if isGenerating { return .reply }
        return nil
    }

    // MARK: Pasteboard and toasts

    /// Replaces the pasteboard with `text`; false when the pasteboard refused.
    static func writeToPasteboard(_ text: String) -> Bool {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
    }

    /// ⇧⌘C, and the toast it posts: the web's words (`chat-view.tsx`).
    static func copyLastResponse(
        from turns: [ChatCommandTurn],
        write: (String) -> Bool = writeToPasteboard
    ) -> JunoToast {
        let id = "chat.copy-last-response"
        guard let text = lastResponse(in: turns) else {
            return JunoToast(id: id, title: "No response to copy yet.")
        }
        return write(text)
            ? JunoToast(id: id, tone: .success, title: "Copied the last response.")
            : JunoToast(id: id, tone: .error, title: "Couldn\u{2019}t copy.")
    }

    /// ⇧⌘;, and the toast it posts: the web's words, including this one's
    /// "Could not" (`use-global-shortcuts.ts`).
    static func copyLastCodeBlock(
        from turns: [ChatCommandTurn],
        write: (String) -> Bool = writeToPasteboard
    ) -> JunoToast {
        let id = "chat.copy-last-code-block"
        guard let block = lastCodeBlock(in: turns) else {
            return JunoToast(id: id, title: "No code block in this conversation yet.")
        }
        return write(block)
            ? JunoToast(id: id, tone: .success, title: "Copied the last code block.")
            : JunoToast(id: id, tone: .error, title: "Could not copy.")
    }
}

// MARK: - Publishing

extension View {
    /// Publishes the Chat menu's actions for this window, and asks before a
    /// menu-bar Regenerate replaces a reply's artifacts — the reply's own
    /// "Regenerate this answer?", in its words.
    func junoChatCommands(_ commands: DesktopChatCommandActions) -> some View {
        modifier(ChatCommandsHost(commands: commands))
    }
}

private struct ChatCommandsHost: ViewModifier {
    let commands: DesktopChatCommandActions

    /// A Regenerate from the menu bar waiting on the reader's go-ahead.
    @State private var pendingRegenerate: PendingRegenerate?

    struct PendingRegenerate: Identifiable {
        let id = UUID()
        let artifactCount: Int
        let perform: () -> Void
    }

    func body(content: Content) -> some View {
        content
            .focusedSceneValue(\.junoChatCommands, published)
            // Opener and actions on one line: the targets gate reads a dialog's
            // buttons as system-drawn only when its brace opens on that line.
            .confirmationDialog("Regenerate this answer?", isPresented: isConfirming, titleVisibility: .visible, presenting: pendingRegenerate) { pending in
                Button("Regenerate", role: .destructive) {
                    pendingRegenerate = nil
                    pending.perform()
                }
                Button("Cancel", role: .cancel) { pendingRegenerate = nil }
            } message: { pending in
                Text(ChatCommands.regenerateMessage(artifactCount: pending.artifactCount))
            }
    }

    /// The actions as published: Regenerate goes through the confirmation
    /// whenever the reply carries artifacts.
    private var published: DesktopChatCommandActions {
        var published = commands
        if let regenerate = commands.regenerate {
            let pending = $pendingRegenerate
            published.regenerate = ChatRegenerateCommand(artifactCount: regenerate.artifactCount) {
                if regenerate.artifactCount > 0 {
                    pending.wrappedValue = PendingRegenerate(
                        artifactCount: regenerate.artifactCount,
                        perform: regenerate.perform
                    )
                } else {
                    regenerate.perform()
                }
            }
        }
        return published
    }

    private var isConfirming: Binding<Bool> {
        Binding(
            get: { pendingRegenerate != nil },
            set: { if !$0 { pendingRegenerate = nil } }
        )
    }
}
