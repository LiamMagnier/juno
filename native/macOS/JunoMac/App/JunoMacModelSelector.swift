import JunoChatKit
import JunoDesignSystem
import SwiftUI
#if DEBUG
import JunoPreviewSupport
#endif

// MARK: - Composer controls

/// The selected model as it appears in the composer's control row: the
/// provider's real mark, the human name, a disclosure chevron. Never a raw
/// model id, and never a system `Picker` menu — the picker it opens carries
/// descriptions, capabilities and grades that a menu cannot show.
struct JunoMacModelControl: View {
    let catalog: [NativeChatModelOption]
    @Binding var selectedModelID: String
    /// Shown when the catalog has not loaded yet, so the control still names
    /// the conversation's own model rather than sitting empty.
    let fallbackName: String

    @State private var presented = false

    private var selected: NativeChatModelOption? {
        catalog.first { $0.id == selectedModelID }
    }

    var body: some View {
        Button {
            presented = true
        } label: {
            HStack(spacing: 5) {
                JunoProviderMark(
                    providerID: selected?.providerID ?? "juno",
                    providerName: selected?.providerName ?? "Juno",
                    size: 13
                )
                Text(selected?.displayName ?? fallbackName)
                    .font(.caption)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 7, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .modifier(JunoMacComposerChip())
        }
        .buttonStyle(.plain)
        .help(Text("chat.model"))
        .accessibilityLabel(Text("chat.model"))
        .accessibilityValue(
            selected.map { "\($0.displayName), \($0.providerName)" } ?? fallbackName
        )
        .accessibilityIdentifier("juno.mac.model-picker")
        .task {
            #if DEBUG
            guard JunoComposerPreviewFlags.opensModelSelector else { return }
            try? await Task.sleep(nanoseconds: 600_000_000)
            presented = true
            #endif
        }
        .popover(isPresented: $presented, arrowEdge: .top) {
            JunoMacModelSelectorView(
                catalog: catalog,
                selectedModelID: selectedModelID,
                onSelect: { model in
                    selectedModelID = model.id
                    presented = false
                }
            )
        }
    }
}

/// The Thinking control: a compact chip showing the current level, opening a
/// small popover with a discrete slider over exactly the levels the selected
/// model supports. Absent entirely for a model that cannot reason.
struct JunoMacThinkingControl: View {
    let scale: NativeThinkingScale
    @Binding var effort: NativeReasoningEffort?

    @State private var presented = false

    private var label: String {
        if scale.isAutomatic { return "Auto" }
        return scale.stops.first { $0.effort == effort }?.label ?? "Off"
    }

    var body: some View {
        if scale.isPresentable {
            Button {
                guard scale.isAdjustable else { return }
                presented = true
            } label: {
                HStack(spacing: 4) {
                    Text(label)
                        .font(.caption)
                        .monospacedDigit()
                        .lineLimit(1)
                    if scale.isAdjustable {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 7, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .foregroundStyle(scale.isAutomatic ? Color.secondary : Color.primary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .modifier(JunoMacComposerChip())
            }
            .buttonStyle(.plain)
            .disabled(!scale.isAdjustable)
            .help(Text("chat.effort"))
            .accessibilityLabel(Text("chat.effort"))
            .accessibilityValue(accessibilityValue)
            .accessibilityIdentifier("juno.mac.effort-picker")
            // Keyed on the scale: the catalog arrives after first render, so a
            // plain `.task` runs while the default model is still selected —
            // typically Auto, which is not adjustable — and never retries.
            .task(id: scale) {
                #if DEBUG
                guard JunoComposerPreviewFlags.opensThinking, scale.isAdjustable else { return }
                try? await Task.sleep(nanoseconds: 700_000_000)
                presented = true
                #endif
            }
            .popover(isPresented: $presented, arrowEdge: .top) {
                // Fully fixed size. A self-sizing AppKit popover whose content
                // measures itself (this one contains a GeometryReader) recurses
                // through `_layoutSubtreeWithOldSize:` until the app dies —
                // that shipped once, as the 3.0.5 thinking-slider crash.
                JunoThinkingPopover(scale: scale, effort: $effort, width: 268)
                    .frame(width: 268, height: scale.stops.count == 2 ? 116 : 92)
            }
        }
    }

    private var accessibilityValue: String {
        if scale.isAutomatic { return "Chosen automatically for each message" }
        guard let current = scale.stops.first(where: { $0.effort == effort }) else {
            return "Off"
        }
        let range = scale.stops.map(\.label).joined(separator: ", ")
        return "\(current.label). Available levels: \(range)"
    }
}

/// One capsule treatment for every small control in the composer, so the model
/// chip and the Thinking chip read as parts of the same row.
struct JunoMacComposerChip: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content
                .background(.quaternary.opacity(0.5), in: Capsule())
                .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}

// MARK: - The picker

/// The model picker as an anchored popover in the website's three regions:
/// provider rail · searchable list · selected-model detail.
///
/// The shell is a fixed 720×460 rather than self-sizing — see the crash note on
/// the Thinking popover; the same rule applies to any popover whose content
/// measures itself, and the detail panel's grade bars do.
struct JunoMacModelSelectorView: View {
    let catalog: [NativeChatModelOption]
    let selectedModelID: String
    let onSelect: (NativeChatModelOption) -> Void

    @State private var query = ""
    @State private var provider: String?
    @State private var detailModelID: String?
    @State private var expandedLegacy: Set<String> = []
    @FocusState private var searchFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            rail
            Divider()
            list
            Divider()
            detail
        }
        .frame(width: 720, height: 460)
        .onAppear { if detailModelID == nil { detailModelID = selectedModelID } }
    }

    // MARK: Regions

    private var rail: some View {
        List {
            Section("Providers") {
                railRow(id: nil, name: "All", count: chatModels.count)
                ForEach(providers, id: \.id) { entry in
                    railRow(id: entry.id, name: entry.shortName, count: entry.count)
                }
            }
        }
        .listStyle(.sidebar)
        .frame(width: 176)
    }

    private var list: some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
            Divider()
            if filtered.isEmpty {
                ContentUnavailableView.search(text: query)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("juno.mac.model-no-results")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: JunoSpace.tight) {
                        ForEach(sections) { section in
                            sectionView(section)
                        }
                    }
                    .padding(JunoSpace.snug)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var detail: some View {
        ScrollView {
            if let model = detailModel {
                JunoModelDetailView(model: model)
                    .padding(JunoSpace.regular)
            } else {
                ContentUnavailableView(
                    "No model selected",
                    systemImage: "cpu",
                    description: Text("Pick a model to compare context, speed and cost.")
                )
                .padding(JunoSpace.regular)
            }
        }
        .frame(width: 252)
        .background(Color.junoSurface)
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search models", text: $query)
                .textFieldStyle(.plain)
                .focused($searchFocused)
            if !query.isEmpty {
                Button {
                    query = ""
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(JunoGlassBackground(cornerRadius: JunoRadius.control))
        .accessibilityIdentifier("juno.mac.model-search")
    }

    // MARK: Sections and rows

    @ViewBuilder
    private func sectionView(_ section: JunoMacModelSection) -> some View {
        Label(section.title, systemImage: section.systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .padding(.top, JunoSpace.tight)

        ForEach(section.current) { row($0) }

        if !section.legacy.isEmpty {
            DisclosureGroup(isExpanded: legacyExpansion(for: section.key)) {
                ForEach(section.legacy) { row($0) }
            } label: {
                Text("Older models (\(section.legacy.count))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .accessibilityIdentifier("juno.mac.model-legacy.\(section.key)")
        }
    }

    private func row(_ model: NativeChatModelOption) -> some View {
        let reason = NativeModelPresentation.unavailabilityReason(model)
        let selected = model.id == selectedModelID
        return Button {
            guard reason == nil else { return }
            onSelect(model)
        } label: {
            HStack(alignment: .top, spacing: 9) {
                JunoProviderMark(
                    providerID: model.providerID,
                    providerName: model.providerName,
                    size: 20
                )
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        Text(model.displayName).font(.subheadline.weight(.medium))
                        if model.choosesReasoningAutomatically {
                            Text("SMART")
                                .font(.system(size: 8, weight: .semibold))
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .foregroundStyle(Color.junoAccent)
                                .background { Capsule().fill(Color.junoAccent.opacity(0.14)) }
                        }
                        if selected {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Color.junoAccent)
                        }
                        Spacer(minLength: 0)
                        if let cost = NativeModelPresentation.costGlyph(model.pricing) {
                            Text(cost).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                        }
                    }
                    if let summary = model.summary {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let reason {
                        Label(reason, systemImage: "lock")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.orange)
                    } else {
                        JunoCapabilityChips(model: model, compact: true)
                    }
                }
            }
            .padding(JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(selected ? Color.junoAccent.opacity(0.10) : Color.junoRowHover.opacity(0.6))
            }
            .opacity(reason == nil ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(reason != nil)
        // Pointer hover previews in the detail pane — the desktop equivalent of
        // the phone's inline expansion, and what the website does too.
        .onHover { inside in
            if inside { detailModelID = model.id }
        }
        .accessibilityIdentifier("juno.mac.model-row.\(model.id)")
    }

    private func railRow(id: String?, name: String, count: Int) -> some View {
        Button {
            provider = id
        } label: {
            HStack(spacing: 8) {
                if let id {
                    JunoProviderMark(providerID: id, providerName: name, size: 16)
                } else {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 12))
                        .frame(width: 16, height: 16)
                        .foregroundStyle(.secondary)
                }
                Text(name).font(.callout).lineLimit(1)
                Spacer(minLength: 4)
                Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(provider == id ? Color.junoRowSelected : Color.clear)
        .accessibilityAddTraits(provider == id ? [.isSelected] : [])
    }

    private func legacyExpansion(for key: String) -> Binding<Bool> {
        Binding(
            get: { isSearching || expandedLegacy.contains(key) },
            set: { expanded in
                if expanded { expandedLegacy.insert(key) } else { expandedLegacy.remove(key) }
            }
        )
    }

    // MARK: Data

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var chatModels: [NativeChatModelOption] {
        catalog.filter(\.isChatCapable)
    }

    private var filtered: [NativeChatModelOption] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return chatModels.filter { model in
            if let provider, model.providerID != provider { return false }
            guard !trimmed.isEmpty else { return true }
            return model.displayName.localizedCaseInsensitiveContains(trimmed)
                || model.providerName.localizedCaseInsensitiveContains(trimmed)
                || (model.summary?.localizedCaseInsensitiveContains(trimmed) ?? false)
        }
    }

    private var sections: [JunoMacModelSection] {
        JunoMacModelSection.order.compactMap { modality in
            let models = filtered.filter { $0.modality == modality.key }
            guard !models.isEmpty else { return nil }
            return JunoMacModelSection(
                key: modality.key,
                title: modality.title,
                systemImage: modality.systemImage,
                current: models.filter { !$0.isLegacy },
                legacy: models.filter(\.isLegacy)
            )
        }
    }

    private var providers: [(id: String, name: String, shortName: String, count: Int)] {
        var order: [String] = []
        var names: [String: String] = [:]
        var counts: [String: Int] = [:]
        for model in chatModels {
            if counts[model.providerID] == nil {
                order.append(model.providerID)
                names[model.providerID] = model.providerName
            }
            counts[model.providerID, default: 0] += 1
        }
        return order.map { id in
            let name = names[id] ?? id
            return (id, name, JunoMacModelSelectorView.shortProviderName(name), counts[id] ?? 0)
        }
    }

    private var detailModel: NativeChatModelOption? {
        guard let detailModelID else { return nil }
        return chatModels.first { $0.id == detailModelID }
    }

    /// Provider labels arrive as "Anthropic · Claude"; the rail only has room
    /// for the lab.
    static func shortProviderName(_ name: String) -> String {
        name.split(separator: "·").first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? name
    }
}

/// A modality group in the picker: the current generation, plus whatever it
/// superseded, kept apart so the older models can be collapsed.
struct JunoMacModelSection: Identifiable {
    let key: String
    let title: String
    let systemImage: String
    let current: [NativeChatModelOption]
    let legacy: [NativeChatModelOption]

    var id: String { key }

    /// Fixed presentation order — a lab shipping a video model should not
    /// reorder the sections.
    static let order: [(key: String, title: String, systemImage: String)] = [
        ("chat", "Chat", "bubble.left.and.text.bubble.right"),
        ("image", "Image", "photo"),
        ("video", "Video", "film"),
    ]
}
