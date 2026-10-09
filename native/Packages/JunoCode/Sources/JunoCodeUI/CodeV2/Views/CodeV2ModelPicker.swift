import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The composer's Model control: the selected model's mark and short name.
/// Opens the picker (⌘⇧M).
struct CodeV2ModelControl: View {
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    var threadTokens: Int = 0
    var isEnabled = true
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?
    var choose: ((String, CodeV2.ProviderModel) -> Void)?

    @State private var isOpen = false

    private var model: CodeV2.ProviderModel? {
        directory.instance(selection.instanceId)?.models?.first { $0.id == selection.model }
    }

    var body: some View {
        Button { isOpen.toggle() } label: {
            HStack(spacing: JunoSpace.tight + 1) {
                CodeV2Mark(id: CodeV2Marks.markID(model: selection.model, instanceId: selection.instanceId), size: 14)
                Text(CodeV2ModelNames.short(model?.label ?? CodeV2Formatting.modelName(selection.model)))
                    .lineLimit(1)
            }
        }
        .buttonStyle(CodeV2FooterButtonStyle(isOpen: isOpen)).contentShape(.rect)
        .disabled(!isEnabled)
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .help("Model (⇧⌘M)")
        .accessibilityLabel("Model")
        .accessibilityValue(model?.label ?? selection.model)
        .accessibilityIdentifier("juno.code.v2.model")
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            CodeV2ModelPicker(
                directory: directory,
                selection: $selection,
                threadTokens: threadTokens,
                openConnections: openConnections.map { open in { isOpen = false; open() } },
                setup: setup,
                choose: { instance, model in
                    if let choose { choose(instance, model) }
                    isOpen = false
                }
            )
        }
    }
}

enum CodeV2ModelNames {
    /// "Claude Opus 5.5" → "Opus 5.5" on the footer, where the mark already
    /// says the lab.
    static func short(_ label: String) -> String {
        for prefix in ["Claude ", "Gemini ", "Grok "] where label.hasPrefix(prefix) {
            return String(label.dropFirst(prefix.count))
        }
        return label
    }

    /// One plain line per model family in the list (DESIGN §5.8). Missing
    /// families show no line rather than an invented one.
    static func blurb(_ id: String) -> String? {
        let lower = id.lowercased()
        let table: [(String, String)] = [
            ("opus", "Long-running agentic coding. Always thinks."),
            ("sonnet", "Near-Opus quality, lighter on plan limits."),
            ("haiku", "Fast subagents and quick edits."),
            ("fable", "Deepest reasoning. Uses limits fastest."),
            ("codex", "OpenAI's agentic coding model."),
            ("gpt-6", "Strong all-round coder with a long window."),
            ("flash", "Cheap and quick. Good for explorers."),
            ("gemini", "Very long context for large repositories."),
            ("grok", "Fast, terse coding agent."),
        ]
        return table.first { lower.contains($0.0) }?.1
    }
}

/// The picker (DESIGN §5.8): a provider-instance rail beside a searchable
/// coding-only list, the instance's facts in one sentence, and the traits
/// footer. 620 wide, at most 520 tall.
struct CodeV2ModelPicker: View {
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    var threadTokens: Int = 0
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?
    var choose: ((String, CodeV2.ProviderModel) -> Void)?

    @State private var focusedInstance: String?
    @State private var query = ""
    @State private var showsTiers = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var railBar

    private var currentInstanceId: String { focusedInstance ?? selection.instanceId }
    private var instance: CodeV2.ProviderInstance? { directory.instance(currentInstanceId) }

    var body: some View {
        HStack(spacing: 0) {
            rail
            VStack(spacing: 0) {
                search
                Divider().overlay(Studio.Surface.hairline)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if query.isEmpty {
                            header
                            list(for: instance)
                        } else {
                            searchResults
                        }
                    }
                    .padding(.bottom, JunoSpace.snug)
                }
                .frame(maxHeight: 380)
                Divider().overlay(Studio.Surface.hairline)
                footer
            }
        }
        .frame(width: 620)
        .frame(maxHeight: 520)
        .background(Studio.Surface.popover)
        .onKeyPress(.upArrow, phases: .down) { press in
            guard press.modifiers.contains(.command), press.modifiers.contains(.shift) else { return .ignored }
            step(-1)
            return .handled
        }
        .onKeyPress(.downArrow, phases: .down) { press in
            guard press.modifiers.contains(.command), press.modifiers.contains(.shift) else { return .ignored }
            step(1)
            return .handled
        }
    }

    private func step(_ delta: Int) {
        guard let next = directory.neighbour(of: currentInstanceId, step: delta) else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { focusedInstance = next.id }
    }

    // MARK: Rail

    private var rail: some View {
        let groups = directory.rail
        return VStack(spacing: JunoSpace.tight) {
            ForEach(Array(groups.enumerated()), id: \.element.id) { index, item in
                if index > 0,
                   CodeV2ProviderDirectory.railGroup(item) == .byok,
                   CodeV2ProviderDirectory.railGroup(groups[index - 1]) != .byok
                {
                    Rectangle().fill(Studio.Surface.hairline).frame(width: 20, height: 1).padding(.vertical, JunoSpace.tight)
                }
                railButton(item)
            }
            if let openConnections {
                Button(action: openConnections) {
                    JunoIconView(.plus, size: 15)
                        .foregroundStyle(Studio.Ink.secondary)
                        .frame(width: 36, height: 36)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Connect a subscription or add a key")
                .accessibilityLabel("Connect")
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, JunoSpace.snug)
        .frame(width: Studio.Metrics.rail)
        .frame(maxHeight: .infinity)
        .background(Studio.Surface.muted)
        .overlay(alignment: .trailing) { Rectangle().fill(Studio.Surface.hairline).frame(width: 1) }
    }

    private func railButton(_ item: CodeV2.ProviderInstance) -> some View {
        let selected = item.id == currentInstanceId
        let connected = CodeV2ProviderDirectory.railGroup(item) != .notConnected
        return Button {
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { focusedInstance = item.id }
        } label: {
            CodeV2Mark(id: CodeV2Marks.markID(instance: item), name: item.label, size: 18, dimmed: !connected)
                .frame(width: 36, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                        .fill(selected ? Studio.Surface.raised : Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                        .strokeBorder(selected ? Studio.Surface.hairline : Color.clear)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .trailing) {
            if selected {
                Capsule().fill(Studio.Ink.primary)
                    .frame(width: 3, height: 18)
                    .matchedGeometryEffect(id: "rail-bar", in: railBar)
            }
        }
        .help(CodeV2ProviderDirectory.tooltip(item))
        .accessibilityLabel(item.label)
        .accessibilityValue(CodeV2ProviderDirectory.tooltip(item))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Search

    private var search: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.search, size: 15).foregroundStyle(Studio.Ink.secondary)
            TextField("Search models", text: $query)
                .textFieldStyle(.plain)
                .font(Studio.Font.label)
            CodeV2Keycap(keys: "⇧⌘↑↓ provider")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 44)
    }

    // MARK: Instance

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(instance?.label ?? "")
                .font(Studio.Font.labelEmphasis)
            if let instance {
                Text(CodeV2ProviderDirectory.headerSentence(instance, alevrPlan: instance.account?.plan))
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.top, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.tight)
    }

    @ViewBuilder
    private func list(for instance: CodeV2.ProviderInstance?) -> some View {
        if let instance {
            switch instance.status {
            case .ready, .limited:
                let models = instance.models ?? []
                if models.isEmpty {
                    Text("This connection has not listed its models yet.")
                        .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                        .padding(JunoSpace.cozy)
                } else {
                    CodeV2SectionHeading(title: "Best for coding")
                    ForEach(models, id: \.id) { model in
                        row(model, in: instance, showsInstance: false)
                    }
                }
            default:
                fix(for: instance)
            }
        }
    }

    /// An unavailable instance shows the fix instead of models.
    private func fix(for instance: CodeV2.ProviderInstance) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let known = CodeV2KnownSubscription.allCases.first(where: { $0.instanceId == instance.id }), let note = known.note {
                Text(note).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
            }
            HStack(spacing: JunoSpace.snug) {
                switch instance.status {
                case .notInstalled:
                    Button("Install") { setup?(instance.id, .install) }.buttonStyle(CodeV2InkButtonStyle()).contentShape(.rect)
                case .signedOut, .error:
                    Button(instance.statusMessage == nil ? "Sign in" : "Sign in again") { setup?(instance.id, .login) }
                        .buttonStyle(CodeV2InkButtonStyle()).contentShape(.rect)
                default:
                    EmptyView()
                }
                if let openConnections {
                    Button("Open Connections", action: openConnections).buttonStyle(CodeV2OutlineButtonStyle()).contentShape(.rect)
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.top, JunoSpace.snug)
    }

    private var searchResults: some View {
        let needle = query.lowercased()
        let hits = directory.rail.flatMap { instance in
            (instance.status == .ready || instance.status == .limited ? instance.models ?? [] : [])
                .filter { $0.label.lowercased().contains(needle) || $0.id.lowercased().contains(needle) }
                .map { (instance, $0) }
        }
        return VStack(alignment: .leading, spacing: 0) {
            if hits.isEmpty {
                Text("No coding model matches “\(query)”.")
                    .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    .padding(JunoSpace.cozy)
            }
            ForEach(hits, id: \.1.id) { pair in
                row(pair.1, in: pair.0, showsInstance: true)
            }
        }
        .padding(.top, JunoSpace.snug)
    }

    private func row(_ model: CodeV2.ProviderModel, in instance: CodeV2.ProviderInstance, showsInstance: Bool) -> some View {
        let isSelected = selection.instanceId == instance.id && selection.model == model.id
        return CodeV2ModelRow(
            model: model, instance: instance, isSelected: isSelected, showsInstance: showsInstance,
            action: {
                if let choose { choose(instance.id, model) } else { selection.model = model.id; selection.instanceId = instance.id }
            }
        )
    }

    // MARK: Footer

    private var selectedModel: CodeV2.ProviderModel? {
        directory.instance(selection.instanceId)?.models?.first { $0.id == selection.model }
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            let levels = selectedModel?.effortLevels ?? []
            if !levels.isEmpty {
                Text("Effort").font(Studio.Font.label).foregroundStyle(Studio.Ink.secondary)
                JunoSegmented(
                    options: levels.map { JunoSegmentedOption($0, $0.title) },
                    selection: Binding(
                        get: { selection.effort ?? levels.first! },
                        set: { selection.effort = $0 }
                    ),
                    accessibilityLabel: "Effort",
                    size: .compact
                )
                .fixedSize()
            }
            Spacer()
            if let tiers = selectedModel?.contextTiers, !tiers.isEmpty {
                Text("Context").font(Studio.Font.label).foregroundStyle(Studio.Ink.secondary)
                Button { showsTiers.toggle() } label: {
                    HStack(spacing: JunoSpace.tight) {
                        Text(CodeV2ContextMath.label(tokens: selection.contextTokens ?? CodeV2ContextMath.sorted(tiers).first!.tokens))
                        JunoIconView(.chevronDown, size: 11)
                    }
                }
                .buttonStyle(CodeV2OutlineButtonStyle(compact: true)).contentShape(.rect)
                .popover(isPresented: $showsTiers, arrowEdge: .top) {
                    if let instance = directory.instance(selection.instanceId), let model = selectedModel {
                        CodeV2TierSelector(
                            instance: instance, model: model, selection: $selection, lean: .constant(false),
                            threadTokens: threadTokens, done: { showsTiers = false }
                        )
                    }
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 52)
    }
}

/// One model in the list: 52 tall, check slot, mark, name over a one-line
/// description, and the trailing window or per-million price.
struct CodeV2ModelRow: View {
    let model: CodeV2.ProviderModel
    let instance: CodeV2.ProviderInstance
    let isSelected: Bool
    var showsInstance = false
    let action: () -> Void

    @State private var hovering = false

    private var trailing: String? {
        guard let tier = model.contextTiers.flatMap({ CodeV2ContextMath.sorted($0).first }) else { return nil }
        if CodeV2ProviderDirectory.billsInDollars(instance.kind), tier.inputPerMTok > 0 {
            return CodeV2ContextMath.dollars(tier.inputPerMTok) + " / " + CodeV2ContextMath.dollars(tier.outputPerMTok)
        }
        let largest = CodeV2ContextMath.sorted(model.contextTiers ?? []).last?.tokens ?? tier.tokens
        return CodeV2ContextMath.label(tokens: largest)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                Group {
                    if isSelected { JunoIconView(.check, size: 14).foregroundStyle(Studio.Ink.primary) }
                    else { Color.clear }
                }
                .frame(width: 16)
                CodeV2Mark(id: CodeV2Marks.markID(model: model.id, instanceId: instance.id), size: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.label)
                        .font(isSelected ? Studio.Font.labelEmphasis : Studio.Font.label)
                        .foregroundStyle(Studio.Ink.primary)
                    if let sub = showsInstance ? instance.label : CodeV2ModelNames.blurb(model.id) {
                        Text(sub).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: JunoSpace.snug)
                if let trailing {
                    Text(trailing).font(Studio.Font.metaDigits).foregroundStyle(Studio.Ink.secondary)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: 52)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(hovering || isSelected ? Studio.Surface.hover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, JunoSpace.tight)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
