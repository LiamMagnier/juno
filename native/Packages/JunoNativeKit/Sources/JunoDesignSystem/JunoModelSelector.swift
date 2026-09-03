import JunoCore
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// The website's model picker as one native control: lab rail · list · detail
/// panel (`src/components/chat/model-selector.tsx`).
///
/// One implementation, driven by ``JunoModelDescriptor``, so Chat and Code
/// cannot drift. The geometry is fixed on purpose — AppKit cannot safely
/// negotiate an unconstrained popover whose detail column changes with hover —
/// and it is the web's: a 760×480 float made of a 48pt rail, the list, and a
/// 272pt detail panel.
///
/// **What is native here.** The rail is a column of borderless `Button`s; the
/// list is a `List(selection:)` whose selection *is* the keyboard cursor, with
/// a `Section` per lab and a `DisclosureGroup` folding each lab's superseded
/// generations; the search is a `TextField`; the one primary action is the
/// system's prominent button. Juno states only what the platform cannot: the
/// selection's colour, a row's words, the meters.
///
/// **What a row is.** The provider mark, the name, the price glyph in mono, and
/// a check on the model in use. A deprecated row carries its last day in the
/// caution ink. Everything else about a model — description, capabilities, the
/// four meters, pricing — lives in the detail panel, which follows the pointer
/// and the arrow keys.
///
/// **What is deliberately not here.** No "Recently used" block: the list is
/// the answer, and a second copy of three rows above it padded the catalog
/// with duplicates. No thinking slider: effort is the composer's own chip.
public struct JunoModelSelector: View {
    private let models: [JunoModelDescriptor]
    private let selectedModelID: String
    private let metrics: JunoModelSelectorMetrics
    private let select: (JunoModelDescriptor) -> Void

    @Environment(\.junoAccessibility) private var accessibility
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var query = ""
    @State private var providerID: String?
    /// The keyboard cursor — the list's selection — and, absent a pointer, the
    /// detail panel's subject.
    @State private var cursorID: String?
    /// The row under the pointer. Previews in the detail panel without moving
    /// the list's selection: a native list's selection does not chase the mouse.
    @State private var hoverID: String?
    @State private var expandedLegacy: Set<String> = []
    @FocusState private var searchFocused: Bool
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
            labRail
            Divider()
            catalog
            Divider()
            detailPanel
        }
        .frame(width: metrics.width, height: metrics.height)
        .clipped()
        // The one place in the design system that clamps Dynamic Type, and the
        // clamp is a consequence of the fixed frame: at AX5 the rail, the list
        // and the 272pt panel would each need roughly twice the width they have.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .onKeyPress(.downArrow) { moveCursor(by: 1); return .handled }
        .onKeyPress(.upArrow) { moveCursor(by: -1); return .handled }
        .onKeyPress(.return) { commitCursor() ? .handled : .ignored }
        .onKeyPress(.escape) { dismiss(); return .handled }
        .onAppear {
            if cursorID == nil { cursorID = selectedModelID }
        }
        .accessibilityIdentifier("juno.model-selector")
    }

    // MARK: Rail

    /// 48pt of 32pt tiles: "All labs" first, a short rule, then one per lab in
    /// the web's order. The chosen tile sits on the sidebar's selection fill;
    /// the rest are bare marks.
    private var labRail: some View {
        ScrollView {
            VStack(spacing: JunoSpace.hairline) {
                railTile(id: nil, name: "All labs", count: models.count) {
                    JunoIconView(.grid, size: 16)
                }

                Divider()
                    .frame(width: 20)
                    .padding(.vertical, 2)

                ForEach(labs) { lab in
                    railTile(id: lab.id, name: lab.name, count: lab.count) {
                        JunoProviderMark(providerID: lab.id, providerName: lab.name, size: 16)
                    }
                }
            }
            .padding(.vertical, JunoSpace.snug)
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
                hoverID = nil
            }
        } label: {
            mark()
                .foregroundStyle(active ? Color.junoForeground : Color.junoMutedForeground)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                        .fill(active ? Color.junoSidebarSelection : Color.clear)
                )
                // The tile draws at 32; the target is the full 44 around it.
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .help("\(name) · \(count)")
        .accessibilityLabel(name)
        .accessibilityValue("\(count) models")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // MARK: Catalog

    private var catalog: some View {
        VStack(spacing: 0) {
            TextField("Search models…", text: $query)
                .textFieldStyle(.roundedBorder)
                .junoFont(size: 13, relativeTo: .subheadline)
                .focused($searchFocused)
                .padding(JunoSpace.snug)
                .onChange(of: query) { _, _ in
                    cursorID = nil
                    hoverID = nil
                }
                .onAppear { searchFocused = true }
                .accessibilityLabel("Search models")
                .accessibilityIdentifier("juno.model-selector.search")

            Divider()

            if groups.isEmpty {
                ContentUnavailableView.search(text: query)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    List(selection: $cursorID) {
                        ForEach(groups) { group in
                            Section {
                                ForEach(group.current) { row in
                                    catalogRow(row)
                                }
                                if !group.legacy.isEmpty {
                                    DisclosureGroup(isExpanded: legacyExpansion(group.id)) {
                                        ForEach(group.legacy) { row in
                                            catalogRow(row)
                                        }
                                    } label: {
                                        Text("Past models · \(group.legacyCount)")
                                            .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                                            .junoSecondaryInk()
                                    }
                                    .tint(Color.junoMutedForeground)
                                    .listRowInsets(rowInsets)
                                    .listRowSeparator(.hidden)
                                    .selectionDisabled()
                                }
                            } header: {
                                Text(group.label)
                                    .monospaced()
                                    .junoSidebarSection()
                                    .padding(.top, JunoSpace.hairline)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    // Says what colour a selection is and leaves the drawing to
                    // the list; the row fill below covers the emphasised state
                    // the tint cannot reach.
                    .tint(Color.junoSidebarSelection)
                    .onChange(of: cursorID) { _, id in
                        guard let id else { return }
                        proxy.scrollTo(id, anchor: nil)
                    }
                }
            }
        }
        .frame(width: metrics.catalogWidth)
    }

    private var rowInsets: EdgeInsets {
        EdgeInsets(top: 0, leading: JunoSpace.snug, bottom: 0, trailing: JunoSpace.snug)
    }

    @ViewBuilder
    private func catalogRow(_ row: JunoModelSelectorCatalog.Row) -> some View {
        switch row {
        case .modality(let modality):
            modalityCaption(modality)
        case .model(let model):
            modelRow(model)
        }
    }

    /// The small mono "Image" / "Video" line that introduces a lab's non-text
    /// rows — the web's `ModalityLabel`. Not a row the cursor can land on.
    private func modalityCaption(_ modality: JunoModelModality) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(modality == .video ? .play : .image, size: 11)
            Text(modality.sectionTitle)
        }
        .junoFont(size: 10, relativeTo: .caption2, design: .monospaced)
        .junoMetaInk()
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.top, JunoSpace.tight)
        .padding(.bottom, 2)
        .listRowInsets(rowInsets)
        .listRowSeparator(.hidden)
        .selectionDisabled()
        .accessibilityHidden(true)
    }

    /// One row. The mark, the name, a "Smart" tag on the router, the last day
    /// of a deprecated model, the price glyph, a check on the model in use.
    /// Flat at rest; the cursor's row takes the sidebar's selection fill.
    private func modelRow(_ model: JunoModelDescriptor) -> some View {
        let auto = JunoModelSelectorCatalog.isAuto(model)
        let selected = model.id == selectedModelID
        let soon = JunoModelSelectorCatalog.isComingSoon(model)
        let retirement = JunoModelSelectorCatalog.retirementLabel(model)
        let trailing = JunoModelSelectorCatalog.trailingLabel(model)

        return Button {
            choose(model)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoProviderMark(
                    providerID: model.providerID,
                    providerName: model.providerName,
                    size: 16
                )
                .padding(.leading, 2)

                Text(model.displayName)
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                    .junoInk()
                    .lineLimit(1)
                    .truncationMode(.tail)

                if auto {
                    JunoCapsuleTag("Smart", tint: Color.junoAccent)
                }

                Spacer(minLength: JunoSpace.hairline)

                if let retirement {
                    Text(retirement)
                        .junoFont(size: 10, relativeTo: .caption2, design: .monospaced)
                        .foregroundStyle(Color.junoCaution)
                        .lineLimit(1)
                }

                if !trailing.isEmpty {
                    Text(trailing)
                        .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                        .monospacedDigit()
                        .junoSecondaryInk()
                        .lineLimit(1)
                }

                if selected {
                    JunoIconView(.check, size: 14)
                        .foregroundStyle(Color.junoAccent)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
            .opacity(soon ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(soon)
        .tag(model.id)
        .id(model.id)
        .listRowInsets(rowInsets)
        .listRowSeparator(.hidden)
        .catalogRowSelection(model.id == cursorID)
        .onHover { hovering in
            if hovering {
                hoverID = model.id
            } else if hoverID == model.id {
                hoverID = nil
            }
        }
        .accessibilityLabel(
            [
                model.displayName,
                model.shortProviderName,
                selected ? "selected" : nil,
                retirement,
                model.unavailabilityReason,
            ]
            .compactMap { $0 }
            .joined(separator: ", ")
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Detail

    private var detailPanel: some View {
        Group {
            if let previewModel {
                JunoModelDetailPanel(
                    model: previewModel,
                    isSelected: previewModel.id == selectedModelID,
                    use: { choose(previewModel) }
                )
            } else {
                Text("Hover a model to compare intelligence, speed, context and cost.")
                    .junoFont(size: 12, relativeTo: .caption)
                    .junoSecondaryInk()
                    .multilineTextAlignment(.center)
                    .padding(JunoSpace.roomy)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: metrics.detailWidth)
        .background(Color.junoSurface)
    }

    // MARK: Choosing

    /// A click, Return, or the pinned button. Auto and any available model are
    /// picked; a plan-gated model opens the upgrade page instead, the way the
    /// web routes to `/upgrade`; anything else only moves the cursor.
    private func choose(_ model: JunoModelDescriptor) {
        // A click is also a cursor move. `List(selection:)` does not reliably
        // update its binding when its row contains a plain Button, and leaving
        // the old cursor behind would make the detail pane describe a model the
        // reader has just replaced.
        cursorID = model.id
        if let _ = JunoModelSelectorCatalog.requiredPlan(model) {
            openURL(JunoBackend.productionURL.appending(path: "upgrade"))
            dismiss()
            return
        }
        guard model.unavailabilityReason == nil else {
            cursorID = model.id
            return
        }
        recentsRaw = JunoModelRecents.recording(model.id, in: recentsRaw)
        select(model)
    }

    // MARK: Keyboard

    private func moveCursor(by offset: Int) {
        guard let next = JunoModelSelectorCatalog.step(from: cursorID, by: offset, in: order) else {
            return
        }
        hoverID = nil
        cursorID = next
    }

    /// Return picks the cursor row, or the first row when nothing has been
    /// walked to yet. False when there is nothing to pick.
    private func commitCursor() -> Bool {
        let id = cursorID ?? order.first
        guard let id, let model = models.first(where: { $0.id == id }),
              model.unavailabilityReason == nil
        else { return false }
        choose(model)
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

    private var isSearching: Bool { JunoModelSelectorCatalog.isSearching(query) }

    private var labs: [JunoModelSelectorCatalog.Lab] {
        JunoModelSelectorCatalog.labs(in: models)
    }

    private var groups: [JunoModelSelectorCatalog.Group] {
        JunoModelSelectorCatalog.groups(models: models, providerID: providerID, query: query)
    }

    /// Every id in display order — what ↑/↓ walk.
    private var order: [String] {
        JunoModelSelectorCatalog.keyboardOrder(
            groups: groups,
            expanded: expandedLegacy,
            searching: isSearching
        )
    }

    /// The panel's subject: the row under the pointer, else the cursor, else
    /// the model in use, else the first visible row — the web's `sheetModel`.
    private var previewModel: JunoModelDescriptor? {
        if let hoverID, let model = models.first(where: { $0.id == hoverID }) { return model }
        if let cursorID, let model = models.first(where: { $0.id == cursorID }) { return model }
        if let model = models.first(where: { $0.id == selectedModelID }) { return model }
        return groups.first?.current.compactMap(\.model).first
    }
}

private extension View {
    /// The cursor row's fill: the sidebar's selection colour, drawn by Juno
    /// because the platform's emphasised selection cannot be recoloured. The
    /// desktop chrome owns the rule; other platforms draw the same pill.
    @ViewBuilder
    func catalogRowSelection(_ selected: Bool) -> some View {
        #if os(macOS)
        junoSidebarRowSelection(selected)
        #else
        listRowBackground(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(selected ? Color.junoSidebarSelection : Color.clear)
                .padding(.horizontal, JunoSpace.tight)
        )
        #endif
    }
}

// MARK: - Detail panel

/// The picker's detail panel — the web's `DetailPanel`: name and provider
/// tile, the lab · context · date line, a deprecation notice, the description,
/// capability chips, the meters, pricing, and one pinned button.
struct JunoModelDetailPanel: View {
    let model: JunoModelDescriptor
    let isSelected: Bool
    let use: () -> Void

    private var auto: Bool { JunoModelSelectorCatalog.isAuto(model) }
    /// Meters use Juno's coral rather than a provider mark's colour. Some labs
    /// brand in near-black, which makes a filled segment indistinguishable from
    /// an empty one in one of the two appearances.
    private var accent: Color { .junoAccent }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    if auto {
                        autoBody
                    } else {
                        modelBody
                    }
                }
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.automatic)

            Divider()

            Button(action: use) {
                Text(JunoModelSelectorCatalog.useLabel(model, selected: isSelected))
                    .junoFont(size: 13, relativeTo: .subheadline, weight: .medium)
                    .frame(maxWidth: .infinity)
                    .contentShape(.rect)
            }
            .junoProminentAction()
            .controlSize(.large)
            .disabled(isSelected || JunoModelSelectorCatalog.isComingSoon(model) || otherwiseUnavailable)
            .padding(JunoSpace.cozy)
            .accessibilityIdentifier("juno.model-selector.use")
        }
    }

    /// Unavailable for a reason neither "soon" nor a plan — nothing the button
    /// can do about it.
    private var otherwiseUnavailable: Bool {
        model.unavailabilityReason != nil
            && !JunoModelSelectorCatalog.isComingSoon(model)
            && JunoModelSelectorCatalog.requiredPlan(model) == nil
    }

    // MARK: A model

    @ViewBuilder
    private var modelBody: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                Text(model.displayName)
                    .junoFont(size: 15, relativeTo: .headline, weight: .semibold)
                    .junoInk()
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                providerTile
            }
            metaLine
        }

        if let notice = JunoModelSelectorCatalog.retirementNotice(model) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                JunoIconView(.triangleAlert, size: 11)
                Text(notice)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .junoFont(size: 11, relativeTo: .caption, weight: .medium)
            .foregroundStyle(Color.junoCaution)
            .help(model.deprecationNote ?? "Deprecated by the provider")
        }

        Text(model.summary ?? "Capable foundation model.")
            .junoFont(size: 12, relativeTo: .caption)
            .lineSpacing(3)
            .junoSecondaryInk()
            .fixedSize(horizontal: false, vertical: true)

        let chips = JunoModelSelectorCatalog.chips(model)
        if !chips.isEmpty {
            JunoChipFlow(spacing: JunoSpace.hairline, lineSpacing: JunoSpace.hairline) {
                ForEach(chips, id: \.label) { chip in
                    JunoCapsuleTag(chip.label, icon: chip.icon)
                }
            }
        }

        let meters = JunoModelSelectorCatalog.meters(model)
        if !meters.isEmpty {
            Divider()
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ForEach(meters, id: \.label) { meter in
                    MeterBars(label: meter.label, value: meter.value, accent: accent)
                }
            }
        }

        if pricingLine != nil || JunoModelSelectorCatalog.requiredPlan(model) != nil {
            Divider()
            VStack(alignment: .leading, spacing: 2) {
                Text("Pricing")
                    .junoFont(size: 10, relativeTo: .caption2, design: .monospaced)
                    .junoSecondaryInk()
                if let pricingLine {
                    pricingLine
                        .junoFont(size: 12, relativeTo: .caption)
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let plan = JunoModelSelectorCatalog.requiredPlan(model) {
                    Text("Requires the \(plan) plan.")
                        .junoFont(size: 11, relativeTo: .caption)
                        .junoSecondaryInk()
                        .padding(.top, 2)
                }
            }
        }

        if otherwiseUnavailable, let reason = model.unavailabilityReason {
            Text(reason)
                .junoFont(size: 11, relativeTo: .caption)
                .foregroundStyle(Color.junoCaution)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A 28pt tile with the lab's mark — the web's bordered square.
    private var providerTile: some View {
        JunoProviderMark(providerID: model.providerID, providerName: model.providerName, size: 16)
            .frame(width: 28, height: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                    .fill(Color.junoMuted.opacity(0.4))
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            )
    }

    /// "Anthropic · 1M context · 2026-06": the lab, then the numbers in mono.
    private var metaLine: some View {
        var line = Text(model.shortProviderName)
        if model.modality == .chat, let context = model.contextWindowTokens {
            line = line + Text(" · ")
                + Text("\(JunoModelFormatting.contextWindow(context)) context").monospaced()
        }
        if let released = model.released {
            line = line + Text(" · ") + Text(released).monospaced()
        }
        return line
            .junoFont(size: 10, relativeTo: .caption2)
            .junoSecondaryInk()
            .fixedSize(horizontal: false, vertical: true)
    }

    /// "$3 in · $15 out / MTok", "Free", or the product's own line.
    private var pricingLine: Text? {
        if let price = model.price {
            if price.isFree {
                return Text("Free").fontWeight(.semibold)
            }
            return Text(JunoModelSelectorCatalog.formatPrice(price.inputPerMillion)).fontWeight(.semibold)
                + Text(" in ").foregroundStyle(Color.junoMutedForeground)
                + Text("· ").foregroundStyle(Color.junoMutedForeground.opacity(0.5))
                + Text(JunoModelSelectorCatalog.formatPrice(price.outputPerMillion)).fontWeight(.semibold)
                + Text(" out / MTok").foregroundStyle(Color.junoMutedForeground)
        }
        if let detail = model.priceDetail {
            return Text(detail).foregroundStyle(Color.junoMutedForeground)
        }
        return nil
    }

    // MARK: Auto

    private static let autoTiers: [(String, String)] = [
        ("1", "Everyday prompt → Fast models · Instant"),
        ("2", "Coding & analysis → Mid tier · Balanced"),
        ("3", "Deep reasoning → Flagship · Deep thinking"),
    ]

    @ViewBuilder
    private var autoBody: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(model.displayName)
                    .junoFont(size: 15, relativeTo: .headline, weight: .semibold)
                    .junoInk()
                JunoCapsuleTag("Recommended", tint: Color.junoAccent)
            }
            Spacer(minLength: 0)
            providerTile
        }

        (Text("Routes each message to the ")
            + Text("optimal model").fontWeight(.medium).foregroundStyle(Color.junoForeground)
            + Text(" and ")
            + Text("thinking depth").fontWeight(.medium).foregroundStyle(Color.junoForeground)
            + Text(" for speed, intelligence and cost."))
            .junoFont(size: 12, relativeTo: .caption)
            .lineSpacing(3)
            .junoSecondaryInk()
            .fixedSize(horizontal: false, vertical: true)

        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(Self.autoTiers, id: \.0) { number, line in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(number)
                        .junoFont(size: 11, relativeTo: .caption, weight: .bold, design: .monospaced)
                        .foregroundStyle(Color.junoAccent)
                    Text(line)
                        .junoFont(size: 11, relativeTo: .caption)
                        .junoSecondaryInk()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }

        Divider()

        Text("Respects your plan limits, image needs, and web search settings.")
            .junoFont(size: 10, relativeTo: .caption2)
            .junoMetaInk()
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The web's `MetricBars`: a label, the value over ten, and ten capsules of
/// which the first `value` carry Juno's coral brand accent. The number is in the
/// accessibility label as well, so the reading never depends on colour alone.
private struct MeterBars: View {
    let label: String
    let value: Int
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .junoSecondaryInk()
                Spacer()
                Text("\(value)/10")
                    .monospacedDigit()
                    .junoMetaInk()
            }
            .junoFont(size: 10, relativeTo: .caption2, design: .monospaced)
            HStack(spacing: JunoSpace.hairline) {
                ForEach(0..<10, id: \.self) { index in
                    Capsule()
                        .fill(index < value ? accent : Color.junoMuted)
                        .frame(height: 10)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value) out of 10")
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

/// The selector's fixed geometry — the web's 760×480, clamped to the window.
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

    /// 48 · 438 · 272, 480 tall: the website's picker, 760 wide.
    public static let standard = JunoModelSelectorMetrics(
        railWidth: 48,
        catalogWidth: 438,
        detailWidth: 272,
        height: 480
    )

    /// These metrics, shrunk to fit inside a window of `size` with a gutter.
    /// The rail and the detail panel keep their widths; the list and the
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
                    providerID: selected?.providerID ?? JunoModelSelectorCatalog.junoProviderID,
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
