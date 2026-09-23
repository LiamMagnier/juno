import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// A model the Regenerate menu can switch to: the catalog row, reduced to what
/// a menu item needs, with the provider it is listed under.
struct DesktopRegenerateModel: Identifiable, Equatable {
    let id: String
    let name: String
    /// The provider id, which names its mark (`provider-<id>`).
    var provider: String = ""
    /// The provider's display name before " · " — the section header.
    var providerLabel: String = ""

    init(id: String, name: String, provider: String = "", providerLabel: String = "") {
        self.id = id
        self.name = name
        self.provider = provider
        self.providerLabel = providerLabel
    }

    /// Every chat model this account can send to — no coming-soon entries and
    /// no legacy ones, as the web's `RegenerateMenu` lists them — grouped under
    /// its provider's name.
    init(option: NativeChatModelOption) {
        self.init(
            id: option.id,
            name: option.displayName,
            provider: option.providerID,
            providerLabel: option.providerName.components(separatedBy: " · ").first ?? option.providerName
        )
    }

    static func switchable(from options: [NativeChatModelOption]) -> [DesktopRegenerateModel] {
        options
            .filter { $0.modality == "chat" && !$0.isLegacy && $0.isAvailable }
            .map(DesktopRegenerateModel.init(option:))
    }
}

/// One turn of the transcript, laid out as the website lays it out
/// (`message-item.tsx`).
///
/// The reader's turn sits on the trailing edge: a quiet bubble in the
/// secondary fill with its bottom-trailing corner tucked, no hairline and no
/// shadow, at most 85% of the measure. Under it, revealed by hover or focus,
/// Copy · Edit · Fork Privately.
///
/// The reply is prose on the page — no card, no plate — and under it one row
/// of plain round actions (``MessageActionRow``): Copy · Good · Bad ·
/// Regenerate ▾ · More ▾, visible at rest on the newest reply and on hover
/// anywhere else. Nothing prints under an answer any more: the model, tokens
/// and cost are in More's info section, as they are on the web.
struct DesktopMessageRow: View {
    let message: NativeChatMessage
    /// Whether this turn has no row anywhere yet: a spoken line from a call
    /// that is still running, or a first turn the store is still creating.
    ///
    /// It suppresses the action row, as `isVoice` does on the web, and for the
    /// same reason: every action addresses something that does not exist yet.
    let isVoice: Bool
    /// A private chat's turn. It has words to copy, read and quote, and nothing
    /// on the server to rate, re-ask, branch, share or link to.
    var isPrivate = false
    /// The newest reply in the transcript, whose actions stay visible at rest
    /// and which alone can be regenerated.
    let isNewest: Bool
    /// The model's human name, resolved from the account catalog by the caller.
    let modelDisplayName: String?
    /// The model a regenerate would switch *from*: this answer's, or the
    /// conversation's.
    var currentModelID: String? = nil
    /// What the Regenerate menu's Switch Model submenu lists.
    let switchableModels: [DesktopRegenerateModel]
    let actions: MessageRowActions
    /// Where this message sits among its revisions, or nil when it has none.
    let branchPosition: NativeMessageBranchPosition?
    /// Whether a generation is running. Greys the pager and hides Edit.
    let isGenerating: Bool
    /// This reply is the one being read aloud: More offers Stop Reading.
    var isSpeaking = false
    /// A branch from this reply is on its way to the server.
    var isBranching = false
    /// A question that never reached the server: "Not sent", and Retry send.
    var isUnsent = false
    /// A new value opens this message's editor, as its Edit action does. Set
    /// only on the last message you sent, by ↑ in the composer.
    var editRequest: UUID? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @Environment(\.junoSnapshotCopied) private var snapshotCopied
    @Environment(\.junoMeasure) private var measure
    /// The pointer is over the turn: the web's `group-hover`.
    @State private var hovered = false
    /// Copy just happened; the copy mark is a check for two seconds.
    @State private var copiedNow = false
    private var copied: Bool { copiedNow || snapshotCopied }
    @State private var copiedReset: Task<Void, Never>?
    /// Whether a long prompt is showing in full. Collapsed is the resting
    /// state, as it is on the web.
    @State private var promptExpanded = false
    @State private var editing = false
    @State private var draft = ""
    /// The menu trigger under the pointer, and the one whose menu is open.
    @State private var hoveredTrigger: MessageMenuTrigger?
    @State private var openTrigger: MessageMenuTrigger?
    @FocusState private var focus: Focus?

    private enum Focus: Hashable {
        case editor, editButton
    }

    private var displayContent: String {
        message.sources.isEmpty
            ? message.content
            : NativeMessageContent.strippingTrailingSourcesSection(message.content)
    }

    private var parts: [NativeMessageContent.Part] {
        NativeMessageContent.parts(of: displayContent)
    }

    private var plainText: String {
        NativeMessageContent.plainText(of: message.content)
    }

    private var reasoningLines: [String]? {
        guard let reasoning = message.reasoning, !reasoning.isEmpty else { return nil }
        return JunoAIcssReasoningLines.lines(text: reasoning)
    }

    private var isLongPrompt: Bool {
        message.role == .user && NativePromptLimits.isLongMessage(plainText)
    }

    private var hasTextContent: Bool {
        !plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// An answer that is only a picture or a file: no Copy and no Regenerate.
    private var isMediaOnly: Bool {
        !hasTextContent && !message.attachments.isEmpty
    }

    private var isTurnHovered: Bool { hovered || snapshotHover }

    // MARK: Body

    var body: some View {
        Group {
            switch message.role {
            case .user: userTurn
            case .assistant: assistantTurn
            case .system, .tool:
                Text(message.content)
                    .junoFont(size: 13, relativeTo: .callout)
                    .junoSecondaryInk()
                    .textSelection(.enabled)
            }
        }
        .onHover { hovered = $0 }
        .onChange(of: editRequest) { _, request in
            guard request != nil, actions.editMessage != nil, !isGenerating, !editing else { return }
            openEditor(returningFocusToEdit: false)
        }
    }

    // MARK: The reader's turn

    private var userTurn: some View {
        VStack(alignment: .trailing, spacing: 0) {
            if editing {
                promptEditor
            } else if hasTextContent {
                VStack(alignment: .trailing, spacing: 0) {
                    userBubble
                    if isLongPrompt {
                        expandControl
                            .padding(.top, JunoSpace.hairline)
                            .padding(.trailing, -6)
                    }
                }
                .frame(maxWidth: measure * 0.85, alignment: .trailing)
            }
            if !editing, isUnsent {
                unsentRow.padding(.top, 6)
            }
            if !editing, !isVoice, !message.isPending {
                userActions.padding(.top, JunoSpace.hairline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityActions {
            if hasTextContent { voiceOverAction("Copy", copyMessage) }
            if actions.editMessage != nil, !isGenerating, !isVoice {
                voiceOverAction("Edit") { openEditor(returningFocusToEdit: false) }
            }
        }
    }

    /// `rounded-card rounded-br-md` in the bubble's own fill.
    private static let bubbleShape = UnevenRoundedRectangle(
        topLeadingRadius: JunoRadius.card,
        bottomLeadingRadius: JunoRadius.card,
        bottomTrailingRadius: JunoRadius.row,
        topTrailingRadius: JunoRadius.card,
        style: .continuous
    )

    /// The bubble: the web's `USER_BUBBLE_CLASS` — `text-reading` (16/1.7),
    /// `px-4 py-2.5`, `bg-secondary`, and nothing else. A reading surface that
    /// wears a hairline or casts a shadow is a card.
    private var userBubble: some View {
        Text(plainText)
            .junoType(.reading)
            .junoInk()
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.close)
            // The clamp is on or off in one frame; only the fade animates.
            .frame(
                maxHeight: isLongPrompt && !promptExpanded
                    ? NativePromptLimits.collapsedMessageHeight : nil,
                alignment: .top
            )
            .clipped()
            .overlay(alignment: .bottom) {
                if isLongPrompt {
                    // `from-secondary`: the bubble's own fill, so the clamp
                    // fades into the bubble rather than into a band of page.
                    LinearGradient(
                        colors: [Color.junoSecondary, Color.junoSecondary.opacity(0)],
                        startPoint: .bottom,
                        endPoint: .top
                    )
                    .frame(height: 64)
                    .opacity(promptExpanded ? 0 : 1)
                    .animation(
                        JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint),
                        value: promptExpanded
                    )
                    .allowsHitTesting(false)
                }
            }
            .background(Self.bubbleShape.fill(Color.junoSecondary))
            .clipShape(Self.bubbleShape)
    }

    /// "Show more · 22 lines" — a control, so the interface face rather than
    /// the mono metadata voice, on a 28pt row so it is a target rather than a
    /// line of type.
    private var expandControl: some View {
        Button {
            promptExpanded.toggle()
        } label: {
            Text(expandLabel)
        }
        .buttonStyle(MessageGhostButtonStyle(fontSize: 11, horizontalPadding: 6))
        .contentShape(.rect)
        .focusEffectDisabled()
        .accessibilityValue(promptExpanded ? "Expanded" : "Collapsed")
        .accessibilityIdentifier("juno.desktop.chat.message-expand")
    }

    private var expandLabel: String {
        if promptExpanded { return "Show less" }
        // The count is shown only when it is exact: the line sampler reads the
        // first 4,000 characters, and past that it would be a guess.
        let lines = NativePromptLimits.sampleLineCount(plainText)
        if plainText.utf8.count <= 4_000, lines > 1 {
            return "Show more · \(lines) lines"
        }
        return "Show more"
    }

    /// Copy · Edit · Fork Privately, with the pager outside the cluster.
    ///
    /// Always revealed by hover or focus, even on the newest turn: the reader's
    /// own words are not what they act on next.
    private var userActions: some View {
        MessageActionRow(
            turnHovered: isTurnHovered,
            copied: copied,
            openTrigger: $openTrigger,
            hoveredTrigger: nil
        ) {
            pager
        } cluster: {
            MessageActionButton(label: copied ? "Copied" : "Copy", action: copyMessage) {
                MessageCopyGlyph(copied: copied)
            }
            // Hidden, not greyed, while a reply is being written — as the web
            // does: an edit then would branch from under the answer.
            if actions.editMessage != nil, !isGenerating {
                MessageActionButton("Edit", icon: .pencil) {
                    openEditor(returningFocusToEdit: true)
                }
                .focused($focus, equals: .editButton)
                .accessibilityIdentifier("juno.desktop.chat.message-edit")
            }
            if let forkPrivately = actions.forkPrivately, !isGenerating, !isPrivate, !isUnsent {
                MessageActionButton("Fork privately", icon: .fork, action: forkPrivately)
            }
        }
    }

    /// A turn that never went out says so at rest, not behind a hover: the
    /// words are still here, and this is the one control that sends them.
    private var unsentRow: some View {
        HStack(spacing: JunoSpace.close) {
            Text("Not sent")
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoDestructiveInk)
            if let retrySend = actions.retrySend {
                Button(action: retrySend) {
                    Label {
                        Text("Retry send")
                    } icon: {
                        JunoIconView(.refresh, size: 14)
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isGenerating)
                .contentShape(.rect)
            }
        }
    }

    @ViewBuilder
    private var pager: some View {
        if let branchPosition, branchPosition.hasAlternatives, let stepBranch = actions.stepBranch {
            MessageVersionPager(
                position: branchPosition,
                isEnabled: !isGenerating,
                step: stepBranch
            )
        }
    }

    // MARK: The editor

    /// The bubble, opened for rewriting in place: the full column, the
    /// bubble's own fill and shape, and a graphite ring once it has focus.
    private var promptEditor: some View {
        VStack(alignment: .trailing, spacing: JunoSpace.snug) {
            editorField
                .padding(.horizontal, JunoSpace.regular - 5)
                .padding(.vertical, JunoSpace.close)
                .background {
                    ZStack {
                        // The 3pt halo stands outside the edge: a 6pt stroke
                        // on the path, its inner half under the fill.
                        Self.bubbleShape
                            .stroke(Color.junoRing.opacity(0.16), lineWidth: 6)
                            .opacity(focus == .editor ? 1 : 0)
                        Self.bubbleShape.fill(Color.junoSecondary)
                    }
                }
                .overlay {
                    Self.bubbleShape
                        .strokeBorder(focus == .editor ? Color.junoRing : Color.clear, lineWidth: 1)
                }
                .animation(
                    JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
                    value: focus == .editor
                )

            HStack(spacing: JunoSpace.snug) {
                // Esc is the field's own (`onKeyPress`), not a window-wide
                // cancel action that would reach past the editor.
                Button("Cancel", action: cancelEdit)
                    .buttonStyle(MessageGhostButtonStyle(fontSize: 13, horizontalPadding: JunoSpace.cozy))
                    .contentShape(.rect)
                // The editor's one prominent button, in the accent the column
                // is tinted with — bordered, not glass: the editor is content
                // on the transcript (§0.1).
                Button("Send", action: submitEdit)
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .contentShape(.rect)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .onAppear { focus = .editor }
    }

    /// Grows with its text up to fourteen lines, then scrolls. A hidden copy
    /// of the draft sets the height; the editor fills it.
    private var editorField: some View {
        Text(draft.isEmpty ? " " : draft + (draft.hasSuffix("\n") ? " " : ""))
            .junoType(.reading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(maxHeight: Self.editorMaximumHeight, alignment: .top)
            .hidden()
            .overlay {
                TextEditor(text: $draft)
                    .junoType(.reading)
                    .junoInk()
                    .textEditorStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .focused($focus, equals: .editor)
                    .onKeyPress(keys: [.return]) { press in
                        editorReturn(press)
                    }
                    .onKeyPress(.escape) {
                        cancelEdit()
                        return .handled
                    }
                    .accessibilityLabel("Edit message")
                    .accessibilityIdentifier("juno.desktop.chat.message-editor")
            }
    }

    /// Fourteen lines of 16pt at 1.7, plus the editor's own inset.
    private static let editorMaximumHeight: CGFloat = 381

    /// Return sends, ⇧Return breaks the line, ⌘Return sends. A Return that
    /// is committing an input method's marked text belongs to the input
    /// method.
    private func editorReturn(_ press: KeyPress) -> KeyPress.Result {
        if let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.hasMarkedText() {
            return .ignored
        }
        if press.modifiers.contains(.shift) { return .ignored }
        submitEdit()
        return .handled
    }

    private func openEditor(returningFocusToEdit: Bool) {
        draft = plainText
        editorReturnsFocusToEdit = returningFocusToEdit
        editing = true
    }

    @State private var editorReturnsFocusToEdit = false

    private func closeEditor() {
        editing = false
        if editorReturnsFocusToEdit {
            Task { @MainActor in
                await Task.yield()
                focus = .editButton
            }
        }
    }

    private func cancelEdit() {
        closeEditor()
        draft = plainText
    }

    /// Unchanged words just close the editor; changed ones branch.
    private func submitEdit() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let unchanged = trimmed == plainText.trimmingCharacters(in: .whitespacesAndNewlines)
        closeEditor()
        guard !unchanged, !isGenerating, let editMessage = actions.editMessage else { return }
        editMessage(trimmed)
    }

    // MARK: The reply

    private var assistantTurn: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                if let lines = reasoningLines, !lines.isEmpty {
                    JunoAIcssReasoningStream(
                        lines: lines,
                        streaming: message.isPending,
                        duration: nil,
                        showsHeader: !message.isPending
                    )
                    .frame(maxWidth: 520, alignment: .leading)
                }

                if let progress = message.mediaProgress {
                    NativeMediaGenerationView(progress: progress)
                } else if message.content.isEmpty, message.isPending {
                    HStack(spacing: 10) {
                        JunoThinkingMatrix()
                        JunoAIcssThinkingLabel("Thinking about your request", size: 15)
                    }
                    .frame(minHeight: 22)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Thinking about your request")
                    .accessibilityAddTraits(.updatesFrequently)
                } else if !parts.isEmpty {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                            switch part {
                            case .text(let text):
                                JunoLessonText(text, streaming: message.isPending)
                            case .artifact(let artifact):
                                DesktopInlineArtifactCard(
                                    artifact: artifact,
                                    open: artifact.streaming ? nil : { actions.openArtifact(artifact) }
                                )
                            }
                        }
                    }
                }

                if !message.sources.isEmpty {
                    DesktopMessageSources(sources: message.sources)
                }

                if let error = message.errorDescription {
                    Text(error)
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoDestructiveInk)
                        .textSelection(.enabled)
                }

                if let continueResponse = actions.continueResponse, showsContinue {
                    DesktopFinishNote(reason: message.finishReason ?? .length, continueResponse: continueResponse)
                }
            }

            // As on the web, a turn that errored gets no row: its only action
            // is Try again, on the error itself.
            if !isVoice, !message.isPending, message.errorDescription == nil {
                replyActions.padding(.top, 6)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityActions { replyAccessibilityActions }
    }

    /// Continue, on the newest reply that stopped part-way with nothing
    /// running. It lives in the finish note, never in the action row.
    private var showsContinue: Bool {
        isNewest && !isGenerating && !message.isPending
            && (message.finishReason == .length || message.finishReason == .networkError)
    }

    private var menuModel: MessageMenuModel {
        MessageMenuModel(
            MessageMenuModel.Input(
                hasText: hasTextContent,
                isMediaOnly: isMediaOnly,
                isNewest: isNewest,
                isGenerating: isGenerating,
                isPrivate: isPrivate,
                isSaved: actions.copyLink != nil,
                canRate: actions.setFeedback != nil,
                canRegenerate: actions.regenerate != nil,
                canReadAloud: actions.readAloud != nil,
                isSpeaking: isSpeaking,
                canBranch: actions.branch != nil,
                canForkPrivately: actions.forkPrivately != nil,
                canShare: actions.share != nil,
                canQuote: actions.quote != nil,
                modelName: modelDisplayName,
                meta: NativeMessageInfoFormat.meta(
                    promptTokens: message.promptTokens,
                    completionTokens: message.completionTokens,
                    costUSD: message.costUSD
                )
            )
        )
    }

    /// `[pager]` `[Copy] [Good] [Bad] [Regenerate ▾] [More ▾]`.
    private var replyActions: some View {
        let model = menuModel
        return MessageActionRow(
            alwaysVisible: isNewest,
            turnHovered: isTurnHovered,
            copied: copied,
            openTrigger: $openTrigger,
            hoveredTrigger: hoveredTrigger
        ) {
            pager
        } cluster: {
            ForEach(model.row, id: \.self) { action in
                switch action {
                case .copy:
                    MessageActionButton(label: copied ? "Copied" : "Copy", action: copyMessage) {
                        MessageCopyGlyph(copied: copied)
                    }
                case .goodResponse:
                    MessageActionButton(
                        "Good response",
                        icon: .thumbsUp,
                        isOn: message.feedback == .up,
                        celebrates: true
                    ) {
                        actions.setFeedback?(message.feedback == .up ? nil : .up)
                    }
                case .badResponse:
                    MessageActionButton(
                        "Bad response",
                        icon: .thumbsDown,
                        isOn: message.feedback == .down,
                        celebrates: true
                    ) {
                        actions.setFeedback?(message.feedback == .down ? nil : .down)
                    }
                case .regenerate:
                    MessageRegenerateMenu(
                        items: model.regenerate,
                        models: switchableModels,
                        currentModelID: currentModelID,
                        isOpen: openTrigger == .regenerate,
                        regenerate: { actions.regenerate?($0) }
                    )
                    .onHover { trackTrigger(.regenerate, hovering: $0) }
                case .more:
                    MessageMoreMenu(
                        items: model.more,
                        actions: actions,
                        isOpen: openTrigger == .more,
                        isBranching: isBranching
                    )
                    .onHover { trackTrigger(.more, hovering: $0) }
                }
            }
        }
    }

    private func trackTrigger(_ trigger: MessageMenuTrigger, hovering: Bool) {
        if hovering {
            hoveredTrigger = trigger
        } else if hoveredTrigger == trigger {
            hoveredTrigger = nil
        }
    }

    /// Every action, reachable by VoiceOver whether or not the row is showing.
    @ViewBuilder
    private var replyAccessibilityActions: some View {
        if !isVoice, !message.isPending, message.errorDescription == nil {
            let model = menuModel
            if model.row.contains(.copy) { voiceOverAction("Copy", copyMessage) }
            if model.row.contains(.goodResponse) {
                voiceOverAction("Good response") { actions.setFeedback?(message.feedback == .up ? nil : .up) }
                voiceOverAction("Bad response") { actions.setFeedback?(message.feedback == .down ? nil : .down) }
            }
            if model.row.contains(.regenerate) {
                voiceOverAction("Regenerate") { actions.regenerate?(.again) }
            }
            ForEach(Array(model.more.enumerated()), id: \.offset) { _, item in
                switch item {
                case .readAloud: voiceOverAction("Read aloud") { actions.readAloud?() }
                case .stopReading: voiceOverAction("Stop reading") { actions.stopReading?() }
                case .branch(let destinations):
                    if destinations.contains(.intoNewChat) {
                        voiceOverAction("Branch into a new saved chat") { actions.branch?() }
                    }
                    if destinations.contains(.forkPrivately) {
                        voiceOverAction("Fork privately") { actions.forkPrivately?() }
                    }
                case .shareChat: voiceOverAction("Share chat") { actions.share?() }
                case .quote: voiceOverAction("Quote in composer") { actions.quote?() }
                case .copyLink: voiceOverAction("Copy link") { actions.copyLink?() }
                case .divider, .info: EmptyView()
                }
            }
        }
    }

    /// One of the turn's actions as VoiceOver offers it: a named button inside
    /// `.accessibilityActions`, which is never drawn.
    private func voiceOverAction(_ name: String, _ action: @escaping () -> Void) -> some View {
        Button(name, action: action)
            .contentShape(.rect)
    }

    // MARK: Copy

    /// Copy, with the check cross-fading in as the confirmation — no toast:
    /// the mark is the whole feedback. It reverts after two seconds.
    private func copyMessage() {
        actions.copy?()
        copiedReset?.cancel()
        copiedNow = true
        copiedReset = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            copiedNow = false
        }
    }
}

/// A ghost text button: no fill at rest, the neutral hover fill under the
/// pointer, a 28pt row with a 10pt radius — the web's "Show more" and the
/// bubble editor's Cancel.
struct MessageGhostButtonStyle: ButtonStyle {
    var fontSize: CGFloat = 13
    var horizontalPadding: CGFloat = JunoSpace.cozy

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, fontSize: fontSize, horizontalPadding: horizontalPadding)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        let fontSize: CGFloat
        let horizontalPadding: CGFloat
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        private var lit: Bool { hovered && isEnabled }

        var body: some View {
            configuration.label
                .junoFont(size: fontSize, relativeTo: fontSize < 12 ? .caption : .callout, weight: .medium)
                .foregroundStyle(lit ? Color.junoForeground : Color.junoSecondaryInk)
                .padding(.horizontal, horizontalPadding)
                .frame(minHeight: 28)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(Color.junoHover)
                        .opacity(lit ? 1 : 0)
                )
                .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
                .opacity(isEnabled ? 1 : 0.5)
                .scaleEffect(
                    configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1
                )
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}
