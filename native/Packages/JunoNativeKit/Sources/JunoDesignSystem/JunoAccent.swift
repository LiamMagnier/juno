import Observation
import SwiftUI

/// The six accents the account can choose between, converted from the web's
/// `[data-accent]` blocks in `src/app/globals.css`.
///
/// Each one drives `--primary` and `--ring` there, and four of the six carry a
/// *different* value in dark mode — a teal that reads at 31.5% lightness on
/// paper disappears on a warm near-black. Both values are kept here for that
/// reason; taking the light one for both is what makes a themed app look like it
/// only half-supports its own themes.
public enum JunoAccent: String, CaseIterable, Sendable, Identifiable {
    case coral
    case juniper
    case teal
    case violet
    case amber
    case sage

    public var id: String { rawValue }

    /// The name shown in a picker.
    public var displayName: String {
        switch self {
        case .coral: "Coral"
        case .juniper: "Juniper"
        case .teal: "Teal"
        case .violet: "Violet"
        case .amber: "Amber"
        case .sage: "Sage"
        }
    }

    /// Unknown values from the server resolve to the brand default rather than
    /// throwing — an accent the client has not shipped yet must not blank the UI.
    public init(setting: String?) {
        self = JunoAccent(rawValue: (setting ?? "").lowercased()) ?? .coral
    }

    /// `--primary`: the action colour, per appearance.
    ///
    /// Read from ``generatedPalette``, the projection of the `[data-accent]`
    /// blocks in `globals.css`. Coral is the same in both appearances, as on
    /// the web; the other five lift in dark. Four of the light values sit lower
    /// than their first cut so white on the fill clears 4.5:1 (coral 4.85,
    /// teal 4.54, violet 5.00, sage 4.52; amber takes dark ink at 7.13). That
    /// tuning lives on the web now, and arrives here through the projection.
    public var color: Color { Color.junoAdaptive(generatedPalette.primary) }

    /// `--primary-foreground`: the text colour that stays legible *on* this
    /// accent. Amber and the lifted dark accents are light enough that white
    /// text on them fails contrast, which is why this is not just white.
    public var onAccent: Color { Color.junoAdaptive(generatedPalette.onPrimary) }

    /// `--primary-ink`: this accent as text — links, accent text, code
    /// keywords. Lighter than the fill in dark mode wherever the fill would
    /// not clear 4.5:1 on the charcoal.
    public var ink: Color { Color.junoAdaptive(generatedPalette.ink) }

    /// The accent block's `--ring`. The same neutral pair in every accent, so
    /// keyboard focus never takes the action colour.
    public var ring: Color { Color.junoAdaptive(generatedPalette.ring) }

    /// The raw `--primary` triplet, for effects that need to move *within* the
    /// accent rather than just paint with it.
    ///
    /// ``color`` is enough for anything that tints; it is not enough for the
    /// voice aura, which has to derive a second hue a fixed distance round the
    /// wheel from whichever accent is in force. Reading the triplet is the only
    /// way to do that and still answer the accent picker — the alternative is a
    /// hard-coded companion that clashes with four of the five accents.
    ///
    /// Derived from the generated `--primary` rather than kept as a second,
    /// hand-typed table of triples (Phase 6): the table and the projection
    /// could only ever agree by someone remembering to edit both.
    public func hsl(dark isDark: Bool) -> (h: Double, s: Double, l: Double) {
        generatedPalette.primary.resolve(dark: isDark).hsl
    }
}

/// The accent currently in force, as one observable value the whole app reads.
///
/// **Why a singleton and not an `@Environment` key.** `Color.junoAccent` is read
/// directly at 80-odd call sites across both apps — chips, rails, disclosure
/// tints, the composer's Send button. An environment key would have meant
/// rewriting every one of them into a view that can see the environment, and any
/// site that was missed would have silently kept the old coral. Reading an
/// `@Observable` from inside a view body registers a dependency wherever that read
/// happens, so changing `current` here invalidates exactly the views that use it —
/// including all 80, unchanged.
///
/// The shell writes to this from the account's settings; nothing else should.
@Observable
@MainActor
public final class JunoAccentSelection {
    public static let shared = JunoAccentSelection()

    public var current: JunoAccent = .coral

    /// A colour the account chose outside the six (`#rrggbb`, Phase 3), or
    /// nil. While it is set, ``current`` is coral — the fallback for the few
    /// readers that need a preset — and the resolved colours below are the
    /// custom one's.
    public private(set) var custom: JunoCustomAccent?

    private init() {}

    /// Applies the account's stored preference. A no-op when it has not changed,
    /// so this is safe to call from an `onChange` that fires on every settings sync.
    public func apply(setting: String?) {
        if let custom = JunoCustomAccent(hex: setting ?? "") {
            if self.custom != custom { self.custom = custom }
            if current != .coral { current = .coral }
            return
        }
        if custom != nil { custom = nil }
        let resolved = JunoAccent(setting: setting)
        guard resolved != current else { return }
        current = resolved
    }

    /// `--primary` in force: the custom colour's, or the preset's.
    public var color: Color { custom?.color ?? current.color }
    /// `--primary-ink` in force.
    public var ink: Color { custom?.ink ?? current.ink }
    /// `--primary-foreground` in force.
    public var onAccent: Color { custom?.onAccent ?? current.onAccent }
    /// The focus ring: graphite in every accent, the custom one included (P3-7).
    public var ring: Color { current.ring }

    /// The HSL triplet in force, per appearance.
    public func hsl(dark isDark: Bool) -> (h: Double, s: Double, l: Double) {
        custom?.hsl(dark: isDark) ?? current.hsl(dark: isDark)
    }
}

/// An accent outside the six presets, as the web derives it from a stored
/// `#rrggbb` (`app-provider.tsx`): hex to HSL, the lightness clamped to at
/// least 55% in dark and at most 55% in light, and the text on it white below
/// 60% lightness and the warm near-black at or above it. The web also moves
/// the focus ring to the custom colour; the Mac keeps it graphite (P3-7).
public struct JunoCustomAccent: Equatable, Sendable {
    /// The stored value, lower-cased: `#ea580c`.
    public let hex: String
    /// Hue in degrees, saturation and lightness as 0…1, before any clamp.
    public let hue: Double
    public let saturation: Double
    public let lightness: Double

    public init?(hex: String) {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard trimmed.count == 7, trimmed.hasPrefix("#"),
            let value = UInt32(trimmed.dropFirst(), radix: 16)
        else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255
        let g = Double((value >> 8) & 0xFF) / 255
        let b = Double(value & 0xFF) / 255
        let maxC = max(r, g, b)
        let minC = min(r, g, b)
        let l = (maxC + minC) / 2
        var h = 0.0
        var s = 0.0
        if maxC != minC {
            let d = maxC - minC
            s = l > 0.5 ? d / (2 - maxC - minC) : d / (maxC + minC)
            switch maxC {
            case r: h = (g - b) / d + (g < b ? 6 : 0)
            case g: h = (b - r) / d + 2
            default: h = (r - g) / d + 4
            }
            h *= 60
        }
        self.hex = trimmed
        // The web rounds each component to a whole number before use.
        hue = h.rounded()
        saturation = (s * 100).rounded() / 100
        lightness = (l * 100).rounded() / 100
    }

    /// The triplet in force for an appearance: lightness clamped to ≥ 0.55 in
    /// dark and ≤ 0.55 in light.
    public func hsl(dark isDark: Bool) -> (h: Double, s: Double, l: Double) {
        let l = isDark ? max(lightness, 0.55) : min(lightness, 0.55)
        return (hue, saturation, l)
    }

    /// Whether the text on the accent is the dark ink rather than white — at
    /// or above 60% lightness, which only a clamped-up dark accent reaches.
    public func takesDarkInk(dark isDark: Bool) -> Bool {
        hsl(dark: isDark).l >= 0.60
    }

    public var color: Color {
        Color.junoAdaptive(
            light: JunoColorToken(hsl: hsl(dark: false)),
            dark: JunoColorToken(hsl: hsl(dark: true))
        )
    }

    /// Accent text: the clamped colour itself, which reads on both canvases.
    public var ink: Color { color }

    public var onAccent: Color {
        let white = JunoGeneratedColors.primaryForeground
        return Color.junoAdaptive(
            light: takesDarkInk(dark: false) ? Self.inkLight : white.light,
            dark: takesDarkInk(dark: true) ? Self.inkDark : white.dark
        )
    }

    /// `hsl(30 3% 12%)` and `hsl(40 6% 10%)`: the web's near-black on a pale
    /// accent. Hand-typed on purpose, and registered as such in
    /// `JunoTokenConsumptionTests`: the web states them in script
    /// (`app-provider.tsx`), not in `globals.css`, so the token generator has
    /// nothing to project. The white beside them is `--primary-foreground`.
    static let inkLight = JunoColorToken(hsl: (30, 0.03, 0.12))
    static let inkDark = JunoColorToken(hsl: (40, 0.06, 0.10))
}

public extension JunoColorToken {
    /// Converts an HSL triple — the form every one of the web's colour tokens is
    /// written in — to the RGB components this type stores.
    init(hsl: (h: Double, s: Double, l: Double)) {
        let chroma = (1 - abs(2 * hsl.l - 1)) * hsl.s
        let sector = hsl.h / 60
        let x = chroma * (1 - abs(sector.truncatingRemainder(dividingBy: 2) - 1))
        let m = hsl.l - chroma / 2

        let (r, g, b): (Double, Double, Double)
        switch sector {
        case ..<1: (r, g, b) = (chroma, x, 0)
        case ..<2: (r, g, b) = (x, chroma, 0)
        case ..<3: (r, g, b) = (0, chroma, x)
        case ..<4: (r, g, b) = (0, x, chroma)
        case ..<5: (r, g, b) = (x, 0, chroma)
        default: (r, g, b) = (chroma, 0, x)
        }

        self.init(unchecked: r + m, g + m, b + m)
    }
}
