// Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
// (ModelPickerContent / ModelListRow / ModelPickerSidebar: the narrow
// provider rail, the search field and two-line rows).
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The composer's model trigger (TARGET §7.1): the lab's mark, the model's
/// short name in ink and its effort in muted ink, one control. Opens the
/// picker (⇧⌘M). With nothing connected it reads `Connect` and opens
/// Settings › Connections.
struct CodeV2ModelControl: View {
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    @Binding var lean: Bool
    var threadTokens: Int = 0
    var isEnabled = true
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?
    var choose: ((String, CodeV2.ProviderModel) -> Void)?

    @State private var isOpen = false

    private var instance: CodeV2.ProviderInstance? { directory.instance(selection.instanceId) }
    private var model: CodeV2.ProviderModel? { instance?.models?.first { $0.id == selection.model } }
    private var isConnected: Bool { instance?.status == .ready || instance?.status == .limited }

    var body: some View {
        Button {
            if isConnected || openConnections == nil { isOpen.toggle() } else { openConnections?() }
        } label: {
            HStack(spacing: JunoSpace.tight + 2) {
                if isConnected {
                    CodeV2Mark(id: CodeV2Marks.markID(model: selection.model, instanceId: selection.instanceId), size: 14)
                    Text(CodeV2ModelNames.short(model?.label ?? CodeV2Formatting.modelName(selection.model)))
                        .foregroundStyle(Studio.Ink.primary)
                        .lineLimit(1)
                    if let effort = selection.effort {
                        Text(effort.title).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                            .contentTransition(.numericText())
                    }
                } else {
                    Text("Connect").foregroundStyle(Studio.Ink.primary)
                }
                JunoIconView(.chevronDown, size: 10).foregroundStyle(Studio.Ink.tertiary)
            }
        }
        .buttonStyle(CodeV2FooterButtonStyle(isOpen: isOpen)).contentShape(.rect)
        .fixedSize()
        .disabled(!isEnabled)
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .help("Model and effort (⇧⌘M)")
        .accessibilityLabel("Model")
        .accessibilityValue([model?.label ?? selection.model, selection.effort?.title].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("juno.code.v2.model")
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            CodeV2ModelPicker(
                directory: directory,
                selection: $selection,
                lean: $lean,
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
    /// "Claude Opus 5.5" → "Opus 5.5" on the trigger, where the mark already
    /// says the lab.
    static func short(_ label: String) -> String {
        for prefix in ["Claude ", "Gemini ", "Grok "] where label.hasPrefix(prefix) {
            return String(label.dropFirst(prefix.count))
        }
        return label
    }
}

/// What the picker says about a source and its models, in one place.
enum CodeV2PickerCopy {
    /// "Your Claude plan · 1M", "Alevr · $5 / $25 · 1M", "Your Anthropic key · 200K".
    static func rowLine(_ model: CodeV2.ProviderModel, in instance: CodeV2.ProviderInstance) -> String {
        let tiers = CodeV2ContextMath.sorted(model.contextTiers ?? [])
        let window = tiers.last.map { CodeV2ContextMath.label(tokens: $0.tokens) }
        var parts: [String] = []
        switch instance.kind {
        case .alevr:
            parts.append("Alevr")
            if let base = tiers.first, base.inputPerMTok > 0 {
                parts.append(CodeV2ContextMath.dollars(base.inputPerMTok).replacingOccurrences(of: ".00", with: "")
                             + " / " + CodeV2ContextMath.dollars(base.outputPerMTok).replacingOccurrences(of: ".00", with: ""))
            }
        case .byok:
            let lab = instance.id.split(separator: ":").last.flatMap { CodeV2.ByokProvider(rawValue: String($0)) }?.labName
            parts.append("Your \(lab ?? "provider") key")
        default:
            parts.append("Your \(CodeV2ProviderDirectory.vendorName(instance)) plan")
        }
        if let window { parts.append(window) }
        return parts.joined(separator: " · ")
    }

    /// The footer's usage: "38% of 5-hour window, resets 20:33" or "Plus plan".
    static func usage(_ instance: CodeV2.ProviderInstance) -> String? {
        if CodeV2ProviderDirectory.billsInDollars(instance.kind) {
            return instance.account?.plan.map { CodeV2ProviderDirectory.planName($0) + " plan" }
        }
        guard let window = instance.limits?.first, let used = window.usedPct else {
            return instance.account?.plan.map { CodeV2ProviderDirectory.planName($0) + " plan" }
        }
        var text = "\(Int(used.rounded()))% used"
        if let resets = window.resetsAt.flatMap({ CodeV2Formatting.clockTime(iso: $0, timeZone: .current) }) {
            text += ", resets \(resets)"
        }
        return text
    }
}

/// The picker (TARGET §8.1): a 44pt rail of the connected sources, a search
/// field, two-line rows (name over where it runs and what it costs), and a
/// two-row footer: effort, then the context window with the plan's usage.
/// 380 wide, at most 440 tall.
struct CodeV2ModelPicker: View {
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    var lean: Binding<Bool> = .constant(false)
    var threadTokens: Int = 0
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?
    var choose: ((String, CodeV2.ProviderModel) -> Void)?
    /// The team popover reuses the picker for one role: no footer there.
    var showsFooter = true

    @State private var focusedInstance: String?
    @State private var query = ""
    @State private var showsTiers = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var connected: [CodeV2.ProviderInstance] {
        directory.rail.filter { CodeV2ProviderDirectory.railGroup($0) != .notConnected }
    }
    private var currentInstanceId: String { focusedInstance ?? selection.instanceId }
    private var instance: CodeV2.ProviderInstance? { directory.instance(currentInstanceId) }

    var body: some View {
        HStack(spacing: 0) {
            rail
            VStack(spacing: 0) {
                search
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if query.isEmpty {
                            list(for: instance)
                        } else {
                            searchResults
                        }
                    }
                    .padding(.horizontal, JunoSpace.tight + 2)
                    .padding(.bottom, JunoSpace.tight + 2)
                }
                .frame(maxHeight: 300)
                if showsFooter {
                    Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                    footer
                }
            }
        }
        .frame(width: 380)
        .frame(maxHeight: 440)
        .clipped()
        .fixedSize(horizontal: false, vertical: true)
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
        guard !connected.isEmpty else { return }
        let index = connected.firstIndex { $0.id == currentInstanceId } ?? 0
        let next = connected[(index + delta + connected.count) % connected.count]
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) { focusedInstance = next.id }
    }

    // MARK: Rail

    private var rail: some View {
        VStack(spacing: JunoSpace.tight) {
            ForEach(connected, id: \.id) { item in railButton(item) }
            if let openConnections {
                Button(action: openConnections) {
                    JunoIconView(.plus, size: 14)
                        .foregroundStyle(Studio.Ink.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Connect a subscription or add a key")
                .accessibilityLabel("Connect")
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, JunoSpace.snug)
        .frame(width: 44)
        .frame(maxHeight: .infinity)
        .background(Studio.Surface.muted.opacity(0.5))
        .overlay(alignment: .trailing) { Rectangle().fill(Studio.Surface.hairline).frame(width: 1) }
    }

    private func railButton(_ item: CodeV2.ProviderInstance) -> some View {
        let selected = item.id == currentInstanceId
        return Button {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) { focusedInstance = item.id }
        } label: {
            CodeV2Mark(id: CodeV2Marks.markID(instance: item), name: item.label, size: 16)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                        .fill(selected ? Studio.Surface.selected : Color.clear)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(CodeV2ProviderDirectory.tooltip(item))
        .accessibilityLabel(item.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Search

    private var search: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.search, size: 14).foregroundStyle(Studio.Ink.tertiary)
            TextField("Search models", text: $query)
                .textFieldStyle(.plain)
                .studioType(.text)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 40)
    }

    // MARK: List

    @ViewBuilder
    private func list(for instance: CodeV2.ProviderInstance?) -> some View {
        if let instance {
            let models = instance.models ?? []
            if models.isEmpty {
                Text("No models listed yet.")
                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    .padding(JunoSpace.cozy)
            } else {
                ForEach(models, id: \.id) { model in
                    row(model, in: instance)
                }
            }
        }
    }

    private var searchResults: some View {
        let needle = query.lowercased()
        let hits = connected.flatMap { instance in
            (instance.models ?? [])
                .filter { $0.label.lowercased().contains(needle) || $0.id.lowercased().contains(needle) }
                .map { (instance, $0) }
        }
        return Group {
            if hits.isEmpty {
                Text("No model matches \u{201C}\(query)\u{201D}")
                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    .padding(JunoSpace.cozy)
            }
            ForEach(hits, id: \.1.id) { pair in
                row(pair.1, in: pair.0)
            }
        }
    }

    private func row(_ model: CodeV2.ProviderModel, in instance: CodeV2.ProviderInstance) -> some View {
        let isSelected = selection.instanceId == instance.id && selection.model == model.id
        return CodeV2ModelRow(
            model: model, instance: instance, isSelected: isSelected,
            action: {
                if let choose { choose(instance.id, model) } else { selection.model = model.id; selection.instanceId = instance.id }
            }
        )
    }

    // MARK: Footer

    private var selectedInstance: CodeV2.ProviderInstance? { directory.instance(selection.instanceId) }
    private var selectedModel: CodeV2.ProviderModel? {
        selectedInstance?.models?.first { $0.id == selection.model }
    }

    private var footer: some View {
        VStack(spacing: 0) {
            let levels = selectedModel?.effortLevels ?? []
            if !levels.isEmpty {
                HStack(spacing: JunoSpace.snug) {
                    Text("Effort").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    Spacer(minLength: JunoSpace.snug)
                    Picker("Effort", selection: Binding(get: { selection.effort ?? levels.first! }, set: { selection.effort = $0 })) {
                        ForEach(levels, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .controlSize(.small)
                    .frame(maxWidth: 250)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: 38)
                Rectangle().fill(Studio.Surface.hairline).frame(height: 1).padding(.horizontal, JunoSpace.cozy)
            }
            HStack(spacing: JunoSpace.snug) {
                Text("Context").studioType(.small).foregroundStyle(Studio.Ink.secondary)
                if let tiers = selectedModel?.contextTiers, !tiers.isEmpty {
                    Button { showsTiers.toggle() } label: {
                        HStack(spacing: JunoSpace.tight) {
                            Text(lean.wrappedValue ? "Lean" : CodeV2ContextMath.label(tokens: selection.contextTokens ?? CodeV2ContextMath.sorted(tiers).first!.tokens))
                                .monospacedDigit()
                            JunoIconView(.chevronDown, size: 9).foregroundStyle(Studio.Ink.tertiary)
                        }
                    }
                    .buttonStyle(CodeV2FooterButtonStyle(isOpen: showsTiers, compact: true))
                    .fixedSize()
                    .popover(isPresented: $showsTiers, arrowEdge: .trailing) {
                        if let instance = selectedInstance, let model = selectedModel {
                            CodeV2TierSelector(
                                instance: instance, model: model, selection: $selection, lean: lean,
                                threadTokens: threadTokens, done: { showsTiers = false }
                            )
                        }
                    }
                }
                if selectedModel?.supportsFast == true {
                    Toggle("Fast", isOn: Binding(get: { selection.fast == true }, set: { selection.fast = $0 }))
                        .toggleStyle(.checkbox)
                        .studioType(.small)
                        .foregroundStyle(Studio.Ink.secondary)
                        .help("About twice the speed at twice the price")
                }
                Spacer(minLength: JunoSpace.snug)
                if let instance = selectedInstance, let usage = CodeV2PickerCopy.usage(instance) {
                    Text(usage).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 38)
        }
    }
}

/// One model: 44 tall, the name over where it runs, a check on the chosen
/// one. No descriptions and no headers (TARGET §8.1).
struct CodeV2ModelRow: View {
    let model: CodeV2.ProviderModel
    let instance: CodeV2.ProviderInstance
    let isSelected: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                CodeV2Mark(id: CodeV2Marks.markID(model: model.id, instanceId: instance.id), size: 14)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.label).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                    Text(CodeV2PickerCopy.rowLine(model, in: instance))
                        .studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
                Spacer(minLength: JunoSpace.snug)
                if isSelected {
                    JunoIconView(.check, size: 13).foregroundStyle(Studio.Ink.primary)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 44)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(hovering ? Studio.Surface.hover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
