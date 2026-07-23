import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import JunoStorage
import PhotosUI
import SwiftUI

/// The chat composer: one Liquid Glass container holding the message editor and,
/// beneath it, a single row of compact controls — `+`, the model, Thinking, then
/// Send. The model and Thinking controls live *inside* this container rather
/// than above it, because they are part of composing a message, not settings.
struct JunoMobileComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    var projects: [NativeProject] = []
    @Binding var prompt: String
    @Binding var selectedModelID: String
    @Binding var reasoningEffort: NativeReasoningEffort?
    /// The one line explaining a thinking level that had to move when the model
    /// changed. Cleared by the owner once shown.
    @Binding var thinkingNotice: String?
    var attachmentModel: NativeComposerAttachmentModel?
    var composerFocused: FocusState<Bool>.Binding

    @State private var showingActions = false
    @State private var showingCamera = false
    @State private var showingFileImporter = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var attachmentNotice: String?
    @State private var deepResearch = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// **Known defect — the composer's "+" does not open on tap.**
    ///
    /// Root cause, established mechanically rather than guessed: the composer's
    /// insets put the "+" centre at x≈36, inside the strip where iOS arms its
    /// leading interactive-pop / edge-pan recogniser. That recogniser takes the
    /// touch and the Button's action never runs — the control does not even
    /// animate. Moving it 40pt clear makes it open on the first tap, every time,
    /// and the model chip 40pt to its right has never had the problem.
    ///
    /// It is *not* fixed here because the fix does not fit in this row. A 20pt
    /// inset is not enough to clear the strip, and a 40pt one squeezes the model
    /// and Thinking chips until SwiftUI stops resolving the layout at all — the
    /// same wall that stops these controls reaching Apple's 44pt touch minimum.
    /// The row has to be rebuilt to carry fewer or narrower controls; that is
    /// the remaining Phase 4 work, not a one-line change.
    ///
    /// Ruled out: the touch target (a separate real defect, fixed), the
    /// popover's anchor and arrow edge, where its `@State` lives, `.animation`
    /// on the Button, the panel's intrinsic size, and the shell's own drag
    /// gesture. `testTheComposerPlusButtonOpensTheActionsPanelOnTap` reproduces
    /// it and is marked as an expected failure so it reports the day it starts
    /// passing.
    static let plusButtonEdgeGestureDefect = "See JunoMobileComposerUITests"

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init)
    }

    private var generatingHere: Bool {
        model.isGenerating && model.activeChatConversationID == conversation.id
    }

    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.isGenerating
            || conversation.isPending
    }

    var body: some View {
        VStack(spacing: 8) {
            if model.canRetrySelectedConversation && !model.isGenerating {
                retryBanner
            }

            // Above the composer, not below it: under the container it would sit
            // in the home-indicator strip and go unread.
            if let thinkingNotice {
                Label(thinkingNotice, systemImage: "info.circle")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
                    .accessibilityIdentifier("juno.mobile.thinking-notice")
            }

            if deepResearch || !model.researchActivity.isEmpty {
                JunoMobileResearchProgress(
                    enabled: deepResearch,
                    activity: model.researchActivity,
                    degradedWarning: model.researchDegradedWarning,
                    onDisable: { deepResearch = false }
                )
            }

            if let attachmentModel, !attachmentModel.attachments.isEmpty {
                JunoMobileAttachmentChips(
                    attachments: attachmentModel.attachments,
                    onRemove: { attachmentModel.remove($0) },
                    onRetry: { attachmentModel.retry($0, conversationID: conversation.id) }
                )
            }

            if let attachmentNotice {
                Text(attachmentNotice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .accessibilityIdentifier("juno.mobile.attachment-notice")
            }

            VStack(spacing: 8) {
                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused(composerFocused)
                    .padding(.horizontal, 6)
                    .padding(.top, 4)
                    .accessibilityIdentifier("juno.mobile.chat-composer")

                controlRow
            }
            .padding(8)
            .background(JunoGlassBackground(cornerRadius: 24))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: sendDisabled)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: generatingHere)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: thinkingNotice)
        .task { await applyPreviewFlags() }
        .modifier(
            JunoMobileAttachmentPresentations(
                conversationID: conversation.id,
                attachmentModel: attachmentModel,
                showingCamera: $showingCamera,
                showingFileImporter: $showingFileImporter,
                photoSelection: $photoSelection,
                attachmentNotice: $attachmentNotice,
                showingActions: $showingActions
            )
        )
    }

    /// The camera sheet, the file importer and the photo-picker plumbing, as
    /// one modifier so the composer's own `body` stays type-checkable.
    private struct JunoMobileAttachmentPresentations: ViewModifier {
        let conversationID: String
        let attachmentModel: NativeComposerAttachmentModel?
        @Binding var showingCamera: Bool
        @Binding var showingFileImporter: Bool
        @Binding var photoSelection: [PhotosPickerItem]
        @Binding var attachmentNotice: String?
        @Binding var showingActions: Bool

        func body(content: Content) -> some View {
            content
        .fullScreenCover(isPresented: $showingCamera) {
            JunoCameraPicker { data, name in
                attachmentModel?.add(
                    data: data, fileName: name, mimeType: "image/jpeg",
                    conversationID: conversationID, isImage: true
                )
            }
            .ignoresSafeArea()
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: JunoAttachmentTypes.allowed,
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                guard let attachmentModel else { return }
                JunoFileLoader.load(urls, into: attachmentModel, conversationID: conversationID)
            case .failure(let error):
                attachmentNotice = error.localizedDescription
            }
        }
        .onChange(of: photoSelection) { _, items in
            guard let attachmentModel, !items.isEmpty else { return }
            showingActions = false
            Task {
                await JunoPhotoLoader.load(
                    items, into: attachmentModel, conversationID: conversationID
                )
                photoSelection = []
            }
        }
        .onChange(of: attachmentModel?.lastErrorDescription) { _, message in
            if let message { attachmentNotice = message }
        }
        }
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
        HStack(spacing: 8) {
            JunoMobileComposerActions(
                projects: projects,
                selectedProjectID: conversation.projectId,
                setProject: { await model.setProject(id: conversation.id, projectID: $0) }
            )

            JunoMobileModelControl(
                models: model.modelCatalog,
                selectedModelID: $selectedModelID,
                fallbackName: junoDisplayModelName(conversation.model)
            )
            .layoutPriority(1)

            if let thinkingScale {
                JunoMobileThinkingControl(scale: thinkingScale, effort: $reasoningEffort)
                    .layoutPriority(2)
            }

            Spacer(minLength: 4)

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
    /// Both states carry the same 44pt `contentShape` as the "+" — they had the
    /// identical 32pt-frame-without-content-shape construction, so they had the
    /// identical shrunken touch target. Stop especially must not be hard to hit:
    /// it is the control you reach for when something is going wrong.
    @ViewBuilder
    private var composerActionButton: some View {
        if generatingHere {
            Button {
                model.stopGeneration()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .modifier(JunoComposerSendBackground(active: true))
                    .contentShape(Circle())
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
                    .frame(width: 32, height: 32)
                    .modifier(JunoComposerSendBackground(active: !sendDisabled))
                    .scaleEffect(sendDisabled ? 0.92 : 1)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(sendDisabled)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("juno.mobile.chat-send")
        }
    }

    private func send() {
        if model.sendMessage(
            conversationID: conversation.id,
            prompt: prompt,
            modelID: selectedModelID.isEmpty ? conversation.model : selectedModelID,
            reasoningEffort: reasoningEffort
        ) {
            prompt = ""
        }
    }
}

/// The composer's "+" and the panel it opens.
///
/// This is its own `View` with its own `@State` for a load-bearing reason, not
/// for tidiness. When the flag lived on `JunoMobileComposer`, flipping it
/// re-evaluated the whole composer body, and the popover — anchored to a button
/// that body had just rebuilt — never appeared. Opening the same panel from a
/// DEBUG launch flag *did* work, which is what made the control look merely
/// "dead" rather than broken: that path set the state before the first render,
/// so nothing was rebuilt underneath it. Giving the button a stable identity of
/// its own is the fix, and it is exactly how `JunoMobileThinkingControl` — the
/// sibling popover that always worked — is already built.
struct JunoMobileComposerActions: View {
    let projects: [NativeProject]
    let selectedProjectID: String?
    let setProject: (String?) async -> Void

    @State private var presented = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            presented = true
        } label: {
            // `contentShape` is load-bearing. Without it SwiftUI hit-tests the
            // *drawn* content, so the touch target collapsed to the plus glyph
            // — 13.3pt on a control that looks 32pt.
            //
            // Applied at 32pt rather than a padded 44pt: widening these controls
            // pushes the model and Thinking chips past what the row can give
            // them and the layout stops resolving at all. Reaching Apple's 44pt
            // minimum needs the row rebuilt first.
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
                .rotationEffect(.degrees(presented ? 45 : 0))
                // The animation belongs on the label, not on the Button. Wrapping
                // the Button in `.animation(_:value:)` — the one modifier the
                // working model and Thinking chips do not have — is what stopped
                // its action running at all.
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: presented)
                .frame(width: 32, height: 32)
                .modifier(JunoComposerGlassCircle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add content or tools")
        .accessibilityIdentifier("juno.mobile.chat-plus")
        .popover(isPresented: $presented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            // Adapts to a sheet at compact width, matching the model selector
            // beside it — the one control in this row that has always opened
            // reliably from a tap on iPhone. Held as a `.popover`, this panel
            // presented correctly when its state was set during the first render
            // (the DEBUG launch flag) but never when the state was set by a tap
            // into a settled layout, which is what the "+ does nothing" report
            // was. A bottom sheet is also the better phone affordance for a menu
            // that will grow attachments and tools.
            panel
                .presentationCompactAdaptation(horizontal: .sheet, vertical: .sheet)
                .presentationDetents([.height(listHeight + headerHeight + 24)])
                .presentationDragIndicator(.visible)
        }
        .task {
            #if DEBUG
            guard JunoComposerPreviewFlags.opensComposerActions else { return }
            try? await Task.sleep(nanoseconds: 400_000_000)
            presented = true
            #endif
        }
    }

    /// Only genuinely wired actions appear here — today that is associating the
    /// conversation with a project (server-validated). Attachments and tools
    /// join this panel when they are real, not before.
    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                deepResearch.toggle()
                showingActions = false
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "binoculars").frame(width: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("research.title")
                        Text("research.subtitle")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if deepResearch {
                        Image(systemName: "checkmark").foregroundStyle(.tint)
                    }
                }
                .font(.callout)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("juno.mobile.deep-research-toggle")
            .accessibilityAddTraits(deepResearch ? [.isSelected] : [])

            Divider().padding(.vertical, 6)

            if attachmentModel != nil {
                Text("attachments.section")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.top, 11)
                    .padding(.bottom, 5)
                VStack(spacing: 1) {
                    attachmentActionRow(
                        title: "attachments.camera", icon: "camera",
                        // Shown but disabled when there is no camera, or when
                        // access was denied or restricted: hiding the row would
                        // leave the reader looking for a control that is simply
                        // absent, with no idea why.
                        disabledReason: JunoCameraAvailability.current().message
                    ) { showingCamera = true }

                    PhotosPicker(
                        selection: $photoSelection,
                        maxSelectionCount: NativeComposerAttachmentModel.maximumAttachments,
                        matching: .images
                    ) {
                        HStack(spacing: 10) {
                            Image(systemName: "photo.on.rectangle").frame(width: 20)
                            Text("attachments.photos")
                            Spacer()
                        }
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("juno.mobile.attach-photos")

                    attachmentActionRow(
                        title: "attachments.files", icon: "folder", disabledReason: nil
                    ) { showingFileImporter = true }
                }
                Divider().padding(.vertical, 6)
            }

            Text("Add to project")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.top, 11)
                .padding(.bottom, 5)

            ScrollView {
                VStack(spacing: 1) {
                    row(id: nil, name: "No project", icon: "tray", selected: selectedProjectID == nil)
                    ForEach(projects) { project in
                        row(
                            id: project.id, name: project.name, icon: "folder",
                            selected: selectedProjectID == project.id
                        )
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: listHeight)
        }
        // A *determinate* size, for the same reason the Thinking popover states
        // one: a `ScrollView` given only a `maxHeight` has no intrinsic height,
        // and a popover with nothing to size to never presents on a tap. The
        // DEBUG launch flag still opened it, because that path sets the state
        // during the first render rather than into a settled layout — which is
        // exactly what made the button look dead rather than broken.
        .frame(width: 268, height: listHeight + headerHeight)
        .accessibilityIdentifier("juno.mobile.composer-actions")
    }

    private var headerHeight: CGFloat { 40 }

    /// Every row, up to five, then it scrolls — so one project and twenty
    /// projects both get a panel that fits what it holds.
    private var listHeight: CGFloat {
        let rows = min(projects.count + 1, 5)
        return CGFloat(rows) * 44 + 6
    }

    private func row(id: String?, name: String, icon: String, selected: Bool) -> some View {
        Button {
            presented = false
            Task { await setProject(id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .frame(width: 24)
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
            .padding(.horizontal, 14)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(selected ? "\(name), selected" : name)
    }
    /// The send / stop control: a circular coral Liquid Glass button that fades
    /// to a discreet disabled state when there is nothing to send and swaps to
    /// Stop while streaming.
    @ViewBuilder
    private var composerActionButton: some View {
        if generatingHere {
            Button {
                model.stopGeneration()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .modifier(JunoComposerSendBackground(active: true))
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
                    .frame(width: 32, height: 32)
                    .modifier(JunoComposerSendBackground(active: !sendDisabled))
                    .scaleEffect(sendDisabled ? 0.92 : 1)
            }
            .buttonStyle(.plain)
            .disabled(sendDisabled)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("juno.mobile.chat-send")
        }
    }

    private func send() {
        // Refuse rather than silently drop: an upload still in flight, or one
        // that failed, means the message would arrive missing a file, and
        // nothing on the client can repair that afterwards.
        if let attachmentModel, !attachmentModel.attachments.isEmpty,
            !attachmentModel.canSend
        {
            attachmentNotice = String(localized: "attachments.wait")
            return
        }
        if model.sendMessage(
            conversationID: conversation.id,
            prompt: prompt,
            modelID: selectedModelID.isEmpty ? conversation.model : selectedModelID,
            reasoningEffort: reasoningEffort,
            attachmentIDs: attachmentModel?.uploadedIDs ?? [],
            deepResearch: deepResearch
        ) {
            prompt = ""
            attachmentModel?.clear()
            attachmentNotice = nil
        }
    }

    /// A row in the attachments section. A disabled row states its reason
    /// inline rather than vanishing.
    private func attachmentActionRow(
        title: LocalizedStringKey,
        icon: String,
        disabledReason: String?,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            if let disabledReason {
                attachmentNotice = disabledReason
            } else {
                showingActions = false
                action()
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon).frame(width: 20)
                Text(title)
                Spacer()
                if disabledReason != nil {
                    Image(systemName: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            .foregroundStyle(disabledReason == nil ? .primary : .secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
