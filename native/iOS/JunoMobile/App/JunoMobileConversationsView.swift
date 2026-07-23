import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

/// The chat destination: the selected conversation's transcript + composer, or
/// an empty state that starts a new chat. The conversation list lives in the
/// sidebar; this screen never owns a NavigationStack (the root provides one).
struct JunoMobileChatDetailScreen: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    var projects: [NativeProject] = []
    var attachmentModel: NativeComposerAttachmentModel?
    var profileName: String?
    /// Carries a home-screen prompt into the conversation that was just created.
    @State private var seededPrompt: String?

    private var selected: NativeConversation? {
        guard let id = model.selectedConversationID else { return nil }
        return model.conversations.first { $0.id == id }
    }

    var body: some View {
        Group {
            if let selected {
                JunoMobileConversationDetail(
                    model: model,
                    conversation: selected,
                    projects: projects,
                    attachmentModel: attachmentModel,
                    seededPrompt: $seededPrompt
                )
            } else {
                emptyState
            }
        }
    }

    /// The website's home, not a generic empty state: a time-of-day greeting in
    /// the editorial serif, the composer as the centre of gravity, and real
    /// prompt modes. Sending here creates the conversation and seeds it, so the
    /// first message is the one you typed rather than an empty chat you then
    /// have to type into again.
    private var emptyState: some View {
        JunoMobileHomeView(
            model: model,
            profileName: profileName,
            recentProjects: projects,
            start: { opening in
                Task {
                    guard let id = await model.createConversation() else { return }
                    model.selectedConversationID = id
                    if let opening, !opening.isEmpty {
                        seededPrompt = opening
                    }
                }
            }
        )
    }
}

private struct JunoMobileConversationDetail: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    var projects: [NativeProject] = []
    var attachmentModel: NativeComposerAttachmentModel?
    /// A prompt carried in from the home screen, consumed once into the draft.
    @Binding var seededPrompt: String?
    @State private var showingRename = false
    @State private var editValue = ""
    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    /// Set when switching models forced the thinking level to move, so the
    /// change is explained rather than silent.
    @State private var thinkingNotice: String?
    @State private var isNearBottom = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composerFocused: Bool

    private let bottomAnchor = "juno.chat.bottom"

    private var messages: [NativeChatMessage] {
        model.messages(for: conversation.id)
    }

    /// Changes whenever streamed content grows or a message is added, driving
    /// the follow-the-stream auto-scroll.
    private var streamSignature: Int {
        let last = messages.last
        return messages.count
            + (last?.content.count ?? 0)
            + (last?.reasoning?.count ?? 0)
    }

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var generatingHere: Bool {
        model.isGenerating && model.activeChatConversationID == conversation.id
    }

    /// The transcript itself. Extracted from `body` because the merged view
    /// stacks a long modifier chain on an inline `ScrollView`, and the type
    /// checker times out on the combined expression.
    @ViewBuilder
    private var transcript: some View {
        if messages.isEmpty {
            ContentUnavailableView(
                "No messages yet",
                systemImage: "bubble.left.and.text.bubble.right",
                description: Text("This conversation is ready for its first message.")
            )
            .frame(maxWidth: .infinity, minHeight: 360)
        } else {
            LazyVStack(spacing: 14) {
                ForEach(messages) { message in
                    JunoMobileMessageRow(message: message)
                }
            }
            .padding()
            Color.clear
                .frame(height: 1)
                .id(bottomAnchor)
        }
    }

    /// Extracted from `body` for the same reason as `scrollArea`: the
    /// nested menu was on its own enough to time the type checker out.
    @ToolbarContentBuilder
    private var conversationToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    editValue = conversation.title
                    showingRename = true
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Divider()
                Button {
                    Task {
                        await model.setPinned(id: conversation.id, pinned: !conversation.pinned)
                    }
                } label: {
                    Label(
                        conversation.pinned ? "Unpin" : "Pin",
                        systemImage: conversation.pinned ? "pin.slash" : "pin"
                    )
                }
                Button {
                    Task {
                        await model.setArchived(
                            id: conversation.id,
                            archived: !conversation.isArchived
                        )
                    }
                } label: {
                    Label(
                        conversation.isArchived ? "Unarchive" : "Archive",
                        systemImage: conversation.isArchived ? "tray.and.arrow.up" : "archivebox"
                    )
                }
            } label: {
                Label("Conversation actions", systemImage: "ellipsis")
            }
            .disabled(model.isMutating || conversation.isPending)
        }
    }

    /// The scrolling transcript with its follow-the-stream behaviour and
    /// jump-to-latest control. A separate function so `body` stays a short
    /// enough expression for the type checker.
    private func scrollArea(_ proxy: ScrollViewProxy) -> some View {
        ScrollView { transcript }
        // Scoped to the transcript, NOT to the whole screen: applied after
        // `.safeAreaInset` it was stamped onto every composer control too,
        // so the model and Thinking chips all reported this identifier
        // instead of their own.
        .accessibilityIdentifier("juno.mobile.conversation-detail")
        .background(Color.junoCanvas)
        .defaultScrollAnchor(.bottom)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            let distance = geometry.contentSize.height
                - geometry.contentOffset.y
                - geometry.containerSize.height
            // Non-scrollable (content fits) counts as "at bottom" so the
            // jump-to-latest control never shows when there is nothing to
            // scroll to.
            return geometry.contentSize.height <= geometry.containerSize.height
                || distance < 120
        } action: { _, nearBottom in
            isNearBottom = nearBottom
        }
        .onChange(of: streamSignature) { _, _ in
            guard isNearBottom else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                proxy.scrollTo(bottomAnchor, anchor: .bottom)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !isNearBottom && !messages.isEmpty {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                        proxy.scrollTo(bottomAnchor, anchor: .bottom)
                    }
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.body.weight(.semibold))
                        .padding(12)
                }
                .background(.regularMaterial, in: Circle())
                .padding(.trailing, 16)
                .padding(.bottom, 8)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel("Scroll to latest")
                .accessibilityIdentifier("juno.mobile.chat-scroll-bottom")
            }
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            scrollArea(proxy)
        }
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { conversationToolbar }
        .alert("Rename conversation", isPresented: $showingRename) {
            TextField("Title", text: $editValue)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { await model.renameConversation(id: conversation.id, title: editValue) }
            }
        }
        .safeAreaInset(edge: .bottom) {
            JunoMobileComposer(
                model: model,
                conversation: conversation,
                projects: projects,
                prompt: $prompt,
                selectedModelID: $selectedModelID,
                reasoningEffort: $reasoningEffort,
                thinkingNotice: $thinkingNotice,
                attachmentModel: attachmentModel,
                composerFocused: $composerFocused
            )
        }
        .onAppear {
            configureSelections()
            // Consumed once: the home screen's text becomes this conversation's
            // draft, and clearing it stops it reappearing on every redraw.
            if let seededPrompt {
                prompt = seededPrompt
                self.seededPrompt = nil
                composerFocused = true
            }
        }
        .onChange(of: selectedModelID) { _, _ in configureSelections() }
        .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
    }

    /// Keeps the composer's model and thinking selections valid as the catalog
    /// loads and as the user switches models. Two rules matter here: a model
    /// that is no longer selectable (plan change, retirement) falls back to one
    /// that is, and a thinking level the new model cannot honour is re-fitted —
    /// with a sentence explaining it, never silently.
    private func configureSelections() {
        selectedModelID = JunoMobileComposerSelection.resolvedModelID(
            current: selectedModelID,
            conversationModel: conversation.model,
            selectable: model.selectableModels
        )
        guard let selectedModel else {
            reasoningEffort = nil
            return
        }
        let adjustment = NativeThinkingScale(model: selectedModel)
            .adjusting(reasoningEffort)
        reasoningEffort = adjustment.effort
        // Only surface the notice when something actually moved; the draft is
        // untouched either way.
        thinkingNotice = adjustment.explanation
    }
}

private struct JunoMobileMessageRow: View {
    let message: NativeChatMessage

    private var isUser: Bool { message.role == .user }

    /// The assistant is working but has not started writing the answer yet — the
    /// moment to show the inline "Thinking about your request" status.
    private var showThinking: Bool {
        !isUser && message.isPending && message.content.isEmpty
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isUser { Spacer(minLength: 64) }
            if !isUser {
                Image(systemName: "sparkle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.junoAccent)
                    .frame(width: 20, height: 20)
                    .padding(.top, 3)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 7) {
                Text(isUser ? "You" : "Juno").junoMetadata()

                // Reasoning sits above the answer as a collapsible control, not
                // as a forgotten note beneath it.
                if !isUser, let reasoning = message.reasoning, !reasoning.isEmpty {
                    JunoReasoningDisclosure(text: reasoning)
                }

                if showThinking {
                    JunoThinkingIndicator()
                } else if !message.content.isEmpty {
                    if isUser {
                        Text(message.content)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        // Real Markdown: headings, lists, tables, code. A reply
                        // rendered as one flat string was losing every structure
                        // the model actually produced.
                        JunoMarkdownText(message.content)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if !message.sources.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sources").junoMetadata()
                        ForEach(message.sources, id: \.url) { source in
                            Link(destination: source.url) {
                                Label(source.title, systemImage: "link")
                                    .font(.caption)
                                    .lineLimit(1)
                            }
                        }
                    }
                }

                if (message.model?.isEmpty == false) || (message.isPending && !showThinking) {
                    HStack(spacing: 8) {
                        if let model = message.model, !model.isEmpty {
                            Text(junoDisplayModelName(model)).font(.caption2).foregroundStyle(.tertiary)
                        }
                        if message.isPending && !showThinking {
                            ProgressView().controlSize(.mini)
                        }
                    }
                }

                if let error = message.errorDescription {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            // Only the user's own words sit on a surface. The assistant's
            // answer is the reading surface — putting it inside a card made
            // every reply a grey rectangle and cost it the full column width.
            .padding(.horizontal, isUser ? 13 : 0)
            .padding(.vertical, isUser ? 10 : 0)
            .background(
                isUser
                    ? AnyShapeStyle(Color.junoAccent.opacity(0.12))
                    : AnyShapeStyle(Color.clear)
            )
            .clipShape(
                RoundedRectangle(
                    cornerRadius: isUser ? JunoCornerRadius.message : 0, style: .continuous
                )
            )
            .contextMenu {
                Button {
                    UIPasteboard.general.string = message.content
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .disabled(message.content.isEmpty)
            }
            if !isUser { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isUser ? "You said" : "Juno replied")
    }
}

/// The inline "Thinking about your request" status shown before the assistant's
/// answer begins. Uses a subtle, self-limiting symbol pulse that is suppressed
/// under Reduce Motion.
private struct JunoThinkingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "sparkles")
                .font(.callout)
                .foregroundStyle(Color.junoAccent)
                .symbolEffect(.pulse, isActive: !reduceMotion)
            Text("Thinking about your request")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Thinking about your request")
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// The post-completion reasoning trace, presented as a compact expandable
/// control (chevron, coral label) rather than a metadata footnote. VoiceOver
/// announces the expanded/collapsed state via `DisclosureGroup`.
private struct JunoReasoningDisclosure: View {
    let text: String
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
        } label: {
            // Secondary, not coral. Reasoning is an aside you may open, not the
            // headline of the answer — spending the accent on a permanently
            // visible label is what made every reply shout.
            Text("Reasoning")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .tint(.secondary)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: expanded)
    }
}
