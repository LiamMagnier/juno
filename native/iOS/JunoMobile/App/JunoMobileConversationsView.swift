import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UIKit

/// The chat destination: the selected conversation's transcript + composer, or —
/// when nothing is selected — a **draft**: the website's serif greeting above an
/// empty composer.
///
/// The draft is the load-bearing part. Tapping New chat used to create a row
/// immediately, so a chat opened and abandoned left a "New chat" in the sidebar
/// forever. Here nothing exists until the first message is sent, which is what
/// the web does and what the sidebar reads as.
struct JunoMobileChatDetailScreen: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    var projects: [NativeProject] = []
    var attachmentModel: NativeComposerAttachmentModel?
    var profileName: String?

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
                    profileName: profileName
                )
            } else {
                JunoMobileDraftChat(
                    model: model,
                    projects: projects,
                    attachmentModel: attachmentModel,
                    profileName: profileName
                )
            }
        }
    }
}

// MARK: - Draft

/// A chat that does not exist yet: the greeting, the composer, nothing else.
private struct JunoMobileDraftChat: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    var projects: [NativeProject]
    var attachmentModel: NativeComposerAttachmentModel?
    var profileName: String?

    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    @State private var thinkingNotice: String?
    @FocusState private var composerFocused: Bool

    var body: some View {
        JunoMobileGreeting(name: profileName)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.junoCanvas)
            .accessibilityIdentifier("juno.mobile.chat-draft")
            .navigationTitle("navigation.chat")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                JunoMobileComposer(
                    model: model,
                    conversation: nil,
                    projects: projects,
                    prompt: $prompt,
                    selectedModelID: $selectedModelID,
                    reasoningEffort: $reasoningEffort,
                    thinkingNotice: $thinkingNotice,
                    attachmentModel: attachmentModel,
                    startConversation: {
                        await model.createConversationResolvingID(
                            model: selectedModelID.isEmpty ? nil : selectedModelID
                        )
                    },
                    composerFocused: $composerFocused
                )
            }
            .onAppear { configureSelections() }
            .onChange(of: selectedModelID) { _, _ in configureSelections() }
            .onChange(of: model.modelCatalog) { _, _ in configureSelections() }
    }

    private func configureSelections() {
        selectedModelID = JunoMobileComposerSelection.resolvedModelID(
            current: selectedModelID,
            conversationModel: "",
            selectable: model.selectableModels
        )
        guard let selected = model.modelCatalog.first(where: { $0.id == selectedModelID }) else {
            reasoningEffort = nil
            return
        }
        let adjustment = NativeThinkingScale(model: selected).adjusting(reasoningEffort)
        reasoningEffort = adjustment.effort
        thinkingNotice = adjustment.explanation
    }
}

/// The website's home greeting, ported: the mark, then a time-of-day phrase, then
/// the reader's first name in medium italic coral. Both halves rise in as two
/// beats rather than one block, as they do in the browser.
struct JunoMobileGreeting: View {
    var name: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var phrase = ""
    @State private var appeared = false

    private var firstName: String? {
        guard let name, let first = name.split(separator: " ").first else { return nil }
        return String(first)
    }

    private var compact: Bool { sizeClass == .compact }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            JunoMark(size: compact ? 21 : 29)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 8)
            Text(greetingText)
                .font(JunoSerif.greeting(compact: compact))
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 10)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.7)
                .lineLimit(2)
        }
        .padding(.horizontal, 28)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(plainGreeting)
        .onAppear {
            if phrase.isEmpty {
                phrase = JunoGreeting.phrase(
                    forHour: Calendar.current.component(.hour, from: Date())
                )
            }
            guard !appeared else { return }
            withAnimation(
                JunoMotion.reduced(.snappy(duration: 0.42), when: reduceMotion)
            ) { appeared = true }
        }
    }

    /// Built as one `AttributedString` so the phrase and the name wrap as a
    /// single sentence. Two `Text`s in an `HStack` broke onto separate lines the
    /// moment either grew, which the web layout never does.
    private var greetingText: AttributedString {
        var result = AttributedString(firstName == nil ? phrase : "\(phrase), ")
        guard let firstName else { return result }
        var name = AttributedString(firstName)
        name.font = JunoSerif.greetingName(compact: compact)
        name.foregroundColor = Color.junoAccent
        result.append(name)
        return result
    }

    private var plainGreeting: String {
        firstName.map { "\(phrase), \($0)" } ?? phrase
    }
}

// MARK: - Conversation

private struct JunoMobileConversationDetail: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    var projects: [NativeProject] = []
    var attachmentModel: NativeComposerAttachmentModel?
    var profileName: String?
    @State private var showingRename = false
    @State private var showingDelete = false
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

    /// The transcript itself. Extracted from `body` because the merged view
    /// stacks a long modifier chain on an inline `ScrollView`, and the type
    /// checker times out on the combined expression.
    @ViewBuilder
    private var transcript: some View {
        if messages.isEmpty {
            // A conversation with no turns is the same moment as a draft, so it
            // gets the same greeting rather than a "No messages yet" placard.
            // `containerRelativeFrame` gives it the scroll view's own height so
            // it centres in the visible area — a fixed `minHeight` inside a
            // bottom-anchored scroll view pins it to the composer instead.
            JunoMobileGreeting(name: profileName)
                .frame(maxWidth: .infinity)
                .containerRelativeFrame(.vertical)
        } else {
            LazyVStack(spacing: 18) {
                ForEach(messages) { message in
                    JunoMobileMessageRow(message: message)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 18)
            Color.clear
                .frame(height: 1)
                .id(bottomAnchor)
        }
    }

    /// Extracted from `body` for the same reason as `scrollArea`: the nested menu
    /// was on its own enough to time the type checker out.
    @ToolbarContentBuilder
    private var conversationToolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            JunoMobileConversationTitle(
                title: conversation.title,
                justRenamed: model.recentlyRenamedConversationID == conversation.id,
                onAnimationShown: { model.acknowledgeTitleAnimation(for: conversation.id) }
            )
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    editValue = conversation.title
                    showingRename = true
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
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
                Divider()
                // Delete, not archive. Archiving moved a conversation into a
                // folder this app has no screen for, which from the phone is
                // indistinguishable from losing it.
                Button(role: .destructive) {
                    showingDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } label: {
                Label("Conversation actions", systemImage: "ellipsis.circle")
            }
            .disabled(model.isMutating || conversation.isPending)
            .accessibilityIdentifier("juno.mobile.conversation-menu")
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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { conversationToolbar }
        .alert("Rename conversation", isPresented: $showingRename) {
            TextField("Title", text: $editValue)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { await model.renameConversation(id: conversation.id, title: editValue) }
            }
        }
        .confirmationDialog(
            "Delete this conversation?",
            isPresented: $showingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                Task { await model.deleteConversation(id: conversation.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("chat.delete.warning")
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
        .onAppear { configureSelections() }
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

/// The navigation-bar title, which has to be able to *change under the reader*
/// when the server names the conversation from its first message.
///
/// A silent swap is the thing to avoid: the reader typed a message, looked away,
/// and the header is suddenly different text. So the new title arrives as a
/// blur-replace and holds a brief coral tint — long enough to be noticed as "Juno
/// named this", short enough not to become chrome.
private struct JunoMobileConversationTitle: View {
    let title: String
    let justRenamed: Bool
    let onAnimationShown: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var highlighted = false

    var body: some View {
        Text(title)
            .font(.system(size: 16, weight: .semibold))
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(highlighted ? Color.junoAccent : Color.primary)
            .id(title)
            .transition(.blurReplace)
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: title)
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: highlighted)
            .accessibilityLabel(title)
            .accessibilityIdentifier("juno.mobile.conversation-title")
            .task(id: justRenamed) {
                guard justRenamed else { return }
                highlighted = true
                try? await Task.sleep(for: .milliseconds(1_100))
                highlighted = false
                onAnimationShown()
            }
    }
}

/// One turn.
///
/// The two roles are shaped differently on purpose, matching the web: the
/// reader's own message is a contained bubble on the trailing edge, and Juno's
/// answer is full-width running text with no container at all. Boxing the answer
/// too made long replies read as a wall of chrome and cost most of the line
/// length on a phone.
private struct JunoMobileMessageRow: View {
    let message: NativeChatMessage

    private var isUser: Bool { message.role == .user }

    /// The assistant is working but has not started writing the answer yet — the
    /// moment to show the inline "Thinking about your request" status.
    private var showThinking: Bool {
        !isUser && message.isPending && message.content.isEmpty
    }

    var body: some View {
        if isUser {
            userBubble
        } else {
            assistantAnswer
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 44)
            Text(message.content)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    Color.junoAccent.opacity(0.13),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                )
                .contextMenu { copyButton }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said, \(message.content)")
    }

    private var assistantAnswer: some View {
        VStack(alignment: .leading, spacing: 9) {
            // Reasoning sits above the answer as a collapsible control, not as a
            // forgotten note beneath it.
            if let reasoning = message.reasoning, !reasoning.isEmpty {
                JunoReasoningDisclosure(text: reasoning)
            }

            if showThinking {
                JunoThinkingIndicator()
            } else if !message.content.isEmpty {
                JunoMarkdownText(message.content)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !message.sources.isEmpty {
                sources
            }

            footer

            if let error = message.errorDescription {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu { copyButton }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Juno replied")
    }

    private var sources: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(message.sources, id: \.url) { source in
                    Link(destination: source.url) {
                        HStack(spacing: 5) {
                            Image(systemName: "link").font(.caption2)
                            Text(source.title).font(.caption).lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .background(Color.junoSurface, in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 1)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private var footer: some View {
        if (message.model?.isEmpty == false) || (message.isPending && !showThinking) {
            HStack(spacing: 8) {
                if let model = message.model, !model.isEmpty {
                    Text(junoDisplayModelName(model))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if message.isPending && !showThinking {
                    ProgressView().controlSize(.mini)
                }
            }
        }
    }

    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = message.content
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
        .disabled(message.content.isEmpty)
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
            HStack(spacing: 6) {
                Image(systemName: "brain")
                    .font(.caption)
                Text("Reasoning")
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(Color.junoAccent)
        }
        .tint(Color.junoAccent)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: expanded)
    }
}
