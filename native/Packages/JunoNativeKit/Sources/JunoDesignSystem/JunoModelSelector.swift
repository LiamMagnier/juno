import SwiftUI

/// The website's model selector as one native control: provider rail ·
/// searchable catalog · model spec sheet.
///
/// One implementation, driven by ``JunoModelDescriptor``, so Chat and Code
/// cannot drift. It used to live in the app target as `DesktopModelSelector`,
/// which meant Juno Code — a package that cannot import the app — was stuck with
/// a plain `Menu` listing display names.
///
/// The fixed size is intentional. AppKit cannot safely negotiate an
/// unconstrained popover whose detail column changes with hover; the resulting
/// intrinsic-size feedback can keep the window's constraints dirty forever.
public struct JunoModelSelector: View {
    private let models: [JunoModelDescriptor]
    private let selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let select: (JunoModelDescriptor) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var query = ""
    @State private var providerID: String?
    @State private var previewModelID: String?
    @State private var expandedLegacy: Set<String> = []

    public init(
        models: [JunoModelDescriptor],
        selectedModelID: String,
        metrics: JunoModelSelectorMetrics = .standard,
        select: @escaping (JunoModelDescriptor) -> Void
    ) {
        self.models = models
        self.selectedModelID = selectedModelID
        self.metrics = metrics
        self.select = select
    }

    public var body: some View {
        HStack(spacing: 0) {
            providerRail
            Divider()
            modelCatalog
            Divider()
            modelDetail
        }
        .frame(width: metrics.width, height: metrics.height)
        // The one place in the design system that clamps Dynamic Type, and the
        // clamp is a consequence of the fixed frame above rather than a
        // preference about type size. AppKit cannot safely negotiate an
        // unconstrained popover whose detail column changes with hover, so this
        // control's size is not negotiable; at AX5 the three columns inside it
        // would each need roughly twice the width they have and the catalog
        // would truncate every model name to two words. `.accessibility1` is
        // the largest step where all three columns still read.
        //
        // Everything the popover *contains* now scales up to that point, which
        // it did not before — every label in here was a fixed `.system(size:)`.
        // A clamp on a control that scales is a ceiling; a clamp on one that
        // does not is a fiction.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        // No opaque fill. This used to paint `Color.junoCanvas` across the whole
        // popover, which is a flat sheet of cream laid over the one surface in
        // the app that the system is already rendering as Liquid Glass — the
        // material was there the entire time, hidden under a solid colour.
        //
        // Letting the presentation's own material through is what makes the
        // picker read as floating over the window rather than as a second window
        // pasted on top of it. The panes inside still carry their own faint
        // tints (the rail, the selected row, the detail column), and those are
        // *tints* — they modulate what shows through instead of replacing it.
        .onAppear {
            if previewModelID == nil {
                previewModelID = selectedModelID
            }
        }
        .accessibilityIdentifier("juno.model-selector")
    }

    private var providerRail: some View {
        ScrollView {
            LazyVStack(spacing: JunoSpace.snug) {
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
            .padding(.vertical, JunoSpace.cozy)
        }
        .scrollIndicators(.hidden)
        .frame(width: metrics.railWidth)
        .background(Color.junoForeground.opacity(0.025))
    }

    private func providerButton(
        id: String?,
        name: String,
        count: Int
    ) -> some View {
        let active = providerID == id
        return Button {
            // The rail's filter change is a content swap in the catalog
            // column beside it, so it is spatial travel and collapses to a flat
            // cross-fade under Reduce Motion. This site read the preference
            // through neither `reduced(_:when:)` nor the environment before —
            // it was one of the four in the package that never asked at all.
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                providerID = id
            }
        } label: {
            Group {
                if let id {
                    JunoProviderMark(providerID: id, providerName: name, size: 24)
                } else {
                    Image(systemName: "square.grid.2x2")
                        .junoFont(size: 15, relativeTo: .body, weight: .medium)
                        .foregroundStyle(active ? Color.junoAccent : Color.junoMutedForeground)
                }
            }
            .frame(width: 40, height: 40)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(active ? Color.junoAccent.opacity(0.12) : Color.clear)
            }
            .overlay {
                if active {
                    RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                        .strokeBorder(Color.junoAccent.opacity(0.36), lineWidth: 1)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .help("\(name) · \(count)")
        .accessibilityLabel(name)
        .accessibilityValue("\(count) models")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var modelCatalog: some View {
        VStack(spacing: 0) {
            JunoModelSearchField(query: $query)
                .padding(JunoSpace.cozy)

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
                    .padding(JunoSpace.cozy)
                }
                .scrollIndicators(.automatic)
            }
        }
        .frame(width: metrics.catalogWidth)
    }

    private func sectionView(_ section: CatalogSection) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Label(section.modality.sectionTitle, systemImage: section.modality.systemImage)
                .junoFont(size: 10.5, relativeTo: .caption, weight: .semibold, design: .monospaced)
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
                        .junoFont(size: 11.5, relativeTo: .footnote, weight: .medium)
                        .junoSecondaryInk()
                }
                .tint(.secondary)
                .padding(JunoSpace.snug)
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                        .fill(Color.junoForeground.opacity(0.025))
                }
            }
        }
    }

    private func modelRow(_ model: JunoModelDescriptor) -> some View {
        let unavailable = model.unavailabilityReason
        let selected = model.id == selectedModelID
        let previewed = model.id == previewModelID

        return Button {
            // An unavailable row is still readable — clicking it moves the spec
            // sheet so the reader can see *why*, instead of doing nothing.
            guard unavailable == nil else {
                previewModelID = model.id
                return
            }
            select(model)
        } label: {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                JunoProviderMark(
                    providerID: model.providerID,
                    providerName: model.providerName,
                    size: 25
                )
                .padding(.top, 1)

                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    HStack(spacing: JunoSpace.tight) {
                        Text(model.displayName)
                            .junoFont(size: 13.5, relativeTo: .subheadline, weight: .semibold)
                            .lineLimit(1)
                        if model.choosesThinkingAutomatically {
                            Text("SMART")
                                .junoFont(size: 8.5, relativeTo: .caption2, weight: .bold)
                                .foregroundStyle(Color.junoAccent)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule().fill(Color.junoAccent.opacity(0.12))
                                )
                        }
                        Spacer(minLength: JunoSpace.hairline)
                        if let cost = model.costGlyph {
                            Text(cost)
                                .junoFont(size: 10, relativeTo: .caption, design: .monospaced)
                                .junoMetaInk()
                        }
                        if selected {
                            Image(systemName: "checkmark")
                                .junoFont(size: 11, relativeTo: .caption, weight: .bold)
                                .foregroundStyle(Color.junoAccent)
                        }
                    }

                    Text(model.summary ?? "\(model.shortProviderName) model")
                        .junoFont(size: 11.5, relativeTo: .footnote)
                        .junoSecondaryInk()
                        .lineLimit(2)

                    HStack(spacing: JunoSpace.tight) {
                        JunoModelCapabilityChips(
                            capabilities: model.capabilities,
                            compact: true
                        )
                        if let unavailable {
                            Label(unavailable, systemImage: "lock")
                                .junoFont(size: 9.5, relativeTo: .caption2, weight: .medium)
                                .foregroundStyle(.orange)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .padding(JunoSpace.cozy)
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
        .buttonStyle(.junoPress)
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
                JunoModelSpecSheet(model: previewModel)
                    .padding(JunoSpace.regular)
            } else {
                ContentUnavailableView(
                    "Choose a model",
                    systemImage: "cpu",
                    description: Text(
                        "Hover a model to compare its capabilities, context, speed, and cost."
                    )
                )
                .padding(JunoSpace.regular)
            }
        }
        .frame(width: metrics.detailWidth)
        // Lightened from 0.85: with the opaque canvas gone from the root, this
        // pane was the last thing wide enough to read as a solid slab. At this
        // weight it still separates the spec sheet from the catalog beside it
        // while the material carries through.
        .background(Color.junoSurface.opacity(0.5))
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

    private var filteredModels: [JunoModelDescriptor] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return models.filter { model in
            if let providerID, model.providerID != providerID {
                return false
            }
            return model.matches(needle)
        }
    }

    private var sections: [CatalogSection] {
        JunoModelModality.allCases.compactMap { modality in
            let options = filteredModels.filter { $0.modality == modality }
            guard !options.isEmpty else { return nil }
            return CatalogSection(
                modality: modality,
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
        var shortNames: [String: String] = [:]
        var counts: [String: Int] = [:]
        for model in models {
            if counts[model.providerID] == nil {
                order.append(model.providerID)
                names[model.providerID] = model.providerName
                shortNames[model.providerID] = model.shortProviderName
            }
            counts[model.providerID, default: 0] += 1
        }
        return order.map { id in
            (
                id,
                names[id] ?? id,
                shortNames[id] ?? id,
                counts[id] ?? 0
            )
        }
    }

    private var previewModel: JunoModelDescriptor? {
        guard let previewModelID else { return nil }
        return models.first { $0.id == previewModelID }
    }

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private struct CatalogSection: Identifiable {
        let modality: JunoModelModality
        let current: [JunoModelDescriptor]
        let legacy: [JunoModelDescriptor]

        var id: String { modality.rawValue }
    }
}

/// The selector's fixed geometry.
///
/// Named numbers rather than literals scattered through the view, because a
/// popover over a split view has to declare a size and this is the one place
/// that decision is made. `standard` is the size Chat shipped with.
public struct JunoModelSelectorMetrics: Equatable, Sendable {
    public let railWidth: CGFloat
    public let catalogWidth: CGFloat
    public let detailWidth: CGFloat
    public let height: CGFloat

    public init(
        railWidth: CGFloat,
        catalogWidth: CGFloat,
        detailWidth: CGFloat,
        height: CGFloat
    ) {
        self.railWidth = railWidth
        self.catalogWidth = catalogWidth
        self.detailWidth = detailWidth
        self.height = height
    }

    /// Rail + catalog + detail + the two dividers between them.
    public var width: CGFloat { railWidth + catalogWidth + detailWidth + 2 }

    public static let standard = JunoModelSelectorMetrics(
        railWidth: 62,
        catalogWidth: 410,
        detailWidth: 286,
        height: 520
    )
}

/// The composer control that opens the selector.
///
/// Ships with the selector so both products get the same trigger — a provider
/// mark, the model's name and a chevron — and so the popover's explicit frame
/// can never be forgotten at a call site.
public struct JunoModelSelectorButton: View {
    private let models: [JunoModelDescriptor]
    @Binding private var selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let placeholder: String
    private let accessibilityID: String

    @State private var presented = false

    public init(
        models: [JunoModelDescriptor],
        selectedModelID: Binding<String>,
        metrics: JunoModelSelectorMetrics = .standard,
        placeholder: String = "Choose model",
        accessibilityID: String = "juno.model-selector.button"
    ) {
        self.models = models
        _selectedModelID = selectedModelID
        self.metrics = metrics
        self.placeholder = placeholder
        self.accessibilityID = accessibilityID
    }

    private var selected: JunoModelDescriptor? {
        models.first { $0.id == selectedModelID }
    }

    private var label: String {
        selected?.displayName
            ?? (selectedModelID.isEmpty ? placeholder : selectedModelID)
    }

    public var body: some View {
        Button {
            presented = true
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoProviderMark(
                    providerID: selected?.providerID ?? "juno",
                    providerName: selected?.providerName ?? "Juno",
                    size: 14
                )
                Text(label)
                    .font(.caption)
                    .junoSecondaryInk()
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .junoSecondaryInk()
            }
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .fixedSize()
        .disabled(models.isEmpty)
        .help("The model this conversation's next turn runs on")
        .accessibilityLabel("Model")
        .accessibilityValue(label)
        .accessibilityIdentifier(accessibilityID)
        // Dismissed with its anchor, always.
        //
        // A `.popover` whose anchor leaves the view hierarchy while it is still
        // presented makes SwiftUI's `PopoverBridge` re-run `updatePresentations`
        // and call `showRelativeToRect:` against a window that is already being
        // ordered — `addChildWindow:` → `_doOrderWindow:` → an uncaught
        // `NSRemoteView` exception, and the process takes SIGTRAP. It is easy to
        // hit: open this popover, then click a different sidebar row, which tears
        // down the composer that owns the anchor.
        //
        // Resetting on disappear guarantees the presentation is torn down with
        // the anchor rather than after it.
        .onDisappear { presented = false }
        .popover(
            isPresented: $presented,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            // Explicit frame, twice over: the selector sizes itself and the
            // popover is told the same numbers. A self-sizing popover over a
            // split view has crashed this app before.
            JunoModelSelector(
                models: models,
                selectedModelID: selectedModelID,
                metrics: metrics,
                select: { model in
                    selectedModelID = model.id
                    presented = false
                }
            )
            .frame(width: metrics.width, height: metrics.height)
        }
    }
}

/// The catalog's search field. Focused on appear, because a popover that opens
/// with 60 models in it is a search box first and a list second.
struct JunoModelSearchField: View {
    @Binding var query: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: "magnifyingglass")
                .junoFont(size: 12, relativeTo: .footnote)
                .junoSecondaryInk()
            TextField("Search models", text: $query)
                .textFieldStyle(.plain)
                .focused($focused)
                .accessibilityIdentifier("juno.model-selector.search")
            if !query.isEmpty {
                Button {
                    query = ""
                    focused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .junoMetaInk()
                }
                .buttonStyle(.junoPress)
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
