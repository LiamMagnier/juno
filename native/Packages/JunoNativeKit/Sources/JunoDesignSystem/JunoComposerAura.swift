import SwiftUI

/// The bloom behind the composer: one soft radial light that says whose model
/// you are about to talk to and how hard it is set to think.
///
/// This is the native half of `.composer-aura` in `src/app/globals.css`, and
/// every number below is that file's — the seven-stop ramp, the two effort
/// curves, the send swell, the eleven-second breathe. Matching them is what
/// makes the phone, the Mac and the browser read as one product rather than
/// three takes on an idea.
///
/// **One gradient, not a stack.** Stacked shadows drew the bloom as three
/// separate falloffs whose seams read as concentric rings on a good display, and
/// a shadow paints only outside its own box, which left a dark plate under the
/// capsule. A single ramp has no seams to band along and covers its own box, so
/// there is no plate. The ramp is hand-shaped to a rough Gaussian rather than
/// left linear, because a straight alpha ramp spends most of its length in the
/// flat middle — exactly where 8-bit alpha steps are widest and most visible.
///
/// **The last stop is the same colour at zero alpha, never `.clear`.** `.clear`
/// is transparent *black*: interpolating to it drags the whole outer third of
/// the ramp through grey and the bloom loses its hue on the way out. Building
/// the final stop from the tint and setting its opacity to zero keeps the hue
/// all the way to the rim, which is the same fix the CSS makes when it refuses
/// `transparent`.
///
/// **Why this is not a `Canvas`.** ``JunoVoiceAura`` earns its
/// `TimelineView(.animation)` because its shape genuinely changes every frame.
/// This one does not: it is a static gradient whose *scalars* move, so it is
/// driven by `withAnimation` over a handful of `@State` doubles and by a
/// `scaleEffect` the compositor owns. It sits directly behind a Liquid Glass
/// surface, which re-samples whatever is behind it every frame — a per-frame
/// repaint here is paid twice, and it is paid out of the composer's frame rate.
///
/// Purely decorative, so it takes no hit-testing and is hidden from VoiceOver:
/// everything it says is said again by the model name and the thinking control.
public struct JunoComposerAura: View {
    /// The colour the entire ramp derives from.
    ///
    /// The caller owns the accent-versus-lab decision, exactly as the cascade
    /// does on the web: idle it is the account's accent, so the empty state
    /// answers the accent picker live; focused it becomes the lab's light from
    /// ``JunoProviderGlow/glow(providerID:dark:)``. Every stop derives from this
    /// one colour so the whole bloom turns over together and stays a coherent
    /// light rather than a mix of two, and a change to it is crossfaded here.
    private let tint: JunoColorToken
    /// How hard the model is set to think, 0…1 — see
    /// ``JunoProviderGlow/auraThink(effort:hasEffortControl:)``.
    private let think: Double
    /// True while the composer holds focus. Typing warms the bloom: the one
    /// place the composer is allowed an accent response to focus, since it
    /// happens behind the surface rather than on it.
    private let focused: Bool
    /// Flip to true on send. One swell and settle; the aura clears it itself.
    private let sending: Bool
    /// The docked variant, which is the one inside an open conversation: a third
    /// of the light and short enough that it pools around the capsule instead of
    /// washing up the transcript. `false` is the empty state's full bloom.
    private let docked: Bool
    /// The window height the two `vh` caps are measured against, when the caller
    /// knows it.
    ///
    /// SwiftUI has no `vh`, and the closest stand-ins are all wrong: the aura
    /// sits in a `background`, so the size it is proposed is the composer's, and
    /// `UIScreen.main` is both deprecated and the wrong box on a Mac. Left
    /// `nil`, the height falls back to the absolute cap alone, which is the
    /// right shape on anything but a short window. Note the reason the *web*
    /// clamps against the viewport — that the box is real layout and whatever it
    /// clears below the composer is added to the empty state's scroll height —
    /// does not exist here: a SwiftUI background contributes no layout at all.
    private let viewport: CGFloat?

    public init(
        tint: JunoColorToken,
        think: Double,
        focused: Bool,
        sending: Bool,
        docked: Bool = true,
        viewport: CGFloat? = nil
    ) {
        self.tint = tint
        self.think = think
        self.focused = focused
        self.sending = sending
        self.docked = docked
        self.viewport = viewport
        // Seeded from the initialiser rather than eased in from a sentinel on
        // first appearance, so opening a conversation shows the light the model
        // has earned instead of animating up to it while the keyboard arrives.
        _easedThink = State(initialValue: JunoComposerAuraRamp.clamped(think))
        _tintRed = State(initialValue: tint.red)
        _tintGreen = State(initialValue: tint.green)
        _tintBlue = State(initialValue: tint.blue)
    }

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Effort, eased. The web transitions `--aura-think` itself and lets both
    /// scalars fall out of it as `calc()`s, so dragging the slider swells the
    /// light instead of stepping it; easing the same single input here keeps
    /// brightness and size in lockstep for free.
    @State private var easedThink: Double
    /// The tint mid-crossfade, held as components because a `Color` is not
    /// interpolable on its own. Eased through RGB rather than through hue: coral
    /// to Gemini's blue is 200° of wheel, and rotating it sweeps the bloom
    /// through green on the way.
    @State private var tintRed: Double
    @State private var tintGreen: Double
    @State private var tintBlue: Double
    /// `--aura-pulse`. Multiplies every alpha; 1 at rest.
    @State private var pulse: Double = 1
    /// Bumped on each rising edge of `sending`, so the swell runs to completion
    /// even if the caller drops `sending` again a frame later.
    @State private var swellCount = 0
    @State private var breathing = false

    // MARK: - Timing, from the web's own tokens

    /// `--dur-slow` on `--ease-out-soft`. Written through ``JunoMotion`` rather
    /// than as a bare `timingCurve` so the curve and the duration both stay on
    /// the ladder — an inline `(0.33, 1, 0.68, 1, duration: 0.36)` is
    /// indistinguishable from an inline `0.34` at a glance, and near-misses of
    /// that size are what a motion ladder exists to catch.
    private static let tintEase = JunoMotion.outSoft(JunoMotion.Duration.slow)
    /// 520ms on `--ease-out-expo`. Effort eases a touch slower than colour:
    /// moving the slider should feel like light coming up, not like a value
    /// changing. Deliberately off the ladder's top rung — this is the web's own
    /// keyframe duration, not a rounding of `slow`.
    private static let effortEase = JunoMotion.outExpo(0.52)
    /// `composer-aura-send`: 1 → 2.3 at 16% of 1100ms → 1.
    private static let swellPeak: Double = 2.3
    private static let swellRise: TimeInterval = 0.176
    private static let swellFall: TimeInterval = 0.924
    /// The guaranteed clear, a hair past the end of the animation.
    private static let swellClear = Duration.milliseconds(1150 - 176)
    /// `composer-aura-breathe`: 11s for the whole 1 → 1.06 → 1 cycle, which is
    /// half that each way once SwiftUI is doing the reversing.
    private static let breatheEase = JunoMotion
        .outSoft(5.5)
        .repeatForever(autoreverses: true)

    public var body: some View {
        GeometryReader { proxy in
            let box = box(in: proxy.size)
            Rectangle()
                // `ellipse 50% 50% at 50% 47%`: an elliptical gradient inscribed
                // in its own box is exactly this shape, and it is the one thing
                // a plain `RadialGradient` cannot express — that one is circular,
                // so a box three times wider than it is tall would paint a disc
                // with dead corners rather than a wash.
                .fill(
                    EllipticalGradient(
                        gradient: ramp,
                        center: UnitPoint(x: 0.5, y: 0.47)
                    )
                )
                .frame(width: box.width, height: box.height)
                // Effort scales the bloom, it does not resize it. The box stays
                // exactly the size and place it always was and this grows or
                // shrinks it about its own centre, which is the only formulation
                // where the centre cannot move — a width that changes has to be
                // re-centred every frame, and any disagreement between the two
                // reads as the light sliding sideways as it dims.
                .scaleEffect(JunoComposerAuraRamp.reach(think: easedThink) * (breathing ? 1.06 : 1))
                // `top: calc(50% - .5rem)` — half the composer root's bottom
                // padding, so the bloom centres on the capsule rather than on the
                // column. Otherwise the light pools under it.
                .position(x: proxy.size.width / 2, y: proxy.size.height / 2 - 8)
        }
        .opacity(focused ? 1 : 0.85)
        // `.tint`: the aura's focus response is an opacity change on a
        // non-interactive backdrop, with no geometry moving. Reduce Motion asks
        // for less movement, not for less feedback, so this rung survives the
        // preference where the swell and the breathe below do not.
        .animation(
            JunoMotion.reduced(Self.tintEase, when: reduceMotion, tier: .tint),
            value: focused
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: JunoComposerAuraRamp.clamped(think)) { _, value in
            withAnimation(JunoMotion.reduced(Self.effortEase, when: reduceMotion)) {
                easedThink = value
            }
        }
        .onChange(of: tint) { _, value in
            withAnimation(JunoMotion.reduced(Self.tintEase, when: reduceMotion, tier: .tint)) {
                tintRed = value.red
                tintGreen = value.green
                tintBlue = value.blue
            }
        }
        .onChange(of: sending) { _, isSending in
            guard isSending else { return }
            swellCount += 1
        }
        .task(id: swellCount) { await swell() }
        // The idle breathe is *removed* under Reduce Motion rather than frozen —
        // the web drops the whole keyframe rule behind a
        // `prefers-reduced-motion: no-preference` query. This is deliberately
        // unlike JunoVoiceAura, which keeps its field and only stops the travel:
        // there the motion carries information (someone is talking), here it
        // carries none, so under the preference there is nothing to preserve.
        .onChange(of: reduceMotion, initial: true) { _, reduced in
            guard !reduced else {
                var still = Transaction()
                still.disablesAnimations = true
                withTransaction(still) { breathing = false }
                return
            }
            withAnimation(Self.breatheEase) { breathing = true }
        }
    }

    // MARK: - The ramp

    /// The seven stops, verbatim from the CSS: base alpha, then per-stop
    /// lightness and saturation multipliers that take the colour up at the core
    /// and down through the rim, so the bloom reads as one light with a hot
    /// centre rather than as a flat wash fading out.
    private var ramp: Gradient {
        let base = JunoProviderGlow.hsl(red: tintRed, green: tintGreen, blue: tintBlue)
        let scale = JunoComposerAuraRamp.aura(docked: docked, dark: colorScheme == .dark)
            * JunoComposerAuraRamp.lit(think: easedThink)
            * pulse

        return Gradient(
            stops: JunoComposerAuraRamp.stops.map { stop in
                let colour = JunoColorToken(
                    hsl: (
                        h: base.h,
                        s: min(1, base.s * stop.saturation),
                        l: min(1, base.l * stop.lightness)
                    )
                )
                return Gradient.Stop(
                    color: Color(juno: colour).opacity(min(1, stop.alpha * scale)),
                    location: stop.location
                )
            }
        )
    }

    /// The laid-out bloom box, before ``JunoComposerAuraRamp/reach(think:)``
    /// scales it.
    ///
    /// Width is free in the empty state — the column above clips sideways, so
    /// nothing the bloom clears there can ever be scrolled to. Docked it is
    /// exactly the column and never wider, because there the nearest clip is the
    /// transcript's own, and leaning on that to hide an overhang would leave the
    /// container quietly scrollable.
    private func box(in size: CGSize) -> CGSize {
        CGSize(
            width: docked ? size.width : min(size.width * 1.8, 1152),
            height: min(
                docked ? 240 : 512,
                (viewport ?? .infinity) * (docked ? 0.26 : 0.54)
            )
        )
    }

    /// One swell and settle on send.
    ///
    /// Cleared on a timer rather than on an animation-completion callback. The
    /// website hit exactly this bug: it drove the swell from a CSS class and
    /// removed it on `animationend`, and under `prefers-reduced-motion` the
    /// keyframes are switched off — so that event never arrived and the class
    /// stuck for the rest of the session. A timer fires whether or not anything
    /// animated, which is the property that matters.
    @MainActor
    private func swell() async {
        // The swell is disabled outright under Reduce Motion, not shortened:
        // a bloom that doubles in brightness is exactly the kind of unbidden
        // motion the preference is asking us not to make.
        guard swellCount > 0, !reduceMotion else { return }

        withAnimation(JunoMotion.outExpo(Self.swellRise)) {
            pulse = Self.swellPeak
        }
        try? await Task.sleep(for: .milliseconds(Int(Self.swellRise * 1000)))
        guard !Task.isCancelled else { return }

        withAnimation(JunoMotion.outExpo(Self.swellFall)) {
            pulse = 1
        }
        try? await Task.sleep(for: Self.swellClear)
        guard !Task.isCancelled else { return }
        pulse = 1
    }
}

/// The composer aura's arithmetic, kept out of the view so it can be pinned to
/// the website's numbers by test rather than by eye.
enum JunoComposerAuraRamp {
    /// One stop of the bloom. `alpha` is the base alpha before `--aura`,
    /// `--aura-lit` and `--aura-pulse` scale it; the other two are multipliers on
    /// the tint's own lightness and saturation.
    struct Stop: Equatable {
        let location: Double
        let alpha: Double
        let lightness: Double
        let saturation: Double
    }

    /// The ramp, in order. The last stop is the tint at zero alpha — its
    /// lightness and saturation multipliers are deliberately non-zero, because
    /// they are what keeps the hue alive right to the rim. See
    /// ``JunoComposerAura`` for why `.clear` is not an option here.
    static let stops: [Stop] = [
        Stop(location: 0, alpha: 0.225, lightness: 1.08, saturation: 1),
        Stop(location: 0.18, alpha: 0.195, lightness: 1, saturation: 1),
        Stop(location: 0.36, alpha: 0.14, lightness: 0.88, saturation: 1),
        Stop(location: 0.54, alpha: 0.085, lightness: 0.72, saturation: 0.96),
        Stop(location: 0.72, alpha: 0.042, lightness: 0.55, saturation: 0.9),
        Stop(location: 0.88, alpha: 0.014, lightness: 0.4, saturation: 0.84),
        Stop(location: 1, alpha: 0, lightness: 0.3, saturation: 0.8),
    ]

    /// How bright, 0.62…1.48.
    ///
    /// Curved rather than ramped. A straight line puts a constant *absolute*
    /// step between tiers, which is a shrinking *relative* step as it climbs, so
    /// the deep end of the ladder — where the difference matters most — bunched
    /// up: 17% between the first two tiers but only 9% between the last two,
    /// under what the eye picks up. The quadratic term spends more of the range
    /// higher up and holds every step to about a sixth brighter than the one
    /// below it, evenly, from Instant to Max.
    static func lit(think: Double) -> Double {
        let t = clamped(think)
        return 0.62 + 0.42 * t + 0.44 * t * t
    }

    /// How big, 0.74…1. Reach tops out at exactly 1: the laid-out box is the one
    /// measured flush against short windows, and effort must never push past it.
    static func reach(think: Double) -> Double {
        0.74 + 0.26 * clamped(think)
    }

    /// `--aura` — one knob every alpha is scaled by, so the bloom can be dialled
    /// without re-balancing the ramp.
    ///
    /// Warm charcoal swallows a low-alpha wash that light paper shows plainly,
    /// so dark gets a little more of it. Docked takes roughly a third: it has
    /// messages above it to stay out of the way of, and earns its place by
    /// carrying the same two signals — the lab's colour while you type, the
    /// swell when you send.
    static func aura(docked: Bool, dark: Bool) -> Double {
        if docked { return dark ? 0.58 : 0.38 }
        return dark ? 1.5 : 1
    }

    static func clamped(_ think: Double) -> Double {
        min(max(think, 0), 1)
    }
}

/// The bloom without a conversation to sit behind.
///
/// Every input this view has is otherwise buried: the tint needs a model
/// selected, the effort needs a slider dragged, the swell needs a message
/// actually sent, and the docked variant needs a chat already open. Putting all
/// four on one screen is the only way to check that the ladder reads as an even
/// climb and that the two variants are recognisably the same light — the native
/// counterpart of the web's own `/dev` galleries.
#Preview("Composer aura") {
    struct Harness: View {
        @State private var think: Double = 0.5
        @State private var provider = "anthropic"
        @State private var focused = true
        @State private var docked = false
        @State private var sending = false

        private let providers = ["anthropic", "openai", "google", "moonshot", "xai"]

        var body: some View {
            VStack(spacing: JunoSpace.section) {
                Spacer()

                RoundedRectangle(cornerRadius: JunoRadius.composer, style: .continuous)
                    .fill(.background.secondary)
                    .overlay {
                        Text("Ask Juno anything")
                            .font(.callout)
                            .junoMetaInk()
                    }
                    .frame(height: 56)
                    .padding(.horizontal, JunoSpace.roomy)
                    .padding(.bottom, JunoSpace.regular)
                    .background {
                        JunoComposerAura(
                            tint: JunoProviderGlow.glow(providerID: provider),
                            think: think,
                            focused: focused,
                            sending: sending,
                            docked: docked
                        )
                    }

                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    Picker("Lab", selection: $provider) {
                        ForEach(providers, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    HStack {
                        Text("Thinking")
                            .font(.caption)
                            .junoSecondaryInk()
                        Slider(value: $think, in: 0...1)
                        Text(String(format: "%.2f", think))
                            .font(.caption.monospacedDigit())
                            .junoSecondaryInk()
                    }

                    Toggle("Focused", isOn: $focused)
                    Toggle("Docked", isOn: $docked)

                    Button("Send") {
                        sending = true
                        Task {
                            try? await Task.sleep(for: .milliseconds(1150))
                            sending = false
                        }
                    }
                }
                .font(.caption)
                .padding(JunoSpace.regular)
            }
            .frame(width: 460, height: 620)
        }
    }
    return Harness()
}
