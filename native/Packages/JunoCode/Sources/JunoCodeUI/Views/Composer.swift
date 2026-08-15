import SwiftUI
import UniformTypeIdentifiers
import AppKit
import JunoCodeCore
import JunoDesignSystem

/// The names for a permission level, in one place.
///
/// `text` is the full label a menu item needs; `shortText` is what fits in the
/// composer's own label beside the mode. Public because the window's subtitle
/// states the same fact from outside this package.
public enum PermissionModeLabel {
    public static func text(for mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: "Read-only"
        case .askBeforeChanges: "Ask before changes"
        case .workspaceWrite: "Workspace write"
        case .fullAccess: "Full access"
        }
    }

    /// The label used beside a mode, where the mode already carries the noun.
    public static func shortText(for mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: "read-only"
        case .askBeforeChanges: "ask to edit"
        case .workspaceWrite: "can edit"
        case .fullAccess: "full access"
        }
    }

    public static func glyph(for mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: "eye"
        case .askBeforeChanges: "hand.raised"
        case .workspaceWrite: "square.and.pencil"
        case .fullAccess: "lock.open"
        }
    }

    /// What the mode allows, stated in the menu so the choice is not four nouns
    /// the reader has to infer a policy from.
    public static func explanation(for mode: PermissionMode) -> String {
        switch mode {
        case .readOnly:
            "Juno may read and search. Every edit and command is refused."
        case .askBeforeChanges:
            "Every edit and every command asks first."
        case .workspaceWrite:
            "Edits inside this folder proceed. Commands still ask."
        case .fullAccess:
            // Says what the policy now actually does. The old wording — "Destructive
            // and networked actions still ask" — was the honest description of a
            // mode that stopped for `npm install` and `git push`, which is not what
            // anyone selecting full access is asking for. Only leaving the folder
            // interrupts now, and that one cannot be switched off.
            "Edits, commands, installs and pushes proceed. Anything reaching outside this folder still asks."
        }
    }
}

public enum AgentBehaviorLabel {
    public static func text(for behavior: AgentBehavior) -> String {
        switch behavior {
        case .ask: "Ask"
        case .survey: "Survey"
        case .plan: "Plan"
        case .code: "Code"
        }
    }

    public static func glyph(for behavior: AgentBehavior) -> String {
        switch behavior {
        case .ask: "questionmark.bubble"
        case .survey: "scope"
        case .plan: "list.bullet.rectangle"
        case .code: "hammer"
        }
    }

    public static func explanation(for behavior: AgentBehavior) -> String {
        switch behavior {
        case .ask: "Answer questions about this project using inspection tools only."
        case .survey:
            "Map the project with read-only inspection and, when useful, parallel sub-agents. Nothing is changed."
        case .plan: "Investigate, then write an implementation plan. Nothing is changed."
        case .code: "Carry the task through, with edits checkpointed and gated."
        }
    }
}

/// The five-bar voice mark shared by the Code composer and its first-turn
/// launchpad. It is deliberately the same compact signal Chat uses instead of
/// an ambiguous waveform outline that disappears inside a small toolbar row.
public struct JunoCodeVoiceGlyph: View {
    private let color: Color
    private let heights: [CGFloat] = [7, 13, 18, 11, 6]

    public init(color: Color = .white) {
        self.color = color
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, height in
                Capsule()
                    .fill(color)
                    .frame(width: 2, height: height)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - The composer

/// The one place the next turn's contract is set.
///
/// Mode, permission level, model and reasoning effort used to appear in four
/// places — a launchpad, a new-session sheet, this bar, and an inspector tab —
/// two of which wrote to different state. They live here now and nowhere else,
/// because they govern the message the reader is about to send and nothing that
/// has already happened.
public struct Composer: View {
    @Bindable var controller: SessionController
    let availableModels: [ModelOption]
    var focus: FocusState<Bool>.Binding?
    /// The workspace's saved prompts, layered over the built-ins. Defaults to
    /// the built-ins alone so a caller that has not discovered the workspace's
    /// `.juno/commands` yet still gets a working slash menu.
    let slashCommands: CodeSlashCommandLibrary
    /// Starts dictation, or nil where the host offers none.
    ///
    /// Injected rather than built here: the speech service lives in `JunoVoiceKit`
    /// and the recording UI in the app target, and `JunoCodeUI` deliberately depends
    /// on neither — it takes `JunoDesignSystem` and nothing else. A closure keeps
    /// that boundary while still letting the Code composer offer the same control
    /// the Chat composer has.
    let beginDictation: (() -> Void)?
    /// Starts realtime voice mode, or nil when the host has no voice service.
    /// Like dictation, this remains a host closure so JunoCodeUI does not own
    /// audio permissions, relay credentials, or transcript persistence.
    let beginVoice: (() -> Void)?

    /// Which row the arrow keys are on. Reset every time the query changes, so
    /// the highlight cannot point past the end of a narrowed list.
    @State private var highlightedCommand = 0
    @State private var highlightedFile = 0
    @State private var fileResults: [FileEntry] = []
    @State private var fileResultsQuery: String?
    @State private var searchingFileQuery: String?
    @State private var isChoosingAttachment = false

    public init(
        controller: SessionController,
        availableModels: [ModelOption],
        focus: FocusState<Bool>.Binding? = nil,
        slashCommands: CodeSlashCommandLibrary = .builtIn,
        beginDictation: (() -> Void)? = nil,
        beginVoice: (() -> Void)? = nil
    ) {
        self.controller = controller
        self.availableModels = availableModels
        self.focus = focus
        self.slashCommands = slashCommands
        self.beginDictation = beginDictation
        self.beginVoice = beginVoice
    }

    /// The `/token` being typed, if the composer is on one.
    private var slashToken: CodeSlashToken? {
        guard !isRunning else { return nil }
        return CodeSlashToken(composerText: controller.composerText)
    }

    /// The menu's contents: non-empty only while the caret is still inside the
    /// command word and something actually matches.
    private var slashMatches: [CodeSlashCommand] {
        guard let token = slashToken, token.isNamingCommand else { return [] }
        return slashCommands.matches(token.query)
    }

    /// The trailing `@name` currently being typed, if it is not an email, path
    /// component or escaped literal.
    private var fileToken: CodeFileContextToken? {
        guard !isRunning else { return nil }
        return CodeFileContextToken(composerText: controller.composerText)
    }

    private var fileSearchQuery: String? {
        guard slashMatches.isEmpty, let query = fileToken?.query, !query.isEmpty else {
            return nil
        }
        return query
    }

    /// Results are tagged with the query that produced them so a fast typist can
    /// never select a stale row during the debounce between two searches.
    private var currentFileMatches: [FileEntry] {
        guard let query = fileToken?.query, fileResultsQuery == query else { return [] }
        return fileResults
    }

    private var isCurrentFileSearchRunning: Bool {
        guard let query = fileToken?.query else { return false }
        return searchingFileQuery == query
    }

    private var isFileMenuVisible: Bool {
        slashMatches.isEmpty
            && (!currentFileMatches.isEmpty || isCurrentFileSearchRunning)
    }

    private var isRunning: Bool { controller.isRunning }

    /// The catalog entry for the session's model, which is what tells the
    /// thinking control which depths this model actually offers.
    private var selectedModel: ModelOption? {
        availableModels.first {
            $0.modelID == controller.session.configuration.modelID
        }
    }

    private var canSend: Bool {
        // An attachment with no sentence is a message in its own right.
        (!controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !controller.pendingAttachments.isEmpty)
            && !isRunning
            && controller.isAgentTransportConfigured
    }

    private var prompt: String {
        guard controller.isAgentTransportConfigured else {
            return "Sign in to Juno to run the agent"
        }
        if isRunning {
            // The runtime refuses a second concurrent run and nothing queues the
            // message, so the field says what will actually happen.
            return "Juno is working — stop the run to send something else"
        }
        // The slash hint rides on the placeholder rather than sitting in the bar
        // as a button. A feature addressed by typing has to be advertised where
        // the typing happens — and the placeholder is the one piece of chrome
        // that disappears the moment it has been read, which is exactly the
        // lifetime a discoverability hint should have.
        switch controller.session.configuration.behavior {
        case .ask: return "Ask about this project…  /  for commands"
        case .survey: return "Map the project and its risks…  /  for commands"
        case .plan: return "Describe the change to plan…  /  for commands"
        case .code: return "Ask Juno to build, fix, or investigate…  /  for commands"
        }
    }

    public var body: some View {
        surface
            // The menu sits above the bar and outside its glass, so it reads as
            // its own pane of material rather than a shape painted on the
            // composer's. Anchored to the composer's top edge and grown upward,
            // so adding rows never moves the field the reader is typing in.
            .overlay(alignment: .top) { suggestionMenu }
            .onChange(of: slashToken?.query) { _, _ in
                highlightedCommand = 0
            }
            .task(id: fileSearchQuery) {
                await searchFiles(matching: fileSearchQuery)
            }
    }

    @ViewBuilder
    private var suggestionMenu: some View {
        if !slashMatches.isEmpty {
            SlashCommandMenu(
                commands: slashMatches,
                highlighted: min(highlightedCommand, slashMatches.count - 1),
                choose: apply
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .alignmentGuide(.top) { $0[.bottom] + JunoSpace.snug }
            .transition(.opacity)
        } else if isFileMenuVisible {
            FileContextMenu(
                entries: currentFileMatches,
                highlighted: min(
                    highlightedFile,
                    max(currentFileMatches.count - 1, 0)
                ),
                isSearching: isCurrentFileSearchRunning,
                choose: apply
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .alignmentGuide(.top) { $0[.bottom] + JunoSpace.snug }
            .transition(.opacity)
        }
    }

    private var surface: some View {
        ComposerSurface(
            prompt: prompt,
            text: $controller.composerText,
            focus: focus,
            submit: submitFromField,
            moveHighlight: highlightHandler,
            dismissOverlay: dismissHandler,
            attachments: controller.pendingAttachments,
            removeAttachment: { controller.removeAttachment(id: $0) },
            addAttachment: { controller.attach($0) }
        ) {
            attachButton

            TurnContractMenu(
                behavior: Binding(
                    get: { controller.session.configuration.behavior },
                    set: { newBehavior in
                        Task { await controller.setBehavior(newBehavior) }
                    }
                ),
                permissionMode: Binding(
                    get: { controller.session.configuration.permissionMode },
                    set: { newMode in
                        Task { await controller.setPermissionMode(newMode) }
                    }
                )
            )

            // No painted divider between the controls.
            //
            // There was a 1pt `Rectangle` here, and it contradicted two doc comments
            // in this repo at once: `junoFloatingChrome` says it "deliberately draws
            // no border" because "real glass carries its own edge — a light scatter
            // at the rim that reads as thickness. Stroking a hairline over it
            // flattens that back into a translucent rounded rectangle", and
            // `ComposerSurface`'s own header calls out "the rejected build stroked a
            // hairline over the glass". Spacing separates these groups; a drawn line
            // only muddies the material they sit on.
            Spacer().frame(width: JunoSpace.snug)

            CodeModelSelector(
                selection: Binding(
                    get: { controller.session.configuration.modelID },
                    set: { newID in
                        Task { await controller.setModelID(newID) }
                    }
                ),
                availableModels: availableModels,
                accessibilityID: "juno.code.composer.model"
            )
            CodeThinkingControl(
                selection: Binding(
                    get: { controller.session.configuration.reasoningEffort },
                    set: { newEffort in
                        Task { await controller.setReasoningEffort(newEffort) }
                    }
                ),
                model: selectedModel,
                accessibilityID: "juno.code.composer.reasoning"
            )

            Spacer(minLength: JunoSpace.snug)

            contextMeter

            if let beginDictation, !isRunning {
                Button(action: beginDictation) {
                    Image(systemName: "mic")
                        .font(.body)
                        // The warm muted ink, which is what a 76%-strength primary was
                        // reaching for — except an opacity on ink cannot
                        // participate in contrast adaptation, and this token
                        // is already measured at the floor.
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(width: 30, height: 30)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Dictate a message")
                .accessibilityLabel("Dictate a message")
                .accessibilityIdentifier("juno.code.composer.dictate")
            }

            if isRunning {
                Button {
                    Task { await controller.stop() }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.junoOnAccent)
                        .frame(width: 26, height: 26)
                }
                .accentGlassAction(active: true)
                .keyboardShortcut(".", modifiers: .command)
                .help("Stop the agent (⌘.)")
                .accessibilityLabel("Stop the agent")
                .accessibilityIdentifier("juno.code.composer.stop")
            } else if let beginVoice,
                controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                controller.pendingAttachments.isEmpty
            {
                Button(action: beginVoice) {
                    JunoCodeVoiceGlyph(color: Color.junoOnAccent)
                        .frame(width: 30, height: 30)
                        .contentShape(.circle)
                }
                .accentGlassAction(active: controller.isAgentTransportConfigured)
                .disabled(!controller.isAgentTransportConfigured)
                .help("Start a voice conversation")
                .accessibilityLabel("Start voice mode")
                .accessibilityIdentifier("juno.code.composer.voice")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(canSend ? Color.junoOnAccent : Color.junoMutedForeground)
                        .frame(width: 30, height: 30)
                        .contentShape(.circle)
                }
                .accentGlassAction(active: canSend)
                .disabled(!canSend)
                .help("Send")
                .accessibilityLabel("Send")
                .accessibilityIdentifier("juno.code.composer.send")
            }
        }
    }

    /// How full the model's context window is.
    ///
    /// Both numbers are the provider's own: the window comes from the manifest
    /// entry, and the fill from the `usage` the provider reports on every turn.
    /// Nothing is estimated, which is why the meter simply does not appear until
    /// there is a real measurement — a made-up token count is worse than none,
    /// because it invites the reader to plan around it.
    @ViewBuilder
    private var contextMeter: some View {
        if let used = controller.contextTokens,
            let window = selectedModel?.catalog?.contextWindowTokens,
            window > 0
        {
            let fraction = min(Double(used) / Double(window), 1)
            let isTight = fraction >= 0.8
            HStack(spacing: JunoSpace.tight) {
                // A ring rather than a bar: it holds its meaning at this size and
                // does not need a width the control row cannot spare.
                ZStack {
                    Circle()
                        .stroke(Color.junoHairline, lineWidth: 2)
                    Circle()
                        .trim(from: 0, to: fraction)
                        .stroke(
                            isTight ? Color.junoCaution : Color.junoMutedForeground,
                            style: StrokeStyle(lineWidth: 2, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 11, height: 11)
                .animation(JunoMotion.fast, value: fraction)

                // The percentage is only worth the width once it matters.
                if isTight {
                    Text("\(Int(fraction * 100))%")
                        .junoCaption()
                        .monospacedDigit()
                        .foregroundStyle(Color.junoCaution)
                }
            }
            .help(
                """
                \(JunoModelFormatting.contextWindow(used)) of \
                \(JunoModelFormatting.contextWindow(window)) context used
                """
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Context \(Int(fraction * 100)) percent full")
            .accessibilityIdentifier("juno.code.composer.context")
        }
    }

    /// Attach an image to this message.
    ///
    /// Only offered where the model can actually see one — an attach control on a
    /// text-only model is a control that can only ever produce an error.
    @ViewBuilder
    private var attachButton: some View {
        if selectedModel?.catalog?.capabilities.contains(.vision) != false {
            Button { isChoosingAttachment = true } label: {
                Image(systemName: "paperclip")
                    .imageScale(.small)
                    .frame(width: 20, height: 20)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .junoSecondaryInk()
            .disabled(isRunning)
            .help("Attach an image")
            .accessibilityLabel("Attach an image")
            .accessibilityIdentifier("juno.code.composer.attach")
            .fileImporter(
                isPresented: $isChoosingAttachment,
                allowedContentTypes: CodeAttachment.acceptedTypes,
                allowsMultipleSelection: true
            ) { result in
                guard case let .success(urls) = result else { return }
                for url in urls {
                    // The panel hands back a security-scoped URL; the read has to
                    // happen inside the scope or it fails for anything outside the
                    // app's own container.
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    if let attachment = CodeAttachment.load(contentsOf: url) {
                        controller.attach(attachment)
                    }
                }
            }
        }
    }

    private func send() {
        guard canSend else { return }
        Task { await controller.send() }
    }

    // MARK: - Slash commands

    /// Arrow keys drive the menu only while it is open; otherwise these stay nil
    /// and the keys fall through to the field, moving the caret as usual.
    ///
    /// Explicitly typed rather than a ternary at the call site: inferring an
    /// optional closure from `nil : someMethod` inside a large ViewBuilder is
    /// what made the type-checker give up on this body entirely.
    private var highlightHandler: ((Int) -> Void)? {
        if !slashMatches.isEmpty {
            return { delta in moveCommandHighlight(delta) }
        }
        if isFileMenuVisible, !currentFileMatches.isEmpty {
            return { delta in moveFileHighlight(delta) }
        }
        return nil
    }

    private var dismissHandler: (() -> Void)? {
        if !slashMatches.isEmpty {
            return { dismissSlashMenu() }
        }
        if isFileMenuVisible {
            return { dismissFileMenu() }
        }
        return nil
    }

    /// Return in the field. While the menu is open it runs the highlighted
    /// command instead of sending — sending the literal text "/rev" would be a
    /// message nobody meant to write.
    private func submitFromField() {
        if !slashMatches.isEmpty {
            let index = min(highlightedCommand, slashMatches.count - 1)
            apply(slashMatches[index])
            return
        }
        if !currentFileMatches.isEmpty {
            let index = min(highlightedFile, currentFileMatches.count - 1)
            apply(currentFileMatches[index])
            return
        }
        // A search in flight owns Return just like the synchronous slash menu
        // does. This avoids sending a partial `@name` a few milliseconds before
        // its results arrive.
        if isCurrentFileSearchRunning { return }
        send()
    }

    private func moveCommandHighlight(_ delta: Int) {
        guard !slashMatches.isEmpty else { return }
        let count = slashMatches.count
        // Wraps, so holding ↓ at the end returns to the top rather than sticking.
        highlightedCommand = ((highlightedCommand + delta) % count + count) % count
    }

    private func moveFileHighlight(_ delta: Int) {
        guard !currentFileMatches.isEmpty else { return }
        let count = currentFileMatches.count
        highlightedFile = ((highlightedFile + delta) % count + count) % count
    }

    /// Closes the menu without losing what was typed.
    ///
    /// A space is appended rather than the text being cleared: Escape means "I
    /// did not want the menu", not "throw away my sentence", and the space is
    /// what takes the composer out of the naming state.
    private func dismissSlashMenu() {
        guard let token = slashToken, token.isNamingCommand else { return }
        controller.composerText += " "
    }

    private func dismissFileMenu() {
        guard fileToken != nil else { return }
        controller.composerText += " "
        highlightedFile = 0
    }

    /// Replace the typed token with the command's prompt.
    ///
    /// The prompt lands **in the composer**, not on the wire. The reader sees
    /// exactly what will be sent and can edit it first — a saved prompt that
    /// fired straight into the agent would be a stored instruction the reader
    /// never read.
    private func apply(_ command: CodeSlashCommand) {
        let argument = slashToken?.argument ?? ""
        controller.composerText = command.expanded(argument: argument)
        highlightedCommand = 0
        // Only when the command names one, and only as a default the reader can
        // still override: the contract beside the field is theirs to set.
        if let behavior = command.behavior,
            behavior != controller.session.configuration.behavior
        {
            Task { await controller.setBehavior(behavior) }
        }
        focus?.wrappedValue = true
    }

    // MARK: - File context

    private func searchFiles(matching query: String?) async {
        highlightedFile = 0
        fileResults = []
        fileResultsQuery = nil
        searchingFileQuery = query

        guard let query else {
            searchingFileQuery = nil
            return
        }

        // The index walks the workspace. Debouncing keeps rapid typing from
        // starting one filesystem traversal per keystroke, and `.task(id:)`
        // cancels the superseded search automatically.
        try? await Task.sleep(for: .milliseconds(140))
        guard !Task.isCancelled else { return }

        let results = await controller.findFiles(nameContains: query, limit: 24)
        guard !Task.isCancelled else { return }

        fileResults = CodeFileContextSearch.ranked(results, query: query)
        fileResultsQuery = query
        searchingFileQuery = nil
    }

    private func apply(_ entry: FileEntry) {
        guard let token = fileToken else { return }
        controller.composerText = token.replacing(
            in: controller.composerText,
            withPath: entry.path.value
        )
        if !entry.isDirectory {
            controller.registerComposerFileReference(entry.path)
        }
        highlightedFile = 0
        fileResults = []
        fileResultsQuery = nil
        searchingFileQuery = nil
        focus?.wrappedValue = true
    }
}

/// The glass shell every composer in Code shares: the session's, and the draft
/// one that stands in for the deleted new-session sheet.
///
/// One `JunoDesktopGlass` container, one glass bar, and no border drawn over it.
/// The rejected build stroked a hairline over the glass and gave each control
/// inside its own capsule fill, which flattened the rim light that makes glass
/// read as having thickness and turned the bar into four grey pills.
struct ComposerSurface<Controls: View>: View {
    let prompt: String
    @Binding var text: String
    var focus: FocusState<Bool>.Binding?
    let submit: () -> Void
    /// Called with -1/+1 when the reader presses ↑/↓ **and** something above the
    /// composer is claiming the arrow keys. Nil means nothing is, so they move
    /// the caret as usual.
    var moveHighlight: ((Int) -> Void)?
    /// Called on Escape while such an overlay is open.
    var dismissOverlay: (() -> Void)?
    /// Images already attached to this message, drawn above the field.
    var attachments: [CodeAttachment] = []
    var removeAttachment: ((UUID) -> Void)?
    /// Called with a dropped or pasted image. nil means the host takes none.
    var addAttachment: ((CodeAttachment) -> Void)?
    @ViewBuilder var controls: () -> Controls
    /// Whether the reader has asked to see a very large draft inline anyway.
    @State private var draftExpanded = false
    @State private var isDropTargeted = false

    init(
        prompt: String,
        text: Binding<String>,
        focus: FocusState<Bool>.Binding? = nil,
        submit: @escaping () -> Void,
        moveHighlight: ((Int) -> Void)? = nil,
        dismissOverlay: (() -> Void)? = nil,
        attachments: [CodeAttachment] = [],
        removeAttachment: ((UUID) -> Void)? = nil,
        addAttachment: ((CodeAttachment) -> Void)? = nil,
        @ViewBuilder controls: @escaping () -> Controls
    ) {
        self.prompt = prompt
        _text = text
        self.focus = focus
        self.submit = submit
        self.moveHighlight = moveHighlight
        self.dismissOverlay = dismissOverlay
        self.attachments = attachments
        self.removeAttachment = removeAttachment
        self.addAttachment = addAttachment
        self.controls = controls
    }

    /// Past this the draft stops being live in the text field.
    ///
    /// Tens of thousands of characters in an auto-sizing `TextField` is a
    /// per-keystroke relayout of the whole composer — the exact problem
    /// ``NativePromptLimits`` was written for on the Chat side, which Code did not
    /// obey because the type lived in `JunoChatKit` and this package cannot import
    /// it. It now lives in the design system, so both composers use one threshold.
    private var isHugeDraft: Bool {
        NativePromptLimits.isHugeDraft(text)
    }

    var body: some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            VStack(spacing: JunoSpace.snug) {
                attachmentStrip
                if isHugeDraft && !draftExpanded {
                    collapsedDraftCard
                } else {
                    textField
                }
                HStack(spacing: JunoSpace.tight) {
                    controls()
                }
            }
            .padding(JunoSpace.snug)
            // Drop feedback is a **tint on the glass**, never a stroke over it.
            //
            // A stroked `RoundedRectangle` overlay here is what turned the composer
            // into a hard-edged rectangle the moment a drag entered the window: the
            // border is drawn over the material, so the rim light that makes glass
            // read as having thickness is flattened out and what is left is a
            // translucent box with a line round it. `junoFloatingChrome`'s own
            // documentation says exactly this — "real glass carries its own edge …
            // stroking a hairline over it flattens that back into a translucent
            // rounded rectangle" — and tinting is the treatment the material
            // actually supports.
            .junoGlass(
                in: RoundedRectangle(
                    cornerRadius: JunoRadius.composer,
                    style: .continuous
                ),
                // Full alpha or nothing. `Glass.tint(_:)` honours the alpha it
                // is given, so a diluted accent stops establishing a
                // predictable luminance and the composer's text ends up
                // reading against whatever is behind the window — the exact
                // defect `accentGlassAction` was written to document. The 0.28
                // that stood here was the one value the material must never be
                // handed.
                tint: isDropTargeted ? Color.junoAccent : nil
            )
            // The whole composer is the drop target, not just the thumbnails —
            // there is nothing to aim at before the first image is attached.
            .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted) { providers in
                guard addAttachment != nil else { return false }
                receive(providers)
                return true
            }
            .animation(JunoMotion.fast, value: isDropTargeted)
            .animation(JunoMotion.fast, value: attachments.count)
        }
    }

    /// The attached images, as removable thumbnails.
    @ViewBuilder
    private var attachmentStrip: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: JunoSpace.snug) {
                    ForEach(attachments) { attachment in
                        thumbnail(attachment)
                    }
                }
                .padding(.horizontal, JunoSpace.tight)
            }
            .scrollIndicators(.never)
            .frame(height: 52)
        }
    }

    private func thumbnail(_ attachment: CodeAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = NSImage(data: attachment.image.data) {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Image(systemName: "photo")
                        .junoSecondaryInk()
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .strokeBorder(Color.junoHairline)
            )

            Button {
                removeAttachment?(attachment.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Color.junoOnAccent, Color.junoMutedForeground)
            }
            .buttonStyle(.plain)
            .offset(x: 5, y: -5)
            .accessibilityLabel("Remove \(attachment.name)")
        }
        .help("\(attachment.name) · \(attachment.sizeDescription)")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attached image \(attachment.name)")
    }

    /// The image currently on the general pasteboard, if there is one.
    ///
    /// Reads the declared type so a copied PNG stays a PNG rather than being
    /// re-encoded; `CodeAttachment` transcodes only what the providers reject.
    static func pasteboardImage() -> CodeAttachment? {
        let pasteboard = NSPasteboard.general
        for type in [NSPasteboard.PasteboardType.png, .tiff] {
            guard let data = pasteboard.data(forType: type) else { continue }
            return CodeAttachment.pasted(
                data: data,
                declaredMediaType: type == .png ? "image/png" : nil
            )
        }
        // A file copied in Finder arrives as a URL rather than as bytes.
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL],
           let url = urls.first,
           let attachment = CodeAttachment.load(contentsOf: url)
        {
            return attachment
        }
        return nil
    }

    /// Turns dropped providers into attachments.
    ///
    /// File URLs are tried first: a drag from Finder offers both a URL and the
    /// image bytes, and the URL is what carries the filename worth showing.
    private func receive(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, let attachment = CodeAttachment.load(contentsOf: url) else {
                        return
                    }
                    Task { @MainActor in addAttachment?(attachment) }
                }
                continue
            }
            provider.loadDataRepresentation(
                forTypeIdentifier: UTType.image.identifier
            ) { data, _ in
                guard let data,
                      let attachment = CodeAttachment.pasted(data: data, declaredMediaType: nil)
                else { return }
                Task { @MainActor in addAttachment?(attachment) }
            }
        }
    }

    /// A very large paste, described rather than rendered.
    ///
    /// The text itself is untouched and is still exactly what gets sent — this only
    /// stops the field from re-measuring it on every keystroke. Expandable, because
    /// refusing to show someone their own draft would be worse than the stall.
    private var collapsedDraftCard: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Image(systemName: "doc.plaintext")
                .junoSecondaryInk()
            VStack(alignment: .leading, spacing: 1) {
                Text("Large draft").junoRowLabel()
                Text(NativePromptLimits.collapsedSummary(for: text))
                    .junoCaption()
            }
            Spacer(minLength: 0)
            Button("Show") { draftExpanded = true }
                .buttonStyle(.borderless)
                .controlSize(.small)
            Button("Clear") { text = "" }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .tint(Color.junoDanger)
        }
        .padding(.horizontal, JunoSpace.tight)
        .padding(.vertical, JunoSpace.snug)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Large draft, \(NativePromptLimits.collapsedSummary(for: text))")
        .accessibilityIdentifier("juno.code.composer.large-draft")
    }

    @ViewBuilder
    private var textField: some View {
        let field = TextField(prompt, text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...10)
            .font(.body)
            .padding(.horizontal, JunoSpace.tight)
            .padding(.top, JunoSpace.hairline)
            // Return sends, and accepts the highlighted suggestion when a menu is
            // open. Shift-Return breaks the line.
            //
            // This was `.onSubmit(submit)`, which never fired: a vertical-axis
            // `TextField` inserts a newline on Return instead of submitting, as the
            // Chat composer's own comment in this repo says
            // (`DesktopChatWorkspace.swift`: "A vertical `TextField` inserts a
            // newline on Return by default, so the key has to be intercepted
            // rather than merely bound"). The consequence was larger than a missing
            // accelerator: `submitFromField` is also what accepts a slash command
            // or an `@file` result, so the whole keyboard path through
            // `SlashCommandMenu` and `FileContextMenu` — arrow keys to move, Return
            // to choose — was reachable only with the mouse, while ↑/↓ worked and
            // implied Return would too.
            .onKeyPress(.return, phases: .down) { press in
                // Shift-Return falls through to the field's own newline.
                if press.modifiers.contains(.shift) { return .ignored }
                submit()
                // Swallowed rather than ignored even when the send is refused: with
                // an empty draft, or mid-run, Return must not quietly grow the box
                // instead of doing what was asked.
                return .handled
            }
            // `.onKeyPress` rather than a focusable list: the field keeps focus
            // the whole time, so the reader never stops typing the command's
            // name. `.ignored` hands the key straight back to the field, which
            // is what keeps ↑/↓ working normally when no menu is open.
            .onKeyPress(.upArrow) {
                guard let moveHighlight else { return .ignored }
                moveHighlight(-1)
                return .handled
            }
            .onKeyPress(.downArrow) {
                guard let moveHighlight else { return .ignored }
                moveHighlight(1)
                return .handled
            }
            .onKeyPress(.escape) {
                guard let dismissOverlay else { return .ignored }
                dismissOverlay()
                return .handled
            }
            // Cmd-V with an image on the pasteboard.
            //
            // Intercepted rather than left to the field because a `TextField` asked
            // to paste a picture inserts nothing at all — the most common way to
            // share a screenshot would simply have done nothing. Text pastes fall
            // straight through via `.ignored`, so ordinary paste is untouched.
            .onKeyPress(keys: ["v"], phases: .down) { press in
                guard press.modifiers.contains(.command),
                      addAttachment != nil,
                      let attachment = Self.pasteboardImage()
                else { return .ignored }
                addAttachment?(attachment)
                return .handled
            }
            .accessibilityLabel("Message the agent")
            .accessibilityIdentifier("juno.code.composer.field")
        if let focus {
            field.focused(focus)
        } else {
            field
        }
    }
}

// MARK: - The next turn's contract

/// Mode and permission level in one menu, because they answer one question:
/// what may Juno do next?
///
/// They were two controls in two places, and the pair was unanswerable — a
/// session could read "Plan" while its permission mode said workspace write.
/// Ask and Plan are read-only by construction, so the permission picker is
/// disabled rather than hidden: the reader can see the level they will get back
/// when they return to Code.
struct TurnContractMenu: View {
    @Binding var behavior: AgentBehavior
    @Binding var storedPermissionMode: PermissionMode

    init(behavior: Binding<AgentBehavior>, permissionMode: Binding<PermissionMode>) {
        _behavior = behavior
        _storedPermissionMode = permissionMode
    }

    private var permissionMode: PermissionMode {
        behavior == .code ? storedPermissionMode : .readOnly
    }

    /// The at-rest signal that this session can act without asking. Only full
    /// access is tinted: colouring every state trains the reader past it.
    private var tint: Color? {
        permissionMode == .fullAccess ? .junoCaution : nil
    }

    var body: some View {
        Menu {
            ForEach(AgentBehavior.allCases, id: \.self) { mode in
                Button {
                    select(mode)
                } label: {
                    menuItem(
                        AgentBehaviorLabel.text(for: mode),
                        systemImage: AgentBehaviorLabel.glyph(for: mode),
                        selected: behavior == mode
                    )
                }
            }

            Text(AgentBehaviorLabel.explanation(for: behavior))

            Divider()

            ForEach(PermissionMode.allCases, id: \.self) { mode in
                Button {
                    select(mode)
                } label: {
                    menuItem(
                        PermissionModeLabel.text(for: mode),
                        systemImage: PermissionModeLabel.glyph(for: mode),
                        selected: storedPermissionMode == mode
                    )
                }
                .disabled(behavior != .code)
            }

            Text(PermissionModeLabel.explanation(for: permissionMode))
        } label: {
            HStack(spacing: JunoSpace.hairline) {
                Image(systemName: AgentBehaviorLabel.glyph(for: behavior))
                    .imageScale(.small)
                Text(
                    "\(AgentBehaviorLabel.text(for: behavior)) · \(PermissionModeLabel.shortText(for: permissionMode))"
                )
                .lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(tint ?? Color.junoMutedForeground)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("What Juno may do on your next message")
        .accessibilityLabel("Mode and permissions")
        .accessibilityValue(
            "\(AgentBehaviorLabel.text(for: behavior)), \(PermissionModeLabel.text(for: permissionMode))"
        )
        .accessibilityIdentifier("juno.code.composer.mode")
    }

    /// SwiftUI updates a menu's selection binding before AppKit has finished
    /// dismissing the menu window. Permission changes also update the label and
    /// the surrounding composer, which can make SwiftUI try to re-order that
    /// window during layout on current macOS releases. Let AppKit finish the
    /// dismissal first; this keeps the selected value and all of its side
    /// effects intact without racing the menu presentation.
    private func select(_ mode: AgentBehavior) {
        Task { @MainActor in
            await Task.yield()
            behavior = mode
        }
    }

    private func select(_ mode: PermissionMode) {
        Task { @MainActor in
            await Task.yield()
            storedPermissionMode = mode
        }
    }

    @ViewBuilder
    private func menuItem(
        _ title: String,
        systemImage: String,
        selected: Bool
    ) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer(minLength: JunoSpace.regular)
            if selected {
                Image(systemName: "checkmark")
                    .accessibilityHidden(true)
            }
        }
    }
}

/// The model the next turn runs on.
///
/// Changing it used to write the session record and nothing else — the running
/// orchestrator kept the model it was built with for the life of the session, so
/// this control silently did nothing. `SessionController` now rebuilds the
/// orchestrator when the contract changes, which is what makes it real.
///
/// The picker itself is ``JunoModelSelectorButton`` — the same provider rail,
/// search field, capability chips and spec sheet Chat and the website show.
/// This used to be a plain `Menu` of display names, which is how Code ended up
/// looking like a different product from the window next to it.
struct CodeModelSelector: View {
    @Binding var selection: String
    let availableModels: [ModelOption]
    let accessibilityID: String

    var body: some View {
        JunoModelSelectorButton(
            models: availableModels.map(\.descriptor),
            selectedModelID: $selection,
            placeholder: availableModels.isEmpty ? "No model" : "Choose model",
            accessibilityID: accessibilityID
        )
    }
}

/// How much thinking the model does before answering.
///
/// The same slider Chat uses, over exactly the depths the chosen model offers.
/// When the model changes, a depth the new one cannot reach is re-fitted through
/// the same binding the reader writes — the session never keeps sending an
/// effort the model does not support just because the label stopped showing it.
struct CodeThinkingControl: View {
    /// nil is the website's "Instant": no thinking parameter is sent at all.
    @Binding var selection: ReasoningEffort?
    let model: ModelOption?
    let accessibilityID: String

    private var ladder: JunoThinkingLadder {
        model?.thinkingLadder
            ?? .code(efforts: ModelOption.contractReasoningEfforts)
    }

    var body: some View {
        JunoThinkingButton(
            ladder: ladder,
            stopID: Binding(
                // The slider speaks stop ids; the session speaks efforts, with the
                // off state spelled nil. This is the only place the two vocabularies
                // meet, and "instant" is the word for the gap between them.
                get: { selection?.rawValue ?? JunoThinkingLadder.instantStopID },
                set: { stopID in
                    guard let stopID else { return }
                    if stopID == JunoThinkingLadder.instantStopID {
                        selection = nil
                        return
                    }
                    guard let effort = ReasoningEffort(rawValue: stopID) else { return }
                    selection = effort
                }
            ),
            accessibilityID: accessibilityID
        )
        .onChange(of: model) { _, newModel in
            // Re-fit across a model change, in both directions: a depth the new
            // model does not reach clamps down, and Instant on a model that always
            // reasons becomes its shallowest real depth rather than silently
            // sending nothing to a provider that requires a value.
            if let refitted = newModel?.refittingEffort(selection) {
                selection = refitted
            }
        }
    }
}
