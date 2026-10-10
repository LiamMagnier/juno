import Foundation
import Observation

// MARK: - Values

/// One generation choice's value, as `/api/generate`'s `params` carries it: a
/// string ("16:9", "1K", "auto", "png"), a number (8 seconds, 4 images) or a
/// flag (sound on).
public enum NativeMediaParamValue: Hashable, Sendable, Codable, CustomStringConvertible {
    case string(String)
    case number(Double)
    case bool(Bool)

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let flag = try? container.decode(Bool.self) {
            self = .bool(flag)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .number(let value):
            // Whole numbers go out as integers, as the web's JSON does (8, not 8.0).
            if value == value.rounded(), abs(value) < 1e15 {
                try container.encode(Int(value))
            } else {
                try container.encode(value)
            }
        }
    }

    public var description: String {
        switch self {
        case .string(let value): value
        case .bool(let value): value ? "true" : "false"
        case .number(let value):
            value == value.rounded() ? String(Int(value)) : String(value)
        }
    }

    public var stringValue: String? { if case .string(let value) = self { value } else { nil } }
    public var numberValue: Double? { if case .number(let value) = self { value } else { nil } }
    public var boolValue: Bool? { if case .bool(let value) = self { value } else { nil } }

    public static let auto = NativeMediaParamValue.string("auto")
}

/// A set of choices for one model, keyed by the web's `MediaParamKey`
/// ("aspect", "resolution", "quality", "durationSec", "fps", "audio",
/// "instrumental", "count", "background", "outputFormat").
public typealias NativeMediaParams = [String: NativeMediaParamValue]

// MARK: - Schema (the catalogue's `mediaParams`)

/// Which control the web row draws for an option (`media-params-ui.ts`,
/// `controlKind`); the native trays draw the same one.
public enum NativeMediaParamControl: String, Sendable, Codable {
    case aspect, segmented, menu, slider, toggle
}

public struct NativeMediaParamChoice: Hashable, Sendable, Codable {
    public let value: NativeMediaParamValue
    public let label: String
    public let detail: String?

    public init(value: NativeMediaParamValue, label: String, detail: String? = nil) {
        self.value = value
        self.label = label
        self.detail = detail
    }
}

public struct NativeMediaParamRange: Hashable, Sendable, Codable {
    public let min: Double
    public let max: Double
    public let step: Double
    /// "s" for a length, "outputs" for a count.
    public let unit: String
    /// The word for "the model decides" ("Auto"), where the provider can.
    public let auto: String?
}

/// One option a model offers, exactly as the catalogue publishes it.
public struct NativeMediaParamOption: Hashable, Sendable, Codable, Identifiable {
    public let key: String
    public let control: NativeMediaParamControl
    /// "select", "range" or "toggle".
    public let kind: String
    public let label: String
    public let `default`: NativeMediaParamValue
    public let choices: [NativeMediaParamChoice]?
    public let range: NativeMediaParamRange?

    public var id: String { key }
}

/// "When `when.key` holds one of `when.in`, `allow.key` may only take one of
/// `allow.in`" (Veo 1080p means 8s; GPT Image 3:2 means 1K).
public struct NativeMediaParamRule: Hashable, Sendable, Codable {
    public struct Side: Hashable, Sendable, Codable {
        public let key: String
        public let `in`: [NativeMediaParamValue]
    }
    public let when: Side
    public let allow: Side
}

/// A media model's generation choices: the catalogue's `mediaParams`, built
/// server-side from `src/lib/media-params.ts`. Everything a tray needs —
/// controls, values, defaults, rules — comes from here; nothing per model is
/// written into the apps.
public struct NativeMediaParamSchema: Hashable, Sendable, Codable {
    /// "image", "video" or "audio".
    public let kind: String
    public let options: [NativeMediaParamOption]
    public let rules: [NativeMediaParamRule]
    /// Plain facts the person cannot change ("With sound", "30s clip").
    public let facts: [String]

    public init(kind: String, options: [NativeMediaParamOption], rules: [NativeMediaParamRule] = [], facts: [String] = []) {
        self.kind = kind
        self.options = options
        self.rules = rules
        self.facts = facts
    }

    /// Decodes the catalogue's JSON for one model; nil when it is not a schema
    /// this build can read (a newer server's shape never breaks the catalogue).
    public static func decode(_ data: Data) -> NativeMediaParamSchema? {
        try? JSONDecoder().decode(NativeMediaParamSchema.self, from: data)
    }

    public var isEmpty: Bool { options.isEmpty && facts.isEmpty }

    public func option(_ key: String) -> NativeMediaParamOption? {
        options.first { $0.key == key }
    }
}

// MARK: - The rules, ported from media-params.ts

public extension NativeMediaParamSchema {
    /// The values one option can take before any rule applies (`optionValues`).
    static func values(of option: NativeMediaParamOption) -> [NativeMediaParamValue] {
        switch option.kind {
        case "toggle":
            return [.bool(false), .bool(true)]
        case "range":
            guard let range = option.range, range.step > 0 else { return [] }
            var out: [NativeMediaParamValue] = range.auto != nil ? [.auto] : []
            var value = range.min
            while value <= range.max + 1e-9 {
                out.append(.number(value))
                value += range.step
            }
            return out
        default:
            return option.choices?.map(\.value) ?? []
        }
    }

    private static func allowedByOption(_ option: NativeMediaParamOption, _ value: NativeMediaParamValue?) -> Bool {
        guard let value else { return false }
        switch option.kind {
        case "toggle":
            return value.boolValue != nil
        case "range":
            guard let range = option.range else { return false }
            if value == .auto { return range.auto != nil }
            guard let number = value.numberValue, number.isFinite else { return false }
            let steps = (number - range.min) / range.step
            return number >= range.min && number <= range.max && abs(steps - steps.rounded()) < 1e-9
        default:
            return option.choices?.contains { $0.value == value } ?? false
        }
    }

    private static func clamp(_ range: NativeMediaParamRange, _ value: Double) -> Double {
        let stepped = range.min + ((value - range.min) / range.step).rounded() * range.step
        return Swift.min(range.max, Swift.max(range.min, stepped))
    }

    /// Ranks for "nearest" when a value has to move: resolution tiers and numbers.
    private static let resolutionRank: [String: Double] = [
        "0.5K": 512, "360p": 360, "480p": 480, "512p": 512, "720p": 720, "768p": 768,
        "1K": 1024, "1080p": 1080, "2K": 2048, "4K": 4096,
    ]

    private static func rank(_ key: String, _ value: NativeMediaParamValue) -> Double? {
        if let number = value.numberValue { return number }
        if key == "resolution", let tier = value.stringValue { return resolutionRank[tier] }
        return nil
    }

    /// The candidate closest to `wanted`; a tie goes to the lower (cheaper) one.
    private static func nearest(
        _ key: String, _ wanted: NativeMediaParamValue, _ candidates: [NativeMediaParamValue]
    ) -> NativeMediaParamValue? {
        guard let target = rank(key, wanted) else { return nil }
        var best: NativeMediaParamValue?
        var bestGap = Double.infinity
        for candidate in candidates {
            guard let r = rank(key, candidate) else { continue }
            let gap = abs(r - target)
            if gap < bestGap || (gap == bestGap && best.flatMap { rank(key, $0) }.map { $0 > r } == true) {
                best = candidate
                bestGap = gap
            }
        }
        return best
    }

    /// Brings dependent options back inside the rules; the `when` side wins.
    private func applyRules(_ params: NativeMediaParams) -> NativeMediaParams {
        var out = params
        for rule in rules {
            guard let held = out[rule.when.key], rule.when.in.contains(held) else { continue }
            guard let current = out[rule.allow.key], !rule.allow.in.contains(current) else { continue }
            let fallback: NativeMediaParamValue? = {
                if let option = option(rule.allow.key), rule.allow.in.contains(option.default) { return option.default }
                return rule.allow.in.first
            }()
            out[rule.allow.key] = Self.nearest(rule.allow.key, current, rule.allow.in) ?? fallback
        }
        return out
    }

    /// Every option at its default (`defaultParams`).
    func defaults() -> NativeMediaParams {
        var out: NativeMediaParams = [:]
        for option in options { out[option.key] = option.default }
        return applyRules(out)
    }

    /// The params a provider will accept (`normalizeParams`): every option
    /// present, unknown keys dropped, an invalid value replaced by the default
    /// (a number outside a range clamped into it), the rules applied.
    func normalized(_ input: NativeMediaParams) -> NativeMediaParams {
        var out: NativeMediaParams = [:]
        for option in options {
            let value = input[option.key]
            if Self.allowedByOption(option, value) {
                out[option.key] = value
            } else if option.kind == "range", let range = option.range, let number = value?.numberValue, number.isFinite {
                out[option.key] = .number(Self.clamp(range, number))
            } else {
                out[option.key] = option.default
            }
        }
        return applyRules(out)
    }

    /// Carries choices across a model switch (`paramsForModelSwitch`): a value
    /// this model has is kept, a resolution or length it lacks moves to its
    /// nearest, anything else falls back to the default.
    func carried(from previous: NativeMediaParams) -> NativeMediaParams {
        var out: NativeMediaParams = [:]
        for option in options {
            guard let value = previous[option.key] else {
                out[option.key] = option.default
                continue
            }
            if Self.allowedByOption(option, value) {
                out[option.key] = value
            } else if option.kind == "range", let range = option.range, let number = value.numberValue {
                out[option.key] = .number(Self.clamp(range, number))
            } else {
                out[option.key] = Self.nearest(option.key, value, Self.values(of: option)) ?? option.default
            }
        }
        return applyRules(out)
    }

    /// The values `key` may take given the rest of `params` (`allowedValues`).
    func allowedValues(_ key: String, in params: NativeMediaParams) -> [NativeMediaParamValue] {
        guard let option = option(key) else { return [] }
        var values = Self.values(of: option)
        for rule in rules where rule.allow.key == key {
            guard let held = params[rule.when.key], rule.when.in.contains(held) else { continue }
            values = values.filter { rule.allow.in.contains($0) }
        }
        return values
    }

    /// "16:9" as 16/9; nil for "auto" or anything that is not a ratio (`aspectRatioOf`).
    private static func aspectRatio(_ value: NativeMediaParamValue) -> Double? {
        guard let text = value.stringValue else { return nil }
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]),
            w.isFinite, h.isFinite, w > 0, h > 0
        else { return nil }
        return w / h
    }

    /// The escape closest to where the blocker was (`closestEscape`): the
    /// nearest tier or number, or for an aspect the ratio closest in shape (by
    /// log ratio; a tie keeps the option's own order).
    private static func closestEscape(
        _ key: String, _ held: NativeMediaParamValue, _ candidates: [NativeMediaParamValue]
    ) -> NativeMediaParamValue? {
        guard key == "aspect" else { return nearest(key, held, candidates) }
        guard let from = aspectRatio(held) else { return nil }
        var best: NativeMediaParamValue?
        var bestGap = Double.infinity
        for candidate in candidates {
            guard let r = aspectRatio(candidate) else { continue }
            let gap = abs(log(r / from))
            if gap < bestGap - 1e-9 {
                best = candidate
                bestGap = gap
            }
        }
        return best
    }

    /// Sets one option the way a person means it (`applyParamChange`): the
    /// picked value wins, and an option that rules it out moves instead — only
    /// to a value where the pick is allowed (4K at 1:1 moves to 16:9, never to
    /// 2:3, which caps at 1K): the blocker's default if it qualifies, else the
    /// closest to where it was.
    func applying(_ key: String, _ value: NativeMediaParamValue, to params: NativeMediaParams) -> NativeMediaParams {
        var next = normalized(params)
        next[key] = value
        for rule in rules where rule.allow.key == key {
            if rule.allow.in.contains(value) { continue }
            guard let held = next[rule.when.key], rule.when.in.contains(held),
                let blocker = option(rule.when.key)
            else { continue }
            let escapes = Self.values(of: blocker).filter { !rule.when.in.contains($0) }
            // A real escape: no rule on the same pair rules the pick out there either.
            let keeping = escapes.filter { candidate in
                !rules.contains { other in
                    other.when.key == rule.when.key && other.allow.key == key
                        && other.when.in.contains(candidate) && !other.allow.in.contains(value)
                }
            }
            let pool = keeping.isEmpty ? escapes : keeping
            let pick = pool.contains(blocker.default)
                ? blocker.default
                : (Self.closestEscape(rule.when.key, held, pool) ?? pool.first)
            if let pick { next[rule.when.key] = pick }
        }
        return normalized(next)
    }
}

// MARK: - What the tray draws (media-params-ui.ts)

/// One value in a control, with what picking it would move when the current
/// combination rules it out.
public struct NativeMediaParamChoiceState: Hashable, Sendable, Identifiable {
    public let value: NativeMediaParamValue
    public let label: String
    public let detail: String?
    /// The current combination rules this value out; picking it moves another option.
    public let conflict: Bool
    /// "Resolution becomes 720p".
    public let consequence: String?

    public var id: NativeMediaParamValue { value }
}

/// One control in the tray, in the web row's order, with its closed chip's words.
public struct NativeMediaParamControlState: Hashable, Sendable, Identifiable {
    public let option: NativeMediaParamOption
    public let value: NativeMediaParamValue?
    /// What the closed chip says ("1:1", "Auto quality", "1 image", "PNG").
    public let chip: String
    public let choices: [NativeMediaParamChoiceState]

    public var id: String { option.key }
    public var key: String { option.key }
}

public extension NativeMediaParamSchema {
    /// The words for one value (`choiceLabel`).
    func label(_ option: NativeMediaParamOption, _ value: NativeMediaParamValue?) -> String {
        guard let value else { return "" }
        switch option.kind {
        case "toggle":
            return value.boolValue == true ? "On" : "Off"
        case "range":
            if value == .auto { return option.range?.auto ?? "Auto" }
            return option.range?.unit == "s" ? "\(value)s" : value.description
        default:
            return option.choices?.first { $0.value == value }?.label ?? value.description
        }
    }

    /// The closed chip's text (`chipText`).
    func chip(_ option: NativeMediaParamOption, _ value: NativeMediaParamValue?) -> String {
        if option.kind == "toggle" { return option.label }
        guard let value else { return option.label }
        switch option.key {
        case "aspect":
            return value == .auto ? "Auto" : value.description
        case "durationSec" where value == .auto:
            return "Auto length"
        case "count":
            if let number = value.numberValue {
                var noun = option.label.lowercased()
                if noun.hasSuffix("s") { noun.removeLast() }
                return "\(Int(number)) \(number == 1 ? noun : noun + "s")"
            }
        case "background" where value == .auto:
            return "Auto background"
        case "quality" where value == .auto:
            return "Auto quality"
        default:
            break
        }
        return label(option, value)
    }

    /// "Resolution becomes 720p" for every other option a pick would move.
    func consequence(of key: String, _ value: NativeMediaParamValue, in params: NativeMediaParams) -> String? {
        let next = applying(key, value, to: params)
        let current = normalized(params)
        let moved = options.compactMap { option -> String? in
            guard option.key != key, next[option.key] != current[option.key] else { return nil }
            return "\(option.label) becomes \(label(option, next[option.key]))"
        }
        return moved.isEmpty ? nil : moved.joined(separator: ", ")
    }

    /// Every control the tray draws, in order (`paramControls`).
    func controls(_ input: NativeMediaParams) -> [NativeMediaParamControlState] {
        let params = normalized(input)
        return options.map { option in
            let allowed = allowedValues(option.key, in: params)
            let value = params[option.key]
            let choices: [NativeMediaParamChoiceState] = option.kind == "toggle" ? [] : Self.values(of: option).map { v in
                let conflict = !allowed.contains(v)
                let meta = option.choices?.first { $0.value == v }
                return NativeMediaParamChoiceState(
                    value: v,
                    label: option.kind == "range" && option.key == "count" ? v.description : label(option, v),
                    detail: meta?.detail,
                    conflict: conflict,
                    consequence: conflict ? consequence(of: option.key, v, in: params) : nil
                )
            }
            return NativeMediaParamControlState(option: option, value: value, chip: chip(option, value), choices: choices)
        }
    }

    /// The JSON-safe body `/api/generate` takes as `params` (`paramsForRequest`).
    func request(_ params: NativeMediaParams) -> NativeMediaParams {
        normalized(params)
    }
}

/// The shape of a ratio inside a `size` square ("16:9" → wide), for the
/// aspect glyph; nil for "auto" and anything that is not a ratio (`aspectBox`).
public func nativeAspectBox(_ value: NativeMediaParamValue?, size: Double) -> CGSize? {
    guard let text = value?.stringValue else { return nil }
    let parts = text.split(separator: ":")
    guard parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]), w > 0, h > 0 else { return nil }
    let scale = size / Swift.max(w, h)
    return CGSize(width: Swift.max(2, w * scale), height: Swift.max(2, h * scale))
}

// MARK: - Memory: the last choices per model

/// The composer's generation choices, remembered per model on this device —
/// the web's `useMediaParams` (`alevr.mediaParams.v1` in localStorage). A
/// model never set before inherits what still fits from the one before it,
/// then its own defaults.
@MainActor
@Observable
public final class NativeMediaParamsMemory {
    public static let defaultsKey = "alevr.mediaParams.v1"

    @ObservationIgnored private let defaults: UserDefaults?
    /// Picked by the person, per model id, persisted.
    public private(set) var saved: [String: NativeMediaParams]
    /// Resolved for a model this session without a pick (carried or default).
    private var resolved: [String: NativeMediaParams] = [:]
    /// The last media model's choices, carried to the next model switched to.
    private var lastActive: NativeMediaParams?

    public init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        if let data = defaults?.data(forKey: Self.defaultsKey),
            let stored = try? JSONDecoder().decode([String: NativeMediaParams].self, from: data)
        {
            saved = stored
        } else {
            saved = [:]
        }
    }

    /// The choices to show for `modelID`: its last pick, else the previous
    /// model's carried across, else its defaults (`paramsForModel`).
    public func params(for modelID: String, schema: NativeMediaParamSchema) -> NativeMediaParams {
        if let mine = saved[modelID] { return schema.normalized(mine) }
        if let mine = resolved[modelID] { return schema.normalized(mine) }
        return lastActive.map(schema.carried(from:)) ?? schema.defaults()
    }

    /// Marks `modelID` as the composer's current media model, fixing what it
    /// carried in so a later switch carries from it in turn.
    public func activate(_ modelID: String, schema: NativeMediaParamSchema) {
        let current = params(for: modelID, schema: schema)
        if saved[modelID] == nil { resolved[modelID] = current }
        lastActive = current
    }

    /// One pick: applied the web's way (the picked value wins) and saved.
    public func set(_ key: String, _ value: NativeMediaParamValue, for modelID: String, schema: NativeMediaParamSchema) {
        let next = schema.applying(key, value, to: params(for: modelID, schema: schema))
        saved[modelID] = next
        resolved[modelID] = nil
        lastActive = next
        persist()
    }

    private func persist() {
        guard let defaults, let data = try? JSONEncoder().encode(saved) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}
