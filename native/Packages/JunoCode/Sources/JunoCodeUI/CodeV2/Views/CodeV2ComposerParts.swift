import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - Footer controls

/// The runtime mode control: a lock glyph and "Auto-edit". The modes are
/// sandbox × approval presets (SPEC §3.7); a runtime that declares fewer
/// modes offers only those. ⇧⌘A cycles.
struct CodeV2ModeControl: View {
    @Binding var mode: CodeV2.RuntimeMode
    @Binding var interaction: CodeV2.InteractionMode
    var allowed: [CodeV2.RuntimeMode] = CodeV2.RuntimeMode.allCases
    var supportsPlan = true
    var isEnabled = true

    private var modes: [CodeV2.RuntimeMode] { allowed.isEmpty ? CodeV2.RuntimeMode.allCases : allowed }

    var body: some View {
        Menu {
            Picker("Permissions", selection: $mode) {
                ForEach(modes, id: \.self) { option in
                    Text("\(option.title)  ·  \(option.summary)").tag(option)
                }
            }
            .pickerStyle(.inline)
            if supportsPlan {
                Divider()
                Toggle("Plan first", isOn: Binding(get: { interaction == .plan }, set: { interaction = $0 ? .plan : .default }))
            }
        } label: {
            HStack(spacing: JunoSpace.tight + 1) {
                JunoIconView(mode == .full ? .lockOpen : .lock, size: 14)
                Text(interaction == .plan ? "Plan · \(mode.title)" : mode.title).lineLimit(1)
                JunoIconView(.chevronDown, size: 11)
            }
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(CodeV2FooterButtonStyle()).contentShape(.rect)
        .fixedSize()
        .disabled(!isEnabled)
        .help("Permissions: what the agent may do without asking (⇧⌘A)")
        .accessibilityLabel("Permissions")
        .accessibilityValue(mode.title)
        .background {
            Button("") {
                let index = modes.firstIndex(of: mode) ?? -1
                mode = modes[(index + 1) % modes.count]
            }
            .keyboardShortcut("a", modifiers: [.command, .shift])
            .hidden()
        }
    }
}

/// Everything on the composer's footer that is Code v2's (DESIGN §5.6):
/// mode and orchestrate on the left; model, traits and the context gauge on
/// the right. Used by both engines, so a thread on Alevr and a thread on a
/// subscription are driven from the same controls.
struct CodeV2ComposerLeading: View {
    @Bindable var model: CodeV2ComposerModel
    let directory: CodeV2ProviderDirectory
    var isEnabled = true

    private var capabilities: CodeV2.ProviderCapabilities? { directory.instance(model.selection.instanceId)?.capabilities }

    var body: some View {
        CodeV2ModeControl(
            mode: $model.runtimeMode,
            interaction: $model.interactionMode,
            allowed: capabilities?.approvals ?? CodeV2.RuntimeMode.allCases,
            supportsPlan: capabilities?.planMode ?? true,
            isEnabled: isEnabled
        )
        CodeV2OrchestrateControl(directory: directory, draft: $model.roles, isEnabled: isEnabled)
    }
}

struct CodeV2ComposerTrailing: View {
    @Bindable var model: CodeV2ComposerModel
    let directory: CodeV2ProviderDirectory
    var context: CodeV2ContextReading?
    var threadTokens: Int = 0
    var isEnabled = true
    var compact: (() -> Void)?
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?

    private var instance: CodeV2.ProviderInstance? { directory.instance(model.selection.instanceId) }
    private var providerModel: CodeV2.ProviderModel? { instance?.models?.first { $0.id == model.selection.model } }

    var body: some View {
        CodeV2ModelControl(
            directory: directory, selection: $model.selection, threadTokens: threadTokens, isEnabled: isEnabled,
            openConnections: openConnections, setup: setup,
            choose: { id, choice in model.choose(instanceId: id, model: choice) }
        )
        CodeV2TraitsControl(
            instance: instance, model: providerModel, selection: $model.selection, lean: $model.lean,
            threadTokens: threadTokens, isEnabled: isEnabled
        )
        if let context {
            CodeV2ContextGauge(reading: context, compact: compact)
        }
    }
}

// MARK: - Queue dock

/// Above the composer while follow-ups wait (DESIGN §5.5): up to three rows,
/// each with Edit and "Steer now ⌘↵", then "+2 more".
struct CodeV2QueueDock: View {
    let queue: [CodeV2.QueuedInput]
    var edit: (CodeV2.QueuedInput) -> Void = { _ in }
    var steer: ((CodeV2.QueuedInput) -> Void)?

    var body: some View {
        let model = CodeV2QueueDockModel(items: queue)
        VStack(spacing: 0) {
            ForEach(model.visible) { item in
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.cornerDownRight, size: 14).foregroundStyle(Studio.Ink.secondary)
                    Text(item.input.text).font(Studio.Font.label).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                    Spacer(minLength: JunoSpace.snug)
                    Button { edit(item) } label: { JunoIconView(.pencil, size: 13) }
                        .buttonStyle(StudioIconButtonStyle()).contentShape(.rect)
                        .help("Edit (⌥↑ for the last one)")
                        .accessibilityLabel("Edit queued message")
                    if let steer {
                        Button { steer(item) } label: {
                            HStack(spacing: JunoSpace.tight) { Text("Steer now"); CodeV2Keycap(keys: "⌘↵") }
                        }
                        .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                    }
                }
                .padding(.horizontal, JunoSpace.snug)
                .frame(minHeight: 32)
            }
            if let more = model.overflowLabel {
                Text(more).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, JunoSpace.snug).frame(height: 24)
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous).fill(Studio.Surface.muted))
        .overlay(RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous).strokeBorder(Studio.Surface.hairline))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Queued follow-ups")
    }
}

// MARK: - Takeover

/// The approval or question that has taken over the composer (DESIGN
/// §5.14): who wants what, the payload in a mono well, the model's reason,
/// and Deny · Allow for this session · Allow once.
struct CodeV2ApprovalTakeover: View {
    let request: CodeV2.ApprovalRequest
    var position: (index: Int, count: Int) = (1, 1)
    var respond: (CodeV2.ApprovalDecision) -> Void
    var showDiff: (() -> Void)?
    var move: ((Int) -> Void)?

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
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.hand, size: 18).foregroundStyle(Studio.Signal.edge)
                Text(headline).font(Studio.Font.labelEmphasis)
                Spacer()
                if position.count > 1 || position.index > 0 {
                    Text("\(position.index) of \(position.count)").font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                }
            }
            if request.action == .command || request.action == .tool || request.action == .computer {
                Text(request.summary)
                    .font(Studio.Font.mono)
                    .foregroundStyle(Studio.Ink.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .background(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous).fill(Studio.Surface.muted))
                    .overlay(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous).strokeBorder(Studio.Surface.hairline))
            } else {
                HStack {
                    Text(request.summary).font(Studio.Font.mono).lineLimit(2)
                    Spacer()
                    if let showDiff { Button("Show diff", action: showDiff).buttonStyle(StudioQuietButtonStyle()) }
                }
            }
            if let reason = request.justification {
                Text(reason).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: JunoSpace.snug) {
                if options.contains(.decline) {
                    Button { respond(.decline) } label: {
                        HStack(spacing: JunoSpace.tight) { Text("Deny"); CodeV2Keycap(keys: "Esc") }
                    }
                    .buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
                    .keyboardShortcut(.cancelAction)
                }
                if options.contains(.cancel) {
                    Menu {
                        Button("Deny and stop") { respond(.cancel) }
                    } label: { JunoIconView(.ellipsis, size: 14) }
                        .menuStyle(.button).menuIndicator(.hidden).buttonStyle(StudioIconButtonStyle()).fixedSize()
                        .help("More").accessibilityLabel("More").contentShape(.rect)
                }
                Spacer()
                if options.contains(.acceptForSession) {
                    Button { respond(.acceptForSession) } label: {
                        HStack(spacing: JunoSpace.tight) { Text("Allow for this session"); CodeV2Keycap(keys: "⇧⌘↵") }
                    }
                    .buttonStyle(CodeV2OutlineButtonStyle()).contentShape(.rect)
                    .keyboardShortcut(.return, modifiers: [.command, .shift])
                }
                if options.contains(.accept) {
                    Button { respond(.accept) } label: {
                        HStack(spacing: JunoSpace.tight) { Text("Allow once"); Text("↵").foregroundStyle(Studio.Surface.canvas.opacity(0.7)) }
                    }
                    .buttonStyle(CodeV2InkButtonStyle()).contentShape(.rect)
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(JunoSpace.regular)
        .onKeyPress(.leftArrow) { move?(-1); return move == nil ? .ignored : .handled }
        .onKeyPress(.rightArrow) { move?(1); return move == nil ? .ignored : .handled }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(headline)
    }
}

/// A question that has taken over the composer: the prompt and its options
/// as a list, like an approval.
struct CodeV2QuestionTakeover: View {
    let request: CodeV2.UserInputRequest
    var answer: ([String: [String]]) -> Void
    @State private var chosen: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.hand, size: 18).foregroundStyle(Studio.Signal.edge)
                Text("The agent has a question").font(Studio.Font.labelEmphasis)
            }
            ForEach(request.questions, id: \.id) { question in
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text(question.prompt).studioReadingFont()
                    if let options = question.options, !options.isEmpty {
                        ForEach(options, id: \.self) { option in
                            let on = chosen[question.id, default: []].contains(option)
                            Button {
                                var set = question.multiSelect == true ? chosen[question.id, default: []] : []
                                if on { set.remove(option) } else { set.insert(option) }
                                chosen[question.id] = set
                            } label: {
                                HStack(spacing: JunoSpace.snug) {
                                    JunoRadioMark(isOn: on).frame(width: 16, height: 16)
                                    Text(option).font(Studio.Font.label)
                                    Spacer()
                                }
                                .frame(minHeight: 28).contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        TextField("Your answer", text: Binding(get: { typed[question.id] ?? "" }, set: { typed[question.id] = $0 }))
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }
            HStack {
                Spacer()
                Button("Answer") {
                    var answers: [String: [String]] = [:]
                    for question in request.questions {
                        if let text = typed[question.id], !text.isEmpty { answers[question.id] = [text] }
                        else { answers[question.id] = Array(chosen[question.id, default: []]) }
                    }
                    answer(answers)
                }
                .buttonStyle(CodeV2InkButtonStyle()).contentShape(.rect)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(JunoSpace.regular)
    }
}

/// The Limited state (DESIGN §6): the plan's limit in words, Resume at
/// reset, Switch model. The glow is off.
struct CodeV2LimitedNotice: View {
    let sentence: String
    var resumeAtReset: (() -> Void)?
    var switchModel: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text(sentence).studioReadingFont().foregroundStyle(Studio.Ink.secondary)
            HStack(spacing: JunoSpace.snug) {
                Spacer()
                if let switchModel { Button("Switch model", action: switchModel).buttonStyle(CodeV2OutlineButtonStyle()) }
                if let resumeAtReset { Button("Resume at reset", action: resumeAtReset).buttonStyle(CodeV2InkButtonStyle()) }
            }
        }
        .padding(JunoSpace.regular)
    }
}
