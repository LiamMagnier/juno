import Foundation

/// The presentation-neutral vocabulary the model selector and the Thinking
/// control are written against.
///
/// Chat carries `NativeChatModelOption` (a manifest row with networking types
/// hanging off it) and Code carries its own `ModelOption`. Neither can be the
/// input to a shared view without dragging its product's whole stack into the
/// other's package, and a third copy of the selector is what this file exists to
/// prevent. So the views take a descriptor, and each product writes one adapter.
///
/// Everything here is *stated*, never derived: a field the product did not fill
/// in is absent from the UI rather than guessed at. That is the same guarantee
/// `NativeModelPresentation` makes on the chat side, moved to where both
/// products can rely on it.

// MARK: - Capabilities

/// A capability the server actually reported for a model.
///
/// SF Symbols are right here — these are Apple-platform concepts (a magnifier,
/// an eye), not brands. Provider identity uses real logos; see ``JunoProviderMark``.
public enum JunoModelCapability: String, Identifiable, CaseIterable, Sendable {
    case reasoning
    case vision
    case search
    case tools
    /// Can drive Juno Code's screen control on this Mac.
    ///
    /// Unlike its siblings this one is **derived rather than reported**, because
    /// no server publishes it — screen control is a macOS-only feature and the
    /// manifest has no field for it. It is still a fact about the model rather
    /// than a guess: driving the screen means reading a screenshot and answering
    /// with a tool call, so it requires exactly `vision` *and* `tools`, both of
    /// which the manifest does report. A model without vision cannot see the
    /// screen it is being asked to click on, which is why `SessionController`
    /// already refuses to activate capture for one.
    ///
    /// See ``computerUse(visionReported:toolsReported:)`` — the derivation lives
    /// in one place so a picker and a session gate cannot disagree about it.
    case computerUse

    public var id: String { rawValue }

    /// Whether this model can run screen control, from the two capabilities the
    /// manifest actually reports.
    public static func computerUse(
        visionReported: Bool,
        toolsReported: Bool
    ) -> Bool {
        visionReported && toolsReported
    }

    public var label: String {
        switch self {
        case .reasoning: "Reasoning"
        case .vision: "Vision"
        case .search: "Search"
        case .tools: "Tools"
        case .computerUse: "Screen control"
        }
    }

    public var systemImage: String {
        switch self {
        case .reasoning: "brain"
        case .vision: "eye"
        case .search: "globe"
        case .tools: "wrench.and.screwdriver"
        case .computerUse: "display"
        }
    }

    /// The one-line explanation the spec sheet shows. Only `computerUse` has one:
    /// the others name themselves, but "Screen control" is a Juno feature rather
    /// than a model property, so it has to say what it means.
    public var explanation: String? {
        switch self {
        case .computerUse:
            "Can see the screen and click, so Juno Code can drive this Mac with it."
        case .reasoning, .vision, .search, .tools:
            nil
        }
    }
}

/// What a model produces. Drives the catalog's top-level sections.
public enum JunoModelModality: String, CaseIterable, Sendable {
    case chat
    case image
    case video

    /// Anything the server sends that this build does not know about is treated
    /// as a chat model rather than dropped — a new modality should degrade to a
    /// visible row, not to an empty catalog.
    public init(raw: String) {
        self = JunoModelModality(rawValue: raw) ?? .chat
    }

    public var sectionTitle: String {
        switch self {
        case .chat: "Chat"
        case .image: "Image"
        case .video: "Video"
        }
    }

    public var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.text.bubble.right"
        case .image: "photo"
        case .video: "film"
        }
    }
}

// MARK: - Thinking

/// One stop on the Thinking control, as the *control* sees it.
///
/// The id is opaque to the view and meaningful only to the product that built
/// the ladder: Chat maps it back to a `NativeThinkingStop`, Code maps it back to
/// a `ReasoningEffort`. Keeping the mapping on the product side is what lets one
/// slider drive two different effort enums without knowing either.
public struct JunoThinkingStop: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    /// The longer form VoiceOver reads, e.g. "Thinking high" rather than "High".
    public let accessibilityLabel: String

    public init(id: String, label: String, accessibilityLabel: String) {
        self.id = id
        self.label = label
        self.accessibilityLabel = accessibilityLabel
    }
}

/// The exact set of thinking stops one model supports.
///
/// `stops` is empty in three situations the UI treats differently: a model with
/// no reasoning at all, a model that always reasons with no exposed control, and
/// a router (`isAutomatic`) that picks the depth per message. Only the product
/// knows which of those applies, so only the product builds this.
public struct JunoThinkingLadder: Equatable, Sendable {
    public let stops: [JunoThinkingStop]
    public let isAutomatic: Bool
    public let modelName: String
    /// The one line under the slider explaining an unusual ladder. Supplied by
    /// the product rather than inferred here — the reason a model has two stops
    /// is a fact about that model, not about the number two.
    public let caption: String?
    /// What this model's premium serving tier multiplies its rates by, or nil
    /// when it has no faster tier. The number rather than a flag, so the toggle
    /// can name the premium it is asking the reader to accept.
    public let fastModeRateMultiplier: Double?
    /// Whether this model offers a deeper "pro" execution of the same request.
    ///
    /// Carried beside the ladder rather than added to it, because it is not a
    /// rung: pro composes with whichever stop is selected instead of replacing
    /// it, so a model can run pro at Low. Making it a stop would also mean
    /// sending "pro" where the request expects a reasoning effort.
    public let supportsProMode: Bool

    public init(
        stops: [JunoThinkingStop],
        isAutomatic: Bool = false,
        modelName: String = "",
        caption: String? = nil,
        fastModeRateMultiplier: Double? = nil,
        supportsProMode: Bool = false
    ) {
        self.stops = stops
        self.isAutomatic = isAutomatic
        self.modelName = modelName
        self.caption = caption
        self.fastModeRateMultiplier = fastModeRateMultiplier
        self.supportsProMode = supportsProMode
    }

    /// Whether this model has a premium serving tier.
    public var supportsFastMode: Bool { fastModeRateMultiplier != nil }

    /// A model that exposes no thinking control at all.
    public static let unavailable = JunoThinkingLadder(stops: [])

    /// The id of the "thinking off" stop.
    ///
    /// A shared constant because two packages have to agree on it without one
    /// importing the other: `JunoChatKit` writes this id when a model's manifest
    /// entry reports `canDisable`, and `JunoCodeUI` reads it to decide that the
    /// session may send *no* thinking parameter. It was a bare `"instant"` string
    /// literal on the producing side and unknown on the consuming side, which is
    /// how Code came to silently drop the stop — and with it the off state on more
    /// than half the catalog.
    public static let instantStopID = "instant"

    /// Whether this model can have thinking turned off entirely.
    public var canDisableThinking: Bool {
        stops.contains { $0.id == Self.instantStopID }
    }

    /// Whether a composer should show a Thinking control at all.
    public var isPresentable: Bool { isAutomatic || !stops.isEmpty }

    /// Whether the control can be dragged. A router is shown but not adjustable.
    public var isAdjustable: Bool { stops.count > 1 }

    public func index(of stopID: String?) -> Int? {
        guard let stopID else { return nil }
        return stops.firstIndex { $0.id == stopID }
    }

    public func stop(at index: Int) -> JunoThinkingStop? {
        stops.indices.contains(index) ? stops[index] : nil
    }

    public func stop(id: String?) -> JunoThinkingStop? {
        guard let id else { return nil }
        return stops.first { $0.id == id }
    }

    /// The label for the composer's own button.
    public func label(for stopID: String?) -> String {
        stop(id: stopID)?.label ?? stops.first?.label ?? "Off"
    }

    /// The spec sheet's one-line summary of what this model can be set to.
    public var summary: String {
        if isAutomatic { return "Chosen automatically for each message" }
        guard !stops.isEmpty else { return "Not adjustable" }
        return stops.map(\.label).joined(separator: " · ")
    }
}

// MARK: - Model

/// Everything the selector can show about one model.
///
/// Values arrive formatted where the formatting is the product's business
/// (pricing strings differ by manifest) and raw where it is not (`grades` are
/// 1–10 by definition). Optionals mean "not published", and the views omit the
/// row entirely rather than printing a placeholder.
public struct JunoModelDescriptor: Identifiable, Equatable, Sendable {
    public let id: String
    /// Resolves the provider artwork; see ``JunoProviderMark``.
    public let providerID: String
    public let providerName: String
    public let displayName: String
    public let summary: String?
    /// Product-authored bullets, shown above the grades in the spec sheet.
    public let highlights: [String]
    public let modality: JunoModelModality
    /// Superseded within its family — collapsed behind "Older models" rather
    /// than interleaved with the current generation.
    public let isLegacy: Bool
    public let released: String?
    public let contextWindowTokens: Int?
    /// The relative-cost glyph ("$", "$$", "$$$"), or nil when the product
    /// published no pricing. Never inferred from the price detail.
    public let costGlyph: String?
    public let priceDetail: String?
    public let speedGrade: Int?
    public let intelligenceGrade: Int?
    public let capabilities: [JunoModelCapability]
    public let thinking: JunoThinkingLadder
    /// Why this model cannot be picked right now, or nil when it can. The row
    /// stays visible and explains itself; it is never silently dropped.
    public let unavailabilityReason: String?
    public let deprecationNote: String?
    /// Last day the provider serves this model, "YYYY-MM-DD". The spec sheet
    /// shows it as "Available until 23 Oct 2026"; see JunoModelFormatting.
    public let retiresOn: String?
    /// True only for a router that picks its own thinking depth. Earns the
    /// "SMART" badge in the catalog row.
    public let choosesThinkingAutomatically: Bool

    public init(
        id: String,
        providerID: String,
        providerName: String,
        displayName: String,
        summary: String? = nil,
        highlights: [String] = [],
        modality: JunoModelModality = .chat,
        isLegacy: Bool = false,
        released: String? = nil,
        contextWindowTokens: Int? = nil,
        costGlyph: String? = nil,
        priceDetail: String? = nil,
        speedGrade: Int? = nil,
        intelligenceGrade: Int? = nil,
        capabilities: [JunoModelCapability] = [],
        thinking: JunoThinkingLadder = .unavailable,
        unavailabilityReason: String? = nil,
        deprecationNote: String? = nil,
        retiresOn: String? = nil,
        choosesThinkingAutomatically: Bool = false
    ) {
        self.id = id
        self.providerID = providerID
        self.providerName = providerName
        self.displayName = displayName
        self.summary = summary
        self.highlights = highlights
        self.modality = modality
        self.isLegacy = isLegacy
        self.released = released
        self.contextWindowTokens = contextWindowTokens
        self.costGlyph = costGlyph
        self.priceDetail = priceDetail
        self.speedGrade = speedGrade
        self.intelligenceGrade = intelligenceGrade
        self.capabilities = capabilities
        self.thinking = thinking
        self.unavailabilityReason = unavailabilityReason
        self.deprecationNote = deprecationNote
        self.retiresOn = retiresOn
        self.choosesThinkingAutomatically = choosesThinkingAutomatically
    }

    public var isSelectable: Bool { unavailabilityReason == nil }

    /// "Anthropic" from "Anthropic · Claude". The rail has room for one word.
    public var shortProviderName: String {
        providerName.split(separator: "·").first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? providerName
    }

    /// Whether `needle` matches anything a reader would search this row by.
    public func matches(_ needle: String) -> Bool {
        guard !needle.isEmpty else { return true }
        return displayName.localizedCaseInsensitiveContains(needle)
            || providerName.localizedCaseInsensitiveContains(needle)
            || id.localizedCaseInsensitiveContains(needle)
            || (summary?.localizedCaseInsensitiveContains(needle) ?? false)
    }
}

// MARK: - Formatting

/// Formatting shared by every surface that lists models. Free of SwiftUI so the
/// rules stay testable.
public enum JunoModelFormatting {
    /// "1M" / "200K", matching `formatContext` on the web so the same model
    /// reads identically in the app and in the browser.
    public static func contextWindow(_ tokens: Int) -> String {
        let million = 1_000_000
        if tokens >= million {
            let value = Double(tokens) / Double(million)
            return value == value.rounded()
                ? "\(Int(value))M"
                : String(format: "%.1fM", value)
        }
        return "\(Int((Double(tokens) / 1000).rounded()))K"
    }

    /// "2026-10-23" -> "23 Oct 2026", matching `formatRetirementDate` on the
    /// web. Assembled from the parts rather than run through `DateFormatter`:
    /// the value is a calendar day, and turning it into a `Date` would place it
    /// at midnight UTC and then render it a day earlier west of Greenwich.
    /// Returns nil for anything that is not a well-formed YYYY-MM-DD.
    public static func retirementDate(_ iso: String) -> String? {
        let parts = iso.split(separator: "-")
        guard parts.count == 3,
              let month = Int(parts[1]), (1...12).contains(month),
              let day = Int(parts[2]), (1...31).contains(day),
              parts[0].count == 4
        else { return nil }
        let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(day) \(names[month - 1]) \(parts[0])"
    }
}
