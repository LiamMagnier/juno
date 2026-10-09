import JunoCore
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// The full model catalogue: the web's `ModelCatalogue`
/// (`src/components/chat/model-catalogue.tsx`), as one native view.
///
/// Three panes, the web's: a 48pt rail of lab marks (All models and Favorites
/// first, names in the tooltip), a column of model names under a search
/// field, and a 272pt detail panel that fills in as the cursor moves. It opens
/// on the model in use, its row lit and its section scrolled into view, so a
/// Veo thread opens on Google's Video rows rather than at the top of the list.
///
/// **What a row is.** A mark and a name, at one line each, so a lab's whole
/// range is visible without scrolling. The trailing slot holds one thing and
/// usually nothing: the check on the model in use, or a lock on a model the
/// plan cannot reach. A star marks a favorite. Everything a choice turns on
/// (how capable, how fast, how much, what it can do) is in the panel.
///
/// **Native.** It is presented in a system popover, which is the Liquid Glass;
/// the rows, rail and panel are plain buttons and scroll views on it, and the
/// one primary action is the system's prominent glass button. One accent, and
/// it is always state or action: the filled star and the Use button.
///
/// One implementation, driven by ``JunoModelDescriptor``, so Chat and Code
/// cannot drift. The geometry is fixed on purpose: AppKit cannot safely
/// negotiate an unconstrained popover whose detail column changes with the
/// cursor. See ``JunoModelSelectorMetrics``.
public struct JunoModelSelector: View {
    private let models: [JunoModelDescriptor]
    private let selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let favorites: Set<String>
    private let toggleFavorite: ((String) -> Void)?
    private let select: (JunoModelDescriptor) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var query = ""
    @State private var filter: JunoModelSelectorCatalog.Filter = .all
    /// The one cursor: the row under the pointer or the arrow keys, by row key.
    @State private var cursorKey: String?
    @State private var expandedLegacy: Set<String> = []
    /// The last pointer position seen over the list, in window space. A row
    /// scrolled under a stationary pointer by the arrow keys reports a hover,
    /// and without this the pointer would take the cursor straight back.
    @State private var lastPointer: CGPoint?
    @State private var placed = false
    @FocusState private var searchFocused: Bool
    /// Recorded on every pick, newest first, and drawn as "Recent" when the
    /// list is long enough for it to save a scroll (the web's `readRecent`).
    @AppStorage(JunoModelRecents.key) private var recentsRaw = ""

    /// `favorites` and `toggleFavorite` are the account's starred models; pass
    /// no `toggleFavorite` where the product has no such setting and the rail
    /// shows no Favorites tile and the panel no star.
    public init(
        models: [JunoModelDescriptor],
        selectedModelID: String,
        metrics: JunoModelSelectorMetrics = .standard,
        favorites: Set<String> = [],
        toggleFavorite: ((String) -> Void)? = nil,
        select: @escaping (JunoModelDescriptor) -> Void
    ) {
        self.models = models
        self.selectedModelID = selectedModelID
        self.metrics = metrics
        self.favorites = favorites
        self.toggleFavorite = toggleFavorite
        self.select = select
    }

    public var body: some View {
        HStack(spacing: 0) {
            labRail
            Divider()
            listColumn
            Divider()
            detailPanel
        }
        .frame(width: metrics.width, height: metrics.height)
        .clipped()
        // The one place in the design system that clamps Dynamic Type, and the
        // clamp is a consequence of the fixed frame.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .onKeyPress(.downArrow) { moveCursor(by: 1) }
        .onKeyPress(.upArrow) { moveCursor(by: -1) }
        .onKeyPress(.home) { moveCursor(to: order.first) }
        .onKeyPress(.end) { moveCursor(to: order.last) }
        .onKeyPress(.return) { commitCursor() ? .handled : .ignored }
        .onKeyPress(.escape) { dismiss(); return .handled }
        .accessibilityIdentifier("juno.model-selector")
    }

    // MARK: Rail

    private var labRail: some View {
        ScrollView {
            VStack(spacing: JunoSpace.hairline) {
                railTile(
                    label: "All models",
                    count: searchable.count,
                    active: isSearching || filter == .all,
                    choose: .all
                ) {
                    JunoIconView(.grid, size: 16)
                }
                if toggleFavorite != nil {
                    railTile(
                        label: "Favorites",
                        count: favorites.isEmpty ? nil : favorites.count,
                        active: !isSearching && filter == .favorites,
                        choose: .favorites
                    ) {
                        JunoIconView(.star, size: 16, isOn: !isSearching && filter == .favorites)
                    }
                }
                Rectangle()
                    .fill(Color.junoBorder)
                    .frame(width: 20, height: 1)
                    .padding(.vertical, JunoSpace.hairline)
                ForEach(railLabs) { lab in
                    railTile(
                        label: lab.name,
                        count: lab.count,
                        active: !isSearching && filter == .lab(lab.id),
                        choose: .lab(lab.id)
                    ) {
                        JunoProviderMark(providerID: lab.id, providerName: lab.name, size: 16)
                    }
                }
            }
            .padding(JunoSpace.snug)
        }
        .scrollIndicators(.never)
        .frame(width: metrics.railWidth)
        .background(Color.junoMuted.opacity(0.4))
    }

    /// One tile: the mark, and the lab and its count in the tooltip. Active is
    /// the selected tone; the accent stays reserved for the model in use.
    private func railTile<Mark: View>(
        label: String,
        count: Int?,
        active: Bool,
        choose target: JunoModelSelectorCatalog.Filter,
        @ViewBuilder mark: () -> Mark
    ) -> some View {
        Button {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                filter = target
                query = ""
                cursorKey = nil
            }
        } label: {
            mark()
        }
        .buttonStyle(JunoCatalogTileStyle(active: active))
        .help(count.map { "\(label) \($0)" } ?? label)
        .accessibilityLabel(label)
        .accessibilityValue(count.map { "\($0) models" } ?? "")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // MARK: List

    private var listColumn: some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, JunoSpace.tight)
            Divider()
            if groups.isEmpty {
                emptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list
            }
        }
        .frame(width: metrics.catalogWidth)
    }

    private var searchField: some View {
        HStack(spacing: JunoSpace.close) {
            JunoIconView(.search, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            TextField("Search models…", text: $query)
                .textFieldStyle(.plain)
                .junoType(.ui)
                .focused($searchFocused)
                .onSubmit { _ = commitCursor() }
                .onChange(of: query) { _, _ in cursorKey = nil }
                .accessibilityLabel("Search models")
                .accessibilityIdentifier("juno.model-selector.search")
            if isSearching {
                Button {
                    query = ""
                } label: {
                    JunoIconView(.close, size: 12)
                }
                .buttonStyle(JunoCatalogTileStyle(active: false, side: 24))
                .help("Clear search")
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, JunoSpace.close)
        .frame(height: 40)
        .onAppear { searchFocused = true }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(groups) { group in
                        groupView(group)
                    }
                }
                .padding(.horizontal, JunoSpace.snug)
                .padding(.top, JunoSpace.tight)
                .padding(.bottom, JunoSpace.cozy)
                .id(filter)
                .transition(.opacity)
            }
            .scrollIndicators(.automatic)
            .onAppear { placeOnSelection(proxy) }
            .onChange(of: cursorKey) { _, key in
                guard let key, keyboardMoved else { return }
                keyboardMoved = false
                proxy.scrollTo(key)
            }
        }
    }

    /// Whether the last cursor move came from the keyboard, which scrolls the
    /// row into view; a pointer move never scrolls.
    @State private var keyboardMoved = false

    @ViewBuilder
    private func groupView(_ group: JunoModelSelectorCatalog.Group) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if group.showsLabel {
                sectionLabel(group.label, count: group.count)
                    .id("group:" + group.id)
            }
            ForEach(group.current) { row in
                rowView(row)
            }
            if !group.legacy.isEmpty {
                legacyToggle(group)
                if isSearching || expandedLegacy.contains(group.id) {
                    ForEach(group.legacy) { row in
                        rowView(row)
                    }
                    .transition(.opacity)
                }
            }
        }
        .padding(.bottom, group.id == "auto:" ? JunoSpace.snug : 0)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(group.label)
    }

    @ViewBuilder
    private func rowView(_ row: JunoModelSelectorCatalog.Row) -> some View {
        switch row {
        case .model(let model, _):
            modelRow(model, key: row.id)
        case .modality(let modality, let count, _):
            sectionLabel(JunoModelSelectorCatalog.modalityLabel(modality), count: count)
                .id(row.id)
        }
    }

    /// The one heading shape in the list: a word, and an optional count. It
    /// draws the lab groups, the modality groups, Favorites and Recent alike.
    private func sectionLabel(_ label: String, count: Int?) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Text(label)
                .junoType(JunoType.caption.weight(.medium))
                .foregroundStyle(Color.junoSecondaryInk)
            if let count {
                Text("\(count)")
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk.opacity(0.7))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.close)
        .padding(.top, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.hairline)
        .accessibilityHidden(true)
    }

    private func modelRow(_ model: JunoModelDescriptor, key: String) -> some View {
        let auto = JunoModelSelectorCatalog.isAuto(model)
        let active = model.id == selectedModelID
        let soon = JunoModelSelectorCatalog.isComingSoon(model)
        let locked = JunoModelSelectorCatalog.isLocked(model)
        let starred = !auto && favorites.contains(model.id)

        return Button {
            choose(model, key: key)
        } label: {
            HStack(spacing: JunoSpace.close) {
                rowMark(model, auto: auto)
                Text(model.displayName)
                    .junoType(active ? JunoType.ui.weight(.medium) : .ui)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: JunoSpace.hairline)
                if starred {
                    JunoIconView(.star, size: 12, isOn: true)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                ZStack {
                    if active {
                        JunoIconView(.check, size: 16)
                            .foregroundStyle(Color.junoForeground)
                    } else if locked {
                        JunoIconView(.lock, size: 12)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
                .frame(width: 16)
            }
            .padding(.horizontal, JunoSpace.close)
            .frame(height: JunoModelSelectorMetrics.rowHeight)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(Color.junoGlassHover.opacity(cursorKey == key ? 1 : 0))
            }
            .contentShape(.rect)
            .opacity(soon ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(soon)
        .id(key)
        .onContinuousHover(coordinateSpace: .global) { phase in
            guard case .active(let point) = phase, point != lastPointer else { return }
            lastPointer = point
            if cursorKey != key { cursorKey = key }
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: cursorKey == key)
        .accessibilityLabel(JunoModelSelectorCatalog.accessibilityLabel(model))
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    @ViewBuilder
    private func rowMark(_ model: JunoModelDescriptor, auto: Bool) -> some View {
        if auto {
            // Auto wears the product's mark on a small bordered tile, the web's.
            JunoMark(size: 10)
                .foregroundStyle(Color.junoForeground)
                .frame(width: 16, height: 16)
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                        .fill(Color.junoCard)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                        .strokeBorder(Color.junoBorder.opacity(0.55), lineWidth: 1)
                }
                .frame(width: 18, height: 18)
        } else {
            JunoProviderMark(providerID: model.providerID, providerName: model.providerName, size: 18)
        }
    }

    private func legacyToggle(_ group: JunoModelSelectorCatalog.Group) -> some View {
        let open = isSearching || expandedLegacy.contains(group.id)
        return Button {
            withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                if expandedLegacy.contains(group.id) {
                    expandedLegacy.remove(group.id)
                } else {
                    expandedLegacy.insert(group.id)
                }
            }
        } label: {
            HStack(spacing: JunoSpace.snug) {
                Text("Past models")
                    .junoType(JunoType.caption.weight(.medium))
                Text("\(group.legacyCount)")
                    .junoType(.caption)
                    .monospacedDigit()
                    .opacity(0.7)
                Spacer(minLength: 0)
                JunoIconView(.chevronDown, size: 12)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.close)
            .frame(height: JunoModelSelectorMetrics.rowHeight)
            .contentShape(.rect)
        }
        .buttonStyle(JunoCatalogRowStyle())
        .disabled(isSearching)
        .accessibilityLabel("Past models")
        .accessibilityValue("\(group.legacyCount), \(open ? "shown" : "hidden")")
    }

    @ViewBuilder
    private var emptyState: some View {
        if filter == .favorites, !isSearching {
            JunoCatalogEmptyBlock(
                icon: .star,
                title: "No favorites yet",
                message: "Press the star in the panel on the right to keep a model here."
            )
        } else {
            JunoCatalogEmptyBlock(
                icon: .search,
                title: isSearching ? "No models match \u{201C}\(query.trimmingCharacters(in: .whitespaces))\u{201D}" : "No models found",
                message: "Try a lab name, a family like \u{201C}sonnet\u{201D}, or a capability like \u{201C}vision\u{201D}.",
                action: isSearching ? ("Clear search", { query = "" }) : nil
            )
        }
    }

    // MARK: Detail

    private var detailPanel: some View {
        JunoModelDetailPanel(
            model: detailModel,
            isSelected: detailModel?.id == selectedModelID,
            isStarred: detailModel.map { favorites.contains($0.id) } ?? false,
            toggleStar: toggleFavorite.flatMap { toggle in
                detailModel.map { model in { toggle(model.id) } }
            },
            use: { if let detailModel { choose(detailModel, key: cursorKey) } }
        )
        .frame(width: metrics.detailWidth)
        .background(Color.junoMuted.opacity(0.4))
    }

    // MARK: Choosing

    /// A click, Return, or the panel's button. Auto and any available model
    /// are picked and recorded as recent; a model the plan cannot reach opens
    /// the upgrade page instead, as the web routes to /upgrade; anything else
    /// only moves the cursor.
    private func choose(_ model: JunoModelDescriptor, key: String?) {
        if let key { cursorKey = key }
        if JunoModelSelectorCatalog.isLocked(model) {
            openURL(JunoBackend.productionURL.appending(path: "upgrade"))
            dismiss()
            return
        }
        guard model.unavailabilityReason == nil else { return }
        if !JunoModelSelectorCatalog.isAuto(model) {
            recentsRaw = JunoModelRecents.recording(model.id, in: recentsRaw)
        }
        select(model)
    }

    // MARK: Keyboard

    private func moveCursor(by offset: Int) -> KeyPress.Result {
        moveCursor(to: JunoModelSelectorCatalog.step(from: cursorKey, by: offset, in: order))
    }

    private func moveCursor(to key: String?) -> KeyPress.Result {
        guard let key else { return .ignored }
        keyboardMoved = true
        cursorKey = key
        return .handled
    }

    /// Return picks the cursor row, or the first row when nothing has been
    /// walked to yet. False when there is nothing to pick.
    private func commitCursor() -> Bool {
        let key = cursorKey ?? order.first
        guard let key, let model = byKey[key], model.unavailabilityReason == nil || JunoModelSelectorCatalog.isLocked(model) else {
            return false
        }
        choose(model, key: key)
        return true
    }

    /// Open on the model in use: its row lit, so the panel describes it and
    /// the arrow keys start from it, and its section scrolled into view (the
    /// heading at the top when the row fits under it, else the row centred).
    private func placeOnSelection(_ proxy: ScrollViewProxy) {
        guard !placed else { return }
        placed = true
        guard let key = JunoModelSelectorCatalog.selectedKey(selectedModelID, in: groups) else { return }
        cursorKey = key
        let anchor = JunoModelSelectorCatalog.anchorKey(for: key, in: groups)
        DispatchQueue.main.async {
            if let anchor {
                proxy.scrollTo(anchor, anchor: .top)
            } else {
                proxy.scrollTo(key, anchor: .center)
            }
        }
    }

    // MARK: Data

    private var isSearching: Bool { JunoModelSelectorCatalog.isSearching(query) }

    private var searchable: [JunoModelDescriptor] {
        JunoModelSelectorCatalog.searchable(models, query: query)
    }

    private var railLabs: [JunoModelSelectorCatalog.Lab] {
        JunoModelSelectorCatalog.labs(in: searchable)
    }

    private var groups: [JunoModelSelectorCatalog.Group] {
        JunoModelSelectorCatalog.groups(
            models: models,
            filter: filter,
            query: query,
            favorites: favorites,
            recents: JunoModelRecents.ids(in: recentsRaw)
        )
    }

    private var byKey: [String: JunoModelDescriptor] { JunoModelSelectorCatalog.modelsByKey(groups) }

    /// Every row key in display order: what the arrow keys walk.
    private var order: [String] {
        JunoModelSelectorCatalog.keyboardOrder(groups: groups, expanded: expandedLegacy, searching: isSearching)
    }

    /// The panel's subject: the cursor's model, else the model in use, else
    /// the first row (the web's `detailModel`).
    private var detailModel: JunoModelDescriptor? {
        if let cursorKey, let model = byKey[cursorKey] { return model }
        if let model = models.first(where: { $0.id == selectedModelID }) { return model }
        return groups.first?.current.compactMap(\.model).first
    }
}

// MARK: - Pieces

/// A rail tile (and the search field's clear button): a rounded square, the
/// selected tone when active, the hover tone under the pointer.
struct JunoCatalogTileStyle: ButtonStyle {
    let active: Bool
    var side: CGFloat = 32

    func makeBody(configuration: Configuration) -> some View {
        Tile(configuration: configuration, active: active, side: side)
    }

    private struct Tile: View {
        let configuration: Configuration
        let active: Bool
        let side: CGFloat
        @State private var hovered = false
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .foregroundStyle(active || hovered ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: side, height: side)
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(active ? Color.junoRowSelected : Color.junoGlassHover.opacity(hovered || configuration.isPressed ? 1 : 0))
                }
                .contentShape(.rect)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        }
    }
}

/// A full-width row that is not a model: the hover tone and nothing else.
struct JunoCatalogRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: Configuration
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(Color.junoGlassHover.opacity((hovered || configuration.isPressed) && isEnabled ? 1 : 0))
                }
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        }
    }
}

/// A centred empty state: the glyph on a quiet tile, a title, a line, and an
/// optional way out. Not a dashed well, which would be a second box inside a
/// pane that has none.
private struct JunoCatalogEmptyBlock: View {
    let icon: JunoIcon
    let title: String
    let message: String
    var action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: JunoSpace.tight) {
            JunoIconView(icon, size: 20)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 40, height: 40)
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoSecondary)
                }
                .padding(.bottom, JunoSpace.tight)
            Text(title)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
                .multilineTextAlignment(.center)
            Text(message)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.0, action: action.1)
                    .buttonStyle(.junoGlass)
                    .controlSize(.small)
                    .padding(.top, JunoSpace.tight)
            }
        }
        .padding(.horizontal, JunoSpace.region)
        .padding(.vertical, JunoSpace.vast)
    }
}

// MARK: - Detail panel

/// The catalogue's detail panel, the web's `DetailPanel`: the mark on a tile
/// and the name, the provider's id in mono, the description, a deprecation
/// line, the 2×2 grid of graded facts, the per-token prices, the capability
/// line, and at the foot the one button and the star.
struct JunoModelDetailPanel: View {
    let model: JunoModelDescriptor?
    let isSelected: Bool
    let isStarred: Bool
    let toggleStar: (() -> Void)?
    let use: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let model {
            content(model)
        } else {
            Text("Point at a model to see what it does.")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .padding(JunoSpace.roomy)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func content(_ model: JunoModelDescriptor) -> some View {
        let auto = JunoModelSelectorCatalog.isAuto(model)
        return VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: JunoSpace.cozy) {
                        Group {
                            if auto {
                                JunoMark(size: 20).foregroundStyle(Color.junoForeground)
                            } else {
                                JunoProviderMark(providerID: model.providerID, providerName: model.providerName, size: 20)
                            }
                        }
                        .frame(width: 40, height: 40)
                        .background {
                            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoCard)
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                                .strokeBorder(Color.junoForeground.opacity(0.07), lineWidth: 1)
                        }
                        Text(model.displayName)
                            .junoType(JunoType.body.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    Text(JunoModelSelectorCatalog.identifier(model))
                        .junoType(.micro)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .padding(.top, JunoSpace.micro)

                    if let summary = model.summary, !summary.isEmpty {
                        Text(summary)
                            .junoType(.caption)
                            .lineSpacing(3)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, JunoSpace.cozy)
                    }

                    if let notice = JunoModelSelectorCatalog.retirementNotice(model) {
                        Text(notice)
                            .junoType(.caption)
                            .foregroundStyle(Color.junoWarningInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, JunoSpace.cozy)
                    }

                    if !auto {
                        facts(model)
                    }

                    if JunoModelSelectorCatalog.isOtherwiseUnavailable(model), let reason = model.unavailabilityReason {
                        Text(reason)
                            .junoType(.caption)
                            .foregroundStyle(Color.junoWarningInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, JunoSpace.regular)
                    }
                }
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .id(model.id)
            .scrollIndicators(.automatic)

            Divider()
            footer(model, auto: auto)
                .padding(JunoSpace.cozy)
        }
    }

    @ViewBuilder
    private func facts(_ model: JunoModelDescriptor) -> some View {
        let stats = JunoModelSelectorCatalog.stats(model)
        if !stats.isEmpty {
            Grid(alignment: .leading, horizontalSpacing: JunoSpace.regular, verticalSpacing: JunoSpace.comfy) {
                ForEach(Array(stride(from: 0, to: stats.count, by: 2)), id: \.self) { start in
                    GridRow {
                        statView(stats[start])
                        if start + 1 < stats.count {
                            statView(stats[start + 1])
                        } else {
                            Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                        }
                    }
                }
            }
            .padding(.top, JunoSpace.regular)
        }

        if model.modality != .audio, let price = model.price, !price.isFree {
            VStack(spacing: JunoSpace.hairline) {
                priceRow("In / MTok", JunoModelSelectorCatalog.formatPrice(price.inputPerMillion))
                priceRow("Out / MTok", JunoModelSelectorCatalog.formatPrice(price.outputPerMillion))
            }
            .padding(.top, JunoSpace.regular)
        }

        if let caps = JunoModelSelectorCatalog.capabilityLine(model) {
            Text(caps)
                .junoType(.micro)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.regular)
        }
    }

    /// The number, then a rule under it: what lets four of them be compared
    /// down a column without reading any. Ink, never the accent, which here
    /// means "selected" and nothing else.
    private func statView(_ stat: JunoModelSelectorCatalog.Stat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(stat.label)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.hairline) {
                Text(stat.value)
                    .junoType(JunoType.body.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let unit = stat.unit {
                    Text(unit)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            .padding(.top, JunoSpace.micro)
            Capsule()
                .fill(Color.junoForeground.opacity(0.08))
                .frame(height: 4)
                .overlay(alignment: .leading) {
                    GeometryReader { geometry in
                        Capsule()
                            .fill(Color.junoForeground.opacity(0.7))
                            .frame(width: geometry.size.width * CGFloat(max(0, min(10, stat.score))) / 10)
                            .animation(JunoMotion.reduced(JunoMotion.slow, when: reduceMotion), value: stat.score)
                    }
                }
                .clipShape(Capsule())
                .padding(.top, JunoSpace.snug)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stat.label)
        .accessibilityValue("\(stat.value)\(stat.unit ?? "")")
    }

    private func priceRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
            Spacer(minLength: JunoSpace.snug)
            Text(value).monospacedDigit()
        }
        .junoType(.micro)
        .foregroundStyle(Color.junoSecondaryInk)
    }

    /// The accent is an action here, not a status: "Use this model" and
    /// "Get Plus" are prominent; "Selected" is a quiet, inert label.
    @ViewBuilder
    private func footer(_ model: JunoModelDescriptor, auto: Bool) -> some View {
        let label = JunoModelSelectorCatalog.useLabel(model, selected: isSelected)
        let inert = isSelected
            || JunoModelSelectorCatalog.isComingSoon(model)
            || JunoModelSelectorCatalog.isOtherwiseUnavailable(model)
        HStack(spacing: JunoSpace.snug) {
            Group {
                if inert {
                    Button(action: use) {
                        Text(label).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.junoGlass)
                    .disabled(true)
                } else {
                    Button(action: use) {
                        Text(label).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.junoProminent)
                }
            }
            .controlSize(.large)
            .accessibilityIdentifier("juno.model-selector.use")

            if !auto, let toggleStar {
                Button(action: toggleStar) {
                    JunoIconView(.star, size: 14, isOn: isStarred)
                        .foregroundStyle(isStarred ? Color.junoAccent : Color.junoSecondaryInk)
                        .contentTransition(.opacity)
                }
                .buttonStyle(JunoCatalogTileStyle(active: false, side: 28))
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isStarred)
                .help(isStarred ? "Remove from favorites" : "Add to favorites")
                .accessibilityLabel(isStarred ? "Remove from favorites" : "Add to favorites")
                .accessibilityAddTraits(isStarred ? [.isButton, .isSelected] : .isButton)
            }
        }
    }
}

// MARK: - Recents

/// The "Recent" record, as the string `@AppStorage` keeps it: the web's
/// `juno:models:recent`, newest first.
public enum JunoModelRecents {
    /// The `UserDefaults` key. Shared by every product's selector on purpose.
    public static let key = "juno.model-selector.recent"
    /// The web's `RECENT_MAX`.
    public static let limit = 3

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

// MARK: - Geometry

/// The catalogue's fixed geometry: the web's 640 by 380 to 500, clamped to
/// the window.
public struct JunoModelSelectorMetrics: Equatable, Sendable {
    public let railWidth: CGFloat
    public let catalogWidth: CGFloat
    public let detailWidth: CGFloat
    public let height: CGFloat

    /// One model row: the web's `h-9`.
    public static let rowHeight: CGFloat = 36

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

    /// Rail + list + detail + the two dividers between them.
    public var width: CGFloat { railWidth + catalogWidth + detailWidth + 2 }

    public var size: CGSize { CGSize(width: width, height: height) }

    /// 48 · 318 · 272, 480 tall: the website's catalogue, 640 wide.
    public static let standard = JunoModelSelectorMetrics(
        railWidth: 48,
        catalogWidth: 318,
        detailWidth: 272,
        height: 480
    )

    /// These metrics, shrunk to fit inside a window of `size` with a gutter.
    /// The rail and the detail panel keep their widths; the list and the
    /// height give.
    public func clamped(to size: CGSize?, gutter: CGFloat = 48) -> JunoModelSelectorMetrics {
        guard let size else { return self }
        let maxWidth = max(railWidth + detailWidth + 200, size.width - gutter)
        let maxHeight = max(380, size.height - gutter)
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

/// A model control with no thinking of its own to set (Compare's columns):
/// the chip, opening the catalogue straight away.
public struct JunoModelSelectorButton: View {
    private let models: [JunoModelDescriptor]
    @Binding private var selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let placeholder: String
    private let accessibilityID: String

    @State private var stage: JunoModelPickerStage?

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

    private var label: String {
        models.first { $0.id == selectedModelID }?.displayName
            ?? (selectedModelID.isEmpty ? placeholder : selectedModelID)
    }

    public var body: some View {
        JunoModelPickerControl(
            stage: $stage,
            ladder: .unavailable,
            stopID: .constant(nil),
            modelName: label,
            catalogSize: metrics.size,
            isEnabled: !models.isEmpty,
            accessibilityValue: label,
            accessibilityID: accessibilityID,
            help: "The model this conversation's next turn runs on"
        ) { open in
            JunoModelChipLabel(name: label, isOpen: open)
        } catalog: { close in
            JunoModelSelector(
                models: models,
                selectedModelID: selectedModelID,
                metrics: metrics,
                select: { model in
                    selectedModelID = model.id
                    close()
                }
            )
        }
    }
}
