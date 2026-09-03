import AVFoundation
import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

struct DesktopComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let libraryModel: NativeLibraryModel?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    /// The local half of every custom assistant on this account, which is where a
    /// project's preferred model is kept. Optional for the same reason
    /// ``JunoDesktopConfiguration/projectWorkspaceModel`` is: a composition root
    /// that could not open this Mac's local store has no preferences to read, and
    /// a composer with no preferences behaves exactly as it did before they
    /// existed.
    let workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
    /// This Mac's local document index. Non-nil is what makes the "My documents"
    /// row in the "+" menu appear at all — see ``documentGroundingArmed``.
    let documentIndex: NativeDocumentIndexModel?
    let connectorModel: NativeConnectorModel?
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    let openVoiceMode: (String) -> Void
    /// Locks this composer to a project and always starts a new conversation.
    /// Used by the project overview so it is the same composer as Chat, not a
    /// prompt-shaped imitation with fewer controls.
    var fixedProjectID: String? = nil
    /// Called after the first message is accepted, so an embedded project
    /// composer can move to the real transcript it just created.
    var didSendConversation: ((String) -> Void)? = nil
    /// The bloom this composer feeds, when the surface it is on has one.
    ///
    /// Optional because the project overview embeds this same composer in the
    /// middle of a page of other things — the website puts no aura there either,
    /// and a light under a card in a list would be claiming that card is the
    /// screen.
    var aura: DesktopChatAuraState? = nil

    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var thinkingStopID = ""
    @State private var deepResearch = false
    @State private var webSearch = false
    @State private var canvasEnabled = false
    // @AppStorage rather than @State, unlike its neighbours: these two are
    // preferences that must survive a relaunch (the web keeps them in
    // localStorage, iOS in UserDefaults), where deepResearch above is
    // deliberately per-send and webSearch/canvas are per-view here already.
    @AppStorage("juno.desktop.composer.fast-mode") private var fastMode = false
    @AppStorage("juno.desktop.composer.pro-mode") private var proMode = false
    /// Let Juno pick the model per turn instead of always using the selection.
    ///
    /// Defaults to false so an existing reader's model choice keeps being obeyed
    /// exactly as before. See ``routedModelID(for:)`` for why this is opt-in.
    @AppStorage("juno.desktop.composer.auto-route-model") private var autoRouteModel = false
    /// Whether a turn may quote this Mac's own document index.
    ///
    /// **Off by default, and that default is the point.** Importing a file into
    /// the Library is consent to *search* it on this machine; it is not standing
    /// consent to put paragraphs of it into every question that leaves the Mac
    /// afterwards. Somebody who has indexed a medical letter and then asks Juno
    /// an unrelated question must not have the letter quoted at a provider
    /// because a lexical ranker thought two words matched.
    ///
    /// `@AppStorage` rather than `@State`, beside `fastMode` and `proMode`: it is
    /// a preference, and a reader who turns it on should not have to turn it on
    /// again in the next window. It can therefore be on with an empty index —
    /// which is fine and says so, because the index is memory-only and starts
    /// empty at every launch.
    @AppStorage("juno.desktop.composer.document-context") private var documentContext = false
    /// What grounding did on the last send, in one sentence.
    ///
    /// Kept because "your documents were searched and nothing matched" and "your
    /// documents were quoted" have to be told apart from outside. Without it a
    /// reader with the switch on has no way to know which of the two happened,
    /// and the safe assumption — that their files were consulted — is the wrong
    /// one about half the time.
    @State private var groundingNote: String?
    /// Whether the reader opened the model picker and chose, in this composer,
    /// since the conversation was selected.
    ///
    /// The top rung of ``routedModelID(for:)``'s precedence. It cannot be derived
    /// from `selectedModelID`: that value is *also* what `configureSelection()`
    /// resolves from the conversation and the catalog, so "GPT-5.6 because the
    /// reader said so" and "GPT-5.6 because it was first in the list" are the
    /// same string and must not be treated as the same instruction.
    @State private var modelChosenByReader = false
    @State private var selectedProjectID: String?
    @State private var selectedConnectors: Set<String> = []
    @State private var showingFileImporter = false
    @State private var showingLibrary = false
    @State private var showingModelSelector = false
    @State private var dictating = false
    @State private var importError: String?
    /// Set while a spoken turn is on the wire, so a second Return cannot send
    /// the same images twice.
    @State private var isSendingVoiceTurn = false
    /// Why the last spoken turn was refused, shown in the same notice row as the
    /// attachment errors because it is the same kind of news.
    @State private var voiceTurnError: String?
    /// Whether a very large draft has been opened back up for editing. The text
    /// is in `prompt` and sent in full either way — this only decides whether it
    /// is live in the text field. See ``NativePromptLimits``.
    @State private var draftExpanded = false
    @FocusState private var focused: Bool
    /// Gives the native glass controls stable identities inside the composer's
    /// single `GlassEffectContainer`, so a state change does not make the
    /// material blink as controls reconfigure.
    @Namespace private var glassNamespace
    /// The call this composer is inside, published by ``junoVoiceDock(_:)``.
    /// Non-nil is what routes a send over the socket instead of to `/api/chat`.
    @Environment(\.junoVoiceCall) private var voiceCall
    /// Read here for the control strip's hover states: the fills cross under
    /// ``JunoMotion/Tier/tint`` and survive the preference, the 2% lift is travel
    /// and does not.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selectedModel: NativeChatModelOption? {
        model.model(withID: selectedModelID)
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init(model:))
    }

    private var reasoningEffort: NativeReasoningEffort? {
        thinkingScale?.stops.first { $0.id == thinkingStopID }?.effort
    }

    // MARK: The reader's own documents

    /// How many files this Mac currently has indexed. Zero is a real and common
    /// state — the index is memory-only and empty at every launch.
    private var indexedDocumentCount: Int {
        documentIndex?.documents.count ?? 0
    }

    /// Whether the next send will search this Mac's documents.
    ///
    /// All three conditions are required. A lit switch over an empty index would
    /// promise something that cannot happen — the same rule the Web search row
    /// already follows for a model that cannot search — and a spoken turn leaves
    /// over the realtime socket, which carries none of the text this grounding
    /// extends. Claiming otherwise mid-call would be the one thing this feature
    /// must never do: say documents were consulted when they were not.
    private var documentGroundingArmed: Bool {
        documentContext && indexedDocumentCount > 0 && !voiceActive
    }

    /// The line above the composer about the reader's documents.
    ///
    /// Two states, never merged: before a send it says what *will* happen, and
    /// after one it says what *did*. Silence in between is not an option — the
    /// whole objection to prompt-side retrieval is that files get read into a
    /// message with nothing on screen admitting it.
    @ViewBuilder
    private var documentContextNotice: some View {
        if let groundingNote {
            Label(verbatim: groundingNote, icon: .fileSearch)
                .junoCaption()
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("juno.desktop.chat.document-context-note")
        } else if documentGroundingArmed {
            Label(
                verbatim: indexedDocumentCount == 1
                    ? "Juno will search 1 document on this Mac and quote what it finds in your message."
                    : "Juno will search \(indexedDocumentCount) documents on this Mac and quote what it finds in your message.",
                icon: .fileSearch
            )
            .junoCaption()
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("juno.desktop.chat.document-context-armed")
        }
    }

    private var canSend: Bool {
        // Text *or* attachments, as the web has it: a message that is nothing
        // but the file you attached is a message. Requiring text here is what
        // made "Attach as file" leave a draft that could not be sent.
        (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !(attachmentModel?.attachments.isEmpty ?? true))
            && !selectedModelID.isEmpty
            && !model.isGenerating
            && !isSendingVoiceTurn
            && (attachmentModel?.canSend ?? true)
    }

    // MARK: Voice mode

    /// Whether a call is running over this composer. While it is, the draft goes
    /// to the model that is speaking rather than to the chat route.
    private var voiceActive: Bool { voiceCall != nil }

    /// Past four images a turn, providers start answering about the first one
    /// and ignoring the rest. The relay enforces the same ceiling; this is here
    /// so the reader is stopped before they compose a fifth.
    private static let maximumVoiceImages = 4

    /// Whether the model on the other end of the call can see at all.
    ///
    /// Read from what the relay said in `session.ready` rather than from a list
    /// of providers kept here, which would be a second copy to drift. Nil while
    /// connecting reads as "no", so the attach row is not offered a beat before
    /// it can work.
    private var voiceCanSeeImages: Bool {
        voiceCall?.controller.capabilities?.videoInput == true
    }

    /// Whether another image can be staged for the call in progress.
    private var canAttachInVoice: Bool {
        voiceCanSeeImages
            && (attachmentModel?.attachments.count ?? 0) < Self.maximumVoiceImages
    }

    /// What the file importer will accept.
    ///
    /// Narrowed to images during a call, which is the Mac's version of the phone
    /// disabling its Files row: no realtime provider accepts a document, and this
    /// column has no separate Photos row to fall back on, so the one attach row
    /// has to become the image row rather than the refused one.
    private var importedContentTypes: [UTType] {
        voiceActive ? [.image] : [.item]
    }

    // MARK: Long drafts

    /// Whether the draft is long enough that sending it as a file is worth
    /// offering. An offer, never a rule — see ``NativePromptLimits``.
    private var isLongDraft: Bool {
        canAttachDraft && NativePromptLimits.isLongDraft(prompt)
    }

    /// Past this the draft leaves the text field entirely and shows as a card.
    /// Tens of thousands of characters in an auto-sizing `TextField` re-measure
    /// on every keystroke, and the composer stops accepting input long before
    /// the reader gets to Send.
    private var showsCollapsedDraft: Bool {
        NativePromptLimits.isHugeDraft(prompt) && !draftExpanded
    }

    private var canAttachDraft: Bool {
        attachmentModel?.hasCapacity ?? false
    }

    /// Sends the draft as `prompt.txt` instead of as message text.
    ///
    /// The web's `attachAsFile`, ported: same file name, same MIME type, and the
    /// same clearing of the draft afterwards, so a prompt attached here and one
    /// attached in the browser arrive at the model as the same message.
    private func attachDraftAsFile() {
        let content = prompt
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let attachmentModel
        else { return }
        attachmentModel.add(
            data: Data(content.utf8),
            fileName: NativePromptLimits.attachedPromptFileName,
            mimeType: NativePromptLimits.attachedPromptMimeType,
            conversationID: model.selectedConversationID,
            isImage: false
        )
        prompt = ""
        draftExpanded = false
    }

    var body: some View {
        // One glass container for the whole composer. The bar and the send
        // button are both glass; without a shared container each samples the
        // canvas independently and they seam where they meet instead of
        // refracting one sample and blending as they approach.
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            composerContent
        }
    }

    private var composerContent: some View {
        VStack(spacing: 10) {
            if let attachmentModel, !attachmentModel.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(attachmentModel.attachments) { attachment in
                            DesktopAttachmentChip(
                                attachment: attachment,
                                remove: { attachmentModel.remove(attachment.id) },
                                retry: {
                                    attachmentModel.retry(
                                        attachment.id,
                                        conversationID: model.selectedConversationID
                                    )
                                }
                            )
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }

            if let message = voiceTurnError ?? importError
                ?? attachmentModel?.lastErrorDescription
            {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color.junoDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            documentContextNotice

            if dictating {
                DesktopDictation(
                    onCancel: {
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        focused = true
                    },
                    onStop: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        focused = true
                    },
                    onSend: { transcript in
                        appendDictated(transcript)
                        withAnimation(JunoMotion.fast) {
                            dictating = false
                        }
                        Task {
                            await Task.yield()
                            send()
                        }
                    }
                )
                .transition(.opacity)
            } else {
                if showsCollapsedDraft {
                    collapsedDraftCard
                        .transition(.opacity)
                } else {
                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .junoFont(size: 15, relativeTo: .body)
                    .lineSpacing(4)
                    .junoInk()
                    .focused($focused)
                    .padding(.horizontal, JunoSpace.tight)
                    .padding(.top, JunoSpace.tight)
                    .padding(.bottom, 2)
                    .accessibilityIdentifier("Message Juno")
                    // Return sends; Shift-Return breaks the line.
                    //
                    // This is what every chat surface does, including Juno's own
                    // web composer, and it is why the send button below carries no
                    // keyboard shortcut of its own — an accelerator on the button
                    // would fight this handler for the same key. A vertical
                    // `TextField` inserts a newline on Return by default, so the
                    // key has to be intercepted rather than merely bound.
                    .onKeyPress(.return, phases: .down) { press in
                        // Shift-Return falls through to the field's own newline.
                        if press.modifiers.contains(.shift) { return .ignored }
                        if canSend {
                            send()
                            return .handled
                        }
                        // Swallowed rather than ignored: with an empty prompt, or
                        // while a turn is still streaming, Return must not quietly
                        // grow the box instead of doing what the user asked.
                        return .handled
                    }

                    if isLongDraft {
                        attachAsFileOffer
                    }
                }

                // One controls row, the web's (`composer-shell.tsx`): `+` on
                // the left; model chip · effort chip · mic · a thin rule · send
                // on the right. Streaming fades everything but the primary
                // action to 60%, because Stop is the one thing left to press.
                HStack(spacing: JunoSpace.hairline) {
                    addMenu
                    Spacer(minLength: JunoSpace.snug)
                    HStack(spacing: JunoSpace.hairline) {
                        modelControl
                        if let scale = thinkingScale, scale.isPresentable {
                            thinkingControl(scale)
                        }
                        if JunoSpeechService.isSupported {
                            dictateButton
                        }
                    }
                    .opacity(model.isGenerating ? 0.6 : 1)
                    .disabled(model.isGenerating)
                    primaryAction
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, 10)
        // Was a freehand 720 against the transcript's 768 — see
        // ``DesktopChatMeasure``. The composer and the transcript are one column
        // and now read one number for it, gutter included, so they stay one
        // column at every window width rather than only at the two where the old
        // pair of numbers happened to cross.
        .frame(maxWidth: DesktopChatMeasure.reading)
        // Real Liquid Glass, and nothing drawn on top of it. The previous
        // treatment stroked a hairline border over the glass, which flattened
        // the rim's light scatter — the thing that makes glass read as having
        // thickness — back into a translucent rounded rectangle. Focus adds
        // nothing here either: an accent stroke, an accent shadow and a 1.003
        // scale on an off-ladder spring shipped briefly and were removed with
        // the ornamented `junoFloatingChrome` build, whose contract names them
        // as exactly the decoration that flattens the material. Focus already
        // has honest voices — the field's own caret, and the aura warming
        // behind the greeting while the composer holds it — so the chrome
        // stays still.
        .junoFloatingChrome(cornerRadius: JunoRadius.composer)
        .padding(.horizontal, DesktopChatMeasure.gutter)
        .padding(.bottom, JunoSpace.tight)
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: importedContentTypes,
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .sheet(isPresented: $showingLibrary) {
            if let libraryModel, let attachmentModel {
                DesktopLibraryPicker(
                    model: libraryModel,
                    capacity: max(
                        0,
                        NativeComposerAttachmentModel.maximumAttachments
                            - attachmentModel.attachments.count
                    ),
                    attach: {
                        if let uploaded = await libraryModel.attachSelection() {
                            attachmentModel.adopt(uploaded)
                            showingLibrary = false
                        }
                    },
                    cancel: {
                        libraryModel.selection = []
                        showingLibrary = false
                    }
                )
            }
        }
        .onAppear {
            // The project is settled *before* the model is, and the order is
            // load-bearing: a project's preferred model is part of the answer
            // `configureSelection()` gives, so resolving first would show the
            // account default for a frame and then jump to the assistant's model
            // in front of the reader.
            if let fixedProjectID {
                selectedProjectID = fixedProjectID
            }
            consumeDraftProject()
            configureSelection()
            consumeDraftPrompt()
            focused = true
            // Published here as well as from the `onChange` pair below, because a
            // composer that opens on the model it already had changes nothing —
            // and the bloom would sit on the accent until the reader happened to
            // pick something.
            publishAura()
        }
        // Every transient presentation is torn down with the composer.
        //
        // A `.popover` whose anchor leaves the hierarchy while still presented
        // makes SwiftUI's `PopoverBridge` call `showRelativeToRect:` against a
        // window that is already being ordered — `addChildWindow:` →
        // `_doOrderWindow:` → an uncaught `NSRemoteView` exception and SIGTRAP.
        // Opening the model selector and then clicking a different sidebar row
        // reproduces it: the click destroys the composer that owns the anchor.
        .onDisappear {
            showingModelSelector = false
            showingLibrary = false
            showingFileImporter = false
        }
        .animation(JunoMotion.fast, value: showsCollapsedDraft)
        // Once the draft is back under the inline ceiling, forget that it was
        // ever expanded — otherwise the *next* huge paste would land straight in
        // the text field, which is the state this card exists to avoid.
        .onChange(of: prompt) { _, text in
            if !NativePromptLimits.isHugeDraft(text) { draftExpanded = false }
        }
        // A refusal that named the call is meaningless once the call is over.
        .onChange(of: voiceActive) { _, active in
            if !active { voiceTurnError = nil }
        }
        .onChange(of: model.modelCatalog) { _, _ in configureSelection() }
        .onChange(of: model.selectedConversationID) { _, selected in
            // A pick is about the conversation it was made in. Moving to another
            // one retires it, so the next conversation's project preference is
            // free to apply — otherwise one deliberate choice would follow the
            // reader around the sidebar for the rest of the session.
            modelChosenByReader = false
            // A note about the last send describes a message in the conversation
            // it was sent to. Carried into another one it is a claim about
            // nothing the reader is looking at.
            groundingNote = nil
            // Project first, then selection: `configureSelection()` reads the
            // project's preferred model, and running it against the *previous*
            // conversation's project would resolve one assistant's model into
            // another assistant's chat. Same reason as `onAppear` above.
            if let fixedProjectID {
                selectedProjectID = fixedProjectID
            } else {
                selectedProjectID = selected == nil
                    ? nil : model.selectedConversation?.projectId
            }
            configureSelection()
            if selected == nil {
                selectedConnectors = []
                canvasEnabled = false
            }
        }
        // Covers both directions the preference can move: the reader filing the
        // draft under a different project from the "+" menu, and the preference
        // itself being edited on the Projects page while this composer is open.
        .onChange(of: projectPreferredModelID) { _, _ in configureSelection() }
        // Disarming the switch retires the note with it: "nothing matched" beside
        // a switch that is now off reads as the state rather than as history.
        .onChange(of: documentContext) { _, _ in groundingNote = nil }
        .onChange(of: draftProjectID) { _, _ in
            consumeDraftProject()
        }
        .onChange(of: draftPrompt) { _, _ in
            consumeDraftPrompt()
        }
        .onChange(of: selectedModelID) { _, _ in
            configureThinking()
            publishAura()
        }
        .onChange(of: thinkingStopID) { _, _ in publishAura() }
        .onChange(of: focused) { _, hasFocus in aura?.focused = hasFocus }
    }

    /// Hands the bloom its two derived inputs.
    ///
    /// `hasEffortControl` is the test of whether a slider is *actually on screen*
    /// — the composer's own gate a few lines up — and deliberately not "does this
    /// model reason". Eleven shipped models declare reasoning and expose no
    /// tiers, and Auto resolves the full ladder while showing no slider at all;
    /// either would leave the page burning at its dimmest with nothing on screen
    /// to explain why.
    private func publishAura() {
        guard let aura else { return }
        aura.providerID = selectedModel?.providerID ?? ""
        aura.think = JunoProviderGlow.auraThink(
            effort: reasoningEffort?.rawValue,
            hasEffortControl: thinkingScale?.isPresentable ?? false
        )
    }

    private func consumeDraftProject() {
        guard model.selectedConversationID == nil, let projectID = draftProjectID else {
            return
        }
        selectedProjectID = projectID
        draftProjectID = nil
    }

    private func consumeDraftPrompt() {
        guard prompt.isEmpty,
            let seededPrompt = draftPrompt
        else { return }
        prompt = seededPrompt
        draftPrompt = nil
        focused = true
    }

    /// The quiet offer under a long draft: "That's a long one — send it as a
    /// file to keep the chat tidy?" One line and one button, exactly as the web
    /// puts it, and it never touches the draft unless the button is used.
    private var attachAsFileOffer: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("That's a long one — send it as a file to keep the chat tidy?")
                .font(.caption)
                .junoSecondaryInk()
            Spacer(minLength: JunoSpace.tight)
            Button(action: attachDraftAsFile) {
                Label("Attach as file", icon: .files)
                    .contentShape(.rect)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("juno.desktop.chat.attach-draft")
        }
        .padding(.horizontal, 8)
        .transition(.opacity)
    }

    /// What a very large paste looks like in the composer: a card standing for
    /// the draft, not the draft itself.
    ///
    /// The text is untouched — it is still in `prompt`, and Send still sends all
    /// of it. What has gone is the live `TextField`, which was re-measuring the
    /// whole passage on every keystroke. "Edit" puts it back for a reader who
    /// really does want to work inside a 40,000-character prompt.
    private var collapsedDraftCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Long message ready to send")
                        .font(.callout.weight(.medium))
                    Text("\(prompt.count.formatted(.number)) characters · sent in full · Return to send")
                        .font(.caption.monospaced())
                        .junoSecondaryInk()
                    Text(prompt.prefix(240) + (prompt.count > 240 ? "…" : ""))
                        .font(.caption)
                        .junoSecondaryInk()
                        .lineLimit(3)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
                Button {
                    prompt = ""
                    draftExpanded = false
                } label: {
                    JunoIconView(.close, size: 14)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .help("Clear this message")
                .accessibilityLabel("Clear this message")
            }

            HStack(spacing: JunoSpace.snug) {
                Button {
                    draftExpanded = true
                    focused = true
                } label: {
                    Label("Edit", icon: .pencil)
                        .contentShape(.rect)
                }
                .accessibilityIdentifier("juno.desktop.chat.expand-draft")

                if canAttachDraft {
                    Button(action: attachDraftAsFile) {
                        Label("Attach as file", icon: .files)
                            .contentShape(.rect)
                    }
                    .accessibilityIdentifier("juno.desktop.chat.attach-draft")
                }
                Spacer(minLength: 0)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoMuted.opacity(0.6))
        )
        // Return sends from here too: the card *is* the draft, and a reader who
        // has just pasted should not have to find the button with the mouse.
        .onKeyPress(.return, phases: .down) { press in
            if press.modifiers.contains(.shift) { return .ignored }
            if canSend { send() }
            return .handled
        }
        .accessibilityIdentifier("juno.desktop.chat.collapsed-draft")
    }

    /// Whether the closed "+" is holding anything — what lights its badge.
    ///
    /// All four of the states the menu can leave behind, where the badge used to
    /// answer for two of them. A chat armed with web search or with canvas looked
    /// from the outside exactly like a chat armed with nothing.
    private var hasArmedTools: Bool {
        deepResearch || webSearch || canvasEnabled || !selectedConnectors.isEmpty
            || documentGroundingArmed
    }

    /// The composer's native action menu.
    ///
    /// This is deliberately a real SwiftUI `Menu`. The previous implementation
    /// recreated a dropdown inside a custom popover: it had to own hover fills,
    /// nested drawers, checkmarks, disabled explanations, focus, dismissal and
    /// glass independently from macOS. That is exactly why it looked foreign.
    /// Native menu groups and submenus give the same information architecture as
    /// the website while letting the platform own Liquid Glass and interaction.
    /// The composer's one menu: Attach · Tools · Context, the web's `+` menu
    /// (`composer.tsx`) as a native `Menu` so the platform owns the glass, the
    /// hover states and the submenus. Every row's mark is the website's.
    private var addMenu: some View {
        Menu {
            Section("Attach") {
                Button {
                    showingFileImporter = true
                } label: {
                    Label(verbatim: voiceActive ? "Attach images…" : "Attach files…", icon: .attach)
                }
                .disabled(voiceActive ? !canAttachInVoice : !(attachmentModel?.hasCapacity ?? false))

                Button {
                    showingLibrary = true
                } label: {
                    Label("Choose from Library…", icon: .library)
                }
                .disabled(voiceActive || !(attachmentModel?.hasCapacity ?? false))
            }

            Section("Tools") {
                Toggle(isOn: $webSearch) {
                    Label("Web search", icon: .web)
                }
                .disabled(selectedModel?.supportsWebSearch != true)

                Toggle(isOn: $canvasEnabled) {
                    Label("Canvas & artifacts", icon: .artifactsTool)
                }

                Toggle(isOn: $deepResearch) {
                    Label("Deep research", icon: .research)
                }

                if documentIndex != nil {
                    Toggle(isOn: $documentContext) {
                        Label(
                            verbatim: indexedDocumentCount == 0
                                ? "My documents — none on this Mac" : "My documents",
                            icon: .fileSearch
                        )
                    }
                    .disabled(voiceActive || indexedDocumentCount == 0)
                }
            }

            if (fixedProjectID == nil && projectModel != nil) || connectorModel != nil {
                Section("Context") {
                    if fixedProjectID == nil, let projectModel {
                        Menu {
                            Button {
                                selectedProjectID = nil
                            } label: {
                                if selectedProjectID == nil {
                                    Label("No project", icon: .check)
                                } else {
                                    Text("No project")
                                }
                            }
                            ForEach(projectModel.projects) { project in
                                Button {
                                    selectedProjectID = project.id
                                } label: {
                                    if selectedProjectID == project.id {
                                        Label(verbatim: project.name, icon: .check)
                                    } else {
                                        Text(project.name)
                                    }
                                }
                            }
                        } label: {
                            Label(verbatim: selectedProjectName ?? "Project", icon: .projects)
                        }
                        .disabled(model.selectedConversationID != nil)
                    }

                    if connectorModel != nil {
                        Menu {
                            if connectedConnectors.isEmpty {
                                Text("No connected apps")
                            } else {
                                ForEach(connectedConnectors) { connector in
                                    Toggle(
                                        connector.label,
                                        isOn: Binding(
                                            get: { selectedConnectors.contains(connector.id) },
                                            set: { _ in toggleConnector(connector.id) }
                                        )
                                    )
                                    .disabled(
                                        !selectedConnectors.contains(connector.id)
                                            && selectedConnectors.count >= 5
                                    )
                                }
                            }
                        } label: {
                            Label(
                                verbatim: selectedConnectors.isEmpty
                                    ? "Connectors" : "Connectors (\(selectedConnectors.count))",
                                icon: .connections
                            )
                        }
                    }
                }
            }
        } label: {
        JunoIconView(.plus, size: 16)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.circle)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .junoGlassButton()
        .controlSize(.small)
        .junoGlassID("composer-add", in: glassNamespace)
        .fixedSize()
        .help("Add files, tools, projects, or connected apps")
        .accessibilityLabel("Add")
        .accessibilityValue(hasArmedTools ? "Tools armed" : "")
        .accessibilityIdentifier("juno.desktop.chat.add")
    }

    private var modelControl: some View {
        Button {
            showingModelSelector = true
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoProviderMark(
                    providerID: selectedModel?.providerID ?? "juno",
                    providerName: selectedModel?.providerName ?? "Juno",
                    size: 14
                )
                Text(selectedModel?.displayName ?? "Choose model")
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                    .lineLimit(1)
                // This is intentionally the composer row's sole disclosure mark.
                JunoIconView(.chevronDown, size: 12)
            }
            .contentShape(.rect)
        }
        .junoGlassButton()
        .controlSize(.small)
        .junoGlassID("composer-model", in: glassNamespace)
        .help("Choose model")
        .accessibilityLabel("Model")
        .accessibilityValue(selectedModel?.displayName ?? "Not selected")
        .accessibilityIdentifier("juno.desktop.chat-model")
        .popover(
            isPresented: $showingModelSelector,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            let metrics = JunoModelSelectorMetrics.fitted
            JunoModelSelector(
                models: model.modelCatalog.map(\.junoDescriptor),
                selectedModelID: selectedModelID,
                metrics: metrics,
                select: { descriptor in
                    selectedModelID = descriptor.id
                    // The only place this is set. It is what makes rung 1 of
                    // ``routedModelID(for:)`` distinguishable from the same id
                    // arriving out of `configureSelection()`, and it is why a
                    // project's preferred model stops reasserting itself after
                    // somebody has said otherwise.
                    modelChosenByReader = true
                    showingModelSelector = false
                }
            )
            .frame(width: metrics.width, height: metrics.height)
        }
        .desktopPreviewOverlays(popover: { showingModelSelector = true })
    }

    @ViewBuilder
    private func thinkingControl(_ scale: NativeThinkingScale) -> some View {
        if scale.isAutomatic {
            // Nothing, which is what the web does: Auto picks thinking
            // server-side, and a chip that reads "Auto" beside a model chip
            // that also reads "Auto" is two controls for one word.
            EmptyView()
        } else {
            // Deliberately no custom disclosure glyph: the model picker owns
            // the only chevron on this bar.
            Picker("Thinking", selection: thinkingEffortBinding(for: scale)) {
                ForEach(scale.stops) { stop in
                    Text(stop.label).tag(Optional(stop.effort))
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .junoGlassButton()
            .controlSize(.small)
            .junoGlassID("composer-thinking", in: glassNamespace)
            .fixedSize()
            .accessibilityLabel("Thinking")
            .accessibilityValue(currentThinkingLabel(in: scale))
            .accessibilityIdentifier("juno.desktop.chat-thinking")
        }
    }

    private var dictateButton: some View {
        Button {
            focused = false
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                dictating = true
            }
        } label: {
            JunoIconView(.mic, size: 16)
                .foregroundStyle(dictating ? Color.junoAccent : Color.junoForeground)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.circle)
        }
        .junoGlassButton()
        .controlSize(.small)
        .junoGlassID("composer-dictate", in: glassNamespace)
        .help("Dictate")
        .accessibilityLabel("Dictate")
        .accessibilityIdentifier("juno.desktop.chat-dictate")
    }

    /// Whether the draft is empty of anything sendable — the state in which
    /// the primary action offers voice instead of send, as on the web.
    private var draftIsEmpty: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (attachmentModel?.attachments.isEmpty ?? true)
    }

    /// The composer's single morphing action: stop while generating, voice on
    /// an empty prompt, send otherwise — the web's `ComposerPrimaryAction`.
    ///
    /// A 32pt **flat** coral circle. No glass, no raised throw, no halo: a
    /// tinted glow under the send button is the one thing the Soft UI brief
    /// names as reading like an AI demo. The face cross-fades (scale .9→1 +
    /// opacity over `fast`) between send, stop and the voice wave; the disc
    /// itself never moves, so the pointer does not have to re-find it.
    private var primaryAction: some View {
        let face: JunoIcon = model.isGenerating ? .stop : (draftIsEmpty ? .mic : .arrowUp)
        let label = model.isGenerating ? "Stop generating" : (draftIsEmpty ? "Start voice conversation" : "Send message")
        let enabled = model.isGenerating || canSend || (draftIsEmpty && !selectedModelID.isEmpty)
        return Button {
            if model.isGenerating {
                model.stopGeneration()
            } else if draftIsEmpty {
                openVoiceMode(selectedModelID)
            } else {
                send()
            }
        }
        label: {
            JunoIconView(face, size: 16)
                .foregroundStyle(Color.junoOnAccent)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.circle)
        }
        .junoProminentGlassButton()
        .controlSize(.small)
        .clipShape(Circle())
        .junoGlassID("composer-primary", in: glassNamespace)
        .disabled(!enabled)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityIdentifier(label)
    }

    private func thinkingEffortBinding(
        for scale: NativeThinkingScale
    ) -> Binding<NativeReasoningEffort?> {
        Binding(
            get: { reasoningEffort },
            set: { effort in
                thinkingStopID = scale.stops.first { $0.effort == effort }?.id
                    ?? scale.defaultStop?.id
                    ?? ""
            }
        )
    }

    private func currentThinkingLabel(in scale: NativeThinkingScale) -> String {
        scale.stops.first { $0.id == thinkingStopID }?.label ?? "Off"
    }

    /// The project whose preferences apply to this composer, if any. The fixed
    /// one wins because a project overview's composer cannot be filed anywhere
    /// else, whatever the "+" menu last remembered.
    private var activeProjectID: String? {
        fixedProjectID ?? selectedProjectID
    }

    /// The project's preferred model, when it applies.
    ///
    /// Nil is the common answer and means "this changes nothing" — no project, no
    /// preference saved, a preference naming a model this account can no longer
    /// select, or a reader who has made a pick of their own. The rule itself is
    /// ``ProjectPreferredModel/resolve(preferredModelID:readerChoseExplicitly:selectableModelIDs:)``,
    /// which lives in JunoChatKit so the phone cannot grow a second, different
    /// version of the same precedence.
    private var projectPreferredModelID: String? {
        guard let activeProjectID, let workspaceModel else { return nil }
        return ProjectPreferredModel.resolve(
            preferredModelID: workspaceModel.workspaces[activeProjectID]?.preferredModelID,
            readerChoseExplicitly: modelChosenByReader,
            selectableModelIDs: model.selectableModels.map(\.id)
        )
    }

    private func configureSelection() {
        selectedModelID = DesktopChatSelection.resolvedModelID(
            current: selectedModelID,
            conversationModel: model.selectedConversation?.model ?? "",
            selectable: model.selectableModels
        )
        // A project's preference is written into the **picker**, not only onto
        // the wire. That is what keeps the control honest: an assistant
        // configured for Sonnet shows "Sonnet" in the composer before the reader
        // presses Send, rather than showing the account default and quietly
        // answering as something else. It sits after the resolve above so it
        // outranks the conversation's own stored model, which is only a record of
        // what the last turn used — see ``routedModelID(for:)`` for the full
        // order and the reasoning.
        if let preferred = projectPreferredModelID {
            selectedModelID = preferred
        }
        configureThinking()
    }

    private func configureThinking() {
        guard let scale = thinkingScale else {
            thinkingStopID = ""
            return
        }
        if scale.stops.contains(where: { $0.id == thinkingStopID }) {
            return
        }
        thinkingStopID = scale.defaultStop?.id ?? ""
        if selectedModel?.supportsWebSearch != true {
            webSearch = false
        }
    }

    /// The model this turn will actually go to.
    ///
    /// **The precedence, highest first, and why it is this order.**
    ///
    /// 1. **An explicit pick the reader made in this composer.** Opening the
    ///    picker and choosing is a specific statement about this conversation,
    ///    made now. Nothing below may quietly overrule it — including
    ///    auto-routing, which used to. That is a deliberate change: routing is a
    ///    *standing* preference set once in Settings, and when a standing default
    ///    and a specific instruction disagree, honouring the standing one is how
    ///    a reader ends up watching a model they did not choose answer a question
    ///    they chose it for.
    /// 2. **The project's preferred model.** Also the reader's instruction, also
    ///    explicit — just made earlier, on the Projects page, about every chat in
    ///    this assistant rather than about this one. It outranks the
    ///    conversation's own stored model because that field only records what
    ///    the last turn happened to use. `configureSelection()` has already put
    ///    it in the picker, so this rung shows before it fires.
    /// 3. **Auto-routing**, when the reader has opted into it and neither of the
    ///    above has spoken. This is the one rung that is not visible in the
    ///    picker beforehand, which is why it is opt-in and off by default.
    /// 4. **Whatever the picker is showing** — the conversation's model, or the
    ///    account default. The behaviour every reader had before any of this
    ///    existed.
    ///
    /// The routed id is not written back into `selectedModelID`: the picker keeps
    /// showing what the reader chose as their default, and routing stays a
    /// per-turn decision rather than something that silently rewrites a setting.
    private func routedModelID(for content: String) -> String {
        // Rung 2 is tested first only because it is the one that needs work:
        // `projectPreferredModelID` is nil exactly when rung 1 applies, and rung
        // 1's answer is already sitting in `selectedModelID`.
        if let preferred = projectPreferredModelID { return preferred }
        if modelChosenByReader { return selectedModelID }
        guard autoRouteModel else { return selectedModelID }
        let signals = NativeComposerSignals(
            prompt: content,
            hasAttachments: !(attachmentModel?.uploadedIDs ?? []).isEmpty,
            deepResearch: deepResearch,
            webSearch: webSearch,
            connectorCount: selectedConnectors.count
        )
        return ModelTierRouter().route(
            task: NativeChatTaskClassifier.classify(signals),
            preference: .automatic,
            models: model.modelCatalog,
            // An empty catalog (offline, or a failed manifest fetch) must still
            // send to what the reader picked rather than to nothing.
            fallback: selectedModelID
        ).modelID
    }

    private func send() {
        guard canSend else { return }
        // A live call takes the turn before the chat route ever sees it. Without
        // this the draft went to `/api/chat` and came back as a written exchange
        // the spoken conversation knew nothing about — two threads, from one
        // composer, with the reader watching the wrong one.
        if let voiceCall {
            sendVoiceTurn(voiceCall)
            return
        }
        // Past the guard that can still refuse the turn, and before the work —
        // the swell answers the keystroke, not the round trip. The web sets its
        // flag in exactly the same place inside `sendFromComposer`.
        aura?.fireSendSwell()
        let content = prompt
        let modelID = routedModelID(for: content)
        let effort = reasoningEffort
        let uploadedIDs = attachmentModel?.uploadedIDs ?? []
        let research = deepResearch
        let search = webSearch
        let canvas = canvasEnabled
        // Snapshotted with the others: the send is async, and reading the
        // @AppStorage values inside the task would pick up a toggle the reader
        // flipped after hitting send.
        let fast = fastMode
        let pro = proMode
        let connectors = Array(selectedConnectors.prefix(5))
        let projectID = selectedProjectID
        // Whatever the last send said about documents is now history about a
        // message further up the transcript. Cleared here rather than on arrival
        // so nothing about the previous turn is on screen while this one runs.
        groundingNote = nil
        let documentCount = indexedDocumentCount
        // Snapshotted for the same reason `fastMode` is: the send is async, and
        // a switch flipped while the turn is in flight must not change what the
        // composer then says about a turn that was already composed.
        let wasGroundingArmed = documentGroundingArmed

        Task {
            // Grounding happens before anything is created or appended, because
            // the turn's text has to be final by then: `sendMessage` sends the
            // string it is given and there is no second channel to add to
            // afterwards. See ``NativeDocumentGrounding`` for why the passages
            // travel inside the message rather than beside it.
            let grounding = await groundedTurn(for: content, armed: wasGroundingArmed)

            let conversationID: String?
            if fixedProjectID == nil, let selected = model.selectedConversationID {
                conversationID = selected
            } else {
                model.isDraftingNewConversation = true
                conversationID = await model.createConversationResolvingID(
                    model: modelID,
                    projectID: fixedProjectID ?? projectID
                )
            }

            guard let conversationID else { return }
            let sent = model.sendMessage(
                conversationID: conversationID,
                prompt: grounding.promptForModel,
                modelID: modelID,
                reasoningEffort: effort,
                attachmentIDs: uploadedIDs,
                deepResearch: research,
                webSearch: search,
                canvasEnabled: canvas ? true : nil,
                connectors: connectors,
                fastMode: fast,
                proMode: pro
            )
            guard sent else { return }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
            deepResearch = false
            canvasEnabled = false
            // Written only after the turn was accepted, and only when the switch
            // was armed: a note about documents beside a message that never left
            // is news about something that did not happen.
            if wasGroundingArmed {
                groundingNote = Self.groundingNote(
                    for: grounding,
                    documentCount: documentCount
                )
            }
            Task {
                await model.generateTitleIfNeeded(conversationID: conversationID)
            }
            didSendConversation?(conversationID)
        }
    }

    /// Retrieves this Mac's passages for one turn and folds them into its text.
    ///
    /// Returns the reader's own words untouched whenever grounding is off, there
    /// is no index, or nothing matched — ``NativeDocumentGrounding`` is the only
    /// thing that decides what a grounded turn looks like, and it refuses to
    /// build a block over an empty result.
    ///
    /// - Parameter armed: the snapshot taken in ``send()``, not the live switch.
    ///   Reading the live one here would let a toggle flipped mid-flight decide
    ///   one thing while the note printed afterwards claims the other — the
    ///   composer would report "nothing matched" for a corpus it never searched.
    private func groundedTurn(for content: String, armed: Bool) async -> NativeDocumentGrounding {
        guard armed, let documentIndex else {
            return NativeDocumentGrounding(ungrounded: content)
        }
        // Asking for exactly what can be used, rather than the index's default
        // eight: five of them would be ranked, formatted and thrown away.
        let passages = await documentIndex.passages(
            matching: content,
            limit: NativeDocumentGrounding.maximumPassages
        )
        return NativeDocumentGrounding.ground(prompt: content, in: passages)
    }

    /// What the composer says about a send that has just happened.
    ///
    /// The two outcomes are worded so they cannot be confused, because the
    /// difference matters: one means the reader's files were read into a message
    /// that has now left the Mac, and the other means they were searched and had
    /// nothing to say. Silence would leave both looking identical.
    private static func groundingNote(
        for grounding: NativeDocumentGrounding,
        documentCount: Int
    ) -> String {
        guard grounding.isGrounded else {
            return documentCount == 1
                ? "Nothing in your 1 indexed document matched that question, so none of it was attached."
                : "Nothing in your \(documentCount) indexed documents matched that question, so none of it was attached."
        }
        let excerpts = grounding.cited.count == 1 ? "1 excerpt" : "\(grounding.cited.count) excerpts"
        // The file names, not a count of them. "2 documents" is a number somebody
        // has to go and check; "Q3 Report.pdf, Contract.docx" is the answer.
        // "in your message", not "in full": a long passage is cut to length
        // before it is quoted, and this line must not claim otherwise.
        return "Sent \(excerpts) from \(grounding.citedSourceNames.joined(separator: ", ")) — they are in your message above."
    }

    /// Sends the draft — text and up to four images — through the live session
    /// rather than through the chat route.
    ///
    /// This is what makes keeping the composer on screen during a call worth
    /// anything. The turn goes over the socket the conversation is already on, so
    /// the model answers it out loud in context; the same draft through
    /// `/api/chat` produced a second, silent conversation instead.
    ///
    /// The encoding, the four-image ceiling, the relay's byte bound and the
    /// re-check that the socket has not been replaced underneath a slow encode
    /// all live in ``JunoRealtimeVoiceController/sendTurn(text:images:)``, which
    /// the phone calls too. Nothing here duplicates them — this only decides
    /// whether there is a turn worth handing over, and says why when there is not.
    private func sendVoiceTurn(_ call: DesktopVoiceColumn) {
        guard !isSendingVoiceTurn else { return }
        voiceTurnError = nil
        let controller = call.controller
        guard controller.phase == .live else {
            // A finished call and a slow one need different sentences: the way out
            // of the first is the dock's restart button, and the way out of the
            // second is waiting.
            voiceTurnError = switch controller.phase {
            case .ended, .error:
                "This voice session has ended. Restart it, or hang up to keep typing."
            default:
                "Voice is still connecting. Try again in a moment."
            }
            return
        }

        let staged = attachmentModel?.attachments ?? []
        guard staged.count <= Self.maximumVoiceImages else {
            voiceTurnError = "Voice mode accepts up to 4 images in one turn."
            return
        }
        // `previewData` is the payload the upload model already holds for an
        // image, which is why this needs no second read and no network. An
        // attachment without one is either a document or a library clone whose
        // bytes only ever existed on the server — neither can be shown to a model
        // over this socket, so the turn is refused rather than quietly sent
        // without them.
        //
        // The uploaded id rides along so the saved transcript can claim the same
        // attachment the model was shown; it is nil until the upload lands, and a
        // turn sent then still reaches the model — it is only the saved copy that
        // loses the picture.
        let images = staged.compactMap { attachment in
            attachment.previewData.map {
                JunoVoiceTurnImage(jpeg: $0, attachmentID: attachment.uploadedID)
            }
        }
        guard images.count == staged.count else {
            voiceTurnError =
                "Voice mode can send images only — remove the other attachments first."
            return
        }
        guard images.isEmpty || voiceCanSeeImages else {
            voiceTurnError = Self.noVisionMessage
            return
        }

        aura?.fireSendSwell()
        let text = prompt
        isSendingVoiceTurn = true
        Task {
            let accepted = await controller.sendTurn(text: text, images: images)
            isSendingVoiceTurn = false
            guard accepted else {
                // The controller re-reads the provider's capabilities after the
                // encode, so a turn with images can be refused there even though
                // it passed the check above — a provider switch mid-encode is
                // exactly that case.
                voiceTurnError = images.isEmpty
                    ? "Voice could not send that turn."
                    : Self.noVisionMessage
                return
            }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
        }
    }

    /// The web's own wording for a provider with no eyes, so both clients name
    /// the same three alternatives.
    private static let noVisionMessage =
        "This voice model can’t see images. Switch to OpenAI, Gemini or Qwen."

    private var connectedConnectors: [NativeConnector] {
        (connectorModel?.linked ?? []).filter(\.connected)
    }

    private var selectedProjectName: String? {
        guard let projectID = fixedProjectID ?? selectedProjectID else { return nil }
        return projectModel?.projects.first { $0.id == projectID }?.name
    }

    private func toggleConnector(_ id: String) {
        if selectedConnectors.contains(id) {
            selectedConnectors.remove(id)
        } else if selectedConnectors.count < 5 {
            selectedConnectors.insert(id)
        }
    }

    private func appendDictated(_ transcript: String) {
        let dictated = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dictated.isEmpty else { return }
        let current = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = current.isEmpty ? dictated : "\(current) \(dictated)"
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            importError = error.localizedDescription
        case .success(let urls):
            importError = nil
            // A call's ceiling is the relay's four, not the message route's ten.
            let ceiling = voiceActive
                ? Self.maximumVoiceImages
                : NativeComposerAttachmentModel.maximumAttachments
            for url in urls.prefix(ceiling) {
                let granted = url.startAccessingSecurityScopedResource()
                defer {
                    if granted { url.stopAccessingSecurityScopedResource() }
                }
                do {
                    let values = try url.resourceValues(forKeys: [.contentTypeKey])
                    let contentType = values.contentType
                    let data = try Data(contentsOf: url)
                    attachmentModel?.add(
                        data: data,
                        fileName: url.lastPathComponent,
                        mimeType: contentType?.preferredMIMEType
                            ?? "application/octet-stream",
                        conversationID: model.selectedConversationID,
                        isImage: contentType?.conforms(to: .image) == true
                    )
                } catch {
                    importError = "Could not attach \(url.lastPathComponent): \(error.localizedDescription)"
                }
            }
        }
    }
}

/// **Attach from Library** — a grid of the files themselves.
///
/// It used to be a `List` of rows: an SF Symbol, the filename, the size. That
/// asks the reader to recognise a screenshot by its name, which nobody can do.
/// The card, its fallback and its press behaviour are the shared
/// ``NativeFilePreviewTile`` — the same one the Library screen and the phone's
/// picker draw, so all three cannot drift into three designs again.
struct DesktopLibraryPicker: View {
    @Bindable var model: NativeLibraryModel
    let capacity: Int
    let attach: () async -> Void
    let cancel: () -> Void

    @State private var previews = NativeFilePreviewLoader()

    private let columns = [GridItem(.adaptive(minimum: 132, maximum: 190), spacing: 14)]

    private func card(_ item: NativeLibraryItem) -> some View {
        let file = NativeFilePreviewRequest(item)
        let selected = model.selection.contains(item.id)
        // Unselected cards go quiet at the ceiling rather than vanishing, so the
        // limit reads as a limit instead of as a grid that stopped responding.
        let blocked = !selected && model.selection.count >= capacity
        return Button {
            model.toggle(item.id, limit: capacity)
        } label: {
            NativeFilePreviewTile(
                file: file,
                state: previews.state(for: item.id),
                cornerRadius: JunoRadius.well
            )
            .overlay {
                // A stroke over the picture, never a wash across it: a coral
                // tint over a photograph changes the photograph, which is the
                // one thing this grid exists to show.
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoAccent, lineWidth: 2)
                    .opacity(selected ? 1 : 0)
            }
            .overlay(alignment: .topTrailing) {
                JunoIconView(selected ? .circleCheck : .circle, size: 16)
                    .foregroundStyle(selected ? Color.junoAccent : Color.white)
                    .padding(8)
                    .shadow(color: .black.opacity(selected ? 0 : 0.25), radius: 2)
            }
            .contentShape(.rect)
        }
        .buttonStyle(NativeFilePreviewPressStyle())
        .disabled(blocked)
        .opacity(blocked ? 0.45 : 1)
        .help(item.fileName)
        .accessibilityLabel("\(item.fileName), \(file.sizeLabel)")
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .task(id: item.id) {
            await previews.load(file) { await model.accessFile(id: item.id) }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Attach from Library")
                        .font(.title2.weight(.semibold))
                    Text("Choose files already shared with Juno.")
                        .font(.callout)
                        .junoSecondaryInk()
                }
                Spacer()
                // The glass-knob switcher, not `Picker(.segmented)`. This
                // header is content inside a sheet, and `NSSegmentedControl`
                // draws its pre-Tahoe slab there — hard dividers, a knob whose
                // radius does not match its track — which is exactly the weight
                // ``DesktopSegmented`` exists to replace everywhere else in the
                // app. The control sizes itself to its labels, so the fixed
                // 220pt frame the picker needed goes with it.
                DesktopSegmented(
                    options: NativeLibraryModel.Filter.allCases.map {
                        .init($0, $0.title)
                    },
                    selection: $model.filter,
                    accessibilityLabel: "Filter"
                )
            }
            .padding(18)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }

            Group {
                if model.isLoading && model.items.isEmpty {
                    ProgressView("Loading Library…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.visibleItems.isEmpty {
                    JunoEmptyState(
                        title: "No matching files",
                        message: "Files and images you share in conversations appear here.",
                        icon: .library
                    )
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(model.visibleItems) { item in
                                card(item)
                            }
                        }
                        .padding(18)
                    }
                }
            }
            .frame(minHeight: 360)

            HStack {
                if let error = model.lastErrorDescription {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Color.junoDanger)
                        .lineLimit(2)
                } else {
                    Text("\(model.selection.count) of \(capacity) selected")
                        .font(.caption)
                        .junoSecondaryInk()
                }
                Spacer()
                Button("Cancel", action: cancel)
                    .contentShape(.rect)
                Button {
                    Task { await attach() }
                } label: {
                    if model.isAttaching {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Attach")
                            .contentShape(.rect)
                    }
                }
                // Untinted, `.borderedProminent` fills with the system accent —
                // system blue beside the coral selection stroke this same grid
                // draws two dozen points away.
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .disabled(model.selection.isEmpty || model.isAttaching)
            }
            .padding(16)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        }
        // A fixed size, and deliberately **no ideal size**. A sheet that reports
        // an ideal has to be re-solved whenever its presenter's frame moves, and
        // when AppKit moves that frame inside an animation SwiftUI traps in
        // `SheetBridge.sheetSize(presentationID:presenterSize:currentSize:)` —
        // the crash a real .ips from this app pinned on the old voice sheet,
        // which was the other view in this file declaring one. Nothing here
        // needs to grow, so nothing here asks to.
        .frame(width: 740, height: 560)
        // Sheet contract: the warm ground inside the content, the platter left to
        // the system. `.fitted` rather than `.form` precisely because the frame
        // above is deliberate — see the note on it.
        .junoSheetSurface(.fitted)
        .task {
            model.selection = []
            await model.refresh()
        }
    }
}

private struct DesktopAttachmentChip: View {
    let attachment: NativeComposerAttachment
    let remove: () -> Void
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            stateIcon
            Text(attachment.fileName)
                .font(.caption)
                .lineLimit(1)
            if case .failed(_, let retryable) = attachment.state, retryable {
                Button("Retry", action: retry)
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
                    .contentShape(.rect)
            }
            Button(action: remove) {
                JunoIconView(.close, size: 12)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Remove \(attachment.fileName)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .fill(Color.junoMuted)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .help(failureMessage ?? attachment.fileName)
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch attachment.state {
        case .preparing, .uploading:
            ProgressView()
                .controlSize(.mini)
        case .uploaded:
            JunoIconView(.circleCheck, size: 14)
                .foregroundStyle(Color.junoSuccess)
        case .failed:
            JunoIconView(.error, size: 14)
                .foregroundStyle(Color.junoDanger)
        }
    }

    private var failureMessage: String? {
        guard case .failed(let message, _) = attachment.state else { return nil }
        return message
    }
}

private extension NativeConversationBucket {
    var desktopTitle: String {
        switch self {
        case .pinned: "Pinned"
        case .today: "Today"
        case .yesterday: "Yesterday"
        case .previous7Days: "Previous 7 days"
        case .previous30Days: "Previous 30 days"
        case .older: "Older"
        // Unreachable on the desktop: `DesktopChatSidebar.groups` drops the
        // archive bucket. The case stays because the bucket is shared with the
        // phone app and the switch has to be exhaustive.
        case .archived: "Archived"
        }
    }
}

// MARK: - The composer's controls
