// Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
// (the composer's quiet-at-rest anatomy, the context strip that hangs under
// it, and the approval panel that takes over its body).
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - The + menu

/// Everything that is not on the composer at rest (code-v4 TARGET §7.1):
/// the team editor and computer use. Lives in the composer's `+` menu, after
/// the attach items the composer owns. The mode (Ask, Accept edits, Auto,
/// Plan, Full access) is on the row itself, as ``CodeV2ModeControl``.
struct CodeV2PlusMenuItems: View {
    @Bindable var model: CodeV2ComposerModel
    let directory: CodeV2ProviderDirectory
    var computerUse: Binding<Bool>?

    var body: some View {
        // Team lane: the role editor, also on the composer's Team chip (⇧⌘O).
        Button("Team…") { model.teamEditorRequested = true }
        if let computerUse {
            Toggle("Computer Use", isOn: computerUse)
        }
    }

}

/// Permission names as the menu and the composer say them.
enum CodeV2PermissionCopy {
    /// The default; shown nowhere at rest.
    static let defaultMode: CodeV2.RuntimeMode = .autoEdit

    static func title(_ mode: CodeV2.RuntimeMode) -> String {
        switch mode {
        case .ask: "Ask first"
        default: mode.title
        }
    }
}

// MARK: - Leading: the model trigger and what is not on its default

/// The composer's left side after `+` (TARGET §7.1): the model trigger (mark,
/// model, effort), the Team chip (always), the mode (always on the row, as
/// on the web), then only the controls whose setting is not the default:
/// `Computer` while computer use is on. Used by both engines.
struct CodeV2ComposerLeading: View {
    @Bindable var model: CodeV2ComposerModel
    let directory: CodeV2ProviderDirectory
    var isEnabled = true
    var threadTokens: Int = 0
    var computerUse: Binding<Bool>?
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?
    /// Skills lane: the thread's skills, on the row after the mode.
    var skills: CodeSkillsModel?

    private var instance: CodeV2.ProviderInstance? { directory.instance(model.selection.instanceId) }
    private var modes: [CodeV2.RuntimeMode] {
        let allowed = instance?.capabilities?.approvals ?? []
        return allowed.isEmpty ? CodeV2.RuntimeMode.allCases : allowed
    }
    private var planMode: Bool { instance?.capabilities?.planMode ?? true }
    private var composerModes: [CodeComposerMode] {
        CodeComposerMode.available(approvals: modes, planMode: planMode)
    }

    var body: some View {
        CodeV2ModelControl(
            directory: directory, selection: $model.selection, lean: $model.lean,
            threadTokens: threadTokens, isEnabled: isEnabled,
            openConnections: openConnections, setup: setup,
            choose: { id, choice in model.choose(instanceId: id, model: choice) }
        )
        // Team lane: always on the composer, Solo or not.
        CodeV2TeamChip(model: model, directory: directory, isEnabled: isEnabled)
        CodeV2ModeControl(model: model, modes: composerModes, isEnabled: isEnabled)
        if let skills {
            CodeSkillsChip(skills: skills, isEnabled: isEnabled)
        }
        if let computerUse, computerUse.wrappedValue {
            Menu {
                Button("Turn Off Computer Use") { computerUse.wrappedValue = false }
            } label: {
                CodeV2TextControlLabel(title: "Computer")
            }
            .menuStyle(.button).menuIndicator(.hidden)
            .buttonStyle(CodeV2FooterButtonStyle()).fixedSize()
            .help("Alevr may use apps on this Mac. Esc stops it.")
            .accessibilityLabel("Computer use")
                .contentShape(.rect)
        }
        // ⇧⌘A cycles the mode, as on the web. ⇧⌘E opens the model
        // control's effort panel.
        Color.clear.frame(width: 0, height: 0)
            .background {
                Button("") { model.cycleComposerMode(approvals: modes, planMode: planMode) }
                    .keyboardShortcut("a", modifiers: [.command, .shift])
                    .hidden()
                    .contentShape(.rect)
            }
            .accessibilityHidden(true)
    }
}

/// The mode, always on the composer's row: Ask, Accept edits, Auto, Plan or
/// Full access, each with its one line, the same five as the web. ⇧⌘A cycles
/// it (``CodeV2ComposerLeading``).
struct CodeV2ModeControl: View {
    @Bindable var model: CodeV2ComposerModel
    let modes: [CodeComposerMode]
    var isEnabled = true

    var body: some View {
        let current = model.composerMode
        Menu {
            Picker("Mode", selection: Binding(get: { model.composerMode }, set: { model.composerMode = $0 })) {
                ForEach(modes) { mode in
                    VStack(alignment: .leading) {
                        Text(mode.title)
                        Text(mode.detail)
                    }
                    .tag(mode)
                }
                if !modes.contains(current) {
                    Text(current.title).tag(current)
                }
            }
            .pickerStyle(.inline)
            Divider()
            Text("\u{21E7}\u{2318}A cycles the mode")
        } label: {
            CodeV2TextControlLabel(title: current.title, icon: current.icon)
        }
        .menuStyle(.button).menuIndicator(.hidden)
        .buttonStyle(CodeV2FooterButtonStyle()).fixedSize()
        .disabled(!isEnabled)
        .help("\(current.detail) \u{21E7}\u{2318}A cycles the mode.")
        .accessibilityLabel("Mode")
        .accessibilityValue(current.title)
        .accessibilityIdentifier("juno.code.composer.mode")
        .contentShape(.rect)
    }
}

/// A text control's face: an optional glyph, the words, a small chevron.
struct CodeV2TextControlLabel: View {
    let title: String
    var detail: String?
    var icon: JunoIcon?

    var body: some View {
        HStack(spacing: JunoSpace.tight + 1) {
            if let icon { JunoIconView(icon, size: 14) }
            Text(title).lineLimit(1)
            if let detail {
                Text(detail).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
            }
            JunoIconView(.chevronDown, size: 10).foregroundStyle(Studio.Ink.tertiary)
        }
    }
}

// MARK: - Trailing: context ring, queued follow-ups

/// The composer's right side before the mic and send: the context ring once
/// the thread has used more than 60% of its window, and `Queued (n)` while
/// follow-ups wait (TARGET §7.1, §7.3).
struct CodeV2ComposerTrailing: View {
    var context: CodeV2ContextReading?
    var compact: (() -> Void)?
    var queue: [CodeV2.QueuedInput] = []
    var editQueued: ((CodeV2.QueuedInput) -> Void)?
    var steerQueued: ((CodeV2.QueuedInput) -> Void)?
    var removeQueued: ((CodeV2.QueuedInput) -> Void)?

    var body: some View {
        if !queue.isEmpty {
            CodeV2QueuedMenu(queue: queue, edit: editQueued, steer: steerQueued, remove: removeQueued)
        }
        if let context, context.fraction > 0.6 {
            CodeV2ContextGauge(reading: context, compact: compact)
        }
    }
}

/// `Queued (2) ⌄`: the follow-ups that wait for the run, each with Edit,
/// Steer now and Remove. Replaces the bar that used to sit above the composer.
struct CodeV2QueuedMenu: View {
    let queue: [CodeV2.QueuedInput]
    var edit: ((CodeV2.QueuedInput) -> Void)?
    var steer: ((CodeV2.QueuedInput) -> Void)?
    var remove: ((CodeV2.QueuedInput) -> Void)?

    var body: some View {
        Menu {
            ForEach(queue, id: \.id) { item in
                Menu(item.input.text) {
                    if let steer { Button("Steer Now") { steer(item) } }
                    if let edit { Button("Edit") { edit(item) } }
                    if let remove { Button("Remove", role: .destructive) { remove(item) } }
                }
            }
        } label: {
            CodeV2TextControlLabel(title: "Queued (\(queue.count))")
        }
        .menuStyle(.button).menuIndicator(.hidden)
        .buttonStyle(CodeV2FooterButtonStyle()).fixedSize()
        .help("Follow-ups that send when the run finishes. ⌘↩ steers now.")
        .accessibilityLabel("Queued follow-ups")
        .accessibilityValue("\(queue.count)")
            .contentShape(.rect)
    }
}

// MARK: - Context strip

/// Where a session runs: its project, branch and machine, and what choosing
/// each one again does. Shown in the strip under the composer.
public struct CodeV2SessionPlace {
    public var project: String
    public var branch: String?
    public var machine: String
    public var pullRequest: Int?
    public var projectMenu: [(String, () -> Void)]
    public var branchMenu: [(String, () -> Void)]
    public var machineMenu: [(String, () -> Void)]

    public init(
        project: String, branch: String? = nil, machine: String = "This Mac", pullRequest: Int? = nil,
        projectMenu: [(String, () -> Void)] = [], branchMenu: [(String, () -> Void)] = [],
        machineMenu: [(String, () -> Void)] = []
    ) {
        self.project = project
        self.branch = branch
        self.machine = machine
        self.pullRequest = pullRequest
        self.projectMenu = projectMenu
        self.branchMenu = branchMenu
        self.machineMenu = machineMenu
    }
}

/// Where the session runs, hanging under the composer like a drawer (TARGET
/// §7.1): project and branch at the left, the machine at the right, all 12pt
/// muted. Inset 22 from the composer's sides so it reads as part of it.
public struct CodeV2ContextStrip: View {
    public struct Item: Identifiable {
        public var id: String { title }
        public var title: String
        public var icon: JunoIcon?
        public var menu: [(String, () -> Void)]

        public init(title: String, icon: JunoIcon? = nil, menu: [(String, () -> Void)] = []) {
            self.title = title
            self.icon = icon
            self.menu = menu
        }
    }

    let leading: [Item]
    let trailing: [Item]

    public init(leading: [Item], trailing: [Item] = []) {
        self.leading = leading
        self.trailing = trailing
    }

    public init(place: CodeV2SessionPlace) {
        var leading = [Item(title: place.project, icon: .projects, menu: place.projectMenu)]
        if let branch = place.branch { leading.append(Item(title: branch, icon: .branch, menu: place.branchMenu)) }
        var trailing: [Item] = []
        if let pr = place.pullRequest { trailing.append(Item(title: "#\(pr)", icon: .pulls)) }
        trailing.append(Item(title: place.machine, icon: .device, menu: place.machineMenu))
        self.init(leading: leading, trailing: trailing)
    }

    public var body: some View {
        HStack(spacing: JunoSpace.tight) {
            ForEach(leading) { item in control(item) }
            Spacer(minLength: JunoSpace.snug)
            ForEach(trailing) { item in control(item) }
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 32)
        .background(
            UnevenRoundedRectangle(
                cornerRadii: .init(topLeading: 0, bottomLeading: 16, bottomTrailing: 16, topTrailing: 0),
                style: .continuous
            )
            .fill(Studio.Surface.muted)
        )
        .overlay(
            UnevenRoundedRectangle(
                cornerRadii: .init(topLeading: 0, bottomLeading: 16, bottomTrailing: 16, topTrailing: 0),
                style: .continuous
            )
            .strokeBorder(Studio.Surface.hairline)
            .mask(Rectangle().padding(.top, 1))
        )
        .padding(.horizontal, 22)
    }

    @ViewBuilder
    private func control(_ item: Item) -> some View {
        let label = HStack(spacing: JunoSpace.tight) {
            if let icon = item.icon { JunoIconView(icon, size: 12) }
            Text(item.title).lineLimit(1).truncationMode(.middle)
            if !item.menu.isEmpty { JunoIconView(.chevronDown, size: 9) }
        }
        .studioType(.small)
        .foregroundStyle(Studio.Ink.secondary)
        if item.menu.isEmpty {
            label.padding(.horizontal, JunoSpace.tight)
        } else {
            Menu {
                ForEach(Array(item.menu.enumerated()), id: \.offset) { _, entry in
                    Button(entry.0, action: entry.1)
                }
            } label: { label }
                .menuStyle(.button).menuIndicator(.hidden)
                .buttonStyle(CodeV2FooterButtonStyle(compact: true)).fixedSize()
                .contentShape(.rect)
        }
    }
}

// MARK: - Takeover

/// An approval that has taken over the composer (TARGET §7.4): who wants
/// what in the signal ink, `1 of 2`, the command in a mono well, the reason
/// on one line, and Deny · Allow for session · Allow once as stock buttons.
struct CodeV2ApprovalTakeover: View {
    let request: CodeV2.ApprovalRequest
    var position: (index: Int, count: Int) = (1, 1)
    var respond: (CodeV2.ApprovalDecision) -> Void
    var showDiff: (() -> Void)?
    var move: ((Int) -> Void)?

    @State private var showsReason = false

    private var who: String { request.detail ?? "The agent" }

    private var headline: String {
        switch request.action {
        case .command: "\(who) wants to run a command"
        case .fileChange: "\(who) wants to edit files"
        case .computer: "\(who) wants to use the computer"
        case .permissions: "\(who) wants to write outside the workspace"
        case .tool: "\(who) wants to use a tool"
        }
    }

    private var options: [CodeV2.ApprovalDecision] { request.options ?? [.accept, .acceptForSession, .decline] }

    var body: some View {
        CodeV2TakeoverPanel(
            title: headline,
            counter: position.count > 1 ? "\(position.index) of \(position.count)" : nil,
            needsYou: true
        ) {
            if request.action == .fileChange {
                Text(request.summary)
                    .studioType(.text)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(2)
            } else {
                CodeV2CommandWell(text: request.summary)
            }
            if let reason = request.justification {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    Text(reason)
                        .studioType(.small)
                        .foregroundStyle(Studio.Ink.secondary)
                        .lineLimit(showsReason ? nil : 1)
                        .fixedSize(horizontal: false, vertical: showsReason)
                    if !showsReason {
                        Button("More") { showsReason = true }
                            .buttonStyle(.plain)
                            .studioType(.small)
                            .foregroundStyle(Studio.Ink.primary)
                            .underline(color: Studio.Ink.tertiary)
                            .contentShape(.rect)
                    }
                }
            }
        } actions: {
            if options.contains(.cancel) {
                Menu {
                    Button("Deny and Stop") { respond(.cancel) }
                } label: { JunoIconView(.ellipsis, size: 14) }
                    .menuStyle(.button).menuIndicator(.hidden)
                    .buttonStyle(StudioIconButtonStyle()).fixedSize()
                    .help("More").accessibilityLabel("More")
                    .contentShape(.rect)
            }
            Spacer(minLength: 0)
            if options.contains(.decline) {
                Button("Deny") { respond(.decline) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .help("Deny (Esc)")
                    .contentShape(.rect)
            }
            if request.action == .fileChange, let showDiff {
                Button("Review", action: showDiff).buttonStyle(.bordered)
                    .contentShape(.rect)
            } else if options.contains(.acceptForSession) {
                Button("Allow for Session") { respond(.acceptForSession) }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.return, modifiers: [.command, .shift])
                    .help("Allow for this session (⇧⌘↩)")
                    .contentShape(.rect)
            }
            if options.contains(.accept) {
                Button(request.action == .fileChange ? "Allow" : "Allow Once") { respond(.accept) }
                    .buttonStyle(CodeV2InkButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .help("Allow once (↩)")
                    .contentShape(.rect)
            }
        }
        .onKeyPress(.leftArrow) { move?(-1); return move == nil ? .ignored : .handled }
        .onKeyPress(.rightArrow) { move?(1); return move == nil ? .ignored : .handled }
    }
}

/// The takeover's shape, shared by approvals, questions, plan approval and
/// the Limited notice: a 14/500 title (signal ink only when it needs you),
/// an optional counter, the body, and a row of stock buttons.
struct CodeV2TakeoverPanel<Content: View, Actions: View>: View {
    let title: String
    var counter: String?
    var needsYou: Bool
    @ViewBuilder var content: () -> Content
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug + 2) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(title)
                    .studioType(.textMedium)
                    .foregroundStyle(needsYou ? Studio.Signal.ink : Studio.Ink.primary)
                    .lineLimit(2)
                Spacer(minLength: JunoSpace.snug)
                if let counter {
                    Text(counter).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary)
                }
            }
            content()
            HStack(spacing: JunoSpace.snug) {
                actions()
            }
            .controlSize(.regular)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.cozy + 2)
        .padding(.bottom, JunoSpace.cozy)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}

/// A command in a quiet well: 12.5 mono, at most three lines.
struct CodeV2CommandWell: View {
    let text: String

    var body: some View {
        Text(text)
            .studioType(.code)
            .foregroundStyle(Studio.Ink.primary)
            .lineLimit(3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .background(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous).fill(Studio.Surface.muted))
    }
}

/// A question from the agent: the question is the title, its options are
/// buttons, and a free answer is typed in place.
struct CodeV2QuestionTakeover: View {
    let request: CodeV2.UserInputRequest
    var answer: ([String: [String]]) -> Void
    @State private var chosen: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]

    private var title: String {
        request.questions.count == 1 ? request.questions[0].prompt : "The agent has \(request.questions.count) questions"
    }

    var body: some View {
        CodeV2TakeoverPanel(title: title, needsYou: true) {
            ForEach(request.questions, id: \.id) { question in
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    if request.questions.count > 1 {
                        Text(question.prompt).studioType(.text).foregroundStyle(Studio.Ink.primary)
                    }
                    if let options = question.options, !options.isEmpty {
                        HStack(spacing: JunoSpace.snug) {
                            ForEach(options, id: \.self) { option in
                                let on = chosen[question.id, default: []].contains(option)
                                Button(option) {
                                    var set = question.multiSelect == true ? chosen[question.id, default: []] : []
                                    if on { set.remove(option) } else { set.insert(option) }
                                    chosen[question.id] = set
                                }
                                .buttonStyle(CodeV2ChoiceButtonStyle(isOn: on))
                                    .contentShape(.rect)
                            }
                        }
                    } else {
                        TextField("Your answer", text: Binding(get: { typed[question.id] ?? "" }, set: { typed[question.id] = $0 }))
                            .textFieldStyle(.plain)
                            .studioType(.text)
                    }
                }
            }
        } actions: {
            Spacer(minLength: 0)
            Button("Answer") {
                var answers: [String: [String]] = [:]
                for question in request.questions {
                    if let text = typed[question.id], !text.isEmpty { answers[question.id] = [text] }
                    else { answers[question.id] = Array(chosen[question.id, default: []]) }
                }
                answer(answers)
            }
            .buttonStyle(CodeV2InkButtonStyle())
            .keyboardShortcut(.defaultAction)
                .contentShape(.rect)
        }
    }
}

/// An option in a question: a hairline button that fills when chosen.
struct CodeV2ChoiceButtonStyle: ButtonStyle {
    var isOn: Bool
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .studioType(.text)
            .foregroundStyle(Studio.Ink.primary)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: 28)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(isOn ? Studio.Surface.selected : (hovering || configuration.isPressed ? Studio.Surface.hover : Color.clear))
            )
            .overlay(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous).strokeBorder(Studio.Surface.hairline))
            .contentShape(.rect)
            .onHover { hovering = $0 }
    }
}

/// The Limited state (TARGET §12): the plan's limit in the foreground ink,
/// not coral, with Switch to Alevr and Wait.
struct CodeV2LimitedNotice: View {
    let sentence: String
    var resumeAtReset: (() -> Void)?
    var switchModel: (() -> Void)?

    var body: some View {
        CodeV2TakeoverPanel(title: sentence, needsYou: false) {
            EmptyView()
        } actions: {
            Spacer(minLength: 0)
            if let resumeAtReset {
                Button("Wait", action: resumeAtReset)
                    .buttonStyle(.bordered)
                    .help("Continue when the plan window resets")
                    .contentShape(.rect)
            }
            if let switchModel {
                Button("Switch to Alevr", action: switchModel)
                    .buttonStyle(CodeV2InkButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .contentShape(.rect)
            }
        }
    }
}
