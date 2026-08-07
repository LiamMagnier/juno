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

    /// `--primary` in light mode, as HSL degrees / percent / percent.
    ///
    /// Four of these moved down in lightness so that white on the fill clears
    /// 4.5:1 with the accent's own button label — sage was worst, at 3.20:1.
    /// Hue and saturation are untouched on every one, so each accent keeps its
    /// character exactly; only the value changed. Recomputed: coral 46% =
    /// 4.85:1 · teal 31.5% = 4.54:1 · violet 60% = 5.00:1 · sage 42.5% = 4.52:1.
    /// Amber already passed at 7.13:1 because its ``onAccent`` is dark ink.
    private var light: (h: Double, s: Double, l: Double) {
        switch self {
        case .coral: (15, 0.54, 0.46)
        case .juniper: (152, 0.44, 0.31)
        case .teal: (180, 0.63, 0.315)
        case .violet: (249, 0.59, 0.60)
        case .amber: (39, 0.67, 0.55)
        case .sage: (120, 0.18, 0.425)
        }
    }

    /// `--primary` in dark mode. Coral is deliberately identical in both, as it is
    /// on the web; the others lift.
    private var dark: (h: Double, s: Double, l: Double) {
        switch self {
        case .coral: (15, 0.54, 0.46)
        case .juniper: (152, 0.42, 0.54)
        case .teal: (187, 0.58, 0.49)
        case .violet: (249, 0.66, 0.71)
        case .amber: (38, 0.73, 0.63)
        case .sage: (120, 0.23, 0.61)
        }
    }

    /// The text colour that stays legible *on* this accent — the web's
    /// `--primary-foreground`. Amber and the lifted dark accents are light enough
    /// that white text on them fails contrast, which is why this is not just white.
    public var onAccent: Color {
        switch self {
        case .coral: .white
        case .juniper:
            // `0 0% 100%` / `150 30% 9%` — juniper's dark value lifts to 54%,
            // so white on it fails; the ink is a near-black in juniper's own
            // hue rather than the warm one the other lifted accents use.
            Color.junoAdaptive(
                light: JunoColorToken(unchecked: 1, 1, 1),
                dark: JunoColorToken(unchecked: 0.0630, 0.1170, 0.0900)
            )
        case .teal, .violet, .sage:
            Color.junoAdaptive(
                light: JunoColorToken(unchecked: 1, 1, 1),
                // `40 6% 10%` — a warm near-black, not pure black.
                dark: JunoColorToken(unchecked: 0.1060, 0.1029, 0.0958)
            )
        case .amber:
            // `30 40% 12%` / `30 40% 10%`.
            Color.junoAdaptive(
                light: JunoColorToken(unchecked: 0.1680, 0.1200, 0.0720),
                dark: JunoColorToken(unchecked: 0.1400, 0.1000, 0.0600)
            )
        }
    }

    public var color: Color {
        Color.junoAdaptive(
            light: JunoColorToken(hsl: light),
            dark: JunoColorToken(hsl: dark)
        )
    }

    /// The raw `--primary` triplet, for effects that need to move *within* the
    /// accent rather than just paint with it.
    ///
    /// ``color`` is enough for anything that tints; it is not enough for the
    /// voice aura, which has to derive a second hue a fixed distance round the
    /// wheel from whichever accent is in force. Reading the triplet is the only
    /// way to do that and still answer the accent picker — the alternative is a
    /// hard-coded companion that clashes with four of the five accents.
    public func hsl(dark isDark: Bool) -> (h: Double, s: Double, l: Double) {
        isDark ? dark : light
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

    private init() {}

    /// Applies the account's stored preference. A no-op when it has not changed,
    /// so this is safe to call from an `onChange` that fires on every settings sync.
    public func apply(setting: String?) {
        let resolved = JunoAccent(setting: setting)
        guard resolved != current else { return }
        current = resolved
    }
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
