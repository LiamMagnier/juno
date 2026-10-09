// Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
// (ModelPickerContent / ModelListRow / ModelPickerSidebar: the narrow
// provider rail, the search field and two-line rows).
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The composer's model trigger (TARGET §7.1): the lab's mark, the model's
/// short name in ink and its effort in muted ink, one control. Slider-first,
/// as Chat's: a model with a choice of effort opens on the shared effort panel
/// (``JunoModelPickerControl``), whose model name leads to this picker; ⇧⌘M
/// opens the picker directly and ⇧⌘E the panel. With nothing connected it
/// reads `Connect` and opens Settings › Connections.
struct CodeV2ModelControl: View {
    let directory: CodeV2ProviderDirectory
    @Binding var selection: CodeV2.ModelSelection
    @Binding var lean: Bool
    var threadTokens: Int = 0
    var isEnabled = true
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?
    var choose: ((String, CodeV2.ProviderModel) -> Void)?

    @State private var stage: JunoModelPickerStage?

    /// The catalogue's fixed frame: AppKit cannot negotiate a popover whose
    /// content measures itself, so the control states it.
    static let catalogSize = CGSize(width: 380, height: 440)

    private var instance: CodeV2.ProviderInstance? { directory.instance(selection.instanceId) }
    private var model: CodeV2.ProviderModel? {
        instance.flatMap { CodeV2ModelCatalogue.models(of: $0, in: directory).first { $0.id == selection.model } }
    }
    private var isConnected: Bool { instance?.status == .ready || instance?.status == .limited }

    /// The selected model's effort levels as the shared panel's stops, its
    /// default effort as the reset target.
    static func ladder(for model: CodeV2.ProviderModel?, name: String) -> JunoThinkingLadder {
        let levels = model?.effortLevels ?? []
        return JunoThinkingLadder(
            stops: levels.map {
                JunoThinkingStop(id: $0.rawValue, label: $0.title, accessibilityLabel: "Effort \($0.title.lowercased())")
            },
            modelName: name,
            fastModeRateMultiplier: model?.supportsFast == true ? 2 : nil,
            defaultStopID: model?.defaultEffort?.rawValue
        )
    }

    private var name: String { model?.label ?? CodeV2Formatting.modelName(selection.model) }
    private var ladder: JunoThinkingLadder { Self.ladder(for: model, name: name) }

    private var stopID: Binding<String?> {
        Binding(
            get: { (selection.effort ?? model?.defaultEffort)?.rawValue },
            set: { id in
                guard let id, let level = CodeV2.EffortLevel(rawValue: id) else { return }
                selection.effort = level
            }
        )
    }

    private var fastMode: Binding<Bool>? {
        guard model?.supportsFast == true else { return nil }
        return Binding(get: { selection.fast == true }, set: { selection.fast = $0 })
    }

    var body: some View {
        if isConnected || openConnections == nil {
            picker
        } else {
            Button {
                openConnections?()
            } label: {
                CodeV2ModelControlLabel(isOpen: false) {
                    Text("Connect").foregroundStyle(Studio.Ink.primary)
                }
            }
            .buttonStyle(.plain)
            .fixedSize()
            .disabled(!isEnabled)
            .help("Connect a subscription or add a key")
            .accessibilityLabel("Model")
            .accessibilityValue("Connect")
            .accessibilityIdentifier("juno.code.v2.model")
        }
    }

    private var picker: some View {
        JunoModelPickerControl(
            stage: $stage,
            ladder: ladder,
            stopID: stopID,
            fastMode: fastMode,
            modelName: name,
            catalogSize: Self.catalogSize,
            arrowEdge: .top,
            isEnabled: isEnabled,
            accessibilityValue: [name, selection.effort?.title].compactMap { $0 }.joined(separator: ", "),
            accessibilityID: "juno.code.v2.model",
            help: "Model and effort (⇧⌘M, ⇧⌘E)"
        ) { open in
            CodeV2ModelControlLabel(isOpen: open) {
                CodeV2Mark(id: CodeV2Marks.markID(model: selection.model, instanceId: selection.instanceId), size: 14)
                Text(CodeV2ModelNames.short(name))
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(1)
                if let effort = selection.effort {
                    Text(effort.title).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                        .contentTransition(.numericText())
                }
            }
        } catalog: { close in
            CodeV2ModelPicker(
                directory: directory,
                selection: $selection,
                lean: $lean,
                threadTokens: threadTokens,
                openConnections: openConnections.map { open in { close(); open() } },
                setup: setup,
                choose: { instance, model in
                    if let choose { choose(instance, model) } else {
                        selection.model = model.id
                        selection.instanceId = instance
                    }
                    close()
                }
            )
        }
        .background {
            // The two shortcuts, as hidden buttons so they work wherever the
            // composer has focus: ⇧⌘M the models, ⇧⌘E the effort.
            Group {
                Button("Model") { stage = .catalog }
                    .keyboardShortcut("m", modifiers: [.command, .shift])
                    .contentShape(.rect)
                Button("Effort") { if ladder.isAdjustable { stage = .effort } }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
                    .contentShape(.rect)
            }
            .opacity(0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .disabled(!isEnabled)
        }
    }
}

/// The trigger's face, in the footer controls' grammar
/// (``CodeV2FooterButtonStyle``): secondary ink at rest, the hover tone under
/// the pointer and while open.
struct CodeV2ModelControlLabel<Content: View>: View {
    let isOpen: Bool
    @ViewBuilder let content: () -> Content

    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: JunoSpace.tight + 2) {
            content()
            JunoIconView(.chevronDown, size: 10).foregroundStyle(Studio.Ink.tertiary)
        }
        .studioType(.text)
        .foregroundStyle(!isEnabled ? Studio.Ink.tertiary : (isOpen || hovering ? Studio.Ink.primary : Studio.Ink.secondary))
        .padding(.horizontal, JunoSpace.snug)
        .frame(minWidth: 28, minHeight: Studio.Metrics.control)
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                .fill(isOpen || hovering ? Studio.Surface.hover : Color.clear)
        )
        .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous))
        .onHover { hovering = $0 }
        .animation(JunoMotion.fast, value: hovering)
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

/// The picker, organised like the web's model catalogue: a 44pt rail of the AI
/// labs (Alevr's models and your keys, filed by who makes them), a hairline,
/// then Subscriptions (the plans connected on this Mac, apart from the labs);
/// a search field; rows grouped under where they run; and a footer with the
/// context window and the plan's usage. Code is an agent, so only text models
/// that call tools are here; image, video and music models are chosen in
/// Settings › Generation models. Effort and Fast live on the effort panel the
/// chip opens first. 380 × 440 in the composer.
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
    /// Where the rail opens, when not the selection's own place (the gallery).
    var initialPlace: CodeV2ModelCatalogue.Place?
    /// A search already typed (the gallery).
    var initialQuery = ""

    /// The list's height inside ``CodeV2ModelControl/catalogSize``.
    static let listHeight: CGFloat = CodeV2ModelControl.catalogSize.height - 40 - 39

    @State private var focusedPlace: CodeV2ModelCatalogue.Place?
    @State private var query = ""
    @State private var showsTiers = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private typealias Catalogue = CodeV2ModelCatalogue

    private var place: Catalogue.Place { focusedPlace ?? Catalogue.place(for: selection, in: directory) }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(spacing: 0) {
            rail
            VStack(spacing: 0) {
                search
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        list
                    }
                    .padding(.horizontal, JunoSpace.tight + 2)
                    .padding(.bottom, JunoSpace.tight + 2)
                }
                // A fixed list height in the composer, so the catalogue fills
                // the control's fixed 380 × 440 frame: search 40, footer 39.
                .frame(
                    minHeight: showsFooter ? Self.listHeight : nil,
                    maxHeight: showsFooter ? Self.listHeight : 300
                )
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
        .onAppear {
            if focusedPlace == nil, let initialPlace { focusedPlace = initialPlace }
            if query.isEmpty, !initialQuery.isEmpty { query = initialQuery }
        }
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
        let places = Catalogue.places(directory)
        guard !places.isEmpty else { return }
        let index = places.firstIndex(of: place) ?? 0
        focus(places[(index + delta + places.count) % places.count])
    }

    private func focus(_ next: Catalogue.Place) {
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
            focusedPlace = next
            query = ""
        }
    }

    // MARK: Rail

    private var rail: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: JunoSpace.tight) {
                ForEach(Catalogue.labs(directory)) { lab in
                    railTile(.lab(lab.id), help: lab.name) {
                        CodeV2Mark(id: lab.id, name: lab.name, size: 16)
                    }
                }
                Rectangle().fill(Studio.Surface.hairline).frame(width: 20, height: 1)
                    .padding(.vertical, 2)
                railTile(.subscriptions, help: subscriptionsHelp) {
                    JunoIconView(.billing, size: 16)
                        .foregroundStyle(Studio.Ink.primary)
                }
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
            }
            .padding(.vertical, JunoSpace.snug)
        }
        .frame(width: 44)
        .frame(maxHeight: .infinity)
        .background(Studio.Surface.muted.opacity(0.5))
        .overlay(alignment: .trailing) { Rectangle().fill(Studio.Surface.hairline).frame(width: 1) }
    }

    private var subscriptionsHelp: String {
        let connected = Catalogue.subscriptions(directory)
        return connected.isEmpty ? "Subscriptions: none connected" : "Subscriptions: " + connected.map(Catalogue.sourceTitle).joined(separator: ", ")
    }

    private func railTile<Mark: View>(_ target: Catalogue.Place, help: String, @ViewBuilder mark: () -> Mark) -> some View {
        let selected = !searching && target == place
        return Button { focus(target) } label: {
            mark()
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                        .fill(selected ? Studio.Surface.selected : Color.clear)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help.components(separatedBy: ":").first ?? help)
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
    private var list: some View {
        let groups = Catalogue.groups(place: place, directory: directory, query: query)
        if searching, groups.isEmpty {
            Text("No model matches \u{201C}\(query)\u{201D}")
                .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                .padding(JunoSpace.cozy)
        } else if !searching, place == .subscriptions, groups.isEmpty {
            CodeV2ConnectSubscriptionRow(action: openConnections)
                .padding(.top, JunoSpace.tight)
        } else {
            ForEach(groups) { group in
                CodeV2PickerHeading(title: group.title, trailing: group.trailing)
                if group.entries.isEmpty {
                    Text("No models listed yet.")
                        .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                        .padding(.horizontal, JunoSpace.snug)
                        .frame(height: 32, alignment: .leading)
                }
                ForEach(group.entries) { entry in
                    row(entry)
                }
            }
        }
    }

    private func row(_ entry: Catalogue.Entry) -> some View {
        let isSelected = selection.instanceId == entry.instance.id && selection.model == entry.model.id
        return CodeV2ModelRow(
            model: entry.model, instance: entry.instance, isSelected: isSelected,
            line: Catalogue.rowLine(entry.model, in: entry.instance, namesSource: searching),
            action: {
                if let choose { choose(entry.instance.id, entry.model) } else {
                    selection.model = entry.model.id
                    selection.instanceId = entry.instance.id
                }
            }
        )
    }

    // MARK: Footer

    private var selectedInstance: CodeV2.ProviderInstance? { directory.instance(selection.instanceId) }
    private var selectedModel: CodeV2.ProviderModel? {
        selectedInstance.flatMap { Catalogue.models(of: $0, in: directory).first { $0.id == selection.model } }
    }

    private var footer: some View {
        VStack(spacing: 0) {
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
                    .contentShape(.rect)
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

/// A group's heading in the picker: where the rows under it run ("Alevr",
/// "Your Anthropic key", "Claude plan"), and a subscription's usage on the
/// right. Small secondary type, as the Chat catalogue's modality headings.
struct CodeV2PickerHeading: View {
    let title: String
    var trailing: String?

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text(title).studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
            Spacer(minLength: JunoSpace.snug)
            if let trailing {
                Text(trailing).studioType(.small).monospacedDigit().foregroundStyle(Studio.Ink.tertiary).lineLimit(1)
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.top, JunoSpace.snug)
        .frame(height: 30, alignment: .bottom)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Subscriptions with nothing connected: one row that opens Connections.
struct CodeV2ConnectSubscriptionRow: View {
    let action: (() -> Void)?
    @State private var hovering = false

    var body: some View {
        Button { action?() } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.plus, size: 13)
                    .foregroundStyle(Studio.Ink.secondary)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Connect a subscription").studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                    Text(CodeV2ModelCatalogue.connectSubtitle)
                        .studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                }
                Spacer(minLength: JunoSpace.snug)
                JunoIconView(.chevronRight, size: 11).foregroundStyle(Studio.Ink.tertiary)
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
        .disabled(action == nil)
        .onHover { hovering = $0 }
        .accessibilityIdentifier("juno.code.v2.model.connectSubscription")
    }
}

/// One model: 44 tall, the name over where it runs, a check on the chosen
/// one. No descriptions and no headers (TARGET §8.1).
struct CodeV2ModelRow: View {
    let model: CodeV2.ProviderModel
    let instance: CodeV2.ProviderInstance
    let isSelected: Bool
    /// The second line; the source's own words when nil.
    var line: String?
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                CodeV2Mark(id: CodeV2Marks.markID(model: model.id, instanceId: instance.id), size: 14)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.label).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                    Text(line ?? CodeV2PickerCopy.rowLine(model, in: instance))
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
