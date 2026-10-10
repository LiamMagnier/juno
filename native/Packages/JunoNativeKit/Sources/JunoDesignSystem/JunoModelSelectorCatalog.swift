import Foundation
import SwiftUI

/// The model catalogue's arithmetic, free of SwiftUI so it can be tested
/// without a render pass: how the labs are ordered, how the list is grouped
/// (Favorites, Recent, then one group per lab with its Text / Image / Video /
/// Audio sections and its past generations folded), what the keyboard walks,
/// and the facts the detail panel prints.
///
/// Every rule here is a port of `src/components/chat/model-catalogue.tsx`,
/// `src/lib/model-picker.ts` and `src/lib/model-metrics.ts`, named the same
/// way, so the same model reads identically in the app and in the browser.
public enum JunoModelSelectorCatalog {

    // MARK: - Labs

    /// The web's `PROVIDER_LIST`: the order the rail runs in and the list is
    /// grouped by. A provider the web has not shipped sorts after all of these,
    /// in the order the manifest sent it.
    public static let labOrder: [String] = [
        "anthropic", "openai", "zhipu", "moonshot", "google", "meta", "deepseek",
        "mistral", "xai", "seedance", "minimax", "mimo", "qwen", "longcat",
    ]

    /// Auto's provider id. Not a lab: it has no rail tile, and its one row sits
    /// above every lab with no heading of its own.
    public static let junoProviderID = "juno"

    /// The product's name, which Auto's detail panel prints where a model
    /// prints its provider id (the web's `PRODUCT_NAME`).
    public static let productName = "Alevr"

    /// The router row: the web's `isAutoModelId`. A router is the one model
    /// that picks its own thinking depth, so the flag the manifest already
    /// publishes is the fact, not an id pattern.
    public static func isAuto(_ model: JunoModelDescriptor) -> Bool {
        model.choosesThinkingAutomatically || model.providerID.lowercased() == junoProviderID
    }

    /// Where a provider sits in the rail: its web rank, or past the end.
    static func labRank(_ providerID: String) -> Int {
        labOrder.firstIndex(of: providerID.lowercased()) ?? labOrder.count
    }

    /// One rail tile.
    public struct Lab: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let count: Int
    }

    /// The rail, in the web's order, from the labs the given models carry. A
    /// lab with nothing in it has no tile, so a tile can never lead to an
    /// empty list. Pass the models that match the search so the counts and the
    /// tiles answer the query, as the web's `countsByProvider` does.
    public static func labs(in models: [JunoModelDescriptor]) -> [Lab] {
        var order: [String] = []
        var names: [String: String] = [:]
        var counts: [String: Int] = [:]
        for model in models where !isAuto(model) {
            let id = model.providerID
            if counts[id] == nil {
                order.append(id)
                names[id] = model.shortProviderName
            }
            counts[id, default: 0] += 1
        }
        let ranked = order.enumerated().sorted { lhs, rhs in
            let l = labRank(lhs.element), r = labRank(rhs.element)
            return l == r ? lhs.offset < rhs.offset : l < r
        }
        return ranked.map { Lab(id: $0.element, name: names[$0.element] ?? $0.element, count: counts[$0.element] ?? 0) }
    }

    // MARK: - The rail's choice

    /// What the list is showing: everything, the account's favorites, or one
    /// lab. A query overrides all three and searches every lab.
    public enum Filter: Hashable, Sendable {
        case all
        case favorites
        case lab(String)

        public var labID: String? {
            if case .lab(let id) = self { return id }
            return nil
        }
    }

    // MARK: - Rows

    /// The web's `MODALITY_LABEL`: "Text", not "Chat", over a lab's chat rows.
    public static func modalityLabel(_ modality: JunoModelModality) -> String {
        switch modality {
        case .chat: "Text"
        case .image: "Image"
        case .video: "Video"
        case .audio: "Audio"
        }
    }

    /// One line of the list: a model, or the "Text" / "Image" / "Video" /
    /// "Audio" heading over a lab's rows of that kind.
    ///
    /// A model can be listed in Favorites, Recent and its lab at once, so a
    /// row's identity is its group's `prefix` plus the model's id: each copy is
    /// a row of its own, with its own cursor (the web's `rowKeyFor`).
    public enum Row: Identifiable, Equatable, Sendable {
        case model(JunoModelDescriptor, prefix: String)
        /// `prefix` names the group, so two labs' "Image" headings are two
        /// rows: a scroll target must be unique.
        case modality(JunoModelModality, count: Int, prefix: String)

        public var id: String {
            switch self {
            case .model(let model, let prefix): prefix + model.id
            case .modality(let modality, _, let prefix): "\(prefix)modality:\(modality.rawValue)"
            }
        }

        public var model: JunoModelDescriptor? {
            if case .model(let model, _) = self { return model }
            return nil
        }
    }

    /// One group of the list: a heading (or none), its rows, and the
    /// superseded generations folded behind "Past models".
    public struct Group: Identifiable, Equatable, Sendable {
        /// The group's key: "auto:", "favorites:", "recent:" or the lab's id.
        public let id: String
        public let label: String
        /// Whether the heading is drawn. Off for Auto, which sits above the
        /// labs on its own, and for the one lab the rail is showing, whose
        /// modality headings carry the list.
        public let showsLabel: Bool
        /// The count printed beside the heading (Favorites, Recent), or nil.
        public let count: Int?
        public let current: [Row]
        public let legacy: [Row]
        public var legacyCount: Int { legacy.filter { $0.model != nil }.count }
    }

    static let modalityOrder: [JunoModelModality] = [.chat, .image, .video, .audio]

    /// Text, image, video, audio, then the manifest's own order (the catalog's
    /// canonical generation-then-strength order, the same one the web sorts
    /// into with `sortModelsForDisplay`). A stable sort, so siblings within a
    /// modality never swap.
    static func sortedByModality(_ models: [JunoModelDescriptor]) -> [JunoModelDescriptor] {
        models.enumerated().sorted { lhs, rhs in
            let l = modalityOrder.firstIndex(of: lhs.element.modality) ?? 0
            let r = modalityOrder.firstIndex(of: rhs.element.modality) ?? 0
            return l == r ? lhs.offset < rhs.offset : l < r
        }.map(\.element)
    }

    /// A group's rows with a modality heading each time the modality changes,
    /// but only when there is more than one to change between: a lab of four
    /// chat models has no "Text" over them (the web's `renderRows`).
    static func rows(
        _ models: [JunoModelDescriptor],
        prefix: String,
        headingPrefix: String? = nil,
        byModality: Bool
    ) -> [Row] {
        let sorted = byModality ? sortedByModality(models) : models
        let kinds = Set(sorted.map(\.modality))
        guard byModality, kinds.count > 1 else {
            return sorted.map { .model($0, prefix: prefix) }
        }
        var out: [Row] = []
        var last: JunoModelModality?
        for model in sorted {
            if model.modality != last {
                let count = sorted.filter { $0.modality == model.modality }.count
                out.append(.modality(model.modality, count: count, prefix: headingPrefix ?? prefix))
            }
            last = model.modality
            out.append(.model(model, prefix: prefix))
        }
        return out
    }

    /// The words that find Auto when the reader types: the web's list.
    static let autoSearchWords = ["auto", "cheap", "route", "smart", "default", "recommended"]

    /// Below this many rows the list is the answer; a "Recent" copy only pads it.
    public static let recentMinimumList = 8

    /// Whether `query` is a search: anything but whitespace.
    public static func isSearching(_ query: String) -> Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Does this model answer the query? One predicate, so the rail's counts
    /// and the list can never disagree about what a search matches.
    public static func matches(_ model: JunoModelDescriptor, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        return model.matches(needle) || model.modality.rawValue.localizedCaseInsensitiveContains(needle)
    }

    /// Every lab model that matches the query: what the rail counts.
    public static func searchable(_ models: [JunoModelDescriptor], query: String) -> [JunoModelDescriptor] {
        models.filter { !isAuto($0) && matches($0, query: query) }
    }

    /// The list, as the web groups it.
    ///
    /// In the All view: Auto alone at the top, then Favorites, then Recent
    /// (only when the list is long enough that they save a scroll), then one
    /// group per lab. In a lab's view: that lab alone, its rows arranged by
    /// modality under their own headings. In Favorites: the starred models,
    /// grouped by lab. Typing searches every lab whatever the rail says.
    /// Superseded generations fold behind "Past models" in every lab group.
    public static func groups(
        models: [JunoModelDescriptor],
        filter: Filter,
        query: String,
        favorites: Set<String> = [],
        recents: [String] = []
    ) -> [Group] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let searching = !needle.isEmpty
        let labFilter = searching ? nil : filter.labID

        var out: [Group] = []

        if filter == .all || searching, let auto = models.first(where: isAuto) {
            let reached = !searching
                || auto.matches(needle)
                || autoSearchWords.contains { $0.localizedCaseInsensitiveContains(needle) }
            if reached {
                out.append(Group(id: "auto:", label: productName, showsLabel: false, count: nil, current: [.model(auto, prefix: "")], legacy: []))
            }
        }

        let visible = searchable(models, query: needle).filter { model in
            if let labFilter, model.providerID != labFilter { return false }
            if filter == .favorites, !searching, !favorites.contains(model.id) { return false }
            return true
        }

        if filter == .all, !searching {
            let starred = visible.filter { favorites.contains($0.id) }
            if !starred.isEmpty {
                out.append(Group(
                    id: "favorites:", label: "Favorites", showsLabel: true, count: starred.count,
                    current: rows(sortedByModality(starred), prefix: "favorites:", byModality: false), legacy: []
                ))
            }
            if visible.count >= recentMinimumList {
                let seen = Set(starred.map(\.id))
                let recent = recents.prefix(JunoModelRecents.limit).compactMap { id in
                    visible.first { $0.id == id && !seen.contains(id) }
                }
                if !recent.isEmpty {
                    out.append(Group(
                        id: "recent:", label: "Recent", showsLabel: true, count: recent.count,
                        current: rows(recent, prefix: "recent:", byModality: false), legacy: []
                    ))
                }
            }
        }

        for lab in labs(in: visible) {
            let mine = visible.filter { $0.providerID == lab.id }
            out.append(Group(
                id: lab.id,
                label: lab.name,
                showsLabel: labFilter == nil,
                count: nil,
                current: rows(mine.filter { !$0.isLegacy }, prefix: "", headingPrefix: lab.id + "/", byModality: true),
                legacy: rows(mine.filter(\.isLegacy), prefix: "legacy:", headingPrefix: lab.id + "/legacy:", byModality: true)
            ))
        }
        return out
    }

    /// The old entry point: a lab id or nil for every lab.
    public static func groups(
        models: [JunoModelDescriptor],
        providerID: String?,
        query: String
    ) -> [Group] {
        groups(models: models, filter: providerID.map(Filter.lab) ?? .all, query: query)
    }

    /// Every model row's key in display order: what the arrow keys walk. A
    /// lab's past models join the walk only while that fold is open, or while
    /// a search has opened every fold.
    public static func keyboardOrder(
        groups: [Group],
        expanded: Set<String>,
        searching: Bool
    ) -> [String] {
        var keys: [String] = []
        for group in groups {
            keys.append(contentsOf: group.current.filter { $0.model != nil }.map(\.id))
            if searching || expanded.contains(group.id) {
                keys.append(contentsOf: group.legacy.filter { $0.model != nil }.map(\.id))
            }
        }
        return keys
    }

    /// The model each row key stands for.
    public static func modelsByKey(_ groups: [Group]) -> [String: JunoModelDescriptor] {
        var out: [String: JunoModelDescriptor] = [:]
        for group in groups {
            for row in group.current + group.legacy {
                if let model = row.model { out[row.id] = model }
            }
        }
        return out
    }

    /// The selected model's row: its copy under its own lab (where the
    /// modality headings are), else wherever else it is listed. Nil when the
    /// list does not show it.
    public static func selectedKey(_ id: String, in groups: [Group]) -> String? {
        let byKey = modelsByKey(groups)
        for key in [id, "legacy:" + id] where byKey[key] != nil { return key }
        for group in groups {
            for row in group.current + group.legacy where row.model?.id == id { return row.id }
        }
        return nil
    }

    /// The heading the list scrolls to when it opens on the selected row: the
    /// nearest group or modality heading above it, when the row still fits
    /// within `window` rows of it; otherwise nil, and the row itself is
    /// centred. The web puts the heading at the top in the same case.
    public static func anchorKey(for rowKey: String, in groups: [Group], window: Int = 9) -> String? {
        for group in groups {
            for rows in [group.current, group.legacy] {
                guard let at = rows.firstIndex(where: { $0.id == rowKey }) else { continue }
                if let heading = rows[..<at].lastIndex(where: { $0.model == nil }), at - heading <= window {
                    return rows[heading].id
                }
                return group.showsLabel && at <= window ? "group:" + group.id : nil
            }
        }
        return nil
    }

    /// The key `offset` steps from `current` in `order`, wrapping at both
    /// ends. From nowhere, down lands on the first row and up on the last.
    public static func step(from current: String?, by offset: Int, in order: [String]) -> String? {
        guard !order.isEmpty else { return nil }
        let at = current.flatMap { order.firstIndex(of: $0) } ?? (offset > 0 ? -1 : order.count)
        let next = ((at + offset) % order.count + order.count) % order.count
        return order[next]
    }

    // MARK: - Plans and availability

    /// The plan a "Requires Plus" reason names, or nil for any other reason:
    /// the web's `modelRequiredPlan`, for a model the account cannot reach.
    public static func requiredPlan(_ model: JunoModelDescriptor) -> String? {
        guard let reason = model.unavailabilityReason else { return nil }
        let prefix = "Requires "
        guard reason.hasPrefix(prefix) else { return nil }
        let plan = reason.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
        return plan.isEmpty ? nil : plan
    }

    /// The web's `isModelLocked`: the plan cannot reach it. A locked row is
    /// still drawn at full strength, with a lock, so someone comparing plans
    /// can read it; only "coming soon" is inert.
    public static func isLocked(_ model: JunoModelDescriptor) -> Bool {
        !isAuto(model) && requiredPlan(model) != nil
    }

    public static func isComingSoon(_ model: JunoModelDescriptor) -> Bool {
        model.unavailabilityReason?.localizedCaseInsensitiveCompare("Coming soon") == .orderedSame
    }

    /// Unavailable for a reason that is neither "soon" nor a plan, which
    /// nothing in the picker can fix.
    public static func isOtherwiseUnavailable(_ model: JunoModelDescriptor) -> Bool {
        model.unavailabilityReason != nil && !isComingSoon(model) && requiredPlan(model) == nil
    }

    /// The detail panel's button, in the web's words.
    public static func useLabel(_ model: JunoModelDescriptor, selected: Bool) -> String {
        if selected { return "Selected" }
        if isComingSoon(model) { return "Not available yet" }
        if let plan = requiredPlan(model) { return "Get \(plan)" }
        if let reason = model.unavailabilityReason { return reason }
        return "Use this model"
    }

    /// The detail panel's deprecation line: the provider's note, else the
    /// last day, else a plain notice.
    public static func retirementNotice(_ model: JunoModelDescriptor) -> String? {
        if let note = model.deprecationNote, !note.isEmpty { return note }
        if let day = model.retiresOn.flatMap(JunoModelFormatting.retirementDate) {
            return "Retires \(day)"
        }
        return nil
    }

    /// The row's accessible name: what the panel shows, so VoiceOver is not
    /// sent to a second pane for the facts (the web's row `aria-label`).
    public static func accessibilityLabel(_ model: JunoModelDescriptor) -> String {
        var parts = [model.displayName, isAuto(model) ? productName : model.shortProviderName]
        let caps = [
            model.capabilities.contains(.vision) ? "Vision" : nil,
            model.capabilities.contains(.reasoning) ? "Thinking" : nil,
            model.capabilities.contains(.search) ? "Search" : nil,
        ].compactMap { $0 }
        parts.append(contentsOf: caps)
        if !isAuto(model), !isComingSoon(model), let price = priceLabel(model) {
            parts.append(model.modality == .audio ? price : "\(price) per million tokens")
        }
        if let plan = requiredPlan(model) { parts.append("needs \(plan)") }
        return parts.joined(separator: ", ")
    }

    // MARK: - The detail panel's facts

    /// One graded fact: the number a person reads, and the 0 to 10 score the
    /// rule under it is drawn at (the web's `Stat`).
    public struct Stat: Equatable, Sendable {
        public let label: String
        public let value: String
        public let unit: String?
        public let score: Int
    }

    /// The web's `contextScore`.
    public static func contextScore(tokens: Int) -> Int {
        if tokens >= 1_000_000 { return 10 }
        if tokens >= 256_000 { return 8 }
        if tokens >= 128_000 { return 6 }
        if tokens >= 64_000 { return 5 }
        return 4
    }

    /// The web's `expensivenessScore`: a log of the output-weighted blend of
    /// the two list prices, so a $2 model and a $20 model sit four segments
    /// apart rather than at opposite ends.
    public static func costScore(_ price: JunoModelPrice) -> Int {
        let blended = price.inputPerMillion * 0.25 + price.outputPerMillion * 0.75
        let score = (log2(blended + 1) * 2.0 + 0.2).rounded()
        return max(1, min(10, Int(score)))
    }

    /// The cost tier for a product that published a tier but no numbers.
    public static func costScore(glyph: String) -> Int? {
        switch glyph {
        case "$": 3
        case "$$": 6
        case "$$$", "$$$$": 9
        default: nil
        }
    }

    /// The web's `priceLabel`: "$3 · $15" (input and output per million
    /// tokens), "Free", or the product's own line.
    public static func priceLabel(_ model: JunoModelDescriptor) -> String? {
        if let price = model.price {
            if price.isFree { return "Free" }
            return "\(formatPrice(price.inputPerMillion)) · \(formatPrice(price.outputPerMillion))"
        }
        return model.priceDetail ?? model.costGlyph
    }

    /// Intelligence, Speed, Context (text models) and Cost: the panel's 2×2
    /// grid. Cost's rule reads "how cheap", so a long bar is good news on
    /// every row. A fact the product never published is left out.
    public static func stats(_ model: JunoModelDescriptor) -> [Stat] {
        var out: [Stat] = []
        if let intelligence = model.intelligenceGrade {
            out.append(Stat(label: "Intelligence", value: "\(intelligence)", unit: "/10", score: intelligence))
        }
        if let speed = model.speedGrade {
            out.append(Stat(label: "Speed", value: "\(speed)", unit: "/10", score: speed))
        }
        if model.modality == .chat, let tokens = model.contextWindowTokens, tokens > 0 {
            out.append(Stat(label: "Context", value: JunoModelFormatting.contextWindow(tokens), unit: nil, score: contextScore(tokens: tokens)))
        }
        if let label = priceLabel(model) {
            let expensive = model.price.map(costScore) ?? model.costGlyph.flatMap(costScore(glyph:))
            if let expensive {
                out.append(Stat(label: "Cost", value: label, unit: nil, score: 11 - expensive))
            }
        }
        return out
    }

    /// "Vision · Thinking · Web search · Tools": the panel's capability line.
    public static func capabilityLine(_ model: JunoModelDescriptor) -> String? {
        let caps = [
            model.capabilities.contains(.vision) ? "Vision" : nil,
            model.capabilities.contains(.reasoning) ? "Thinking" : nil,
            model.capabilities.contains(.search) ? "Web search" : nil,
            model.capabilities.contains(.tools) ? "Tools" : nil,
        ].compactMap { $0 }
        return caps.isEmpty ? nil : caps.joined(separator: " · ")
    }

    /// The id the panel prints under the name, in mono: the provider's own
    /// model id without a routing prefix, or the product's name for Auto.
    public static func identifier(_ model: JunoModelDescriptor) -> String {
        if isAuto(model) { return productName }
        return model.id.split(separator: ":").last.map(String.init) ?? model.id
    }

    /// The web's `formatPrice`: "$3", "$0.25", "$1.50".
    public static func formatPrice(_ value: Double) -> String {
        if value >= 1 {
            return value == value.rounded()
                ? String(format: "$%.0f", value)
                : String(format: "$%.2f", value)
        }
        return String(format: "$%.2f", value)
    }
}


/// A lab's mark colour, for the meters on its models' detail panel.
///
/// The web's `PROVIDER_ACCENTS`, with the same three substitutions its
/// `GLOW_SOURCES` makes: OpenAI, Moonshot and xAI brand in near-black, and a
/// row of black segments is a meter in light mode and nothing at all in dark.
/// So those three carry the luminous stand-in each lab already uses elsewhere.
/// A lab the web has not shipped falls back to the account's accent.
public enum JunoProviderAccent {
    static let marks: [String: UInt32] = [
        "anthropic": 0xd9_78_59,
        "openai": 0x10_a3_7f,
        "google": 0x42_85_f4,
        "meta": 0x00_73_ff,
        "zhipu": 0x2f_66_ff,
        "moonshot": 0x6a_5b_ff,
        "deepseek": 0x4f_7c_ff,
        "mistral": 0xff_8a_00,
        "xai": 0x8e_a3_c0,
        "seedance": 0x7c_3a_ed,
        "minimax": 0x18_a0_a0,
        "mimo": 0xff_6a_00,
        "qwen": 0x61_5c_ed,
        "longcat": 0xf5_a5_24,
    ]

    /// The lab's colour as a token, or nil for a lab this build does not know.
    public static func token(providerID: String) -> JunoColorToken? {
        guard let hex = marks[providerID.lowercased()] else { return nil }
        return JunoColorToken(
            unchecked: Double((hex >> 16) & 255) / 255,
            Double((hex >> 8) & 255) / 255,
            Double(hex & 255) / 255
        )
    }

    /// The colour the meters fill with.
    public static func color(providerID: String) -> Color {
        guard let token = token(providerID: providerID) else { return Color.junoAccent }
        return Color.junoAdaptive(light: token, dark: token)
    }
}
