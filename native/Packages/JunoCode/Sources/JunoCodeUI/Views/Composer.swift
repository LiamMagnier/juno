import SwiftUI
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
            "Edits and commands proceed. Destructive and networked actions still ask."
        }
    }
}

public enum AgentBehaviorLabel {
    public static func text(for behavior: AgentBehavior) -> String {
        switch behavior {
        case .ask: "Ask"
        case .plan: "Plan"
        case .code: "Code"
        }
    }

    public static func glyph(for behavior: AgentBehavior) -> String {
        switch behavior {
        case .ask: "questionmark.bubble"
        case .plan: "list.bullet.rectangle"
        case .code: "hammer"
        }
    }

    public static func explanation(for behavior: AgentBehavior) -> String {
        switch behavior {
        case .ask: "Answer questions about this project using inspection tools only."
        case .plan: "Investigate, then write an implementation plan. Nothing is changed."
        case .code: "Carry the task through, with edits checkpointed and gated."
        }
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

    /// Which row the arrow keys are on. Reset every time the query changes, so
    /// the highlight cannot point past the end of a narrowed list.
    @State private var highlightedCommand = 0
    @State private var highlightedFile = 0
    @State private var fileResults: [FileEntry] = []
    @State private var fileResultsQuery: String?
    @State private var searchingFileQuery: String?

    public init(
        controller: SessionController,
        availableModels: [ModelOption],
        focus: FocusState<Bool>.Binding? = nil,
        slashCommands: CodeSlashCommandLibrary = .builtIn
    ) {
        self.controller = controller
        self.availableModels = availableModels
        self.focus = focus
        self.slashCommands = slashCommands
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
        !controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
            dismissOverlay: dismissHandler
        ) {
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

            Rectangle()
                .fill(Color.junoHairline)
                .frame(width: 1, height: 18)
                .padding(.horizontal, 1)
                .accessibilityHidden(true)

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
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.junoOnAccent)
                        .frame(width: 26, height: 26)
                }
                .accentGlassAction(active: canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
                .help("Send (⌘⏎)")
                .accessibilityLabel("Send")
                .accessibilityIdentifier("juno.code.composer.send")
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
    @ViewBuilder var controls: () -> Controls

    init(
        prompt: String,
        text: Binding<String>,
        focus: FocusState<Bool>.Binding? = nil,
        submit: @escaping () -> Void,
        moveHighlight: ((Int) -> Void)? = nil,
        dismissOverlay: (() -> Void)? = nil,
        @ViewBuilder controls: @escaping () -> Controls
    ) {
        self.prompt = prompt
        _text = text
        self.focus = focus
        self.submit = submit
        self.moveHighlight = moveHighlight
        self.dismissOverlay = dismissOverlay
        self.controls = controls
    }

    var body: some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            VStack(spacing: JunoSpace.snug) {
                textField
                HStack(spacing: JunoSpace.tight) {
                    controls()
                }
            }
            .padding(JunoSpace.snug)
            .junoFloatingChrome(cornerRadius: JunoCornerRadius.composer)
        }
    }

    @ViewBuilder
    private var textField: some View {
        let field = TextField(prompt, text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...10)
            .font(.body)
            .padding(.horizontal, JunoSpace.tight)
            .padding(.top, JunoSpace.hairline)
            .onSubmit(submit)
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
            Picker("Mode", selection: $behavior) {
                ForEach(AgentBehavior.allCases, id: \.self) { mode in
                    Label(
                        AgentBehaviorLabel.text(for: mode),
                        systemImage: AgentBehaviorLabel.glyph(for: mode)
                    )
                    .tag(mode)
                }
            }
            .pickerStyle(.inline)

            Text(AgentBehaviorLabel.explanation(for: behavior))

            Divider()

            Picker("Permissions", selection: $storedPermissionMode) {
                ForEach(PermissionMode.allCases, id: \.self) { mode in
                    Label(
                        PermissionModeLabel.text(for: mode),
                        systemImage: PermissionModeLabel.glyph(for: mode)
                    )
                    .tag(mode)
                }
            }
            .pickerStyle(.inline)
            .disabled(behavior != .code)

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
            .foregroundStyle(tint ?? .secondary)
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
    @Binding var selection: ReasoningEffort
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
                get: { selection.rawValue },
                set: { stopID in
                    guard
                        let stopID,
                        let effort = ReasoningEffort(rawValue: stopID)
                    else { return }
                    selection = effort
                }
            ),
            accessibilityID: accessibilityID
        )
        .onChange(of: model) { _, newModel in
            if let clamped = newModel?.clampingReasoningEffort(selection) {
                selection = clamped
            }
        }
    }
}
