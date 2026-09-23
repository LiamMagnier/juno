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

    /// Package-internal constructor for the curated palette tokens, whose
    /// components are known-valid literals.
    init(unchecked red: Double, _ green: Double, _ blue: Double, _ opacity: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    // The brand primitives. Every one of them now reads the generated
    // projection of `src/app/globals.css` (`Generated/JunoGeneratedTokens.swift`)
    // rather than holding a hand-converted triple.
    //
    // `warmWhite` and `warmBlack` used to sit here as the canvas, and they were
    // the reason this comment exists. They were the one ground the generator
    // did not feed, so they went stale twice: `48 7% 9%` after the web moved to
    // a 4% ground, and then 4% after the web moved back up to the 11.5% warm
    // charcoal it ships today — which left the Mac painting a near-black the
    // website no longer has. The canvas is now `JunoGeneratedColors.background`
    // like every other surface (see `JunoColorToken.canvasLight`). The one
    // hand-kept ground left is the phone's dark canvas, held at its shipped 4%
    // on purpose and documented where it is declared.

    /// `--primary`: Juno's coral, the same value in light and dark — the web
    /// does not brighten it, and neither should we.
    ///
    /// `15 54% 46%`, darkened from 51% on the web so white on it clears the
    /// 4.5:1 the primary CTA's label needs. This is the *brand* coral, not the
    /// account's accent: anything that should follow the accent picker reads
    /// ``SwiftUI/Color/junoAccent`` instead.
    public static let coral = JunoGeneratedColors.primary.light

    /// This token at a fraction of its current alpha.
    ///
    /// The derived tokens — tertiary ink, the glass fills, the selection edge —
    /// are a web ink at an opacity (`text-muted-foreground/70`,
    /// `foreground / 0.06`). Deriving them here, from the projected ink, is
    /// what keeps them following that ink when the web retunes it; a literal
    /// RGBA would be one more hand-kept copy.
    public func withOpacity(_ factor: Double) -> JunoColorToken {
        JunoColorToken(unchecked: red, green, blue, opacity * min(max(factor, 0), 1))
    }

    /// The same hue and saturation, `delta` lighter (positive) or darker
    /// (negative) in HSL lightness — the unit every web colour token is
    /// written in, so a declared divergence can be stated as "one step darker
    /// than the web" and keep meaning that when the web moves.
    public func adjustingLightness(by delta: Double) -> JunoColorToken {
        let maxC = max(red, green, blue)
        let minC = min(red, green, blue)
        let lightness = (maxC + minC) / 2
        let chroma = maxC - minC
        var hue = 0.0
        var saturation = 0.0
        if chroma > 0 {
            saturation = chroma / (1 - abs(2 * lightness - 1))
            switch maxC {
            case red: hue = 60 * ((green - blue) / chroma).truncatingRemainder(dividingBy: 6)
            case green: hue = 60 * ((blue - red) / chroma + 2)
            default: hue = 60 * ((red - green) / chroma + 4)
            }
            if hue < 0 { hue += 360 }
        }
        let shifted = JunoColorToken(
            hsl: (hue, saturation, min(max(lightness + delta, 0), 1))
        )
        return JunoColorToken(unchecked: shifted.red, shifted.green, shifted.blue, opacity)
    }
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
    //
    // Every timed rung is a generated duration on a generated curve
    // (`JunoGeneratedDuration` × `JunoGeneratedEasing`), so the Mac runs the
    // web's own `transition: <dur> <ease>` pairs rather than SwiftUI's stock
    // `.easeOut`/`.easeIn`, which are neither of the web's curves. The springs
    // keep SwiftUI's duration/bounce form — the web has no spring token to
    // project — and are the only rungs ``platformFactor`` touches.

    /// A press: `--dur-press` (70ms) on `--ease-out-soft`, for the 0.97 dip.
    ///
    /// Below the direct-manipulation threshold: anything slower than ~70ms on
    /// a transform is *felt* as lag on the one interaction where latency is
    /// most obvious. Its home is ``JunoPressButtonStyle`` — no view author
    /// reaches for a 70ms animation by hand.
    public static let press = outSoft(Duration.press)
    /// Feedback on the element already under the pointer: a hover fill, a
    /// face swap (send → stop), the message action row's reveal.
    /// `--dur-fast` (120ms) on `--ease-out-soft`.
    public static let fast = outSoft(Duration.fast)
    /// Everything leaving: `--dur-exit` (160ms) on `--ease-in`.
    ///
    /// Entrances decelerate, exits accelerate, and exit is ~0.65 × its
    /// entrance — a dismissal on an ease-out reads as the UI being reluctant to
    /// let go. Its home is the removal half of ``SwiftUI/AnyTransition/junoOverlay``
    /// and ``SwiftUI/AnyTransition/junoInline``: an exit curve is only
    /// reachable through an asymmetric transition.
    public static let exit = timingCurve(JunoGeneratedEasing.in, duration: Duration.exit)
    /// The default entrance: `--dur-base` (220ms) on `--ease-out-soft`. The
    /// greeting, the starter chips, an arriving turn, a toast.
    public static let base = outSoft(Duration.base)
    /// A whole region changing in place: `--dur-slow` (360ms) on
    /// `--ease-out-expo`. The AI title cross-fading into a sidebar row.
    public static let slow = outExpo(Duration.slow)
    /// Standard transitions: selection, the composer growing, tiles, the
    /// segmented thumb. A 0.22s spring with a 0.05 bounce, × ``platformFactor``.
    public static let standard = Animation.spring(
        duration: Duration.base * platformFactor, bounce: 0.05
    )
    /// Emphasized transitions: the composer handoff from the empty state to a
    /// conversation. A 0.36s spring with a 0.10 bounce, × ``platformFactor``.
    public static let emphasized = Animation.spring(
        duration: Duration.slow * platformFactor, bounce: 0.10
    )
    /// The composer handoff (§10.1 of the Mac redesign) as the one transaction
    /// it is: ``emphasized``, or under Reduce Motion a 160ms cross-fade.
    ///
    /// Not ``reduced(_:when:tier:)``, whose travel substitute is 220ms: the
    /// handoff under Reduce Motion is *several things leaving at once* — the
    /// greeting, the chips, the composer's lift — and a leaving thing is timed
    /// on `--dur-exit`. Kept here rather than at the call sites so the two
    /// places that start a handoff (a first send, a call dialled from a draft)
    /// cannot drift apart.
    public static func handoff(reduceMotion: Bool) -> Animation {
        reduceMotion ? outSoft(Duration.exit) : emphasized
    }
    /// Layout that must not overshoot: a dock opening, a panel changing height.
    /// ``emphasized``'s duration with no bounce, because an edge that bounces
    /// past its resting place drags the content beside it along twice.
    public static let layout = Animation.spring(
        duration: Duration.slow * platformFactor, bounce: 0
    )
    /// Interactive, gesture-following spring for anything tracking a held
    /// finger or a dragged pointer.
    public static let interactive = Animation.interactiveSpring(
        response: 0.32 * platformFactor, dampingFraction: 0.85
    )
    /// The older name for ``interactive``. Kept so the ladder gains a rung
    /// without renaming every drag surface in one commit.
    public static let spring = interactive
    /// The one celebratory rung, and the only bounce above the house range.
    ///
    /// **Exactly two sites product-wide**: a run reaching Completed, and an
    /// approval being accepted. A third fails review. Bounce is the single
    /// strongest toy-versus-tool dial, which is why the ceiling is 0.18 and why
    /// it is spent on the two moments a person has genuinely been waiting for.
    /// Not scaled by ``platformFactor``: a reward is the same size everywhere.
    public static let reward = Animation.spring(duration: Duration.slow, bounce: 0.18)

    /// Same names, different values: the Mac runs the springs at three
    /// quarters of the phone's, with identical bounce.
    ///
    /// A pointer covers distance faster than a thumb, the windows are larger,
    /// and identical timings on both platforms are themselves a tell that
    /// motion was specified once and shipped twice. One factor, applied here
    /// and nowhere else — a call site that multiplies by hand is starting a
    /// second ladder.
    ///
    /// **Springs only.** The timed rungs (press, fast, exit, base, slow) are the
    /// web's own durations and stay exactly that on the Mac: they pace
    /// feedback, not travel, and a hover that answers faster than the web's
    /// would read as a different product rather than a native one. Recorded
    /// as deliberate difference 11 in the redesign spec's register (§0.8).
    public static var platformFactor: Double {
        #if os(macOS)
            return 0.75
        #else
            return 1
        #endif
    }

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
    /// Every rung forwards to ``JunoGeneratedDuration``, which
    /// `scripts/generate-design-tokens.ts` projects from the `--dur-*` custom
    /// properties in `src/app/globals.css`.
    ///
    /// These used to be five independent literals that happened to equal the
    /// generated ones. That is the same failure mode the colour tokens'
    /// header describes: a conversion done by hand, once, with nothing
    /// re-checking it. It was worse here than for colour, because
    /// ``JunoGeneratedDuration`` already existed and had **no consumers at
    /// all** — the projection was generated, verified by `design:tokens:check`,
    /// and then ignored, while `JunoMotionTests` pinned the hand-written array.
    /// Retuning `--dur-base` to 200ms on the web would have left Swift at 0.22
    /// with every check still green.
    ///
    /// Forwarding costs nothing at runtime (these inline to the same constants)
    /// and means the generator is now load-bearing rather than decorative.
    public enum Duration {
        /// `--dur-press`, 70ms — a press dip.
        public static let press = JunoGeneratedDuration.press
        /// `--dur-fast`, 120ms — a property changing on the element already
        /// under the pointer.
        public static let fast = JunoGeneratedDuration.fast
        /// `--dur-exit`, 160ms — a dismissal.
        public static let exit = JunoGeneratedDuration.exit
        /// `--dur-base`, 220ms — the default. Something small moving a short
        /// distance.
        public static let base = JunoGeneratedDuration.base
        /// `--dur-slow`, 360ms — a whole region changing.
        public static let slow = JunoGeneratedDuration.slow
        /// `--dur-emphasis`, 560ms — a one-shot that has to be *noticed*.
        ///
        /// Present on the web and in the projection since the ladder was
        /// written, and unreachable from Swift until now because the hand-copied
        /// enum stopped at five rungs. Deliberately more than double ``base``:
        /// the web's own note beside it records that at 250–350ms an emphasis
        /// move reads as slowness rather than as significance.
        public static let emphasis = JunoGeneratedDuration.emphasis
    }

    /// The web's `--ease-out-soft`, for entrances. Deceleration: fast off the
    /// mark, settling at the end.
    ///
    /// The four control points come from ``JunoGeneratedEasing``, for the same
    /// reason the durations do — they were inline literals here, and the
    /// generator already projects every `--ease-*` curve the stylesheet
    /// declares.
    public static func outSoft(_ duration: TimeInterval = Duration.slow) -> Animation {
        timingCurve(JunoGeneratedEasing.outSoft, duration: duration)
    }

    /// The web's `--ease-out-expo`. A harder deceleration than ``outSoft(_:)``,
    /// for a value that should read as *arriving* rather than as changing.
    public static func outExpo(_ duration: TimeInterval = Duration.slow) -> Animation {
        timingCurve(JunoGeneratedEasing.outExpo, duration: duration)
    }

    // MARK: - Choreography rungs

    /// A pane settling in from the edge it docks against — the artifact canvas,
    /// the preview dock, the simulator pane, the review pane: `--dur-base` on
    /// `--ease-out-expo`.
    ///
    /// This used to be `DesktopChatMotion.canvasEnter`, a second ladder the Mac
    /// app kept beside this one with the same curve written as four raw
    /// numbers. One ladder, one rung.
    public static let canvasEnter = outExpo(Duration.base)

    /// The web's `rise-in`: opacity 0→1 over a ``riseDistance`` lift, on
    /// `--dur-base` and `--ease-out-soft` — `animate-rise-in` in
    /// `tailwind.config.ts`, which is ``base`` exactly.
    ///
    /// It used to be `--ease-out-strong` over 360ms, a curve and a duration the
    /// web's keyframe never used: the greeting and each arriving turn landed a
    /// beat later, and harder, than the same moment in the browser.
    ///
    /// **The phone keeps the old entrance for now.** Its greeting and message
    /// arrival were choreographed against the 360ms rise (the greeting's two
    /// beats are staged on it), so retiming them is part of the phone's own
    /// pass rather than a token change that lands underneath it.
    #if os(iOS)
    public static let riseIn = timingCurve(JunoGeneratedEasing.outStrong, duration: Duration.slow)
    #else
    public static let riseIn = base
    #endif

    /// How far a `rise-in` entrance travels, in points: the web's 6px
    /// (`translateY(calc(6px * var(--motion-shift, 1)))`). Read it through
    /// ``shift(_:reduceMotion:)`` so Reduce Motion zeroes it.
    public static let riseDistance: CGFloat = 6

    /// A travel distance, or zero under Reduce Motion — the native form of the
    /// web's `--motion-shift`, which multiplies every translating keyframe.
    public static func shift(_ distance: CGFloat, reduceMotion: Bool) -> CGFloat {
        reduceMotion ? 0 : distance
    }

    /// A starting scale, or identity under Reduce Motion — the web's
    /// `--motion-scale-from`.
    public static func scaleFrom(_ scale: CGFloat, reduceMotion: Bool) -> CGFloat {
        reduceMotion ? 1 : scale
    }

    /// The periods of the loops that carry live state, in seconds. Each one
    /// runs on `--ease-breathe` (``JunoGeneratedEasing/breathe``) on the web,
    /// and each one stops under Reduce Motion through ``ambient(_:when:)``.
    ///
    /// Only live state loops. A loop with nothing happening behind it is the
    /// ambient decoration the redesign removes.
    public enum Loop {
        /// `thinking-matrix`: the nine-dot working mark.
        public static let matrix: TimeInterval = 1.8
        /// `status-glow`: the live status dot's breathe.
        public static let statusBreathe: TimeInterval = 2.8
        /// `skeleton-breathe`: a loading placeholder's rise and settle.
        public static let skeletonBreathe: TimeInterval = 1.8
    }

    /// One of the ``Loop`` periods as a running breathe: half the period out on
    /// `--ease-breathe`, half back, forever.
    ///
    /// Always pass it through ``ambient(_:when:)`` — a loop is the one kind of
    /// motion Reduce Motion stops rather than shortens — and drive it from a
    /// state flipped in `onAppear`, so the loop has two values to travel
    /// between.
    public static func breathe(period: TimeInterval) -> Animation {
        timingCurve(JunoGeneratedEasing.breathe, duration: period / 2)
            .repeatForever(autoreverses: true)
    }

    /// Builds a SwiftUI curve from a projected cubic-bezier quadruple.
    ///
    /// One place that knows the control-point order, so a new `--ease-*` rung
    /// becomes a two-line addition rather than another inline `.timingCurve`
    /// with four unlabelled numbers.
    static func timingCurve(
        _ curve: (x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat),
        duration: TimeInterval
    ) -> Animation {
        .timingCurve(curve.x1, curve.y1, curve.x2, curve.y2, duration: duration)
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
        /// row sliding, a panel revealing. **Its spring becomes `--ease-out-soft`
        /// at `--dur-base`, and the caller drops the distance** through
        /// ``JunoMotion/shift(_:reduceMotion:)`` and
        /// ``JunoMotion/scaleFrom(_:reduceMotion:)`` — so what is left is the
        /// same change as a cross-fade. This is the tier the preference exists
        /// for.
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
    /// The default tier is ``Tier/travel``: deliberately an animation and not
    /// `nil`, because returning nil made 117 sites snap and a user who enables
    /// the preference stopped being told that anything had happened at all.
    /// Pass `.tint` or `.ambient` where the animation is genuinely one of those.
    ///
    /// The travel substitute is the web's own reduced-motion block in
    /// `globals.css`, which re-points `--ease-spring`, `--ease-out-strong` and
    /// `--ease-out-expo` at `--ease-out-soft` and caps `--dur-slow` at
    /// `--dur-base`: a spring with its travel removed has nothing left to
    /// overshoot, and a spring on opacity alone clips.
    ///
    /// On 26.4 and later, pass ``JunoAccessibilityPreferences/reducesTravel``
    /// rather than the bare Reduce Motion flag, so the system's "Prefer
    /// Cross-Fade Transitions" setting is answered by the same substitution.
    public static func reduced(
        _ animation: Animation,
        when reduceMotion: Bool,
        tier: Tier = .travel
    ) -> Animation? {
        guard reduceMotion else { return animation }
        switch tier {
        case .travel: return outSoft(Duration.base)
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

// MARK: - Reading measures

/// The two column widths every reading surface in the product is set to.
///
/// The web's `AppPage` has `measure="reading" (48rem) | "wide" (64rem)`; this
/// is that pair in points. It exists because the number 768 was declared in
/// three places and 720/800/820 in four others, each a private constant that
/// happened to be near the one beside it — the transcript, the composer, the
/// context strip and the remote canvas were each a few points off one another
/// and none of them could be retuned from one line.
public enum JunoReadingMeasure {
    /// 768 — prose: a transcript, a composer, a page of settings text.
    public static let reading: CGFloat = 768
    /// 1024 — a page of tiles or a list that earns the extra width.
    public static let wide: CGFloat = 1024
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

    /// A page or product taking the column: the web's `rise-in` — a cross-fade
    /// with a 6pt lift on the way in, a plain fade on the way out. Under Reduce
    /// Motion the lift is the travel that goes; the caller drops it through
    /// ``JunoMotion/reduced(_:when:tier:)`` on the animation, and the offset
    /// collapses into the same short cross-fade.
    static var junoPage: AnyTransition {
        .asymmetric(
            insertion: .opacity
                .combined(with: .offset(y: JunoMotion.riseDistance))
                .animation(JunoMotion.riseIn),
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
    /// The system's "Prefer Cross-Fade Transitions" (26.4 and later; always
    /// false before it). It asks for the same thing as Reduce Motion's travel
    /// tier — the change without the movement — so the two are answered by one
    /// substitution through ``reducesTravel``.
    public var prefersCrossFadeTransitions: Bool

    public init(
        reduceMotion: Bool = false,
        reduceTransparency: Bool = false,
        increaseContrast: Bool = false,
        prefersCrossFadeTransitions: Bool = false
    ) {
        self.reduceMotion = reduceMotion
        self.reduceTransparency = reduceTransparency
        self.increaseContrast = increaseContrast
        self.prefersCrossFadeTransitions = prefersCrossFadeTransitions
    }

    /// Whether travel — a lift, a slide, a scale — should collapse to a
    /// cross-fade. Pass this as the `when:` of
    /// ``JunoMotion/reduced(_:when:tier:)`` for the travel tier and to
    /// ``JunoMotion/shift(_:reduceMotion:)``.
    ///
    /// Loops answer Reduce Motion alone: a cross-fade preference says how a
    /// transition should look, not that ambient state should stop.
    public var reducesTravel: Bool {
        reduceMotion || prefersCrossFadeTransitions
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
        var crossFade = false
        if #available(macOS 26.4, iOS 26.4, *) {
            crossFade = accessibilityPrefersCrossFadeTransitions
        }
        return JunoAccessibilityPreferences(
            reduceMotion: accessibilityReduceMotion,
            reduceTransparency: accessibilityReduceTransparency,
            increaseContrast: colorSchemeContrast == .increased,
            prefersCrossFadeTransitions: crossFade
        )
    }
}
