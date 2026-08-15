import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import SwiftUI

// MARK: - Compact composer control

/// The selected model, as it appears inside the composer's bottom row: the
/// provider's real mark, the human name, a disclosure chevron. Never a raw model
/// id, and never a full-width row of its own — it is one control among several
/// on a single line, exactly as on the website.
struct JunoMobileModelControl: View {
    let models: [NativeChatModelOption]
    @Binding var selectedModelID: String
    /// Shown when the catalog has not loaded yet, so the control still names the
    /// conversation's own model rather than sitting empty.
    let fallbackName: String
    var onSelect: (NativeChatModelOption) -> Void = { _ in }

    @State private var presented = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selected: NativeChatModelOption? {
        models.first { $0.id == selectedModelID }
    }

    var body: some View {
        Button {
            presented = true
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoProviderMark(
                    providerID: selected?.providerID ?? "juno",
                    providerName: selected?.providerName ?? "Juno",
                    size: 15
                )
                Text(selected?.displayName ?? fallbackName)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    // The name yields first when the row runs out of room; the
                    // mark and the chevron are what keep the control readable.
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                    // Keyed on the model, so picking a different one *replaces*
                    // the name in place rather than mutating it letter by letter
                    // — the web's `<span key={current.id} className="animate-fade-in">`.
                    .id(selectedModelID)
                    .transition(.opacity)
                    .animation(
                        JunoMotion.reduced(
                            JunoMotion.outSoft(JunoMotion.Duration.base),
                            when: reduceMotion,
                            tier: .tint
                        ),
                        value: selectedModelID
                    )
                // One chevron, turning over — the web's `rotate-180` when the
                // popover opens. `chevron.up.chevron.down` cannot do that: it is
                // symmetrical, so a 180° turn is indistinguishable from no turn
                // at all, and it stated a direction the picker does not have.
                Image(systemName: "chevron.up")
                    .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
                    .junoSecondaryInk()
                    .rotationEffect(.degrees(presented ? 180 : 0))
                    .animation(
                        JunoMotion.reduced(
                            JunoMotion.outSoft(JunoMotion.Duration.base),
                            when: reduceMotion
                        ),
                        value: presented
                    )
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .frame(minWidth: 0)
            .modifier(JunoMobileComposerChipBackground())
            // The chip draws at its own height; the finger gets the same 44pt the
            // composer's round controls beside it already carry, in the capsule
            // shape the chip visibly is.
            .frame(minHeight: 44)
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(JunoMobileChipPressStyle())
        .accessibilityLabel("Model")
        .accessibilityValue(
            selected.map { "\($0.displayName), \($0.providerName)" } ?? fallbackName
        )
        .accessibilityHint("Opens the model picker")
        .accessibilityIdentifier("juno.mobile.chat-model")
        .popover(isPresented: $presented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            // The layout is chosen here, from the *composer's* size class, not
            // inside the presentation: a SwiftUI popover reports compact to its
            // own content even on a 13" iPad, which would silently give the iPad
            // the phone layout.
            if sizeClass == .regular {
                selector(layout: .wide).frame(width: 720, height: 540)
            } else {
                selector(layout: .compact)
                    // A popover over the keyboard would be unusable on a phone,
                    // so compact width adapts to a native detent sheet carrying
                    // the same hierarchy.
                    .presentationCompactAdaptation(horizontal: .sheet, vertical: .sheet)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
        .task {
            #if DEBUG
            guard JunoComposerPreviewFlags.opensModelSelector else { return }
            // One layout pass so the popover has an anchor to attach to.
            try? await Task.sleep(nanoseconds: 400_000_000)
            presented = true
            #endif
        }
    }

    private func selector(layout: JunoMobileModelSelectorLayout) -> some View {
        JunoMobileModelSelectorView(
            models: models,
            selectedModelID: selectedModelID,
            layout: layout,
            onSelect: { model in
                selectedModelID = model.id
                onSelect(model)
                presented = false
            }
        )
    }
}

/// A modality group in the picker: the current generation, plus whatever it
/// superseded, kept apart so the older models can be collapsed.
struct JunoMobileModelSection: Identifiable {
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

/// Which of the two selector layouts to build. Decided by the presenting
/// context, never by the presentation's own (unreliable) size class.
enum JunoMobileModelSelectorLayout {
    /// One searchable column with a provider rail and inline detail.
    case compact
    /// The website's three regions — provider rail, list, detail.
    case wide
}

// MARK: - The selector

/// The model picker, in two layouts sharing every row, chip and detail view:
/// compact width gets a searchable single column with a provider rail and
/// inline detail; regular width gets the website's three regions
/// (rail · list · detail). Which one is built is decided by the presenting
/// composer, so Split View and Slide Over follow their own size class.
struct JunoMobileModelSelectorView: View {
    let models: [NativeChatModelOption]
    let selectedModelID: String
    var layout: JunoMobileModelSelectorLayout = .compact
    let onSelect: (NativeChatModelOption) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var query = ""
    @State private var provider: String?
    @State private var detailModelID: String?
    /// Which sections have had their "Older models" group opened by hand.
    @State private var expandedLegacy: Set<String> = []
    /// Flipped once, on the first layout, to run the opening cascade.
    ///
    /// A single flag rather than per-row appearance: the web staggers the list
    /// *when the popover opens*, and a row that is scrolled to later is already
    /// settled. Driving it from each row's own `onAppear` would instead make the
    /// list ripple every time it was scrolled, which is a different — and much
    /// busier — idea.
    @State private var rowsIn = false

    /// Each model's place in the flat, displayed order, so the cascade reads as
    /// one wave down the list rather than restarting at every section header.
    private var rowOrder: [String: Int] {
        var order: [String: Int] = [:]
        var index = 0
        for section in sections {
            for model in section.current + section.legacy {
                order[model.id] = index
                index += 1
            }
        }
        return order
    }

    var body: some View {
        Group {
            switch layout {
            case .wide: wideLayout
            case .compact: compactLayout
            }
        }
        .onAppear {
            rowsIn = true
            // Only the wide layout opens on a detail: it has a column for it.
            // Expanding the selected row inline on a phone would push the rest
            // of the list off a medium-detent sheet before it is even scrolled.
            if layout == .wide, detailModelID == nil { detailModelID = selectedModelID }
            #if DEBUG
            if let search = JunoComposerPreviewFlags.modelSearch { query = search }
            if let filter = JunoComposerPreviewFlags.modelProvider { provider = filter }
            #endif
        }
        // No container-level accessibilityIdentifier: SwiftUI stamps it onto
        // every descendant, overwriting the rows' and the search field's own.
    }

    // MARK: Layouts

    private var compactLayout: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !providers.isEmpty {
                    providerRail
                        .padding(.horizontal, JunoSpace.cozy)
                        .padding(.vertical, JunoSpace.snug)
                }
                List {
                    if filtered.isEmpty {
                        Section { noResults.listRowSeparator(.hidden) }
                    } else {
                        ForEach(sections) { section in
                            sectionContent(section, showsDetailToggle: true)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollDismissesKeyboard(.interactively)
            }
            // The list is reading material, so it sits on an opaque canvas.
            // Glass stays on the chrome — the chips, the composer, the search
            // bar — rather than washing out the content behind everything.
            .junoScreenCanvas()
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search models"
            )
        }
    }

    /// The website's three regions, side by side: provider rail, model list,
    /// selected-model detail.
    ///
    /// Deliberately not `NavigationSplitView`. Inside a popover the split view
    /// is handed a compact size class and collapses to its root column, so the
    /// iPad would silently get a list of providers and nothing else. The layout
    /// branch is already decided from the composer's own size class, so the
    /// adaptive behaviour a split view would provide has nothing left to do.
    private var wideLayout: some View {
        HStack(spacing: 0) {
            List {
                Section("Providers") {
                    providerListRow(id: nil, name: "All", count: chatModels.count)
                    ForEach(providers, id: \.id) { entry in
                        // The lab alone: "Anthropic · Claude" truncates in a
                        // rail this narrow, and the lab is the part that
                        // identifies the group.
                        providerListRow(
                            id: entry.id, name: entry.shortName, count: entry.count
                        )
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(width: 208)

            Divider()

            VStack(spacing: 0) {
                JunoMobileSelectorSearchField(query: $query)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.cozy)
                if filtered.isEmpty {
                    noResults
                    Spacer(minLength: 0)
                } else {
                    List {
                        ForEach(sections) { section in
                            sectionContent(section, showsDetailToggle: false)
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity)

            Divider()

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
            .frame(width: 268)
            .background(Color.junoSurface)
        }
        .background(Color.junoCanvas)
    }

    // MARK: Sections

    @ViewBuilder
    private func sectionContent(
        _ section: JunoMobileModelSection,
        showsDetailToggle: Bool
    ) -> some View {
        Section {
            ForEach(section.current) { model in
                row(model, showsDetailToggle: showsDetailToggle)
            }
            if !section.legacy.isEmpty {
                DisclosureGroup(
                    isExpanded: legacyExpansion(for: section.key)
                ) {
                    ForEach(section.legacy) { model in
                        row(model, showsDetailToggle: showsDetailToggle)
                    }
                } label: {
                    Text("Older models (\(section.legacy.count))")
                        .font(.subheadline)
                        .junoSecondaryInk()
                }
                .tint(.secondary)
                .accessibilityIdentifier("juno.mobile.model-legacy.\(section.key)")
            }
        } header: {
            Label(section.title, systemImage: section.systemImage)
                .font(.caption.weight(.semibold))
                .textCase(nil)
        }
    }

    private func legacyExpansion(for key: String) -> Binding<Bool> {
        Binding(
            get: { isSearching || expandedLegacy.contains(key) },
            set: { expanded in
                if expanded {
                    expandedLegacy.insert(key)
                } else {
                    expandedLegacy.remove(key)
                }
            }
        )
    }

    // MARK: Rows

    @ViewBuilder
    private func row(_ model: NativeChatModelOption, showsDetailToggle: Bool) -> some View {
        let reason = NativeModelPresentation.unavailabilityReason(model)
        let selected = model.id == selectedModelID
        let expanded = showsDetailToggle && detailModelID == model.id

        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                Button {
                    guard reason == nil else { return }
                    onSelect(model)
                } label: {
                    JunoMobileModelRowLabel(
                        model: model,
                        selected: selected,
                        unavailabilityReason: reason
                    )
                }
                .buttonStyle(.plain)
                .disabled(reason != nil)

                if showsDetailToggle {
                    Button {
                        // `fade-in-up`'s own timing, so the spec sheet's arrival
                        // and the row's growth are one movement.
                        withAnimation(
                            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)
                        ) {
                            detailModelID = expanded ? nil : model.id
                        }
                    } label: {
                        Image(systemName: expanded ? "chevron.up" : "info.circle")
                            .junoFont(size: 15, relativeTo: .subheadline)
                            .junoSecondaryInk()
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(expanded ? "Hide details" : "Show details")
                }
            }

            if expanded {
                JunoModelDetailView(model: model, showsHeader: false)
                    .padding(.top, JunoSpace.hairline)
                    // `fade-in-up`, keyed on the model: the spec sheet is a
                    // different set of numbers each time, and sliding it up a
                    // few points is what says so.
                    .transition(.opacity.combined(with: .offset(y: JunoSpace.tight)))
            }
        }
        .padding(.vertical, JunoSpace.hairline)
        .contentShape(Rectangle())
        // The opening cascade, `min(i, 12) * 16ms` exactly as the web caps it:
        // past a dozen rows the stagger stops adding rhythm and starts adding
        // wait, so the tail of a long list arrives together.
        .opacity(rowsIn ? 1 : 0)
        .offset(y: rowsIn ? 0 : 8)
        .animation(
            reduceMotion
                ? nil
                : JunoMotion.emphasized
                    .delay(Double(min(rowOrder[model.id] ?? 0, 12)) * 0.016),
            value: rowsIn
        )
        .onTapGesture {
            // Regular width has no inline expansion: tapping a row previews it
            // in the detail column, and the row's own button commits it.
            guard !showsDetailToggle else { return }
            detailModelID = model.id
        }
        .accessibilityIdentifier("juno.mobile.model-row.\(model.id)")
    }

    private func providerListRow(id: String?, name: String, count: Int) -> some View {
        Button {
            provider = id
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                if let id {
                    JunoProviderMark(providerID: id, providerName: name, size: 18)
                } else {
                    Image(systemName: "square.grid.2x2")
                        .junoFont(size: 14, relativeTo: .subheadline)
                        .frame(width: 18, height: 18)
                        .junoSecondaryInk()
                }
                Text(name).lineLimit(1)
                Spacer(minLength: 4)
                Text("\(count)")
                    .font(.caption.monospacedDigit())
                    .junoMetaInk()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(provider == id ? Color.junoRowSelected : Color.clear)
        .accessibilityAddTraits(provider == id ? [.isSelected] : [])
    }

    /// A horizontally scrolling provider filter — the compact-width stand-in for
    /// the website's icon rail.
    private var providerRail: some View {
        ScrollView(.horizontal) {
            HStack(spacing: JunoSpace.snug) {
                providerChip(id: nil, name: "All")
                ForEach(providers, id: \.id) { entry in
                    providerChip(id: entry.id, name: entry.shortName)
                }
            }
            .padding(.horizontal, JunoSpace.hairline)
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("juno.mobile.model-provider-rail")
    }

    private func providerChip(id: String?, name: String) -> some View {
        let active = provider == id
        return Button {
            provider = active ? nil : id
        } label: {
            HStack(spacing: JunoSpace.tight) {
                if let id {
                    JunoProviderMark(providerID: id, providerName: name, size: 15)
                }
                Text(name)
                    .font(.footnote.weight(active ? .semibold : .regular))
                    .lineLimit(1)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .foregroundStyle(active ? Color.junoAccent : .primary)
            .background {
                Capsule().fill(active ? Color.junoAccent.opacity(0.14) : Color.junoRowHover)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    private var noResults: some View {
        ContentUnavailableView.search(text: query)
            .frame(maxWidth: .infinity, minHeight: 200)
            .accessibilityIdentifier("juno.mobile.model-no-results")
    }

    // MARK: Data

    /// Chat models only. Image and video generation entries share the manifest
    /// but cannot be sent to from a chat composer, so listing them — even
    /// greyed — would only be noise.
    private var chatModels: [NativeChatModelOption] {
        models.filter(\.isChatCapable)
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

    /// One section per modality — Chat, Image, Video — matching the web
    /// selector's groups. Within a section the server's order is preserved
    /// verbatim (lab, then newest generation, then power), and superseded
    /// models are split out so they can be collapsed rather than interleaved.
    ///
    /// There is deliberately no per-provider header here: the rows already name
    /// their provider, the rail filters by lab, and a second level of headings
    /// on a phone buries the models themselves.
    private var sections: [JunoMobileModelSection] {
        JunoMobileModelSection.order.compactMap { modality in
            let models = filtered.filter { $0.modality == modality.key }
            guard !models.isEmpty else { return nil }
            return JunoMobileModelSection(
                key: modality.key,
                title: modality.title,
                systemImage: modality.systemImage,
                current: models.filter { !$0.isLegacy },
                legacy: models.filter(\.isLegacy)
            )
        }
    }

    /// Searching auto-expands the older-model groups, so a match can never hide
    /// behind a collapsed disclosure — the same rule the web selector uses.
    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
            return (id, name, Self.shortProviderName(name), counts[id] ?? 0)
        }
    }

    private func providerName(_ id: String) -> String? {
        providers.first { $0.id == id }?.name
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

/// The wide layout's search field. `.searchable` needs a navigation container
/// to render into, and the three-region layout deliberately has none, so this
/// is the same glass-capsule field the composer uses.
private struct JunoMobileSelectorSearchField: View {
    @Binding var query: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: "magnifyingglass")
                .junoSecondaryInk()
            TextField("Search models", text: $query)
                .textFieldStyle(.plain)
                .focused($focused)
                .submitLabel(.search)
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
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .background(JunoGlassBackground(cornerRadius: 12))
        .accessibilityIdentifier("juno.mobile.model-search")
    }
}

// MARK: - Row label

private struct JunoMobileModelRowLabel: View {
    let model: NativeChatModelOption
    let selected: Bool
    let unavailabilityReason: String?

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            JunoProviderMark(
                providerID: model.providerID,
                providerName: model.providerName,
                size: 22
            )
            // An optical baseline nudge against the two-line title beside it,
            // not a gap.
            .padding(.top, 1)

            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.tight) {
                    Text(model.displayName)
                        .font(.body.weight(.medium))
                        .lineLimit(2)
                    if model.choosesReasoningAutomatically {
                        Text("SMART")
                            .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
                            .padding(.horizontal, JunoSpace.tight)
                            .padding(.vertical, JunoSpace.hairline)
                            .foregroundStyle(Color.junoAccent)
                            .background {
                                Capsule().fill(Color.junoAccent.opacity(0.14))
                            }
                    }
                    if selected {
                        Image(systemName: "checkmark")
                            .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
                            .foregroundStyle(Color.junoAccent)
                    }
                    Spacer(minLength: 0)
                    if let cost = NativeModelPresentation.costGlyph(model.pricing) {
                        Text(cost)
                            .font(.caption)
                            .junoMetaInk()
                    }
                }

                Text(model.providerName)
                    .font(.caption)
                    .junoSecondaryInk()

                if let summary = model.summary {
                    Text(summary)
                        .font(.caption)
                        .junoSecondaryInk()
                        .lineLimit(2)
                }

                if let unavailabilityReason {
                    Label(unavailabilityReason, systemImage: "lock")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Color.junoCaution)
                } else {
                    JunoCapabilityChips(model: model, compact: true)
                }
            }
        }
        .opacity(unavailabilityReason == nil ? 1 : 0.55)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    private var accessibilityLabel: String {
        var parts = [model.displayName, model.providerName]
        if selected { parts.append("selected") }
        if let unavailabilityReason { parts.append(unavailabilityReason) }
        parts.append(contentsOf: NativeModelPresentation.capabilityChips(model).map(\.label))
        return parts.joined(separator: ", ")
    }
}

// MARK: - Detail
