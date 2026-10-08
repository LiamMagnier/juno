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
    /// The approval cards this reply is blocked on — above its answer.
    var approvals = MessageRowApprovals()
    /// The stream behind this pending reply dropped and is being picked up.
    var isRecovering = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @Environment(\.junoSnapshotCopied) private var snapshotCopied
    @Environment(\.junoMeasure) private var measure
    /// The stored rows behind the artifacts this reply mentions.
    @Environment(\.junoArtifactResolver) private var artifactResolver
    /// ⌘F's highlight for this message.
    @Environment(\.junoFindHighlight) private var findHighlight
    @Environment(\.junoActivityPanelMessageID) private var activityPanelMessageID
    @Environment(\.desktopAgentThread) private var agentThread
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
    /// A regenerate waiting on the reader's go-ahead, because this reply's
    /// artifacts go with it.
    @State private var pendingRegenerate: MessageRegenerateRequest?
    @FocusState private var focus: Focus?
    /// The earlier version on screen — an index into ``versions`` — or nil
    /// for the live row, which is always the newest page.
    @State private var versionIndex: Int?
    /// The earlier versions, read on the first step back and dropped whenever
    /// the server's count moves (a regenerate or an edit added one).
    @State private var versions: [NativeMessageVersion]?
    @State private var versionsLoading = false

    private enum Focus: Hashable {
        case editor, editButton
    }

    /// What the turn shows: the live row, or the earlier version the reader
    /// paged back to (the web's `view`). Everything drawn reads this; ids,
    /// the rating and the pending state are the live row's either way.
    private var shown: NativeChatMessage {
        guard let versionIndex, let versions, versionIndex < message.versionCount,
            versions.indices.contains(versionIndex)
        else { return message }
        return message.showing(versions[versionIndex])
    }

    private var parts: [NativeMessageContent.Part] {
        Self.parts(of: shown)
    }

    /// A reply's parts as the row draws them: its words without the trailing
    /// "Sources" section the sources pill replaces, split around artifacts.
    nonisolated static func parts(of message: NativeChatMessage) -> [NativeMessageContent.Part] {
        parts(of: message, content: message.content)
    }

    /// The same, for `content` standing in for the message's own — the paced
    /// prefix of a reply being written.
    nonisolated static func parts(of message: NativeChatMessage, content: String) -> [NativeMessageContent.Part] {
        NativeMessageContent.parts(
            of: message.sources.isEmpty
                ? content
                : NativeMessageContent.strippingTrailingSourcesSection(content)
        )
    }

    /// The prose runs of a reply, in order — what ⌘F searches.
    static func textParts(of message: NativeChatMessage) -> [String] {
        parts(of: message).compactMap { part in
            if case .text(let text) = part { return text }
            return nil
        }
    }

    /// How many of the reply's sources a `[n]` in it may point at: all of
    /// them when the model was handed them as a numbered corpus, otherwise
    /// none — the web's rule, so a bracket never resolves to an arbitrary,
    /// wrong source.
    static func citationCount(of message: NativeChatMessage) -> Int {
        message.sources.contains(where: \.cited) ? message.sources.count : 0
    }

    private var plainText: String {
        NativeMessageContent.plainText(of: shown.content)
    }

    private var isLongPrompt: Bool {
        shown.role == .user && NativePromptLimits.isLongMessage(plainText)
    }

    private var hasTextContent: Bool {
        !plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// An answer that is only a picture or a file: no Copy and no Regenerate.
    private var isMediaOnly: Bool {
        !hasTextContent && !shown.attachments.isEmpty
    }

    private var isTurnHovered: Bool { hovered || snapshotHover }

    // MARK: Body

    var body: some View {
        Group {
            switch shown.role {
            case .user: userTurn
            case .assistant: assistantTurn
            case .system, .tool:
                Text(shown.content)
                    .junoFont(size: 13, relativeTo: .callout)
                    .junoSecondaryInk()
                    .textSelection(.enabled)
            }
        }
        .onHover { hovered = $0 }
        .onChange(of: message.versionCount) {
            // A regenerate or an edit appended a version under the same id:
            // back to the newest page, and history is read again on demand.
            versionIndex = nil
            versions = nil
        }
        .onChange(of: editRequest) { _, request in
            guard request != nil, actions.editMessage != nil, !isGenerating, !editing else { return }
            openEditor(returningFocusToEdit: false)
        }
    }

    // MARK: The reader's turn

    private var userTurn: some View {
        VStack(alignment: .trailing, spacing: 0) {
            // What came with the question, above it: pictures as themselves,
            // documents as pages. A turn that is only files has no bubble.
            if !shown.attachments.isEmpty {
                UserAttachmentStrip(attachments: shown.attachments)
                    .padding(.bottom, editing || hasTextContent ? JunoSpace.snug : 0)
            }
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
            if !editing, !isVoice, !shown.isPending {
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
        Text(JunoFindText.highlighted(plainText, with: findHighlight))
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
            // Find's current match may sit under the clamp's fade, where the
            // bar's "3 of 12" would point at nothing visible: open the bubble.
            .onChange(of: findHighlight?.current) { _, current in
                if current != nil, isLongPrompt, !promptExpanded {
                    promptExpanded = true
                }
            }
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
            // A state, so the interface face: mono is for code, ids, counts
            // and costs (§10.2 rule 6). The web sets it in its mono voice.
            Text("Not sent")
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
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
                // The web's outline: neutral, never the column's coral tint.
                .tint(nil)
                .disabled(isGenerating)
                .contentShape(.rect)
            }
        }
    }

    /// ‹ 2/3 ›: the versions the server keeps of this turn (regenerate, edit
    /// and resend), the live row as the last page — or, on a turn with none,
    /// its place among its branches.
    @ViewBuilder
    private var pager: some View {
        if message.versionCount > 0, actions.loadVersions != nil {
            MessageVersionPager(
                index: versionIndex ?? message.versionCount,
                total: message.versionCount + 1,
                isEnabled: !isGenerating,
                isLoading: versionsLoading,
                step: stepVersion
            )
        } else if let branchPosition, branchPosition.hasAlternatives, let stepBranch = actions.stepBranch {
            MessageVersionPager(
                position: branchPosition,
                isEnabled: !isGenerating,
                step: stepBranch
            )
        }
    }

    /// One page back or forward. The earlier versions are read on the first
    /// step back; a count the server and this Mac disagree on stays put, as
    /// the web's pager does. Presentational only: the row is untouched, and a
    /// regenerate always continues from the live thread.
    private func stepVersion(_ direction: Int) {
        let count = message.versionCount
        let current = versionIndex ?? count
        let next = min(max(current + direction, 0), count)
        guard next != current else { return }
        if next == count {
            versionIndex = nil
            return
        }
        if let versions {
            if versions.indices.contains(next) { versionIndex = next }
            return
        }
        guard !versionsLoading, let loadVersions = actions.loadVersions else { return }
        versionsLoading = true
        Task { @MainActor in
            defer { versionsLoading = false }
            do {
                let loaded = try await loadVersions()
                versions = loaded
                if loaded.indices.contains(next) { versionIndex = next }
            } catch {
                actions.reportFailure?("Couldn’t load that version.")
            }
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
                    .buttonStyle(.junoProminent)
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
    ///
    /// "Unchanged" is against the **live** question, as on the web: the
    /// editor opens on the page shown, so paging back to an earlier wording
    /// and sending it as it stands is a one-step resend of that wording.
    private func submitEdit() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let unchanged = trimmed == NativeMessageContent.plainText(of: message.content)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        closeEditor()
        guard !unchanged, !isGenerating, let editMessage = actions.editMessage else { return }
        editMessage(trimmed)
    }

    // MARK: The reply

    /// The reply, top to bottom (spec §6.3 as the rework orders it): the run,
    /// any approval it is blocked on, the answer — or the error in its place —,
    /// the note on how it ended, its sources, and its actions.
    private var assistantTurn: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                // In an agent's thread a reply speaks as the agent: its byline,
                // and while nothing has happened yet, its face thinking.
                if let agentThread, !isVoice, !shown.isPending {
                    DesktopAgentByline(identity: agentThread)
                }
                if let agentThread, !isVoice, isAgentWaitingToStart {
                    DesktopAgentPendingRow(identity: agentThread)
                } else if !isVoice {
                    if isLiveInChatResearch {
                        // A research turn a profile-1 server answers in the
                        // chat: one research row while it works (SPEC §9.11.3).
                        DesktopResearchRow(
                            run: NativeResearchRun.inChat(message: shown, live: true, question: actions.researchQuestion),
                            ownsLoop: activityPanelMessageID != shown.id,
                            citations: shown.sources,
                            citingText: shown.content,
                            open: { actions.openResearch?("message:\(shown.id)") }
                        )
                    } else {
                        DesktopRunBlock(
                            message: shown,
                            live: shown.isPending,
                            recovering: isRecovering,
                            awaitingApproval: approvals.approvals.contains(where: \.isPending),
                            ownsLoop: activityPanelMessageID != shown.id,
                            openPanel: actions.openActivity,
                            openResearch: actions.openResearch
                        )
                    }
                }

                // Above the answer: the turn is blocked on this, so it sits
                // where the reader's eye already is.
                ForEach(approvals.approvals) { approval in
                    DesktopApprovalCard(
                        approval: approval,
                        isBusy: approvals.inFlightID == approval.id,
                        errorMessage: approvals.error(approval.id),
                        canAllowScope: approvals.canAllowScope(approval),
                        decide: { decision in approvals.decide(approval, decision) }
                    )
                }

                if let progress = shown.mediaProgress, shown.errorDescription == nil {
                    NativeMediaGenerationView(progress: progress)
                } else if let error = standaloneError {
                    DesktopTurnError(message: error, retry: showsRetry ? actions.retry : nil)
                } else if !parts.isEmpty || !shown.attachments.isEmpty {
                    answerBody
                }

                if let question = suggestedResearch, let researchThis = actions.researchThis, !shown.isPending {
                    DesktopResearchThisChip(question: question) { researchThis(question) }
                }

                if let note = noteSentence {
                    DesktopTurnNote(
                        sentence: note,
                        isFailure: shown.errorDescription != nil,
                        continueResponse: showsContinue ? actions.continueResponse : nil
                    )
                }

                if !shown.sources.isEmpty {
                    DesktopMessageSources(sources: shown.sources)
                }
            }

            // As on the web, a turn that errored gets no row: its only action
            // is Try again, on the error itself.
            if !isVoice, !shown.isPending, shown.errorDescription == nil {
                replyActions.padding(.top, 6)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityActions { replyAccessibilityActions }
        // Opener and action on one line: the targets gate reads a dialog's
        // buttons as system-drawn only when its brace opens on that line.
        .confirmationDialog("Regenerate this answer?", isPresented: regenerateConfirmation, titleVisibility: .visible, presenting: pendingRegenerate) { request in
            Button("Regenerate", role: .destructive) {
                pendingRegenerate = nil
                actions.regenerate?(request)
            }
            Button("Cancel", role: .cancel) { pendingRegenerate = nil }
        } message: { _ in
            Text(artifactCount == 1 ? "Its 1 artifact will be replaced." : "Its \(artifactCount) artifacts will be replaced.")
        }
    }

    /// A reply in an agent's thread that has not started anything yet: no
    /// activity, no words, no media. Its pending row is the agent's own.
    private var isAgentWaitingToStart: Bool {
        shown.isPending && shown.activity.isEmpty && parts.isEmpty
            && shown.answerStartedAt == nil && shown.mediaProgress == nil && !isRecovering
    }

    /// A live research turn answered in the chat, whose report has not
    /// started: the research row stands where the run block would.
    private var isLiveInChatResearch: Bool {
        guard shown.isPending, shown.mediaProgress == nil else { return false }
        // Through the writing too: the report takes minutes, and the working
        // view says which section it is on while the answer streams below.
        if NativeResearchRun.isInChatResearch(activity: shown.activity) { return true }
        guard shown.answerStartedAt == nil else { return false }
        // Asked for, and no sign yet of a server that hands research off or
        // refused it: a timeline server's rows carry `seq` from the first one.
        return shown.researchRequested && !shown.activity.contains { $0.seq != nil || $0.notice?.code == "research_skipped" }
    }

    /// The question a `suggest_research` call left under this answer — the
    /// newest one wins (SPEC §3.8.9).
    private var suggestedResearch: String? {
        shown.activity.last { $0.call?.tool == "suggest_research" && $0.call?.status == .succeeded }?
            .call?.args["question"]
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }

    /// The words, the files it produced and the artifacts it wrote — in the
    /// reading style, with the tail fading while it is written.
    private var answerBody: some View {
        let citations = Self.citationCount(of: shown)
        let bases = partFindBases(citations: citations)
        return VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            // The web's order: documents it produced, then the pictures and
            // clips, then the words.
            if !shown.attachments.isEmpty {
                AssistantAttachments(
                    attachments: shown.attachments,
                    canEditImages: !isPrivate && !isGenerating
                )
            }
            if !parts.isEmpty {
                // Paced: the words are released at a steady cadence and the
                // newest fade in where the writing is (JunoPacedStream), in
                // place of the old 30% tail band.
                JunoPacedStream(shown.content, live: shown.isPending) { paced in
                    pacedParts(Self.parts(of: shown, content: paced), bases: bases)
                }
            }
        }
        .environment(\.junoProseStyle, .reading)
        .environment(\.junoCitationCount, citations)
        .environment(\.junoCitationPopover, citations > 0 ? citationPopover : nil)
    }

    /// The reply's parts as drawn: prose runs and the artifacts between them.
    private func pacedParts(_ parts: [NativeMessageContent.Part], bases: [Int]) -> some View {
        VStack(alignment: .leading, spacing: JunoProseMetrics.blockGap) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                switch part {
                case .text(let text):
                    JunoLessonText(text, streaming: shown.isPending)
                        .environment(\.junoFindHighlight, findHighlight?.shifted(by: bases.indices.contains(index) ? bases[index] : 0))
                case .artifact(let artifact) where NativeResearchReport.isReport(artifact):
                    researchReportCard(artifact)
                        .junoStreamBlockReveal()
                case .artifact(let artifact):
                    let card = artifactResolver.card(
                        for: artifact,
                        message: shown,
                        messageIsPending: shown.isPending
                    )
                    let message = shown
                    DesktopInlineArtifactCard(
                        card: card,
                        open: card.isStreaming ? nil : { actions.openArtifact(artifact, message) }
                    )
                    .junoStreamBlockReveal()
                }
            }
        }
    }

    /// The door into the research report this answer carries, in place of the
    /// generic artifact card: while it is written, the section and the words
    /// so far; once written, the report's card, which opens its window.
    @ViewBuilder
    private func researchReportCard(_ artifact: NativeMessageContent.ArtifactReference) -> some View {
        if artifact.streaming {
            NativeResearchReportCard(
                content: .writing(
                    title: artifact.title,
                    words: artifact.content.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count,
                    section: NativeResearchReport.sections(of: artifact.content).last(where: { $0.level > 0 })?.title
                ),
                open: nil
            )
        } else if let report = NativeResearchReport(message: shown, question: actions.researchQuestion) {
            NativeResearchReportCard(
                content: .report(report),
                open: actions.openReport.map { open in { open(report.id) } }
                    ?? { actions.openArtifact(artifact, shown) }
            )
        } else {
            let card = artifactResolver.card(for: artifact, message: shown, messageIsPending: shown.isPending)
            DesktopInlineArtifactCard(card: card, open: { actions.openArtifact(artifact, shown) })
        }
    }

    /// Where each prose part's find matches start within the reply.
    private func partFindBases(citations: Int) -> [Int] {
        guard let findHighlight, findHighlight.isActive else { return [] }
        var running = 0
        return parts.map { part in
            defer {
                if case .text(let text) = part {
                    running += JunoFindText.count(of: findHighlight.query, inLesson: text, citations: citations)
                }
            }
            return running
        }
    }

    /// A citation's source, by its number.
    private var citationPopover: JunoCitationPopover {
        let sources = shown.sources
        return JunoCitationPopover { number in
            guard sources.indices.contains(number - 1) else { return AnyView(EmptyView()) }
            return AnyView(SourceCitationPopover(source: sources[number - 1], number: number))
        }
    }

    /// A reply that failed with nothing to show for it: the error takes the
    /// answer's place. With a partial answer, the failure is its note instead.
    private var standaloneError: String? {
        guard let error = shown.errorDescription, shown.mediaProgress == nil else { return nil }
        let hasPartial = hasTextContent && shown.content != error
        return hasPartial || !shown.attachments.isEmpty ? nil : error
    }

    /// Try Again, on the newest reply with nothing running.
    private var showsRetry: Bool {
        isNewest && !isGenerating && actions.retry != nil
    }

    /// The note under the answer: a partial answer's failure, or why it ended
    /// short of its end.
    private var noteSentence: String? {
        guard !shown.isPending, shown.mediaProgress == nil else { return nil }
        if let error = shown.errorDescription {
            return standaloneError == nil ? error : nil
        }
        return DesktopFinishCopy.sentence(for: shown.finishReason)
    }

    /// The artifacts this reply wrote. Regenerating a reply deletes them on
    /// the server (the web's regenerate does the same, and is reported to the
    /// owner), so a Mac regenerate of a reply that carries any asks first —
    /// Try Again, More Concise, Add Details and Switch Model alike.
    private var artifactCount: Int {
        Set(parts.compactMap { part -> String? in
            if case .artifact(let artifact) = part { return artifact.id }
            return nil
        }).count
    }

    private var regenerateConfirmation: Binding<Bool> {
        Binding(get: { pendingRegenerate != nil }, set: { if !$0 { pendingRegenerate = nil } })
    }

    private func requestRegenerate(_ request: MessageRegenerateRequest) {
        if artifactCount > 0 {
            pendingRegenerate = request
        } else {
            actions.regenerate?(request)
        }
    }

    /// Continue, on the newest reply that stopped part-way with nothing
    /// running. It lives in the finish note, never in the action row.
    private var showsContinue: Bool {
        isNewest && !isGenerating && !shown.isPending
            && (shown.finishReason == .length || shown.finishReason == .networkError)
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
                    promptTokens: shown.promptTokens,
                    completionTokens: shown.completionTokens,
                    costUSD: shown.costUSD
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
                        isOn: shown.feedback == .up,
                        celebrates: true
                    ) {
                        actions.setFeedback?(shown.feedback == .up ? nil : .up)
                    }
                case .badResponse:
                    MessageActionButton(
                        "Bad response",
                        icon: .thumbsDown,
                        isOn: shown.feedback == .down,
                        celebrates: true
                    ) {
                        actions.setFeedback?(shown.feedback == .down ? nil : .down)
                    }
                case .regenerate:
                    MessageRegenerateMenu(
                        items: model.regenerate,
                        models: switchableModels,
                        currentModelID: currentModelID,
                        isOpen: openTrigger == .regenerate,
                        regenerate: requestRegenerate
                    )
                    .onHover { trackTrigger(.regenerate, hovering: $0) }
                case .more:
                    MessageMoreMenu(
                        items: model.more,
                        actions: actions,
                        content: shown.content,
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
        if !isVoice, !shown.isPending, shown.errorDescription == nil {
            let model = menuModel
            if model.row.contains(.copy) { voiceOverAction("Copy", copyMessage) }
            if model.row.contains(.goodResponse) {
                voiceOverAction("Good response") { actions.setFeedback?(shown.feedback == .up ? nil : .up) }
                voiceOverAction("Bad response") { actions.setFeedback?(shown.feedback == .down ? nil : .down) }
            }
            if model.row.contains(.regenerate) {
                voiceOverAction("Regenerate") { requestRegenerate(.again) }
            }
            ForEach(Array(model.more.enumerated()), id: \.offset) { _, item in
                switch item {
                case .readAloud: voiceOverAction("Read aloud") { actions.readAloud?(shown.content) }
                case .stopReading: voiceOverAction("Stop reading") { actions.stopReading?() }
                case .branch(let destinations):
                    if destinations.contains(.intoNewChat) {
                        voiceOverAction("Branch into a new saved chat") { actions.branch?() }
                    }
                    if destinations.contains(.forkPrivately) {
                        voiceOverAction("Fork privately") { actions.forkPrivately?() }
                    }
                case .shareChat: voiceOverAction("Share chat") { actions.share?() }
                case .quote: voiceOverAction("Quote in composer") { actions.quote?(shown.content) }
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
        actions.copy?(shown.content)
        copiedReset?.cancel()
        copiedNow = true
        copiedReset = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            copiedNow = false
        }
    }
}

/// The approval cards a reply is blocked on, and what answering one does.
struct MessageRowApprovals {
    var approvals: [NativeChatApproval] = []
    var inFlightID: String? = nil
    var error: (String) -> String? = { _ in nil }
    var canAllowScope: (NativeChatApproval) -> Bool = { $0.canAllowScope }
    var decide: (NativeChatApproval, NativeChatApprovalDecision) -> Void = { _, _ in }
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
