import Foundation
import SwiftUI

/// The model picker's arithmetic, free of SwiftUI so it can be tested without a
/// render pass: how the labs are ordered, how a lab's rows are grouped and
/// folded, what the keyboard walks, and the four meters the detail panel draws.
///
/// Every rule here is a port of `src/components/chat/model-selector.tsx` and
/// `src/lib/model-metrics.ts`, named the same way, so the same model reads
/// identically in the app and in the browser.
public enum JunoModelSelectorCatalog {

    // MARK: - Labs

    /// The web's `PROVIDER_LIST` — the order the rail runs in and the list is
    /// grouped by. A provider the web has not shipped sorts after all of these,
    /// in the order the manifest sent it.
    public static let labOrder: [String] = [
        "anthropic", "openai", "zhipu", "moonshot", "google", "meta", "deepseek",
        "mistral", "xai", "seedance", "minimax", "mimo", "qwen", "longcat",
    ]

    /// Auto's provider id. Not a lab: it has no rail tile, and its one row sits
    /// in a "Juno" group above every lab.
    public static let junoProviderID = "juno"

    /// The router row — the web's `isAutoModelId`. A router is the one model
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

    /// The rail, in the web's order, from the labs the manifest actually
    /// carries — an absent lab has no tile rather than a dimmed one, because a
    /// native manifest only lists what the account can call.
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

    // MARK: - Rows

    /// One line of the list: a model, or the small "Image" / "Video" caption
    /// that introduces a lab's non-text rows.
    public enum Row: Identifiable, Equatable, Sendable {
        case model(JunoModelDescriptor)
        case modality(JunoModelModality)

        public var id: String {
            switch self {
            case .model(let model): model.id
            case .modality(let modality): "modality:\(modality.rawValue)"
            }
        }

        public var model: JunoModelDescriptor? {
            if case .model(let model) = self { return model }
            return nil
        }
    }

    /// One lab's rows: the current generation, and the superseded ones folded
    /// behind "Past models".
    public struct Group: Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let current: [Row]
        public let legacy: [Row]
        public var legacyCount: Int { legacy.filter { $0.model != nil }.count }
    }

    static let modalityOrder: [JunoModelModality] = [.chat, .image, .video]

    /// Text → image → video, then the manifest's own order — which is the
    /// catalog's canonical generation-then-strength order, the same one the web
    /// sorts into with `sortModelsForDisplay`. A stable sort, so siblings within
    /// a modality never swap.
    static func sortedByModality(_ models: [JunoModelDescriptor]) -> [JunoModelDescriptor] {
        models.enumerated().sorted { lhs, rhs in
            let l = modalityOrder.firstIndex(of: lhs.element.modality) ?? 0
            let r = modalityOrder.firstIndex(of: rhs.element.modality) ?? 0
            return l == r ? lhs.offset < rhs.offset : l < r
        }.map(\.element)
    }

    /// A list of models with a caption each time the modality changes away from
    /// text — the web's `renderRows`.
    static func rows(_ models: [JunoModelDescriptor]) -> [Row] {
        var out: [Row] = []
        var last: JunoModelModality?
        for model in sortedByModality(models) {
            if model.modality != .chat, model.modality != last {
                out.append(.modality(model.modality))
            }
            last = model.modality
            out.append(.model(model))
        }
        return out
    }

    /// The words that find Auto when the reader types — the web's list.
    static let autoSearchWords = ["auto", "cheap", "route", "smart", "default"]

    /// Whether `needle` is a search: anything but whitespace.
    public static func isSearching(_ query: String) -> Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The list, grouped by lab in the rail's order, filtered by the rail's
    /// choice and the search.
    ///
    /// Typing filters across every lab: a query clears the rail's filter rather
    /// than searching inside one lab, exactly as the web does. Auto is a group
    /// of its own at the top, shown in the "All" view (or whenever a query
    /// reaches it) and never under a lab filter.
    public static func groups(
        models: [JunoModelDescriptor],
        providerID: String?,
        query: String
    ) -> [Group] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let searching = !needle.isEmpty
        let filter = searching ? nil : providerID

        var out: [Group] = []

        let autos = models.filter { isAuto($0) }
        if filter == nil, let auto = autos.first {
            let matches = !searching
                || auto.matches(needle)
                || autoSearchWords.contains { $0.localizedCaseInsensitiveContains(needle) }
            if matches {
                out.append(Group(id: junoProviderID, label: "Juno", current: [.model(auto)], legacy: []))
            }
        }

        let visible = models.filter { model in
            if isAuto(model) { return false }
            if let filter, model.providerID != filter { return false }
            return model.matches(needle) || model.modality.rawValue.localizedCaseInsensitiveContains(needle)
        }
        for lab in labs(in: visible) {
            let mine = visible.filter { $0.providerID == lab.id }
            out.append(
                Group(
                    id: lab.id,
                    label: lab.name,
                    current: rows(mine.filter { !$0.isLegacy }),
                    legacy: rows(mine.filter(\.isLegacy))
                )
            )
        }
        return out
    }

    /// Every model id in display order — what ↑/↓ walk. A lab's past models
    /// join the walk only while that fold is open, or while a search has
    /// opened every fold.
    public static func keyboardOrder(
        groups: [Group],
        expanded: Set<String>,
        searching: Bool
    ) -> [String] {
        var ids: [String] = []
        for group in groups {
            ids.append(contentsOf: group.current.compactMap { $0.model?.id })
            if searching || expanded.contains(group.id) {
                ids.append(contentsOf: group.legacy.compactMap { $0.model?.id })
            }
        }
        return ids
    }

    /// The id `offset` steps from `current` in `order`, wrapping at both ends.
    /// From nowhere, ↓ lands on the first row and ↑ on the last.
    public static func step(from current: String?, by offset: Int, in order: [String]) -> String? {
        guard !order.isEmpty else { return nil }
        let at = current.flatMap { order.firstIndex(of: $0) } ?? (offset > 0 ? -1 : order.count)
        let next = ((at + offset) % order.count + order.count) % order.count
        return order[next]
    }

    // MARK: - The row's words

    /// The web's `formatRetirementDate` line on a deprecated row — "Until
    /// 23 Oct 2026", or "Retiring" when the provider has announced no day —
    /// or nil for a model nobody is retiring.
    public static func retirementLabel(_ model: JunoModelDescriptor) -> String? {
        if let day = model.retiresOn.flatMap(JunoModelFormatting.retirementDate) {
            return "Until \(day)"
        }
        return model.deprecationNote == nil ? nil : "Retiring"
    }

    /// The detail panel's fuller form of the same fact.
    public static func retirementNotice(_ model: JunoModelDescriptor) -> String? {
        if let day = model.retiresOn.flatMap(JunoModelFormatting.retirementDate) {
            return "Available until \(day)"
        }
        return model.deprecationNote == nil ? nil : "Retiring soon"
    }

    /// The plan a "Requires Pro" reason names, or nil for any other reason.
    public static func requiredPlan(_ model: JunoModelDescriptor) -> String? {
        guard let reason = model.unavailabilityReason else { return nil }
        let prefix = "Requires "
        guard reason.hasPrefix(prefix) else { return nil }
        let plan = reason.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
        return plan.isEmpty ? nil : plan
    }

    public static func isComingSoon(_ model: JunoModelDescriptor) -> Bool {
        model.unavailabilityReason?.localizedCaseInsensitiveCompare("Coming soon") == .orderedSame
    }

    /// The right-aligned mono word on a row: "Soon", the plan that unlocks it,
    /// nothing for Auto, else the price glyph.
    public static func trailingLabel(_ model: JunoModelDescriptor) -> String {
        if isComingSoon(model) { return "Soon" }
        if let plan = requiredPlan(model) { return plan }
        if model.unavailabilityReason != nil { return "Unavailable" }
        if isAuto(model) { return "" }
        return model.costGlyph ?? ""
    }

    /// The pinned button's label — the web's `useLabel`.
    public static func useLabel(_ model: JunoModelDescriptor, selected: Bool) -> String {
        if isComingSoon(model) { return "Coming soon" }
        if let plan = requiredPlan(model) { return "Upgrade to \(plan)" }
        if let reason = model.unavailabilityReason { return reason }
        if selected { return "Current model" }
        return isAuto(model) ? "Use Auto" : "Use this model"
    }

    // MARK: - Meters

    /// A meter on the detail panel: ten segments, 1–10.
    public struct Meter: Equatable, Sendable {
        public let label: String
        public let value: Int
    }

    /// The web's `contextScore`.
    public static func contextScore(tokens: Int) -> Int {
        if tokens >= 1_000_000 { return 10 }
        if tokens >= 256_000 { return 8 }
        if tokens >= 128_000 { return 6 }
        if tokens >= 64_000 { return 5 }
        return 4
    }

    /// The web's `expensivenessScore`: a log of the output-weighted blend of the
    /// two list prices, so a $2 model and a $20 model sit four segments apart
    /// rather than at opposite ends.
    public static func costScore(_ price: JunoModelPrice) -> Int {
        let blended = price.inputPerMillion * 0.25 + price.outputPerMillion * 0.75
        let score = (log2(blended + 1) * 2.0 + 0.2).rounded()
        return max(1, min(10, Int(score)))
    }

    /// The cost meter for a product that published a tier but no numbers.
    public static func costScore(glyph: String) -> Int? {
        switch glyph {
        case "$": 3
        case "$$": 6
        case "$$$", "$$$$": 9
        default: nil
        }
    }

    /// Intelligence · Speed · Context · Cost for a text model; Quality · Speed
    /// · Cost for one that makes images or video. A meter whose value the
    /// product never published is left out rather than drawn empty.
    public static func meters(_ model: JunoModelDescriptor) -> [Meter] {
        let generative = model.modality != .chat
        var out: [Meter] = []
        if let intelligence = model.intelligenceGrade {
            out.append(Meter(label: generative ? "Quality" : "Intelligence", value: intelligence))
        }
        if let speed = model.speedGrade {
            out.append(Meter(label: "Speed", value: speed))
        }
        if !generative, let tokens = model.contextWindowTokens {
            out.append(Meter(label: "Context", value: contextScore(tokens: tokens)))
        }
        if let price = model.price {
            out.append(Meter(label: "Cost", value: costScore(price)))
        } else if let glyph = model.costGlyph, let score = costScore(glyph: glyph) {
            out.append(Meter(label: "Cost", value: score))
        }
        return out
    }

    /// The web's `isFastModel`: a speed grade of eight or better.
    public static func isFast(_ model: JunoModelDescriptor) -> Bool {
        (model.speedGrade ?? 0) >= 8
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

    // MARK: - Capability chips

    /// One text chip with its Lucide mark, in the web's order.
    public struct Chip: Equatable, Sendable {
        public let label: String
        public let icon: JunoIcon
    }

    /// Image · Video · Vision · Thinking · Search · Fast, each only when the
    /// model has it. Every mark is the web's, except two it has no asset for:
    /// video takes the play mark, and Fast takes the gauge rather than a bolt —
    /// the bolt is Juno Work's, and a speed chip must not look like a
    /// destination.
    public static func chips(_ model: JunoModelDescriptor) -> [Chip] {
        var out: [Chip] = []
        if model.modality == .image { out.append(Chip(label: "Image", icon: .image)) }
        if model.modality == .video { out.append(Chip(label: "Video", icon: .play)) }
        if model.capabilities.contains(.vision) { out.append(Chip(label: "Vision", icon: .eye)) }
        if model.capabilities.contains(.reasoning) { out.append(Chip(label: "Thinking", icon: .brain)) }
        if model.capabilities.contains(.search) { out.append(Chip(label: "Search", icon: .web)) }
        if isFast(model) { out.append(Chip(label: "Fast", icon: .gauge)) }
        return out
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
