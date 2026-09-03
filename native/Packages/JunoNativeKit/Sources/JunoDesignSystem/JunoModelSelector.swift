import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// The website's model picker as one native control: provider rail · searchable
/// list · spec sheet (`src/components/chat/model-selector.tsx`).
///
/// One implementation, driven by ``JunoModelDescriptor``, so Chat and Code
/// cannot drift. The geometry is fixed on purpose — AppKit cannot safely
/// negotiate an unconstrained popover whose detail column changes with hover —
/// and it is the web's: a 56pt rail of flat 36pt tiles, rows 56pt tall, a
/// 300pt spec sheet.
///
/// **What a row is.** A provider mark on a small bordered tile, the name, one
/// line of description, the price glyph right-aligned in mono. Selection is a
/// coral hairline over the accent fill; the keyboard cursor and the pointer lay
/// a flat wash. Nothing sparkles, nothing shows an icon per capability — those
/// are words on the spec sheet's inset well.
///
/// **What is deliberately not here.** No "Recently used" block: the list is
/// the answer, and a second copy of three rows above it padded the catalog
/// with duplicates. No thinking slider: effort is the composer's own chip, and
/// a slider inside the picker was a second control for the same value.
public struct JunoModelSelector: View {
    private let models: [JunoModelDescriptor]
    private let selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let select: (JunoModelDescriptor) -> Void

    @Environment(\.junoAccessibility) private var accessibility

    @State private var query = ""
    @State private var providerID: String?
    /// The keyboard cursor and the spec sheet's subject: whichever row the
    /// pointer or the arrow keys last landed on.
    @State private var cursorID: String?
    @State private var expandedLegacy: Set<String> = []
    /// Still recorded on select, so the web's "recent" ordering elsewhere stays
    /// in step; no longer drawn as a section. See the type note above.
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
            specSheet
        }
        .frame(width: metrics.width, height: metrics.height)
        .clipped()
        // The one place in the design system that clamps Dynamic Type, and the
        // clamp is a consequence of the fixed frame: at AX5 the three columns
        // would each need roughly twice the width they have.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .onAppear {
            if cursorID == nil { cursorID = selectedModelID }
        }
        .accessibilityIdentifier("juno.model-selector")
    }

    // MARK: Rail

    /// 56pt of flat 36pt tiles: "All" first, a short rule, then one per
    /// provider. The selected tile carries a coral hairline; nothing is tinted
    /// because the mark is the colour.
    private var providerRail: some View {
        ScrollView {
            VStack(spacing: JunoSpace.snug) {
                railTile(id: nil, name: "All providers", count: models.count) {
                    JunoIconView(.grid, size: 16)
                }

                Rectangle()
                    .fill(Color.junoBorder)
                    .frame(width: 20, height: 1)
                    .padding(.vertical, 2)

                ForEach(providers, id: \.id) { provider in
                    railTile(id: provider.id, name: provider.name, count: provider.count) {
                        JunoProviderMark(providerID: provider.id, providerName: provider.name, size: 18)
                    }
                }
            }
            .padding(.vertical, 10)
            .frame(width: metrics.railWidth)
        }
        .scrollIndicators(.hidden)
        .frame(width: metrics.railWidth)
        .background(Color.junoSidebar)
    }

    private func railTile<Mark: View>(
        id: String?,
        name: String,
        count: Int,
        @ViewBuilder mark: () -> Mark
    ) -> some View {
        let active = providerID == id
        return Button {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: accessibility.reduceMotion)) {
                providerID = id
                cursorID = nil
            }
        } label: {
            mark()
                .foregroundStyle(active ? Color.junoForeground : Color.junoMutedForeground)
                .frame(width: 36, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                        .fill(active ? Color.junoSurface : Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                        .strokeBorder(
                            active ? Color.junoAccent.opacity(0.7) : Color.clear,
                            lineWidth: 1
                        )
                )
                // The tile draws at 36; the target is the full 44 around it.
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
                .padding(JunoSpace.snug)
                .onKeyPress(.downArrow) { moveCursor(by: 1); return .handled }
                .onKeyPress(.upArrow) { moveCursor(by: -1); return .handled }
                .onKeyPress(.return) { commitCursor() ? .handled : .ignored }
                .onChange(of: query) { _, _ in cursorID = nil }

            Divider()

            if filteredModels.isEmpty {
                ContentUnavailableView.search(text: query)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: JunoSpace.cozy) {
                            ForEach(sections) { section in
                                sectionView(section)
                            }
                        }
                        .padding(JunoSpace.snug)
                    }
                    .scrollIndicators(.automatic)
                    .onChange(of: cursorID) { _, id in
                        guard let id else { return }
                        proxy.scrollTo(id, anchor: nil)
                    }
                }
            }
        }
        .frame(width: metrics.catalogWidth)
    }

    /// The web's `GroupLabel`: a mono label in secondary ink.
    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .junoFont(size: 11, relativeTo: .caption2, weight: .medium, design: .monospaced)
            .junoSecondaryInk()
            .padding(.horizontal, 10)
            .padding(.top, JunoSpace.hairline)
            .padding(.bottom, 2)
    }

    private func sectionView(_ section: CatalogSection) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionHeader(section.modality.groupTitle)

            ForEach(section.current) { model in
                modelRow(model)
            }

            if !section.legacy.isEmpty {
                DisclosureGroup(isExpanded: legacyExpansion(section.id)) {
                    VStack(spacing: 2) {
                        ForEach(section.legacy) { model in
                            modelRow(model)
                        }
                    }
                    .padding(.top, 2)
                } label: {
                    Text("Past models · \(section.legacy.count)")
                        .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                        .junoSecondaryInk()
                }
                .tint(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, JunoSpace.tight)
            }
        }
    }

    /// One 56pt row. Rest: nothing. Cursor/pointer: a flat wash. Selected: the
    /// accent fill with a coral hairline. The border is always drawn
    /// (transparent at rest) so selection moves nothing.
    private func modelRow(_ model: JunoModelDescriptor) -> some View {
        let unavailable = model.unavailabilityReason
        let selected = model.id == selectedModelID
        let cursor = model.id == cursorID && !selected

        return Button {
            guard unavailable == nil else {
                cursorID = model.id
                return
            }
            recentsRaw = JunoModelRecents.recording(model.id, in: recentsRaw)
            select(model)
        } label: {
            HStack(spacing: 10) {
                JunoProviderMark(
                    providerID: model.providerID,
                    providerName: model.providerName,
                    size: 16
                )
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                        .fill(Color.junoMuted.opacity(0.7))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
                )

                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        Text(model.displayName)
                            .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                            .junoInk()
                            .lineLimit(1)
                        Spacer(minLength: JunoSpace.hairline)
                        Text(unavailable != nil ? "Unavailable" : (model.costGlyph ?? ""))
                            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                            .junoSecondaryInk()
                            .monospacedDigit()
                    }
                    Text(unavailable ?? model.summary ?? "\(model.shortProviderName) model")
                        .junoFont(size: 12, relativeTo: .caption)
                        .foregroundStyle(
                            unavailable == nil ? Color.junoMutedForeground : Color.junoCaution
                        )
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                if selected {
                    JunoIconView(.check, size: 14)
                        .foregroundStyle(Color.junoAccent)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 56)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(
                        selected
                            ? Color.junoMuted
                            : (cursor ? Color.junoRowHover : Color.clear)
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(
                        selected
                            ? Color.junoAccent.opacity(0.7)
                            : (accessibility.increaseContrast
                                ? Color.junoForeground.opacity(0.4)
                                : Color.clear),
                        lineWidth: 1
                    )
            )
            .contentShape(.rect)
            .opacity(unavailable == nil ? 1 : 0.6)
        }
        .buttonStyle(.junoPress)
        .id(model.id)
        .onHover { hovering in
            if hovering { cursorID = model.id }
        }
        .accessibilityLabel(
            [model.displayName, model.providerName, selected ? "selected" : nil, unavailable]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Spec sheet

    private var specSheet: some View {
        Group {
            if let previewModel {
                JunoModelSelectorSpecSheet(
                    model: previewModel,
                    isSelected: previewModel.id == selectedModelID,
                    use: {
                        recentsRaw = JunoModelRecents.recording(previewModel.id, in: recentsRaw)
                        select(previewModel)
                    }
                )
            } else {
                Text("Hover or arrow through the list to compare models.")
                    .junoFont(size: 12, relativeTo: .caption)
                    .junoSecondaryInk()
                    .multilineTextAlignment(.center)
                    .padding(JunoSpace.roomy)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: metrics.detailWidth)
        .background(
            accessibility.usesOpaqueTransientSurfaces
                ? Color.junoSurface
                : Color.junoSurface.opacity(0.6)
        )
    }

    // MARK: Keyboard

    /// Every id in display order — what ↑/↓ walk.
    private var order: [String] {
        var ids: [String] = []
        for section in sections {
            ids.append(contentsOf: section.current.map(\.id))
            if isSearching || expandedLegacy.contains(section.id) {
                ids.append(contentsOf: section.legacy.map(\.id))
            }
        }
        return ids
    }

    private func moveCursor(by offset: Int) {
        let ids = order
        guard !ids.isEmpty else { return }
        let at = cursorID.flatMap { ids.firstIndex(of: $0) } ?? (offset > 0 ? -1 : ids.count)
        let next = ((at + offset) % ids.count + ids.count) % ids.count
        cursorID = ids[next]
    }

    /// Enter picks the cursor row, or the first row when nothing has been
    /// walked to yet. False when there is nothing to pick.
    private func commitCursor() -> Bool {
        let id = cursorID ?? order.first
        guard let id, let model = models.first(where: { $0.id == id }),
              model.unavailabilityReason == nil
        else { return false }
        recentsRaw = JunoModelRecents.recording(model.id, in: recentsRaw)
        select(model)
        return true
    }

    // MARK: Data

    private func legacyExpansion(_ id: String) -> Binding<Bool> {
        Binding(
            get: { isSearching || expandedLegacy.contains(id) },
            set: { expanded in
                if expanded { expandedLegacy.insert(id) } else { expandedLegacy.remove(id) }
            }
        )
    }

    private var filteredModels: [JunoModelDescriptor] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return models.filter { model in
            if let providerID, model.providerID != providerID { return false }
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

    private var providers: [(id: String, name: String, count: Int)] {
        var order: [String] = []
        var names: [String: String] = [:]
        var counts: [String: Int] = [:]
        for model in models {
            if counts[model.providerID] == nil {
                order.append(model.providerID)
                names[model.providerID] = model.shortProviderName
            }
            counts[model.providerID, default: 0] += 1
        }
        return order.map { (id: $0, name: names[$0] ?? $0, count: counts[$0] ?? 0) }
    }

    /// The sheet's subject: the cursor row, else the selection, else the first
    /// visible row — the web's `hoveredModel`.
    private var previewModel: JunoModelDescriptor? {
        if let cursorID, let model = models.first(where: { $0.id == cursorID }) { return model }
        if let model = models.first(where: { $0.id == selectedModelID }) { return model }
        return filteredModels.first
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

private extension JunoModelModality {
    /// The web's `MODALITY_GROUPS` labels.
    var groupTitle: String {
        switch self {
        case .chat: "Chat & reasoning"
        case .image: "Image generation"
        case .video: "Video generation"
        }
    }
}

/// The picker's spec sheet — the web's `ModelDetailPanel`: eyebrow, name,
/// description, the capabilities as mono tags on an inset well, a two-column
/// mono table, and one button. No slider, no bars, no icons.
struct JunoModelSelectorSpecSheet: View {
    let model: JunoModelDescriptor
    let isSelected: Bool
    let use: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        HStack(spacing: JunoSpace.tight) {
                            JunoProviderMark(
                                providerID: model.providerID,
                                providerName: model.providerName,
                                size: 14
                            )
                            Text(model.shortProviderName)
                                .junoFont(size: 11, relativeTo: .caption2, weight: .medium, design: .monospaced)
                                .junoSecondaryInk()
                        }
                        Text(model.displayName)
                            .junoFont(size: 18, relativeTo: .title3, weight: .semibold)
                            .junoInk()
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let retires = model.retiresOn.flatMap(JunoModelFormatting.retirementDate) {
                        Text("Available until \(retires)")
                            .junoFont(size: 12, relativeTo: .caption)
                            .foregroundStyle(Color.junoCaution)
                            .padding(.horizontal, 10)
                            .padding(.vertical, JunoSpace.tight)
                            .background(
                                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                                    .fill(Color.junoCaution.opacity(0.1))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                                    .strokeBorder(Color.junoCaution.opacity(0.4), lineWidth: 1)
                            )
                    }

                    Text(model.summary ?? "Capable foundation model.")
                        .junoFont(size: 13, relativeTo: .subheadline)
                        .lineSpacing(3)
                        .junoSecondaryInk()
                        .fixedSize(horizontal: false, vertical: true)

                    if !tags.isEmpty {
                        JunoChipFlow(spacing: 6, lineSpacing: 6) {
                            ForEach(tags, id: \.self) { tag in
                                JunoModelTag(tag)
                            }
                        }
                        .padding(JunoSpace.snug)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                                .fill(Color.junoCanvas)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                                .strokeBorder(Color.junoHairline, lineWidth: 1)
                        )
                    }

                    VStack(spacing: 0) {
                        Divider()
                        ForEach(Array(specRows.enumerated()), id: \.offset) { index, row in
                            if index > 0 { Divider() }
                            HStack(alignment: .firstTextBaseline) {
                                Text(row.label)
                                    .junoSecondaryInk()
                                Spacer(minLength: JunoSpace.snug)
                                Text(row.value)
                                    .junoInk()
                                    .multilineTextAlignment(.trailing)
                            }
                            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                            .monospacedDigit()
                            .padding(.vertical, JunoSpace.tight)
                        }
                    }

                    if let reason = model.unavailabilityReason {
                        Text(reason)
                            .junoFont(size: 12, relativeTo: .caption)
                            .foregroundStyle(Color.junoCaution)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(JunoSpace.regular)
            }

            Divider()

            Button(action: use) {
                Text(isSelected ? "Selected" : "Use this model")
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(.rect)
            }
            .junoProminentAction()
            .controlSize(.regular)
            .disabled(isSelected || model.unavailabilityReason != nil)
            .padding(JunoSpace.cozy)
            .accessibilityIdentifier("juno.model-selector.use")
        }
    }

    /// The web's `capabilityTags`: words, in the order the site lists them.
    private var tags: [String] {
        var tags: [String] = []
        if model.modality == .image { tags.append("Image") }
        if model.modality == .video { tags.append("Video") }
        for capability in model.capabilities {
            tags.append(capability == .reasoning ? "Thinking" : capability.label)
        }
        if let speed = model.speedGrade, speed >= 8 { tags.append("Fast") }
        if model.choosesThinkingAutomatically { tags.append("Auto") }
        return tags
    }

    private var specRows: [(label: String, value: String)] {
        var rows: [(String, String)] = []
        if let context = model.contextWindowTokens {
            rows.append(("Context", JunoModelFormatting.contextWindow(context)))
        }
        if let speed = model.speedGrade { rows.append(("Speed", "\(speed)/10")) }
        if let intelligence = model.intelligenceGrade {
            rows.append(("Intelligence", "\(intelligence)/10"))
        }
        if let price = model.priceDetail {
            rows.append(("Cost / MTok", price))
        } else if let glyph = model.costGlyph {
            rows.append(("Cost", glyph))
        }
        rows.append(("Thinking", model.thinking.summary))
        if let released = model.released { rows.append(("Released", released)) }
        return rows.map { (label: $0.0, value: $0.1) }
    }
}

/// The "Recently used" record, as the string `@AppStorage` keeps it.
///
/// Still written on every pick so the ordering the web keeps under
/// `juno:models:recent` has a native counterpart, and still testable without a
/// `UserDefaults` — but no longer drawn as a section of the picker.
public enum JunoModelRecents {
    /// The `UserDefaults` key. Shared by every product's selector on purpose.
    public static let key = "juno.model-selector.recent"
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

/// The selector's fixed geometry — the web's 880×560, clamped to the window.
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

    /// 56 · 522 · 300, 560 tall: the website's picker.
    public static let standard = JunoModelSelectorMetrics(
        railWidth: 56,
        catalogWidth: 522,
        detailWidth: 300,
        height: 560
    )

    /// These metrics, shrunk to fit inside a window of `size` with a gutter.
    /// The rail and the spec sheet keep their widths; the catalog and the
    /// height give.
    public func clamped(to size: CGSize?, gutter: CGFloat = 48) -> JunoModelSelectorMetrics {
        guard let size else { return self }
        let maxWidth = max(railWidth + detailWidth + 240, size.width - gutter)
        let maxHeight = max(360, size.height - gutter)
        let catalog = min(catalogWidth, maxWidth - railWidth - detailWidth - 2)
        return JunoModelSelectorMetrics(
            railWidth: railWidth,
            catalogWidth: catalog,
            detailWidth: detailWidth,
            height: min(height, maxHeight)
        )
    }

    /// ``standard`` clamped to the key window, so the popover is never clipped.
    @MainActor
    public static var fitted: JunoModelSelectorMetrics {
        #if canImport(AppKit)
        return standard.clamped(to: NSApp?.keyWindow?.contentView?.bounds.size)
        #else
        return standard
        #endif
    }
}

/// The composer control that opens the selector: the provider mark, the
/// model's name and one chevron — the web's chip, nothing else.
public struct JunoModelSelectorButton: View {
    private let models: [JunoModelDescriptor]
    @Binding private var selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let placeholder: String
    private let accessibilityID: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var presented = false
    @State private var hovered = false

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
        selected?.displayName ?? (selectedModelID.isEmpty ? placeholder : selectedModelID)
    }

    public var body: some View {
        let lit = hovered || presented
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
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                    .lineLimit(1)
                    .truncationMode(.tail)
                JunoIconView(.chevronDown, size: 12)
                    .opacity(0.6)
                    .rotationEffect(.degrees(presented ? 180 : 0))
            }
            .foregroundStyle(lit ? Color.junoForeground : Color.junoForeground.opacity(0.8))
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(lit ? Color.junoRowHover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.junoPress)
        .fixedSize()
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        .disabled(models.isEmpty)
        .help("The model this conversation's next turn runs on")
        .accessibilityLabel("Model")
        .accessibilityValue(label)
        .accessibilityIdentifier(accessibilityID)
        // Dismissed with its anchor, always: a `.popover` whose anchor leaves
        // the hierarchy while presented takes the process down with an
        // `NSRemoteView` exception.
        .onDisappear { presented = false }
        .popover(
            isPresented: $presented,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            let fitted = metrics.clamped(to: windowSize)
            JunoModelSelector(
                models: models,
                selectedModelID: selectedModelID,
                metrics: fitted,
                select: { model in
                    selectedModelID = model.id
                    presented = false
                }
            )
            .frame(width: fitted.width, height: fitted.height)
        }
    }

    private var windowSize: CGSize? {
        #if canImport(AppKit)
        NSApp?.keyWindow?.contentView?.bounds.size
        #else
        nil
        #endif
    }
}

/// The catalog's search field: an inset well, focused on appear, because a
/// popover that opens with 60 models in it is a search box first and a list
/// second.
struct JunoModelSearchField: View {
    @Binding var query: String
    @FocusState private var focused: Bool
    @Environment(\.junoAccessibility) private var accessibility

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.search, size: 14)
                .junoSecondaryInk()
            TextField("Search models…", text: $query)
                .textFieldStyle(.plain)
                .junoFont(size: 13, relativeTo: .subheadline)
                .focused($focused)
                .accessibilityIdentifier("juno.model-selector.search")
            if !query.isEmpty {
                Button {
                    query = ""
                    focused = true
                } label: {
                    JunoIconView(.circleX, size: 14)
                        .junoMetaInk()
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .fill(Color.junoCanvas)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                .strokeBorder(
                    focused
                        ? Color.junoForeground.opacity(0.6)
                        : (accessibility.increaseContrast
                            ? Color.junoForeground.opacity(0.4)
                            : Color.junoBorder),
                    lineWidth: 1
                )
        )
        .onAppear { focused = true }
    }
}
