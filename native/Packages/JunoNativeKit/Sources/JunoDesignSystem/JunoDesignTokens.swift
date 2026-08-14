import SwiftUI

public enum JunoColorTokenError: Error, Equatable, Sendable {
    case componentOutOfRange
}

/// Platform-neutral color components used to keep the brand palette testable.
public struct JunoColorToken: Hashable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let opacity: Double

    public init(red: Double, green: Double, blue: Double, opacity: Double = 1) throws {
        guard [red, green, blue, opacity].allSatisfy({ (0...1).contains($0) }) else {
            throw JunoColorTokenError.componentOutOfRange
        }
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    private init(uncheckedRed red: Double, green: Double, blue: Double, opacity: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    /// Package-internal constructor for the curated palette tokens, whose
    /// components are known-valid literals.
    init(unchecked red: Double, _ green: Double, _ blue: Double, _ opacity: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    // The brand primitives, converted from the web's own custom properties in
    // `src/app/globals.css` so the two platforms cannot drift. The comment on
    // each token is the HSL triple it was derived from.

    /// `--primary: 15 54% 46%`. Juno's coral. Deliberately the *same* value in
    /// light and dark — the web does not brighten it, and neither should we.
    ///
    /// Darkened from 51%: white on `15 54% 51%` computes to 4.081:1, below the
    /// 4.5:1 the primary CTA's 14px medium label needs. Hue and saturation are
    /// untouched, so the warm coral character is exactly as before.
    public static let coral = JunoColorToken(
        uncheckedRed: 0.7084,
        green: 0.3358,
        blue: 0.2116
    )
    /// `--background` (light): `54 18% 97%`. A warm off-white, not a pure grey.
    ///
    /// Lightness is unchanged at 97% — only hue and chroma moved, so no surface
    /// relationship or elevation step shifts. Still warm: R > G > B.
    public static let warmWhite = JunoColorToken(
        uncheckedRed: 0.9754,
        green: 0.9743,
        blue: 0.9646
    )
    /// `--background` (dark): `48 7% 9%`. Warm — red highest, blue lowest. The
    /// previous value was cool (blue highest), which read as a generic graphite
    /// rather than as Juno.
    public static let warmBlack = JunoColorToken(
        uncheckedRed: 0.0963,
        green: 0.0938,
        blue: 0.0837
    )
}

public extension Color {
    init(juno token: JunoColorToken) {
        self.init(
            red: token.red,
            green: token.green,
            blue: token.blue,
            opacity: token.opacity
        )
    }
}

/// The superseded spacing scale. **Use ``JunoSpace``.**
///
/// Two spacing scales shipped side by side — this one and `JunoSpace`, which
/// carries 723 references in the macOS screens against these 47. Every rung
/// below re-points at its `JunoSpace` equivalent, so a call site that keeps
/// compiling also keeps its exact gap; the one exception is spelled out on it.
///
/// | was | is now | delta |
/// |---|---|---|
/// | `compact` 6 | ``JunoSpace/tight`` 6 | — |
/// | `small` 8 | ``JunoSpace/snug`` 8 | — |
/// | `control` 10 | ``JunoSpace/cozy`` 12 | +2 |
/// | `content` 16 | ``JunoSpace/regular`` 16 | — |
/// | `comfortable` 20 | ``JunoSpace/roomy`` 20 | — |
/// | `section` 24 | ``JunoSpace/section`` 24 | — |
/// | `page` 32 | ``JunoSpace/region`` 32 | — |
public enum JunoSpacing {
    /// Between tightly-coupled parts: an icon and its label.
    @available(*, deprecated, renamed: "JunoSpace.tight")
    public static let compact: CGFloat = JunoSpace.tight
    /// Between controls in a row.
    @available(*, deprecated, renamed: "JunoSpace.snug")
    public static let small: CGFloat = JunoSpace.snug
    /// The default gap inside a control or between adjacent rows.
    ///
    /// The only rung that moves: 10 is the one number in either scale that is
    /// off the 4-point grid, so it has no exact counterpart. `cozy` (12) is the
    /// role match — "a control's internal padding; a row's horizontal inset".
    @available(*, deprecated, renamed: "JunoSpace.cozy")
    public static let control: CGFloat = JunoSpace.cozy
    /// Standard content inset — the left edge of most text.
    @available(*, deprecated, renamed: "JunoSpace.regular")
    public static let content: CGFloat = JunoSpace.regular
    /// A roomier inset for cards and reading surfaces.
    @available(*, deprecated, renamed: "JunoSpace.roomy")
    public static let comfortable: CGFloat = JunoSpace.roomy
    /// Between sections of a screen.
    @available(*, deprecated, renamed: "JunoSpace.section")
    public static let section: CGFloat = JunoSpace.section
    /// A page's outer breathing room, above a first heading.
    @available(*, deprecated, renamed: "JunoSpace.region")
    public static let page: CGFloat = JunoSpace.region

    @available(*, deprecated, renamed: "JunoSpace.region")
    public static let spacious: CGFloat = JunoSpace.region
}

/// The superseded corner-radius scale. **Use ``JunoRadius``.**
///
/// This enum and `JunoRadius` gave *different numbers to the same four role
/// names* — `control` 10 here against 6 there, `row` 12 against 8, `panel` 16
/// against 12, `floating` 22 against 18 — which made every new call site a coin
/// flip decided by which type name the author happened to reach for. `JunoRadius`
/// won on adoption (156 references against 61) and absorbed the three roles only
/// this enum named: `card`, `message` and `composer`.
///
/// Read side by side the two were one ladder offset by a rung, so most of the
/// mapping is exact:
///
/// | was | is now | delta |
/// |---|---|---|
/// | `compactControl` 8 | ``JunoRadius/row`` 8 | — |
/// | `control` 10 | ``JunoRadius/row`` 8 | −2 |
/// | `row` 12 | ``JunoRadius/panel`` 12 | — |
/// | `panel` 16 | ``JunoRadius/card`` 16 | — |
/// | `card` 16 | ``JunoRadius/card`` 16 | — |
/// | `message` 18 | ``JunoRadius/message`` 18 | — |
/// | `floating` 22 | ``JunoRadius/floating`` 18 | −4 (1 call site) |
/// | `composer` 24 | ``JunoRadius/composer`` 24 | — |
///
/// `popover` and `sheet` are **gone rather than re-pointed**, and that is not an
/// oversight. Both had zero call sites, and both name a corner the app is not
/// allowed to set: on OS 26 the system draws popovers and sheets in Liquid Glass
/// and varies a sheet's radius with the device's display corner and with the
/// active detent, so any fixed value breaks the concentric nesting on some
/// device. Adopting them would have been a regression dressed as consistency.
/// See ``SwiftUI/View/junoSheetSurface(_:)`` for what a sheet may set.
public enum JunoCornerRadius {
    /// A compact control: a chip, a small pill, a tag.
    @available(*, deprecated, renamed: "JunoRadius.row")
    public static let compactControl: CGFloat = JunoRadius.row
    /// A standard control or a list row.
    @available(*, deprecated, renamed: "JunoRadius.row")
    public static let control: CGFloat = JunoRadius.row
    /// A selectable row in a sidebar or list.
    @available(*, deprecated, renamed: "JunoRadius.well")
    public static let row: CGFloat = JunoRadius.well
    /// A chat message bubble.
    @available(*, deprecated, renamed: "JunoRadius.message")
    public static let message: CGFloat = JunoRadius.message
    /// A content card (a project, an artifact).
    @available(*, deprecated, renamed: "JunoRadius.card")
    public static let card: CGFloat = JunoRadius.card
    /// A grouped panel.
    @available(*, deprecated, renamed: "JunoRadius.card")
    public static let panel: CGFloat = JunoRadius.card
    /// Floating chrome: a floating toolbar, a transient control group.
    @available(*, deprecated, renamed: "JunoRadius.floating")
    public static let floating: CGFloat = JunoRadius.floating
    /// The composer's outer container.
    @available(*, deprecated, renamed: "JunoRadius.composer")
    public static let composer: CGFloat = JunoRadius.composer
}

/// The shared motion language for JunoMobile and JunoDesktop. A small, named set of
/// durations/springs so every surface animates with the same intent instead of
/// ad-hoc per-call values. All are short and purposeful; spatial motion is
/// dropped under Reduce Motion via ``reduced(_:when:tier:)``.
public enum JunoMotion {

    // MARK: - The ladder

    /// A press. Below the direct-manipulation threshold: anything slower than
    /// ~70ms on a transform is *felt* as lag on the one interaction where
    /// latency is most obvious.
    ///
    /// Its home is ``JunoPressButtonStyle`` — the rung had zero call sites until
    /// there was a button style that owned it, because no view author reaches
    /// for a 70ms animation by hand.
    public static let press = Animation.easeOut(duration: Duration.press)
    /// Immediate feedback: taps, toggles, icon morphs (e.g. + → ×), Send/Stop.
    public static let fast = Animation.easeOut(duration: Duration.fast)
    /// A dismissal. Entrances decelerate, exits accelerate — the product had no
    /// accelerate curve at all, which is why every dismissal read as the UI
    /// being reluctant to let go. Exit is ~0.65 × its entrance.
    ///
    /// Its home is ``SwiftUI/AnyTransition/junoOverlay`` and
    /// ``SwiftUI/AnyTransition/junoInline``: an exit curve is only reachable
    /// through the removal half of an asymmetric transition, which is why a rung
    /// whose own doc comment described the bug it fixes still had zero uses.
    public static let exit = Animation.easeIn(duration: Duration.exit)
    /// Standard transitions: selection, disclosure, popovers, sheets.
    public static let standard = Animation.spring(duration: Duration.base, bounce: 0.05)
    /// Emphasized transitions: larger spatial moves like the sidebar reveal.
    public static let emphasized = Animation.spring(duration: Duration.slow, bounce: 0.10)
    /// Interactive, gesture-following spring for drag-driven surfaces.
    public static let spring = Animation.interactiveSpring(response: 0.32, dampingFraction: 0.85)

    /// The ladder's rungs as raw seconds, for the handful of places that need a
    /// duration rather than an `Animation` — a `Task.sleep`, a `TimelineView`
    /// phase, a `.timingCurve` the web pins by keyframe.
    ///
    /// Named because the near-misses are the damaging ones. An audit found 35
    /// inline curve constructors across 16 files carrying 21 distinct durations,
    /// and the harm was not the outliers: it was 0.15 sitting beside `fast`
    /// 0.12, 0.2 beside `base` 0.22, and 0.3/0.32/0.34 beside `slow` 0.36. Four
    /// values that close read as one intention executed inconsistently, which is
    /// exactly what a ladder exists to prevent.
    public enum Duration {
        /// 70ms — a press dip.
        public static let press: TimeInterval = 0.07
        /// 120ms — a property changing on the element already under the pointer.
        public static let fast: TimeInterval = 0.12
        /// 160ms — a dismissal.
        public static let exit: TimeInterval = 0.16
        /// 220ms — the default. Something small moving a short distance.
        public static let base: TimeInterval = 0.22
        /// 360ms — a whole region changing.
        public static let slow: TimeInterval = 0.36
    }

    /// The web's `--ease-out-soft`, for entrances. Deceleration: fast off the
    /// mark, settling at the end.
    public static func outSoft(_ duration: TimeInterval = Duration.slow) -> Animation {
        .timingCurve(0.33, 1, 0.68, 1, duration: duration)
    }

    /// The web's `--ease-out-expo`. A harder deceleration than ``outSoft(_:)``,
    /// for a value that should read as *arriving* rather than as changing.
    public static func outExpo(_ duration: TimeInterval = Duration.slow) -> Animation {
        .timingCurve(0.16, 1, 0.3, 1, duration: duration)
    }

    // MARK: - Reduce Motion

    /// What a given animation is *doing*, which is what decides how Reduce
    /// Motion should treat it.
    ///
    /// The preference was previously answered by one flat rule — everything
    /// became a 160ms ease-out — and one rule cannot be right for three
    /// different things. It over-served colour changes, which were never a
    /// vestibular problem and lost their character for nothing; and it
    /// under-served ambient loops, which do not want a shorter duration, they
    /// want to stop.
    public enum Tier: Sendable {
        /// Something moves, resizes, or crosses the layout: a sheet rising, a
        /// row sliding, a panel revealing. **Collapses to a flat cross-fade.**
        /// This is the tier the preference exists for.
        case travel
        /// Colour, opacity or a tint crossfading in place, with no geometry
        /// change. **Survives unchanged.** Reduce Motion asks for less movement,
        /// not for less feedback, and a fill that changes colour is not moving.
        case tint
        /// A continuous loop with no state behind it: a breathing glow, a
        /// shimmer, a pulsing dot. **Stops.** Returning `nil` here is the point
        /// — an ambient loop that is merely slowed is still unbidden motion in
        /// the reader's periphery, which is precisely what the preference is
        /// asking us not to make.
        case ambient
    }

    /// Returns the animation Reduce Motion should get for a given ``Tier``.
    ///
    /// The default tier is ``Tier/travel``, which is the behaviour every
    /// existing call site already had — a flat 160ms ease-out, deliberately not
    /// `nil`, because returning nil made 117 sites snap and a user who enables
    /// the preference stopped being told that anything had happened at all.
    /// Pass `.tint` or `.ambient` where the animation is genuinely one of those.
    public static func reduced(
        _ animation: Animation,
        when reduceMotion: Bool,
        tier: Tier = .travel
    ) -> Animation? {
        guard reduceMotion else { return animation }
        switch tier {
        case .travel: return .easeOut(duration: Duration.exit)
        case .tint: return animation
        case .ambient: return nil
        }
    }

    /// A continuous loop, or nothing at all under Reduce Motion.
    ///
    /// Sugar over `reduced(_:when:tier: .ambient)` so the ambient case reads as
    /// a decision at the call site rather than as an argument. Use it for
    /// anything driven by `repeatForever`; `TimelineView(.animation(paused:))`
    /// is the better tool where the loop is frame-driven.
    public static func ambient(_ animation: Animation, when reduceMotion: Bool) -> Animation? {
        reduced(animation, when: reduceMotion, tier: .ambient)
    }
}

// MARK: - Press

/// The button style that owns ``JunoMotion/press``.
///
/// A 70ms dip and a small opacity drop, and nothing else — no fill, no border,
/// no shape. It is a drop-in for `.buttonStyle(.plain)` on anything that draws
/// its own affordance, which is most of Juno's controls, and it is the reason
/// the press rung is no longer dead: `.plain` on macOS gives no press feedback
/// whatsoever, so every custom control in the app was silent under the pointer.
///
/// It reads Reduce Motion itself. A scale change is spatial travel, so under the
/// preference the dip is dropped and the opacity carries the press alone.
public struct JunoPressButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        // The body is a real `View` rather than modifiers applied straight to
        // `configuration.label`, because `@Environment` read from a `ButtonStyle`
        // itself is not re-evaluated when the environment changes — the style is
        // not a `DynamicProperty` container. A style that reads Reduce Motion
        // the obvious way would answer whatever the preference was when the
        // style value was created, which for a preference the user toggles mid
        // session is the same as not reading it.
        PressBody(configuration: configuration)
    }

    private struct PressBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
                .opacity(configuration.isPressed ? 0.72 : 1)
                .animation(
                    JunoMotion.reduced(JunoMotion.press, when: reduceMotion, tier: .tint),
                    value: configuration.isPressed
                )
        }
    }
}

public extension ButtonStyle where Self == JunoPressButtonStyle {
    /// `.buttonStyle(.junoPress)` — a plain button that answers the pointer.
    static var junoPress: JunoPressButtonStyle { JunoPressButtonStyle() }
}

// MARK: - Transitions

/// The two transitions that make ``JunoMotion/exit`` reachable.
///
/// Both are asymmetric on purpose, and the asymmetry *is* the design: entrances
/// decelerate (`ease-out-soft`), exits accelerate (`ease-in`). Juno had no
/// accelerate curve in use anywhere, which is why every dismissal in the product
/// read as the UI being reluctant to let go.
public extension AnyTransition {
    /// Something arriving over the content: a popover's inner content, a toast,
    /// an inspector card, an inline confirmation.
    static var junoOverlay: AnyTransition {
        .asymmetric(
            insertion: .opacity
                .combined(with: .scale(scale: 0.98))
                .animation(JunoMotion.outSoft(JunoMotion.Duration.base)),
            removal: .opacity.animation(JunoMotion.exit)
        )
    }

    /// Something appearing *within* a column of content: a disclosure body, a
    /// validation message, a streamed line. No scale — it must not push the text
    /// around it sideways.
    static var junoInline: AnyTransition {
        .asymmetric(
            insertion: .opacity.animation(JunoMotion.outSoft(JunoMotion.Duration.base)),
            removal: .opacity.animation(JunoMotion.exit)
        )
    }
}

// MARK: - Accessibility

/// The three system accessibility switches Juno's *hand-drawn* chrome must
/// answer, carried as one testable value.
///
/// System controls answer these switches on their own — Liquid Glass
/// substitutes itself under Reduce Transparency, `List` selection strengthens
/// under Increase Contrast — which is a large part of why the desktop
/// vocabulary keeps handing surfaces to the system. But Juno also draws by
/// hand: a hover fill, a translucent pane tint over a presentation's material,
/// a segmented track, an ambient aura. The system cannot reach into those, so
/// they must consult the switches themselves, and this type is the policy they
/// consult. It is a plain value rather than a view so the policy can be
/// unit-tested without a render pass; in a view, read it through
/// ``SwiftUI/EnvironmentValues/junoAccessibility`` so a custom fill answers
/// the same switches, live, that the platform's own controls do.
public struct JunoAccessibilityPreferences: Equatable, Sendable {
    public var reduceMotion: Bool
    public var reduceTransparency: Bool
    public var increaseContrast: Bool

    public init(
        reduceMotion: Bool = false,
        reduceTransparency: Bool = false,
        increaseContrast: Bool = false
    ) {
        self.reduceMotion = reduceMotion
        self.reduceTransparency = reduceTransparency
        self.increaseContrast = increaseContrast
    }

    /// A *scheduling* duration under Reduce Motion: a `Task.sleep` before a
    /// reveal, a timed phase. Zero rather than merely shorter, because a
    /// scheduled delay is dead air once the motion it was pacing is gone.
    /// `Animation` values never come through here — they go through
    /// ``JunoMotion/reduced(_:when:tier:)``, whose travel tier deliberately
    /// keeps a short cross-fade so a state change is still announced.
    public func animationDuration(_ proposed: TimeInterval) -> TimeInterval {
        reduceMotion ? 0 : max(0, proposed)
    }

    /// Whether a hand-drawn transient surface — a hover fill, a pane tint laid
    /// over a popover's material — should abandon its translucency and paint at
    /// full alpha. Reduce Transparency swaps system materials to opaque backers
    /// by itself, but it cannot see a custom `opacity(…)` fill; this is the
    /// question such a fill asks instead.
    public var usesOpaqueTransientSurfaces: Bool {
        reduceTransparency
    }
}

public extension EnvironmentValues {
    /// The current ``JunoAccessibilityPreferences``, assembled from the three
    /// system switches.
    ///
    /// A computed key path over the live environment rather than a stored
    /// custom key, so `@Environment(\.junoAccessibility)` tracks the system
    /// values themselves — there is no injection step to forget, and a switch
    /// the user flips mid-session propagates exactly as the underlying
    /// environment values do.
    var junoAccessibility: JunoAccessibilityPreferences {
        JunoAccessibilityPreferences(
            reduceMotion: accessibilityReduceMotion,
            reduceTransparency: accessibilityReduceTransparency,
            increaseContrast: colorSchemeContrast == .increased
        )
    }
}
