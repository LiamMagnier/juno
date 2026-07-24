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

    private func addPhotos(_ files: [JunoPickedFile]) {
        guard let attachmentModel else { return }
        for file in files where attachmentModel.hasCapacity {
            attachmentModel.add(
                data: file.data,
                fileName: file.fileName,
                mimeType: file.mimeType,
                conversationID: conversation?.id,
                isImage: file.isImage
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
    let addPhotos: ([JunoPickedFile]) -> Void
    let addCapture: (Data, String) -> Void
    let addFiles: ([URL]) -> Void

    /// Which picker the panel was tapped for.
    ///
    /// One value, one presentation. Each picker used to have its own modifier on
    /// this button — `.photosPicker`, `.fileImporter`, `.fullScreenCover` — and
    /// SwiftUI honours the first presentation declared on a view and silently
    /// drops the rest, which is why the panel closed and no picker ever came up.
    enum Picker: String, Identifiable {
        case photos, camera, files

        var id: String { rawValue }
    }

    @State private var presented = false
    /// Chosen in the panel, opened once the panel has *finished* closing. A
    /// presentation requested while another is still dismissing is dropped too,
    /// so the hand-off happens in `onDismiss` rather than in the row's action.
    @State private var pending: Picker?
    @State private var active: Picker?
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
        // The menu is a full-screen cover with a *clear* background, not a
        // sheet. That is what lets it be what it should be: a compact panel
        // floating just above the composer, over the transcript — rather than a
        // full-width tray slid up from the bottom edge, which is what a sheet
        // can only ever be. Presenting it this way also keeps the strict rule
        // that this button owns one presentation at a time.
        .fullScreenCover(isPresented: $presented, onDismiss: openPendingPicker) {
            panel
                .presentationBackground(.clear)
        }
        .fullScreenCover(item: $active) { picker in
            switch picker {
            case .photos:
                // The tray, not the system picker: recents first, All Photos
                // behind it. A half-height sheet so the chat stays visible,
                // which is what makes it read as part of composing.
                JunoMobilePhotoTray(
                    selectionLimit: NativeComposerAttachmentModel.maximumAttachments,
                    onPick: addPhotos
                )
                .presentationBackground(.clear)
            case .camera:
                JunoMobileCameraCapture(onCapture: addCapture)
            case .files:
                JunoMobileDocumentPicker(onPick: addFiles)
                    .ignoresSafeArea()
            }
        }
        .task {
            #if DEBUG
            guard JunoComposerPreviewFlags.opensComposerActions else { return }
            try? await Task.sleep(nanoseconds: 400_000_000)
            presented = true
            #endif
        }
    }

    private func openPendingPicker() {
        guard let pending else { return }
        self.pending = nil
        active = pending
    }

    /// The floating panel: a compact card anchored above the composer's leading
    /// edge, with a scrim behind it.
    ///
    /// Shaped after the panel this replaced a bottom sheet for — one glyph in a
    /// circular chip, one word, nothing else. The two-line rows it had before
    /// (title over an explanatory subtitle) turned a three-item menu into a
    /// paragraph: "Camera" needs no gloss, and reading one is slower than
    /// looking at three.
    private var panel: some View {
        ZStack(alignment: .bottomLeading) {
            // The scrim is the dismissal. It carries no colour of its own —
            // dimming the chat to choose a photo would be a heavier moment than
            // this is.
            Color.black.opacity(0.001)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { presented = false }
                .accessibilityLabel("Close menu")
                .accessibilityAddTraits(.isButton)

            VStack(alignment: .leading, spacing: 0) {
                row(title: "attachments.camera", icon: "camera", opens: .camera)
                row(title: "attachments.photos", icon: "photo", opens: .photos)
                row(title: "attachments.files", icon: "paperclip", opens: .files)
                if canPickProject {
                    Divider().overlay(Color.junoHairline).padding(.horizontal, 14)
                    projectMenu
                }
            }
            .padding(.vertical, 8)
            .frame(width: 272, alignment: .leading)
            .background(JunoGlassBackground(cornerRadius: 26))
            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 24, y: 6)
            // Sits *on* the composer, not above it: same leading inset, same
            // bottom inset, same corner radius. Floating it clear of the
            // composer read as a detached second surface; landing it on the
            // control it belongs to is what makes it feel like the "+" opened.
            .padding(.leading, 12)
            .padding(.bottom, 8)
            .opacity(canAttach ? 1 : 0.6)
            .transition(
                .scale(scale: 0.86, anchor: .bottomLeading)
                    .combined(with: .opacity)
                    .combined(with: .offset(y: 12))
            )
            .accessibilityIdentifier("juno.mobile.composer-actions")
        }
        // A spring with a little overshoot, anchored at the "+": the panel grows
        // out of the button rather than fading in over it. `JunoMotion.standard`
        // is a flat snap, which for a surface this size read as a jump.
        .animation(
            JunoMotion.reduced(
                .spring(response: 0.34, dampingFraction: 0.76), when: reduceMotion
            ),
            value: presented
        )
    }

    /// The project picker, as a native menu rather than a run of rows.
    ///
    /// Listing every project inline made the panel's length a function of how
    /// many projects the account has — three attachment actions and then a wall.
    /// A `Menu` keeps the panel one fixed size and, from OS 26, presents in the
    /// system's own Liquid Glass.
    private var projectMenu: some View {
        Menu {
            // Buttons rather than a `Picker`: a picker in a menu infers its tag
            // type from the content, and an optional id makes that inference
            // ambiguous. The checkmark is drawn explicitly instead.
            menuItem(id: nil, name: String(localized: "attachments.no-project"))
            ForEach(projects) { project in
                menuItem(id: project.id, name: project.name)
            }
        } label: {
            HStack(spacing: 14) {
                chip(icon: "folder", tinted: selectedProjectID != nil)
                Text("attachments.project")
                    .font(.system(size: 17))
                    .foregroundStyle(.primary)
                Spacer(minLength: 6)
                Text(selectedProjectName)
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    // The value is what the reader is here to see; the fixed
                    // label beside it should yield the width, not win it.
                    .layoutPriority(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .frame(height: 54)
            .contentShape(Rectangle())
        }
        // A `Menu` tints its whole label with the accent, which turned this row
        // coral while its three siblings stayed ink. The foreground styles
        // inside the label cannot override that on their own — the tint has to
        // be set on the menu itself.
        .tint(Color.primary)
        .accessibilityIdentifier("juno.mobile.composer-project")
    }

    private func menuItem(id: String?, name: String) -> some View {
        Button {
            presented = false
            Task { await setProject(id) }
        } label: {
            if selectedProjectID == id {
                Label(name, systemImage: "checkmark")
            } else {
                Text(name)
            }
        }
    }

    private var selectedProjectName: String {
        guard let selectedProjectID,
            let project = projects.first(where: { $0.id == selectedProjectID })
        else { return String(localized: "attachments.no-project") }
        return project.name
    }

    private func chip(icon: String, tinted: Bool = false) -> some View {
        ZStack {
            Circle().fill(Color.primary.opacity(0.06))
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(tinted ? Color.junoAccent : .primary)
        }
        .frame(width: 38, height: 38)
    }

    private func row(
        title: LocalizedStringKey, icon: String, opens: Picker
    ) -> some View {
        Button {
            // Record, then close. `onDismiss` opens the picker.
            pending = opens
            presented = false
        } label: {
            HStack(spacing: 14) {
                chip(icon: icon)
                Text(title)
                    .font(.system(size: 17))
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(height: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canAttach)
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
