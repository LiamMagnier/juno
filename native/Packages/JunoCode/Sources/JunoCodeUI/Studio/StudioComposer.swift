import SwiftUI
import UniformTypeIdentifiers
import JunoCodeCore
import JunoCodeRuntime
import JunoDesignSystem

/// The composer: one field, its attachments, and a single row of controls.
///
/// Shared by the landing screen and every thread, so the first message and
/// the fiftieth are written in the same place with the same keys. The old
/// workbench had four composers; this is the only one.
///
/// Keys: ↩ sends (or ⌘↩, if the reader chose that), ⇧↩ breaks the line, ↑/↓
/// and ↩ drive the `/` and `@` menus, esc closes them, ⌘V pastes a picture,
/// and esc twice in an empty composer opens the rewind picker.
struct StudioComposer<Leading: View, Trailing: View>: View {
    @Binding var text: String
    var placeholder: String
    var attachments: [CodeAttachment] = []
    var addAttachment: ((CodeAttachment) -> Void)?
    var removeAttachment: (UUID) -> Void = { _ in }
    var slashCommands: CodeSlashCommandLibrary = .builtIn
    /// Nil where there is no project to search.
    var searchFiles: ((String) async -> [FileEntry])?
    var chooseFile: (FileEntry) -> Void = { _ in }
    /// Runs a chosen command. Returns false when the host could not run it
    /// now, so a verb's typed argument stays in the field for later instead
    /// of being cleared with nothing to show for it.
    var runCommand: (CodeSlashCommand, _ argument: String) -> Bool = { _, _ in true }
    /// Why a command cannot run right now — `/compact` while Juno works —
    /// shown in its menu row, which is then dimmed and cannot be chosen.
    var commandUnavailableReason: (CodeSlashCommand) -> String? = { _ in nil }
    var canSend: Bool
    var isRunning = false
    var send: () -> Void
    var stop: (() -> Void)?
    /// Esc pressed twice quickly, in an empty composer. Nil where there is
    /// nothing to rewind — the landing screen, or while a run is active.
    var rewind: (() -> Void)?
    var focus: FocusState<Bool>.Binding?
    /// The field's accessibility identifier: the landing's and a thread's
    /// are different controls to a UI test.
    var fieldIdentifier = "juno.code.composer.field"
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    @State private var highlighted = 0
    @State private var fileResults: [FileEntry] = []
    @State private var fileResultsQuery: String?
    @State private var searchingQuery: String?
    @State private var isDropTargeted = false
    @State private var isChoosingImage = false
    @State private var escapes = StudioDoublePress()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var preferences: StudioPreferences { .shared }

    // MARK: Suggestions

    private var slashToken: CodeSlashToken? { CodeSlashToken(composerText: text) }

    private var slashMatches: [CodeSlashCommand] {
        guard let token = slashToken, token.isNamingCommand else { return [] }
        return slashCommands.matches(token.query)
    }

    private var fileToken: CodeFileContextToken? {
        guard searchFiles != nil else { return nil }
        return CodeFileContextToken(composerText: text)
    }

    private var fileQuery: String? {
        guard slashMatches.isEmpty, let query = fileToken?.query, !query.isEmpty else { return nil }
        return query
    }

    private var fileMatches: [FileEntry] {
        guard let query = fileToken?.query, fileResultsQuery == query else { return [] }
        return fileResults
    }

    private var menuCount: Int { slashMatches.isEmpty ? fileMatches.count : slashMatches.count }

    // MARK: Body

    var body: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty {
                attachmentStrip
            }
            field
            controlRow
        }
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.composer, style: .continuous)
                .fill(Studio.Surface.raised)
                .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.composer, style: .continuous)
                .strokeBorder(
                    isDropTargeted ? Studio.Ink.accent : Studio.Surface.hairline,
                    lineWidth: isDropTargeted ? 1.5 : 1
                )
        )
        // Above the composer, never over it. The guide goes on the menu as a
        // whole: set inside the `if` branches it is lost through the
        // conditional, and the list was drawn down over the field being typed in.
        .overlay(alignment: .top) {
            suggestionMenu.alignmentGuide(.top) { $0[.bottom] + JunoSpace.snug }
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted) { providers in
            guard addAttachment != nil else { return false }
            receive(providers)
            return true
        }
        .fileImporter(isPresented: $isChoosingImage, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let attachment = CodeAttachment.load(contentsOf: url) {
                    addAttachment?(attachment)
                }
            }
        }
        .onChange(of: slashToken?.query) { _, _ in highlighted = 0 }
        .task(id: fileQuery) { await search(fileQuery) }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: attachments.count)
    }

    private var field: some View {
        let field = TextField(placeholder, text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .studioReadingFont()
            .lineLimit(1...12)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.cozy + 2)
            .padding(.bottom, JunoSpace.snug)
            .onKeyPress(.return, phases: .down) { press in
                if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
                    return .ignored
                }
                if menuCount > 0 || searchingQuery != nil {
                    choose()
                    return .handled
                }
                if preferences.commandReturnSends, !press.modifiers.contains(.command) {
                    return .ignored
                }
                submit()
                return .handled
            }
            .onKeyPress(.upArrow) {
                guard menuCount > 0 else { return .ignored }
                highlighted = (highlighted - 1 + menuCount) % menuCount
                return .handled
            }
            .onKeyPress(.downArrow) {
                guard menuCount > 0 else { return .ignored }
                highlighted = (highlighted + 1) % menuCount
                return .handled
            }
            .onKeyPress(.escape) {
                if menuCount > 0 {
                    text += " "
                    return .handled
                }
                guard let rewind, text.isEmpty, attachments.isEmpty else {
                    escapes.reset()
                    return .ignored
                }
                guard escapes.press() else {
                    // The first press passes through, so esc keeps meaning
                    // whatever else it means here.
                    return .ignored
                }
                rewind()
                return .handled
            }
            .onKeyPress(keys: ["v"], phases: .down) { press in
                guard press.modifiers.contains(.command),
                      let addAttachment,
                      let attachment = StudioPasteboard.image()
                else { return .ignored }
                addAttachment(attachment)
                return .handled
            }
            .accessibilityLabel("Message Juno")
            .accessibilityIdentifier(fieldIdentifier)
        return Group {
            if let focus { field.focused(focus) } else { field }
        }
    }

    private var controlRow: some View {
        HStack(spacing: JunoSpace.hairline) {
            if addAttachment != nil {
                Menu {
                    Button("Add Images…") { isChoosingImage = true }
                    Button("Paste Image") {
                        if let attachment = StudioPasteboard.image() {
                            addAttachment?(attachment)
                        }
                    }
                    if searchFiles != nil {
                        Button("Mention a File") { text += text.isEmpty || text.hasSuffix(" ") ? "@" : " @" }
                    }
                    Button("Commands") { if text.isEmpty { text = "/" } }
                } label: {
                    JunoIconView(.plus, size: 15)
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(StudioIconButtonStyle())
                .fixedSize()
                .help("Add images, files or commands")
                .accessibilityLabel("Add")
            }
            leading()
            Spacer(minLength: JunoSpace.snug)
            trailing()
            sendButton
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.bottom, JunoSpace.snug)
    }

    @ViewBuilder
    private var sendButton: some View {
        if isRunning, let stop, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, attachments.isEmpty {
            Button(action: stop) {
                RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                    .fill(Studio.Surface.canvas)
                    .frame(width: 9, height: 9)
                    .frame(width: Studio.Metrics.control, height: Studio.Metrics.control)
                    .background(Circle().fill(Studio.Ink.primary))
            }
            .buttonStyle(.plain)
            // ⌘. is the host's Stop command (Session › Stop), not a shortcut on
            // this button: the button gives way to Send once the draft has any
            // text, and the shortcut used to vanish with it.
            .help("Stop (⌘.)")
            .accessibilityLabel("Stop")
            .accessibilityIdentifier("juno.code.composer.stop")
            .transition(.scale(scale: 0.8).combined(with: .opacity))
        } else {
            Button(action: submit) {
                JunoIconView(.arrowUp, size: 14)
                    .foregroundStyle(canSend ? Studio.Surface.canvas : Studio.Ink.tertiary)
                    .frame(width: Studio.Metrics.control, height: Studio.Metrics.control)
                    .background(Circle().fill(canSend ? Studio.Ink.primary : Studio.Surface.muted))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .help(isRunning ? "Send while it works (↩)" : "Send (↩)")
            .accessibilityLabel(isRunning ? "Send while it works" : "Send")
            .accessibilityIdentifier("juno.code.composer.send")
            .transition(.scale(scale: 0.8).combined(with: .opacity))
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: JunoSpace.snug) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let image = NSImage(data: attachment.image.data) {
                                Image(nsImage: image).resizable().scaledToFill()
                            } else {
                                Studio.Surface.muted
                            }
                        }
                        .frame(width: 52, height: 52)
                        .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                                .strokeBorder(Studio.Surface.hairline)
                        )
                        Button { removeAttachment(attachment.id) } label: {
                            JunoIconView(.close, size: 9)
                                .foregroundStyle(Studio.Surface.canvas)
                                .frame(width: 16, height: 16)
                                .background(Circle().fill(Studio.Ink.primary.opacity(0.8)))
                        }
                        .buttonStyle(.plain)
                        .offset(x: 5, y: -5)
                        .accessibilityLabel("Remove \(attachment.name)")
                    }
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.cozy)
        }
    }

    // MARK: Menu

    @ViewBuilder
    private var suggestionMenu: some View {
        if !slashMatches.isEmpty {
            StudioSuggestionList(
                rows: slashMatches.map { command in
                    let unavailable = commandUnavailableReason(command)
                    return .init(
                        id: command.name,
                        title: "/" + command.name,
                        detail: unavailable ?? command.summary,
                        isMono: false,
                        hint: command.argumentHint,
                        isEnabled: unavailable == nil
                    )
                },
                highlighted: min(highlighted, slashMatches.count - 1),
                choose: { index in apply(slashMatches[index]) }
            )
        } else if !fileMatches.isEmpty || searchingQuery != nil {
            StudioSuggestionList(
                rows: fileMatches.map {
                    .init(id: $0.path.value, title: $0.path.value, detail: $0.isDirectory ? "Folder" : nil, isMono: true)
                },
                highlighted: min(highlighted, max(fileMatches.count - 1, 0)),
                isSearching: searchingQuery != nil && fileMatches.isEmpty,
                choose: { index in apply(fileMatches[index]) }
            )
        }
    }

    private func choose() {
        if !slashMatches.isEmpty {
            apply(slashMatches[min(highlighted, slashMatches.count - 1)])
        } else if !fileMatches.isEmpty {
            apply(fileMatches[min(highlighted, fileMatches.count - 1)])
        }
    }

    private func apply(_ command: CodeSlashCommand) {
        // A dimmed row already says why; choosing it does nothing rather
        // than falling through to send the half-typed name as a message.
        guard commandUnavailableReason(command) == nil else { return }
        highlighted = 0
        let argument = slashToken?.argument ?? ""
        if command.action != nil {
            if runCommand(command, argument) { text = "" }
        } else {
            text = command.expanded(argument: argument)
            _ = runCommand(command, argument)
        }
        focus?.wrappedValue = true
    }

    /// Return and the send button both land here. A session verb typed out
    /// by name — `/compact keep the API decisions` — runs as the verb with its
    /// argument, instead of going to the model as a message.
    private func submit() {
        if let typed = slashCommands.typedAction(in: text) {
            if runCommand(typed.command, typed.argument) { text = "" }
            return
        }
        if canSend { send() }
    }

    private func apply(_ entry: FileEntry) {
        guard let token = fileToken else { return }
        text = token.replacing(in: text, withPath: entry.path.value)
        chooseFile(entry)
        highlighted = 0
        fileResults = []
        fileResultsQuery = nil
        focus?.wrappedValue = true
    }

    private func search(_ query: String?) async {
        highlighted = 0
        fileResults = []
        fileResultsQuery = nil
        searchingQuery = query
        guard let query, let searchFiles else {
            searchingQuery = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(120))
        guard !Task.isCancelled else { return }
        let results = await searchFiles(query)
        guard !Task.isCancelled else { return }
        fileResults = CodeFileContextSearch.ranked(results, query: query)
        fileResultsQuery = query
        searchingQuery = nil
    }

    private func receive(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, let attachment = CodeAttachment.load(contentsOf: url) else { return }
                    Task { @MainActor in addAttachment?(attachment) }
                }
                continue
            }
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                guard let data, let attachment = CodeAttachment.pasted(data: data, declaredMediaType: nil) else {
                    return
                }
                Task { @MainActor in addAttachment?(attachment) }
            }
        }
    }
}

/// Two presses of one key, close enough together to be one gesture: Claude
/// Code's Esc Esc.
struct StudioDoublePress {
    /// Quick enough that a single press is never mistaken for the first half
    /// of a pair the reader did not mean.
    var interval: TimeInterval = 0.5
    private var last: Date?

    /// Records a press, and answers whether it completes a pair. A completed
    /// pair starts over, so a third press is the first of the next pair.
    mutating func press(at date: Date = Date()) -> Bool {
        if let last, date.timeIntervalSince(last) < interval {
            self.last = nil
            return true
        }
        last = date
        return false
    }

    mutating func reset() {
        last = nil
    }
}

/// The `/` and `@` menu: a small list above the composer.
struct StudioSuggestionList: View {
    struct Row: Identifiable {
        let id: String
        let title: String
        let detail: String?
        let isMono: Bool
        /// What may follow the title — a verb's argument — set lighter beside it.
        var hint: String?
        var isEnabled = true
    }

    let rows: [Row]
    let highlighted: Int
    var isSearching = false
    let choose: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if isSearching {
                HStack(spacing: JunoSpace.snug) {
                    StudioSpinner().frame(width: 10, height: 10)
                    Text("Searching files…").font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                }
                .padding(JunoSpace.snug)
            }
            ForEach(Array(rows.prefix(8).enumerated()), id: \.element.id) { index, row in
                Button { choose(index) } label: {
                    HStack(spacing: JunoSpace.snug) {
                        Text(row.title)
                            .font(row.isMono ? Studio.Font.mono : Studio.Font.labelEmphasis)
                            .foregroundStyle(row.isEnabled ? Studio.Ink.primary : Studio.Ink.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let hint = row.hint {
                            Text(hint)
                                .font(Studio.Font.label)
                                .foregroundStyle(Studio.Ink.tertiary)
                                .lineLimit(1)
                                .fixedSize()
                        }
                        if let detail = row.detail {
                            Text(detail)
                                .font(Studio.Font.meta)
                                .foregroundStyle(Studio.Ink.tertiary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(height: Studio.Metrics.rowHeight)
                    .background(
                        RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                            .fill(index == highlighted && row.isEnabled ? Studio.Surface.selected : Color.clear)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!row.isEnabled)
                .accessibilityIdentifier("juno.code.composer.suggestion.\(row.id)")
            }
        }
        .padding(JunoSpace.hairline)
        .frame(maxWidth: 520, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .fill(Studio.Surface.raised)
                .shadow(color: .black.opacity(0.10), radius: 16, y: 6)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }
}

// MARK: - Composer chips

/// The mode chip: Plan · Ask · Auto-edit · Full access.
struct StudioModeChip: View {
    let mode: StudioMode
    let select: (StudioMode) -> Void
    var isEnabled = true

    var body: some View {
        Menu {
            ForEach(StudioMode.ladder) { option in
                Button {
                    select(option)
                } label: {
                    Label {
                        VStack(alignment: .leading) {
                            Text(option.title)
                            Text(option.detail)
                        }
                    } icon: {
                        JunoIconView(option.icon, size: 14)
                    }
                }
                .modifier(StudioModeShortcut(mode: option))
            }
        } label: {
            StudioChipLabel(
                title: mode.shortTitle,
                icon: mode.icon,
                emphasis: mode == .fullAccess ? Studio.Ink.primary : nil
            )
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .fixedSize()
        .disabled(!isEnabled)
        .help("\(mode.title): \(mode.detail)")
        .accessibilityLabel("Mode")
        .accessibilityValue(mode.title)
        .accessibilityIdentifier("juno.code.composer.mode")
    }
}

private struct StudioModeShortcut: ViewModifier {
    let mode: StudioMode

    func body(content: Content) -> some View {
        if let digit = mode.shortcutDigit {
            content.keyboardShortcut(KeyEquivalent(digit), modifiers: [.command, .option])
        } else {
            content
        }
    }
}

/// The model and thinking depth, as one chip opening the same selector Chat
/// uses — one model picker across the whole app.
struct StudioModelChip: View {
    let models: [ModelOption]
    let modelID: String
    let effort: ReasoningEffort?
    let selectModel: (String) -> Void
    let selectEffort: (ReasoningEffort?) -> Void
    var isEnabled = true

    @State private var modelPresented = false
    @State private var effortPresented = false

    private var selected: ModelOption? { models.first { $0.modelID == modelID } }

    private var name: String {
        selected?.descriptor.displayName ?? (modelID.isEmpty ? "Choose model" : Self.readable(modelID))
    }

    /// "anthropic:claude-sonnet-5" → "Claude Sonnet 5", for a model the
    /// catalog has not described (yet).
    static func readable(_ id: String) -> String {
        let bare = id.split(separator: ":").last.map(String.init) ?? id
        return bare
            .split(separator: "-")
            .map { word in word.first.map { $0.uppercased() + word.dropFirst() } ?? "" }
            .joined(separator: " ")
    }

    private var ladder: JunoThinkingLadder {
        selected?.thinkingLadder ?? .code(efforts: ModelOption.contractReasoningEfforts)
    }

    private var stopID: Binding<String?> {
        Binding(
            get: { effort?.rawValue ?? JunoThinkingLadder.instantStopID },
            set: { value in
                guard let value else { return }
                if value == JunoThinkingLadder.instantStopID {
                    selectEffort(nil)
                } else if let effort = ReasoningEffort(rawValue: value) {
                    selectEffort(effort)
                }
            }
        )
    }

    var body: some View {
        HStack(spacing: 0) {
            Button { modelPresented = true } label: {
                StudioChipLabel(title: name, showsChevron: false)
            }
            .buttonStyle(.plain)
            .disabled(!isEnabled || models.isEmpty)
            .help("Model (⇧⌘M)")
            .keyboardShortcut("m", modifiers: [.command, .shift])
            .accessibilityLabel("Model")
            .accessibilityValue(name)
            .accessibilityIdentifier("juno.code.composer.model")
            .popover(isPresented: $modelPresented, arrowEdge: .bottom) {
                JunoModelSelector(
                    models: models.map(\.descriptor),
                    selectedModelID: modelID,
                    metrics: .standard,
                    select: { model in
                        modelPresented = false
                        selectModel(model.id)
                    }
                )
                .frame(
                    width: JunoModelSelectorMetrics.standard.width,
                    height: JunoModelSelectorMetrics.standard.height
                )
            }

            if ladder.isAdjustable {
                Button { effortPresented = true } label: {
                    StudioChipLabel(
                        title: ladder.isAutomatic ? "Auto" : ladder.label(for: stopID.wrappedValue),
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
                .disabled(!isEnabled)
                .help("Thinking depth (⇧⌘E)")
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .accessibilityLabel("Thinking")
                .popover(isPresented: $effortPresented, arrowEdge: .bottom) {
                    JunoThinkingPanel(ladder: ladder, stopID: stopID)
                        .frame(
                            width: JunoThinkingMetrics.width,
                            height: JunoThinkingMetrics.height(caption: ladder.caption != nil, modeToggles: false)
                        )
                }
            }
        }
        .fixedSize()
    }
}

/// A small ring that fills as the context window does. Quiet until it matters.
struct StudioContextMeter: View {
    let used: Int
    let window: Int
    /// What the session's calls have been billed for since it was opened,
    /// compaction summaries included.
    var spent: ModelUsageTotals?

    private var fraction: Double { min(1, Double(used) / Double(max(window, 1))) }

    private var help: String {
        let context = "Context: \(StudioFormat.tokens(used)) of \(StudioFormat.tokens(window)) tokens (\(Int(fraction * 100))%)"
        guard let spent, spent.requests > 0 else { return context }
        return context
            + "\nSince opening: \(StudioFormat.tokens(spent.inputTokens)) in, "
            + "\(StudioFormat.tokens(spent.outputTokens)) out over \(StudioFormat.plural(spent.requests, "request"))"
    }

    var body: some View {
        ZStack {
            Circle().stroke(Studio.Surface.hairline, lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(
                    fraction > 0.8 ? Studio.Ink.accent : Studio.Ink.tertiary,
                    style: StrokeStyle(lineWidth: 2, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 14, height: 14)
        .frame(width: Studio.Metrics.control, height: Studio.Metrics.control)
        .help(help)
        .accessibilityLabel("Context used")
        .accessibilityValue("\(Int(fraction * 100)) percent")
    }
}

/// Reads a picture off the general pasteboard for the composer.
enum StudioPasteboard {
    /// The image currently on the general pasteboard, if there is one.
    ///
    /// Reads the declared type so a copied PNG stays a PNG rather than being
    /// re-encoded; `CodeAttachment` transcodes only what the providers reject.
    static func image() -> CodeAttachment? {
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
}
