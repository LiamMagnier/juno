import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import JunoStorage
import PhotosUI
import SwiftUI

/// The chat composer: one Liquid Glass container holding the pending
/// attachments, the message editor, and beneath them a single row of compact
/// controls — `+`, the model, Thinking, then Send. The model and Thinking
/// controls live *inside* this container rather than above it, because they are
/// part of composing a message, not settings.
///
/// The composer also serves the **draft** state, where no conversation exists
/// yet: `conversation` is nil and `startConversation` creates the row on the
/// first send. That is what keeps a chat the reader opened and abandoned out of
/// the sidebar.
struct JunoMobileComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    /// Nil while composing a draft — the conversation is created on first send.
    var conversation: NativeConversation?
    var projects: [NativeProject] = []
    @Binding var prompt: String
    @Binding var selectedModelID: String
    @Binding var reasoningEffort: NativeReasoningEffort?
    /// The one line explaining a thinking level that had to move when the model
    /// changed. Cleared by the owner once shown.
    @Binding var thinkingNotice: String?
    /// Owns the pending uploads. Held by the shell, not here, so a queued
    /// attachment survives navigating away and back.
    var attachmentModel: NativeComposerAttachmentModel?
    /// Creates the conversation a draft send belongs to and returns its id.
    /// Nil inside an existing conversation.
    var startConversation: (() async -> String?)?
    var composerFocused: FocusState<Bool>.Binding

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Set while a draft's conversation is being created, so a second tap on
    /// Send cannot create a second conversation.
    @State private var isStarting = false

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init)
    }

    private var generatingHere: Bool {
        guard let conversation else { return false }
        return model.isGenerating && model.activeChatConversationID == conversation.id
    }

    private var attachments: [NativeComposerAttachment] {
        attachmentModel?.attachments ?? []
    }

    /// Send is blocked while any upload is still in flight. Sending a message
    /// that references an attachment the server has not accepted produces a
    /// message with a missing file, which cannot be repaired from the client.
    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.isGenerating
            || isStarting
            || conversation?.isPending == true
            || attachmentModel.map { !$0.canSend } == true
    }

    var body: some View {
        VStack(spacing: 8) {
            if model.canRetrySelectedConversation && !model.isGenerating {
                retryBanner
            }

            // Above the composer, not below it: under the container it would sit
            // in the home-indicator strip and go unread.
            if let thinkingNotice {
                notice(thinkingNotice, symbol: "info.circle", tint: Color.secondary)
                    .accessibilityIdentifier("juno.mobile.thinking-notice")
            }
            if let attachmentError = attachmentModel?.lastErrorDescription {
                notice(attachmentError, symbol: "exclamationmark.circle", tint: Color.orange)
                    .accessibilityIdentifier("juno.mobile.attachment-error")
            }

            VStack(spacing: 8) {
                if !attachments.isEmpty, let attachmentModel {
                    JunoMobileAttachmentChips(
                        attachments: attachments,
                        onRemove: { attachmentModel.remove($0) },
                        onRetry: { attachmentModel.retry($0, conversationID: conversation?.id) }
                    )
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }

                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused(composerFocused)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
                    .accessibilityIdentifier("juno.mobile.chat-composer")

                controlRow
            }
            .padding(8)
            .background(JunoGlassBackground(cornerRadius: 26))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: sendDisabled)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: generatingHere)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: thinkingNotice)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: attachments.count)
        .task { await applyPreviewFlags() }
    }

    private func notice(_ text: String, symbol: String, tint: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.caption2)
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
            .transition(.opacity)
    }

    /// Drives the composer into one exact state for visual QA. No effect — and
    /// no code — outside DEBUG.
    private func applyPreviewFlags() async {
        #if DEBUG
        if let forced = JunoComposerPreviewFlags.forcedModelID {
            // The catalog arrives asynchronously; without waiting, a scripted
            // screenshot silently lands on whatever was selected by default.
            for _ in 0..<20 where !model.modelCatalog.contains(where: { $0.id == forced }) {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if model.modelCatalog.contains(where: { $0.id == forced }) {
                selectedModelID = forced
            }
        }
        if let level = JunoComposerPreviewFlags.forcedThinkingLevel {
            reasoningEffort = level
        }
        if JunoComposerPreviewFlags.focusesComposer {
            composerFocused.wrappedValue = true
        }
        #endif
    }

    /// `+` · model · Thinking · phase · Send. There is deliberately no
    /// microphone: dictation is not wired on iPhone yet, and a control that
    /// does nothing is worse than one that is absent. The system keyboard's own
    /// dictation key remains available in the meantime.
    private var controlRow: some View {
        HStack(spacing: 6) {
            JunoMobileComposerActions(
                projects: projects,
                selectedProjectID: conversation?.projectId,
                canPickProject: conversation != nil,
                canAttach: attachmentModel?.hasCapacity ?? false,
                setProject: { projectID in
                    guard let conversation else { return }
                    await model.setProject(id: conversation.id, projectID: projectID)
                },
                addPhotos: addPhotos,
                addCapture: addCapture,
                addFiles: addFiles
            )

            JunoMobileModelControl(
                models: model.modelCatalog,
                selectedModelID: $selectedModelID,
                fallbackName: junoDisplayModelName(conversation?.model ?? "")
            )
            .layoutPriority(1)

            if let thinkingScale {
                JunoMobileThinkingControl(scale: thinkingScale, effort: $reasoningEffort)
                    .layoutPriority(2)
            }

            Spacer(minLength: 2)

            if model.chatPhase != .idle {
                phaseIndicator
            }

            composerActionButton
        }
    }

    private var phaseIndicator: some View {
        HStack(spacing: 5) {
            if isStreamingPhase {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: phaseSymbol)
            }
            Text(phaseLabel)
                .lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(phaseLabel)
    }

    private var retryBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(model.chatErrorDescription ?? "The response was interrupted.")
                .lineLimit(2)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button("Retry") {
                guard let conversation else { return }
                model.retryLastMessage(conversationID: conversation.id)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("juno.mobile.chat-retry")
        }
        .font(.caption)
    }

    private var isStreamingPhase: Bool {
        switch model.chatPhase {
        case .appending, .submitting, .reasoning, .streaming, .reconnecting: true
        case .idle, .stopping, .failed: false
        }
    }

    private var phaseLabel: String {
        switch model.chatPhase {
        case .idle: "Ready"
        case .appending: "Saving message"
        case .submitting: "Starting"
        case .reasoning: "Reasoning"
        case .streaming: "Writing"
        case .stopping: "Stopping"
        case .reconnecting: "Reconnecting"
        case .failed: "Interrupted"
        }
    }

    private var phaseSymbol: String {
        switch model.chatPhase {
        case .reconnecting: "wifi.exclamationmark"
        case .failed: "exclamationmark.circle"
        case .stopping: "stop.circle"
        default: "sparkles"
        }
    }

    /// The send / stop control: a circular coral Liquid Glass button that fades
    /// to a discreet disabled state when there is nothing to send and swaps to
    /// Stop while streaming.
    ///
    /// Both states carry the same 44pt-tall `contentShape` as the "+": they had
    /// the identical 32pt-frame-without-content-shape construction, so they had
    /// the identical shrunken touch target. Stop especially must not be hard to
    /// hit — it is the control you reach for when something is going wrong.
    @ViewBuilder
    private var composerActionButton: some View {
        if generatingHere {
            Button {
                model.stopGeneration()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .modifier(JunoComposerSendBackground(active: true))
                    .frame(width: 40, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Stop generation")
            .accessibilityIdentifier("juno.mobile.chat-stop")
        } else {
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .modifier(JunoComposerSendBackground(active: !sendDisabled))
                    .scaleEffect(sendDisabled ? 0.92 : 1)
                    .frame(width: 40, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(sendDisabled)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("juno.mobile.chat-send")
        }
    }

    // MARK: Attachments

    private func addPhotos(_ items: [PhotosPickerItem]) {
        guard let attachmentModel else { return }
        Task {
            await JunoPhotoLoader.load(
                items, into: attachmentModel, conversationID: conversation?.id
            )
        }
    }

    private func addCapture(_ data: Data, _ fileName: String) {
        attachmentModel?.add(
            data: data,
            fileName: fileName,
            mimeType: "image/jpeg",
            conversationID: conversation?.id,
            isImage: true
        )
    }

    private func addFiles(_ urls: [URL]) {
        guard let attachmentModel else { return }
        JunoFileLoader.load(urls, into: attachmentModel, conversationID: conversation?.id)
    }

    // MARK: Send

    private func send() {
        let attachmentIDs = attachmentModel?.uploadedIDs ?? []
        if let conversation {
            deliver(conversationID: conversation.id, attachmentIDs: attachmentIDs)
            return
        }
        // Draft: create the conversation, then send into it. Sending first and
        // creating after would leave the message with nowhere to land.
        guard let startConversation else { return }
        isStarting = true
        Task {
            let created = await startConversation()
            isStarting = false
            guard let created else { return }
            deliver(conversationID: created, attachmentIDs: attachmentIDs)
        }
    }

    private func deliver(conversationID: String, attachmentIDs: [String]) {
        let sent = model.sendMessage(
            conversationID: conversationID,
            prompt: prompt,
            modelID: selectedModelID.isEmpty
                ? (conversation?.model ?? selectedModelID) : selectedModelID,
            reasoningEffort: reasoningEffort,
            attachmentIDs: attachmentIDs
        )
        guard sent else { return }
        prompt = ""
        attachmentModel?.clear()
        // The title is generated from the first turn, exactly as the web does —
        // see NativeConversationModel.generateTitleIfNeeded.
        Task { await model.generateTitleIfNeeded(conversationID: conversationID) }
    }
}

/// The composer's "+" and the panel it opens: Photos, Camera, Files, then the
/// conversation's project.
///
/// This is its own `View` with its own `@State` for a load-bearing reason, not
/// for tidiness. When the flag lived on `JunoMobileComposer`, flipping it
/// re-evaluated the whole composer body, and the popover — anchored to a button
/// that body had just rebuilt — never appeared. Giving the button a stable
/// identity of its own is the fix, and it is how `JunoMobileThinkingControl` —
/// the sibling popover that always worked — is already built.
struct JunoMobileComposerActions: View {
    let projects: [NativeProject]
    let selectedProjectID: String?
    /// False in a draft: there is no conversation to file into a project yet.
    var canPickProject: Bool = true
    /// False once the message is holding the maximum number of attachments.
    var canAttach: Bool = true
    let setProject: (String?) async -> Void
    let addPhotos: ([PhotosPickerItem]) -> Void
    let addCapture: (Data, String) -> Void
    let addFiles: ([URL]) -> Void

    @State private var presented = false
    @State private var showingPhotos = false
    @State private var showingCamera = false
    @State private var showingFiles = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            presented = true
        } label: {
            // `contentShape` is load-bearing. Without it SwiftUI hit-tests the
            // *drawn* content, so the touch target collapsed to the plus glyph
            // — 13.3pt on a control that looks 32pt.
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
                .rotationEffect(.degrees(presented ? 45 : 0))
                // The animation belongs on the label, not on the Button. Wrapping
                // the Button in `.animation(_:value:)` — the one modifier the
                // working model and Thinking chips do not have — is what stopped
                // its action running at all.
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: presented)
                .frame(width: 34, height: 34)
                .modifier(JunoComposerGlassCircle())
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add content or tools")
        .accessibilityIdentifier("juno.mobile.chat-plus")
        .sheet(isPresented: $presented) {
            panel
                .presentationDetents([.height(panelHeight)])
                .presentationDragIndicator(.visible)
        }
        .photosPicker(
            isPresented: $showingPhotos,
            selection: $photoSelection,
            maxSelectionCount: NativeComposerAttachmentModel.maximumAttachments,
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: photoSelection) { _, items in
            guard !items.isEmpty else { return }
            addPhotos(items)
            photoSelection = []
        }
        .fullScreenCover(isPresented: $showingCamera) {
            JunoMobileCameraCapture(onCapture: addCapture)
        }
        .fileImporter(
            isPresented: $showingFiles,
            allowedContentTypes: JunoAttachmentTypes.allowed,
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            addFiles(urls)
        }
        .task {
            #if DEBUG
            guard JunoComposerPreviewFlags.opensComposerActions else { return }
            try? await Task.sleep(nanoseconds: 400_000_000)
            presented = true
            #endif
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            header("attachments.add")
            VStack(spacing: 1) {
                action(
                    title: "attachments.photos",
                    subtitle: "attachments.photos.detail",
                    icon: "photo.on.rectangle.angled"
                ) { showingPhotos = true }
                action(
                    title: "attachments.camera",
                    subtitle: "attachments.camera.detail",
                    icon: "camera"
                ) { showingCamera = true }
                action(
                    title: "attachments.files",
                    subtitle: "attachments.files.detail",
                    icon: "folder"
                ) { showingFiles = true }
            }
            .disabled(!canAttach)
            .opacity(canAttach ? 1 : 0.45)

            if !canAttach {
                Text("attachments.full")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
            }

            if canPickProject {
                header("attachments.project")
                ScrollView {
                    VStack(spacing: 1) {
                        projectRow(
                            id: nil, name: "No project", icon: "tray",
                            selected: selectedProjectID == nil
                        )
                        ForEach(projects) { project in
                            projectRow(
                                id: project.id, name: project.name, icon: "folder",
                                selected: selectedProjectID == project.id
                            )
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: projectListHeight)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 6)
        .accessibilityIdentifier("juno.mobile.composer-actions")
    }

    private func header(_ key: LocalizedStringKey) -> some View {
        Text(key)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }

    /// Every project row, up to four, then it scrolls — so one project and
    /// twenty both get a panel that fits what it holds.
    private var projectListHeight: CGFloat {
        CGFloat(min(projects.count + 1, 4)) * 52
    }

    private var panelHeight: CGFloat {
        let attachments: CGFloat = 40 + 3 * 56 + (canAttach ? 0 : 30)
        return attachments + (canPickProject ? 40 + projectListHeight : 0) + 40
    }

    private func action(
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey,
        icon: String,
        perform: @escaping () -> Void
    ) -> some View {
        Button {
            // Dismiss first: presenting a picker from a sheet that is still on
            // screen drops the presentation on iOS.
            presented = false
            perform()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .frame(width: 26)
                    .foregroundStyle(Color.junoAccent)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 16, weight: .medium))
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .frame(height: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func projectRow(
        id: String?, name: String, icon: String, selected: Bool
    ) -> some View {
        Button {
            presented = false
            Task { await setProject(id) }
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .frame(width: 26)
                    .foregroundStyle(selected ? Color.junoAccent : .primary)
                Text(name)
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.junoAccent)
                }
            }
            .padding(.horizontal, 18)
            .frame(height: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(selected ? "\(name), selected" : name)
    }
}

/// The composer's selection rules, kept as pure functions so the fallback
/// behaviour is testable without standing up a view.
enum JunoMobileComposerSelection {
    /// The model the composer should be on. Preference order: keep the current
    /// choice if it is still selectable, otherwise the conversation's own model,
    /// otherwise the first selectable one. The conversation's model is the last
    /// resort when nothing is selectable at all — the composer then still names
    /// something real rather than going blank.
    static func resolvedModelID(
        current: String,
        conversationModel: String,
        selectable: [NativeChatModelOption]
    ) -> String {
        if !current.isEmpty, selectable.contains(where: { $0.id == current }) {
            return current
        }
        if selectable.contains(where: { $0.id == conversationModel }) {
            return conversationModel
        }
        return selectable.first?.id ?? conversationModel
    }
}

/// A circular coral Liquid Glass background for the composer's send/stop button,
/// with a material fallback below OS 26. When inactive the coral tint fades to a
/// discreet level so the disabled state stays legible without shouting.
struct JunoComposerSendBackground: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(
                    .regular.tint(Color.junoAccent.opacity(active ? 0.95 : 0.32)).interactive(),
                    in: Circle()
                )
        } else {
            content
                .background(Color.junoAccent.opacity(active ? 1 : 0.35), in: Circle())
        }
    }
}

/// A neutral (non-accent) circular Liquid Glass background for the composer's
/// "+" button, with a material fallback below OS 26.
struct JunoComposerGlassCircle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}
