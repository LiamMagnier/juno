import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The website model selector translated to a fixed native popover:
/// provider rail · searchable catalog · model spec sheet.
///
/// The fixed size is intentional. AppKit cannot safely negotiate an
/// unconstrained popover whose detail column changes with hover; the resulting
/// intrinsic-size feedback can keep the window's constraints dirty forever.
struct DesktopModelSelector: View {
    let models: [NativeChatModelOption]
    let selectedModelID: String
    let select: (NativeChatModelOption) -> Void

    @State private var query = ""
    @State private var providerID: String?
    @State private var previewModelID: String?
    @State private var expandedLegacy: Set<String> = []

    var body: some View {
        HStack(spacing: 0) {
            providerRail
            Divider()
            modelCatalog
            Divider()
            modelDetail
        }
        .frame(width: 760, height: 520)
        .background(Color.junoCanvas)
        .onAppear {
            if previewModelID == nil {
                previewModelID = selectedModelID
            }
        }
        .accessibilityIdentifier("juno.desktop.model-selector")
    }

    private var providerRail: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                providerButton(id: nil, name: "All models", count: models.count)

                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 28, height: 1)
                    .padding(.vertical, 2)

                ForEach(providers, id: \.id) { provider in
                    providerButton(
                        id: provider.id,
                        name: provider.shortName,
                        count: provider.count
                    )
                }
            }
            .padding(.vertical, 12)
        }
        .scrollIndicators(.hidden)
        .frame(width: 62)
        .background(Color.primary.opacity(0.025))
    }

    private func providerButton(
        id: String?,
        name: String,
        count: Int
    ) -> some View {
        let active = providerID == id
        return Button {
            withAnimation(JunoMotion.fast) {
                providerID = id
            }
        } label: {
            Group {
                if let id {
                    JunoProviderMark(providerID: id, providerName: name, size: 24)
                } else {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(active ? Color.junoAccent : Color.junoMutedForeground)
                }
            }
            .frame(width: 40, height: 40)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(active ? Color.junoAccent.opacity(0.12) : Color.clear)
            }
            .overlay {
                if active {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.junoAccent.opacity(0.36), lineWidth: 1)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("\(name) · \(count)")
        .accessibilityLabel(name)
        .accessibilityValue("\(count) models")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var modelCatalog: some View {
        VStack(spacing: 0) {
            DesktopModelSearchField(query: $query)
                .padding(10)

            Divider()

            if filteredModels.isEmpty {
                ContentUnavailableView.search(text: query)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(sections) { section in
                            sectionView(section)
                        }
                    }
                    .padding(10)
                }
                .scrollIndicators(.automatic)
            }
        }
        .frame(width: 410)
    }

    private func sectionView(_ section: DesktopModelSection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(section.title, systemImage: section.systemImage)
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .junoSecondaryInk()
                .textCase(.uppercase)
                .padding(.horizontal, 3)

            ForEach(section.current) { model in
                modelRow(model)
            }

            if !section.legacy.isEmpty {
                DisclosureGroup(
                    isExpanded: legacyExpansion(section.id)
                ) {
                    VStack(spacing: 7) {
                        ForEach(section.legacy) { model in
                            modelRow(model)
                        }
                    }
                    .padding(.top, 7)
                } label: {
                    Text("Older models · \(section.legacy.count)")
                        .font(.system(size: 11.5, weight: .medium))
                        .junoSecondaryInk()
                }
                .tint(.secondary)
                .padding(8)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.primary.opacity(0.025))
                }
            }
        }
    }

    private func modelRow(_ model: NativeChatModelOption) -> some View {
        let unavailable = NativeModelPresentation.unavailabilityReason(model)
        let selected = model.id == selectedModelID
        let previewed = model.id == previewModelID

        return Button {
            guard unavailable == nil else {
                previewModelID = model.id
                return
            }
            select(model)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                JunoProviderMark(
                    providerID: model.providerID,
                    providerName: model.providerName,
                    size: 25
                )
                .padding(.top, 1)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(model.displayName)
                            .font(.system(size: 13.5, weight: .semibold))
                            .lineLimit(1)
                        if model.choosesReasoningAutomatically {
                            Text("SMART")
                                .font(.system(size: 8.5, weight: .bold))
                                .foregroundStyle(Color.junoAccent)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule().fill(Color.junoAccent.opacity(0.12))
                                )
                        }
                        Spacer(minLength: 4)
                        if let cost = NativeModelPresentation.costGlyph(model.pricing) {
                            Text(cost)
                                .font(.system(size: 10, design: .monospaced))
                                .junoMetaInk()
                        }
                        if selected {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(Color.junoAccent)
                        }
                    }

                    Text(
                        model.summary
                            ?? "\(DesktopModelSelector.shortProviderName(model.providerName)) model"
                    )
                    .font(.system(size: 11.5))
                    .junoSecondaryInk()
                    .lineLimit(2)

                    HStack(spacing: 6) {
                        JunoCapabilityChips(model: model, compact: true)
                        if let unavailable {
                            Label(unavailable, systemImage: "lock")
                                .font(.system(size: 9.5, weight: .medium))
                                .foregroundStyle(Color.junoCaution)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .padding(10)
            .background {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(
                        selected
                            ? Color.junoAccent.opacity(0.075)
                            : (previewed ? Color.junoRowHover : Color.junoSurface.opacity(0.72))
                    )
            }
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(
                        selected
                            ? Color.junoAccent.opacity(0.55)
                            : Color.junoHairline,
                        lineWidth: selected ? 1 : 0.5
                    )
            }
            .contentShape(.rect)
            .opacity(unavailable == nil ? 1 : 0.62)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                previewModelID = model.id
            }
        }
        .accessibilityLabel(
            [
                model.displayName,
                model.providerName,
                selected ? "selected" : nil,
                unavailable,
            ]
            .compactMap { $0 }
            .joined(separator: ", ")
        )
    }

    private var modelDetail: some View {
        ScrollView {
            if let previewModel {
                JunoModelDetailView(model: previewModel)
                    .padding(16)
            } else {
                ContentUnavailableView(
                    "Choose a model",
                    systemImage: "cpu",
                    description: Text(
                        "Hover a model to compare its capabilities, context, speed, and cost."
                    )
                )
                .padding(16)
            }
        }
        .frame(width: 286)
        .background(Color.junoSurface.opacity(0.85))
    }

    private func legacyExpansion(_ id: String) -> Binding<Bool> {
        Binding(
            get: { isSearching || expandedLegacy.contains(id) },
            set: { expanded in
                if expanded {
                    expandedLegacy.insert(id)
                } else {
                    expandedLegacy.remove(id)
                }
            }
        )
    }

    private var filteredModels: [NativeChatModelOption] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return models.filter { model in
            if let providerID, model.providerID != providerID {
                return false
            }
            guard !needle.isEmpty else { return true }
            return model.displayName.localizedCaseInsensitiveContains(needle)
                || model.providerName.localizedCaseInsensitiveContains(needle)
                || model.id.localizedCaseInsensitiveContains(needle)
                || (model.summary?.localizedCaseInsensitiveContains(needle) ?? false)
        }
    }

    private var sections: [DesktopModelSection] {
        DesktopModelSection.order.compactMap { entry in
            let options = filteredModels.filter {
                ($0.modality.isEmpty ? "chat" : $0.modality) == entry.id
            }
            guard !options.isEmpty else { return nil }
            return DesktopModelSection(
                id: entry.id,
                title: entry.title,
                systemImage: entry.systemImage,
                current: options.filter { !$0.isLegacy },
                legacy: options.filter(\.isLegacy)
            )
        }
    }

    private var providers:
        [(id: String, name: String, shortName: String, count: Int)]
    {
        var order: [String] = []
        var names: [String: String] = [:]
        var counts: [String: Int] = [:]
        for model in models {
            if counts[model.providerID] == nil {
                order.append(model.providerID)
                names[model.providerID] = model.providerName
            }
            counts[model.providerID, default: 0] += 1
        }
        return order.map { id in
            let name = names[id] ?? id
            return (
                id,
                name,
                Self.shortProviderName(name),
                counts[id] ?? 0
            )
        }
    }

    private var previewModel: NativeChatModelOption? {
        guard let previewModelID else { return nil }
        return models.first { $0.id == previewModelID }
    }

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func shortProviderName(_ name: String) -> String {
        name.split(separator: "·").first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? name
    }
}

private struct DesktopModelSection: Identifiable {
    let id: String
    let title: String
    let systemImage: String
    let current: [NativeChatModelOption]
    let legacy: [NativeChatModelOption]

    static let order: [(id: String, title: String, systemImage: String)] = [
        ("chat", "Chat", "bubble.left.and.text.bubble.right"),
        ("image", "Image", "photo"),
        ("video", "Video", "film"),
    ]
}

private struct DesktopModelSearchField: View {
    @Binding var query: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12))
                .junoSecondaryInk()
            TextField("Search models", text: $query)
                .textFieldStyle(.plain)
                .focused($focused)
                .accessibilityIdentifier("juno.desktop.model-search")
            if !query.isEmpty {
                Button {
                    query = ""
                    focused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .junoMetaInk()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 11)
        .frame(height: 34)
        .background(JunoGlassBackground(cornerRadius: 11))
        .overlay {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 0.5)
        }
        .onAppear { focused = true }
    }
}
