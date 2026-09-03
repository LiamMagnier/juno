import SwiftUI

/// The website's model selector as one native control: provider rail ·
/// searchable catalog · model spec sheet.
///
/// One implementation, driven by ``JunoModelDescriptor``, so Chat and Code
/// cannot drift. It used to live in the app target, which meant Juno Code — a
/// package that cannot import the app — was stuck with a plain `Menu` listing
/// display names.
///
/// The fixed size is intentional. AppKit cannot safely negotiate an
/// unconstrained popover whose detail column changes with hover; the resulting
/// intrinsic-size feedback can keep the window's constraints dirty forever.
///
/// **What a row is.** A name, the price glyph right-aligned in mono, one line
/// of description. That is all. The rows used to carry a row of capability
/// glyphs under the description — a brain, an eye, a globe, a wrench — and
/// the review read that as "a row of spark icons" under every model, which is
/// what a row of eight-point symbols is once there are sixty of them. The
/// capabilities are still on the spec sheet, as words. Selection is stated by
/// the row rising — the Soft UI tile with a coral hairline — and hover by a
/// flat accent wash; nothing else in a row changes.
public struct JunoModelSelector: View {
    private let models: [JunoModelDescriptor]
    private let selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let select: (JunoModelDescriptor) -> Void

    // One read for all three switches. The selector draws its fills and
    // hairlines by hand — a hover fill, a pane tint over the popover's
    // material — and the system substitutions (opaque backers under Reduce
    // Transparency, stronger borders under Increase Contrast) cannot reach a
    // hand-drawn `opacity(…)`, so the fills below consult the preferences
    // themselves.
    @Environment(\.junoAccessibility) private var accessibility

    @State private var query = ""
    @State private var providerID: String?
    @State private var previewModelID: String?
    @State private var expandedLegacy: Set<String> = []
    /// The reader's last few choices, newest first. Persisted so the "Recently
    /// used" section is the same across Chat, Code and Work — it is one reader
    /// choosing models, not three products remembering separately.
    @AppStorage(JunoModelRecents.key) private var recentsRaw = ""

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
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        // No opaque fill. Letting the presentation's own material through is
        // what makes the picker read as floating over the window rather than as
        // a second window pasted on top of it. The panes inside still carry
        // their own faint tints, and those are *tints* — they modulate what
        // shows through instead of replacing it.
        .onAppear {
            if previewModelID == nil {
                previewModelID = selectedModelID
            }
        }
        .accessibilityIdentifier("juno.model-selector")
    }

    // MARK: Rail

    private var providerRail: some View {
        ScrollView {
            LazyVStack(spacing: JunoSpace.snug) {
                providerButton(id: nil, name: "All models", count: models.count)

                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 24, height: 1)
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

    /// A 36pt tile with the provider's mark. Selected is the raised tile with
    /// a coral hairline; nothing is tinted, because the mark is the colour.
    private func providerButton(
        id: String?,
        name: String,
        count: Int
    ) -> some View {
        let active = providerID == id
        return Button {
            // The rail's filter change is a content swap in the catalog
            // column beside it, so it is spatial travel and collapses to a flat
            // cross-fade under Reduce Motion.
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: accessibility.reduceMotion)) {
                providerID = id
            }
        } label: {
            Group {
                if let id {
                    JunoProviderMark(providerID: id, providerName: name, size: 20)
                } else {
                    JunoIconView(systemImage: "square.grid.2x2")
                        .junoFont(size: 14, relativeTo: .body, weight: .medium)
                        .foregroundStyle(active ? Color.junoAccent : Color.junoMutedForeground)
                }
            }
            .frame(width: 36, height: 36)
            .background {
                if active {
                    RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                        .fill(Color.junoSurface)
                        .shadow(
                            color: Color.junoCardShadow,
                            radius: JunoElevation.cardBlur,
                            y: JunoElevation.cardOffsetY
                        )
                }
            }
            .overlay {
                if active {
                    RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                        .strokeBorder(Color.junoAccent, lineWidth: 1)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .help("\(name) · \(count)")
        .accessibilityLabel(name)
        .accessibilityValue("\(count) models")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // MARK: Catalog

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
                    LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
                        if !recentModels.isEmpty {
                            recentSection
                        }
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

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .junoFont(size: 11.5, relativeTo: .caption, weight: .semibold)
            .junoSecondaryInk()
            .padding(.horizontal, 3)
    }

    /// The reader's last few choices, first. Absent while searching — a search
    /// is a question about the whole catalog — and narrowed by the rail like
    /// everything else, so "Recently used" under the Anthropic tile lists only
    /// Anthropic models.
    private var recentSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            sectionHeader("Recently used")
            ForEach(recentModels) { model in
                modelRow(model)
            }
        }
        .accessibilityIdentifier("juno.model-selector.recent")
    }

    private func sectionView(_ section: CatalogSection) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            sectionHeader(section.modality.sectionTitle)

            ForEach(section.current) { model in
                modelRow(model)
            }

            if !section.legacy.isEmpty {
                DisclosureGroup(
                    isExpanded: legacyExpansion(section.id)
                ) {
                    VStack(spacing: JunoSpace.snug) {
                        ForEach(section.legacy) { model in
                            modelRow(model)
                        }
                    }
                    .padding(.top, JunoSpace.snug)
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
        let hovered = model.id == previewModelID && !selected

        return Button {
            // An unavailable row is still readable — clicking it moves the spec
            // sheet so the reader can see *why*, instead of doing nothing.
            guard unavailable == nil else {
                previewModelID = model.id
                return
            }
            recentsRaw = JunoModelRecents.recording(model.id, in: recentsRaw)
            select(model)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoProviderMark(
                    providerID: model.providerID,
                    providerName: model.providerName,
                    size: 14
                )
                // A mark is an image and has no baseline; without a guide it
                // hangs a few points under the name beside it.
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }

                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                        Text(model.displayName)
                            .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
                            .junoInk()
                            .lineLimit(1)
                        if model.choosesThinkingAutomatically {
                            JunoModelTag("Smart", accent: true)
                        }
                        Spacer(minLength: JunoSpace.hairline)
                        if let cost = model.costGlyph {
                            Text(cost)
                                .junoFont(size: 10.5, relativeTo: .caption, design: .monospaced)
                                .junoMetaInk()
                        }
                    }

                    Text(unavailable ?? model.summary ?? "\(model.shortProviderName) model")
                        .junoFont(size: 11.5, relativeTo: .footnote)
                        .foregroundStyle(
                            unavailable == nil ? Color.junoMutedForeground : Color.junoCaution
                        )
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .background {
                // Selected: the raised tile. Hover: a flat accent wash. Rest:
                // nothing — the rows sit directly on the popover's material,
                // and only the one the reader chose is lifted off it.
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(
                        selected
                            ? Color.junoSurface
                            : (hovered ? Color.junoAccent.opacity(0.09) : Color.clear)
                    )
                    .shadow(
                        color: selected ? Color.junoCardShadow : Color.clear,
                        radius: JunoElevation.cardBlur,
                        y: JunoElevation.cardOffsetY
                    )
            }
            .overlay {
                // The coral hairline is the selection. Under Increase Contrast
                // the resting rows also take a border, one treatment for
                // strengthened borders across the package.
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(
                        selected
                            ? Color.junoAccent
                            : (accessibility.increaseContrast
                                ? Color.junoForeground.opacity(0.4)
                                : Color.clear),
                        lineWidth: 1
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

    // MARK: Detail

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
        // Light enough that the material carries through — except under
        // Reduce Transparency, where "the material carries through" is exactly
        // what the user has asked to stop: the system makes the popover's
        // backing opaque, and this hand-drawn tint goes full-alpha with it.
        .background(
            accessibility.usesOpaqueTransientSurfaces
                ? Color.junoSurface
                : Color.junoSurface.opacity(0.5)
        )
    }

    // MARK: Data

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

    private var recentModels: [JunoModelDescriptor] {
        guard !isSearching else { return [] }
        let visible = Dictionary(
            filteredModels.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return JunoModelRecents.ids(in: recentsRaw).compactMap { visible[$0] }
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

/// The "Recently used" list, as the string `@AppStorage` keeps it.
///
/// Pure functions over a comma-joined string, so the selector's storage stays
/// a one-line `@AppStorage` and the ordering rule is testable without a
/// `UserDefaults` in the test. Model ids never contain commas — they are
/// `provider/model` slugs — which is what makes the join safe.
public enum JunoModelRecents {
    /// The `UserDefaults` key. Shared by every product's selector on purpose.
    public static let key = "juno.model-selector.recent"
    /// How many are kept. Four is a hand's worth: enough to hold the two or
    /// three a reader actually alternates between, few enough that the section
    /// never becomes a second catalog.
    public static let limit = 4

    public static func ids(in raw: String) -> [String] {
        raw.split(separator: ",").map(String.init).filter { !$0.isEmpty }
    }

    /// `raw` with `id` moved (or added) to the front, trimmed to ``limit``.
    public static func recording(_ id: String, in raw: String) -> String {
        var next = ids(in: raw).filter { $0 != id }
        next.insert(id, at: 0)
        return next.prefix(limit).joined(separator: ",")
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
/// Ships with the selector so both products get the same trigger — the
/// provider mark, the model's name and a chevron, nothing else — and so the
/// popover's explicit frame can never be forgotten at a call site.
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
                JunoIconView(systemImage: "chevron.down", size: 9)
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

/// The catalog's search field: an inset well, focused on appear, because a
/// popover that opens with 60 models in it is a search box first and a list
/// second.
///
/// A well rather than glass. The field sits *on* the popover's material, and
/// glass on glass flattens both; the Soft UI inset — the secondary fill with an
/// inner hairline — is what a text field looks like on a raised surface.
struct JunoModelSearchField: View {
    @Binding var query: String
    @FocusState private var focused: Bool
    @Environment(\.junoAccessibility) private var accessibility

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(systemImage: "magnifyingglass")
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
                    JunoIconView(systemImage: "xmark.circle.fill")
                        .junoMetaInk()
                        .frame(minWidth: 22, minHeight: 22)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 32)
        .background {
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .fill(
                    accessibility.usesOpaqueTransientSurfaces
                        ? Color.junoMuted
                        : Color.junoMuted.opacity(0.55)
                )
        }
        .overlay {
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(
                    accessibility.increaseContrast
                        ? Color.junoForeground.opacity(0.4)
                        : Color.junoHairline,
                    lineWidth: accessibility.increaseContrast ? 1 : 0.5
                )
        }
        .onAppear { focused = true }
    }
}
