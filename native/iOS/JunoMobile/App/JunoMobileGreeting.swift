import JunoChatKit
import JunoDesignSystem
import Observation
import SwiftUI

// MARK: - The web's motion tokens

/// The website's authored easing curves and durations, as SwiftUI animations.
///
/// `JunoMotion` offers springs, which are the right default for anything the
/// finger drives. These are the other half: the *authored* curves the stylesheet
/// uses for choreography — a message rising in, a chevron turning over, a thumb
/// travelling to a detent — where the browser and the phone have to agree frame
/// for frame or the two products stop feeling like one. Every value is
/// `--ease-*` / `--dur-*` from `src/app/globals.css`, unchanged.
enum JunoMobileMotion {
    /// `--dur-fast`. Immediate feedback: a press, a colour swap.
    static let durFast: TimeInterval = 0.12
    /// `--dur-base`. The default: rows, chevrons, travel between detents.
    static let durBase: TimeInterval = 0.22
    /// `--dur-slow`. Whole-surface crossfades.
    static let durSlow: TimeInterval = 0.36

    /// `--ease-spring: cubic-bezier(0.32, 0.72, 0, 1)`. Travel and rise — it
    /// leaves fast and lands slowly, which is what makes a move read as weight
    /// rather than as a tween.
    static func easeSpring(_ duration: TimeInterval) -> Animation {
        .timingCurve(0.32, 0.72, 0, 1, duration: duration)
    }

    /// `--ease-out-soft: cubic-bezier(0.33, 1, 0.68, 1)`.
    static func easeOutSoft(_ duration: TimeInterval) -> Animation {
        .timingCurve(0.33, 1, 0.68, 1, duration: duration)
    }

    /// `rise-in`: 0.32s on the spring curve. The one entry animation the whole
    /// product uses — a new message, a greeting, a row in the model picker.
    static let riseIn = easeSpring(0.32)

    /// The half of `rise-in` a `transition` expresses: opacity 0 → 1 and an 8pt
    /// climb. Paired with ``riseIn`` on the container's `.animation(_:value:)`,
    /// which is also what limits it to genuinely new content — SwiftUI does not
    /// run insertion transitions for the rows that were already there on the
    /// first layout, so a loaded history arrives settled, exactly as the web's
    /// `animateFrom` index arranges by hand.
    /// Computed rather than stored: `AnyTransition` is not `Sendable`, so a
    /// `static let` of one is shared mutable state under Swift 6's checking.
    /// Rebuilding it per read costs nothing — it is two value-type wrappers.
    static var riseInTransition: AnyTransition { .opacity.combined(with: .offset(y: 8)) }

    /// `fade-in`: 0.2s ease-out. Used where a value is *replaced* in place —
    /// the model name after picking a different model.
    static let fadeIn = Animation.easeOut(duration: 0.2)

    /// `fade-in-up`: 0.25s ease-out, and the 6pt climb that goes with it.
    static let fadeInUp = Animation.easeOut(duration: 0.25)
    static var fadeInUpTransition: AnyTransition { .opacity.combined(with: .offset(y: 6)) }
}

/// The web's `active:scale-[0.97]` on `duration-fast ease-out-soft`, for the
/// composer's chips.
///
/// A `.plain` button gives no press feedback at all, and these chips sit on
/// Liquid Glass, which already flexes — so the scale is small on purpose: enough
/// to confirm the tap landed, not enough to fight the material underneath.
struct JunoMobileChipPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        // The environment is read in a nested `View`, not on the style itself: a
        // `ButtonStyle` is not a dynamic-property container, so an `@Environment`
        // declared here would silently keep its default and Reduce Motion would
        // never be honoured.
        Press(pressed: configuration.isPressed, label: configuration.label)
    }

    private struct Press: View {
        let pressed: Bool
        let label: ButtonStyleConfiguration.Label

        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            label
                .scaleEffect(pressed && !reduceMotion ? 0.97 : 1)
                .animation(
                    JunoMotion.reduced(
                        JunoMobileMotion.easeOutSoft(JunoMobileMotion.durFast),
                        when: reduceMotion
                    ),
                    value: pressed
                )
        }
    }
}

// MARK: - The bloom's inputs

/// Everything ``JunoComposerAura`` needs, gathered by the screen that owns the
/// model selection so the greeting and the composer cannot disagree about which
/// lab is lit.
///
/// This exists because the light moved. The bloom used to be mounted only behind
/// the composer, where every input was already local; it now lights the
/// *greeting* on an empty screen — which is where the web puts it, and where it
/// belongs, since the greeting is the thing you are reading while you decide
/// what to ask. The screen is the only place that can see both.
struct JunoMobileAuraLight: Equatable {
    /// The lab's own ambient light, or the account's accent for a model this
    /// client has never heard of.
    var tint: JunoColorToken
    /// How hard the model is set to think, 0…1.
    var think: Double
    /// True while the composer holds focus. Typing warms the bloom.
    var focused: Bool
    /// Flipped on an accepted send; the aura clears it itself.
    var sending: Bool
    /// The chat column's measured height, so the aura's `54vh` cap means
    /// something on a short screen. Nil until the column has been measured —
    /// handing the aura a zero would clamp the bloom out of existence on the
    /// first frame.
    var viewport: CGFloat?

    /// - Parameter model: the selected model, or nil while the catalog loads.
    ///
    /// Main-actor isolated because the palette it reads is: `JunoProviderGlow`
    /// resolves the account's accent through a main-actor store, and every caller
    /// builds this from a `View` body anyway.
    @MainActor
    init(
        model: NativeChatModelOption?,
        effort: NativeReasoningEffort?,
        focused: Bool,
        sending: Bool,
        viewport: CGFloat,
        dark: Bool
    ) {
        tint = JunoProviderGlow.glow(providerID: model?.providerID ?? "", dark: dark)
        // Gated on whether a thinking control is actually on screen, not on
        // whether the model reasons: models that reason without exposing tiers
        // would otherwise burn at the dimmest end with no slider anywhere to
        // explain why. Same contract the composer uses.
        think = JunoProviderGlow.auraThink(
            effort: effort?.rawValue,
            hasEffortControl: model.map { NativeThinkingScale(model: $0).isPresentable } ?? false
        )
        self.focused = focused
        self.sending = sending
        self.viewport = viewport > 0 ? viewport : nil
    }
}

/// The send swell, held by the screen rather than by the composer.
///
/// It has to be shared, because the thing that swells is not always the thing
/// that was tapped: on an empty screen the bloom is behind the *greeting* and
/// the Send button is in the composer below it. One object both can see is the
/// smallest arrangement that keeps them in step.
///
/// Cleared on a timer and **not** on an animation-completion callback. The
/// website hit exactly this bug: it drove the swell from a CSS class and removed
/// it on `animationend`, and under `prefers-reduced-motion` the keyframes are
/// switched off — so the event never arrived and the class stuck for the rest of
/// the session. A timer fires whether or not anything animated.
@MainActor
@Observable
final class JunoMobileSendSwell {
    private(set) var active = false

    @ObservationIgnored private var reset: Task<Void, Never>?

    /// The 1100ms keyframe plus 50ms, so the belt-and-braces clear lands just
    /// past the end of the animation rather than inside it.
    private static let clearAfter = Duration.milliseconds(1150)

    func fire() {
        reset?.cancel()
        active = true
        reset = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.clearAfter)
            guard !Task.isCancelled else { return }
            self?.active = false
        }
    }
}

// MARK: - The bloom, mounted

/// ``JunoComposerAura`` with its swell re-armed a beat behind the caller's.
///
/// The aura starts a swell on the **rising edge** of `sending`, so an instance
/// born with it already true never sees one — and on the phone the send is
/// exactly what re-mounts the bloom. Two ways round:
///
/// - a conversation with no turns yet. `sendMessage` appends the user message
///   and the placeholder in the same update, so the greeting's full bloom is torn
///   down and the composer's docked one is *born* mid-swell;
/// - a new chat, where creating the conversation swaps the draft screen for the
///   conversation screen under a swell that has already started.
///
/// Seeding false and raising the edge on the next pass hands the new bloom the
/// swell the old one was showing — which is what the browser gets for free,
/// because a CSS animation starts when the class is present on an element as it
/// is created. The Mac carries the same shim, as `DesktopChatAuraLayer`; every
/// iOS mount point goes through this one so the two platforms cannot drift.
struct JunoMobileAuraLayer: View {
    let light: JunoMobileAuraLight
    /// `false` is the empty state's full bloom; `true` the dialled-down variant
    /// that pools around the capsule inside a conversation.
    let docked: Bool

    /// The swell flag, one update behind the light's. See above.
    @State private var sending = false

    var body: some View {
        JunoComposerAura(
            tint: light.tint,
            think: light.think,
            focused: light.focused,
            sending: sending,
            docked: docked,
            viewport: light.viewport
        )
        .onChange(of: light.sending, initial: true) { _, isSending in
            sending = isSending
        }
    }
}

// MARK: - The greeting

/// The website's home greeting, ported: the mark, a time-of-day phrase, then the
/// reader's first name in medium italic accent — lit from behind by the same
/// bloom the composer used to keep to itself.
///
/// **The glow is here, not under the capsule.** On the web there is exactly one
/// `.composer-aura`; it lives in the composer's host but stands 32rem tall and is
/// centred above it, so its top half spills over the gap and the greeting reads
/// *on* the light (`globals.css`, the comment above `.empty-greeting`). Native
/// cannot borrow that trick — a SwiftUI background is sized by its host, and the
/// composer's host is a strip at the foot of the screen — so the mount point
/// moves instead: on an empty screen the greeting carries the undocked bloom and
/// the composer carries none, and inside a conversation it is the other way
/// round. Exactly one instance either way, which is what keeps the `--aura` /
/// `--aura-lit` / `--aura-pulse` arithmetic honest.
///
/// **Two beats, one line box.** The phrase rises at 60ms and the name at 180ms,
/// as the browser does. Doing that with two `Text`s in an `HStack` is what broke
/// the layout before — either half growing pushed the other onto its own line,
/// which the web's inline spans never do. So the sentence is still built once, as
/// one `AttributedString`, and drawn *twice*: each copy hides the half it is not
/// animating behind a clear foreground. Identical strings and identical fonts
/// mean identical line breaking and an identical `minimumScaleFactor` resolution,
/// so the two copies cannot drift apart — and a clear glyph casts no halo, so
/// each copy's legibility shadow lands only around the words it actually shows.
struct JunoMobileGreeting: View {
    var name: String?
    /// The bloom behind the sentence. Nil where something else owns the light:
    /// during a call the voice field has it, and two lights under one sentence
    /// read as a bug.
    var aura: JunoMobileAuraLight?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var phrase = ""
    /// The two beats, flipped 60ms and 180ms after the greeting appears.
    @State private var phraseIn = false
    @State private var nameIn = false

    private var firstName: String? {
        guard let name, let first = name.split(separator: " ").first else { return nil }
        return String(first)
    }

    private var compact: Bool { sizeClass == .compact }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            JunoMark(size: compact ? 21 : 29)
                .opacity(phraseIn ? 1 : 0)
                .offset(y: phraseIn ? 0 : 8)
            sentence
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity)
        .background { auraLayer }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(plainGreeting)
        .onAppear {
            if phrase.isEmpty {
                phrase = JunoGreeting.phrase(
                    forHour: Calendar.current.component(.hour, from: Date())
                )
            }
            play()
        }
    }

    /// The two stacked copies of the one sentence. See the type's note for why
    /// this is not two `Text`s side by side.
    private var sentence: some View {
        ZStack {
            layer(showsName: false)
                .opacity(phraseIn ? 1 : 0)
                .offset(y: phraseIn ? 0 : 8)
            layer(showsName: true)
                .opacity(nameIn ? 1 : 0)
                .offset(y: nameIn ? 0 : 8)
        }
    }

    private func layer(showsName: Bool) -> some View {
        Text(greetingText(showsName: showsName))
            .font(JunoSerif.greeting(compact: compact))
            .multilineTextAlignment(.center)
            .minimumScaleFactor(0.7)
            .lineLimit(2)
            // `.empty-greeting`: the page's own background, shaped to the
            // glyphs. It restores local contrast over the bloom without a plate,
            // a blur or a second colour, and costs nothing where there is no
            // glow behind the text. Two stacked shadows rather than CSS's two
            // independent ones — the second sees the first, which reads as a
            // marginally denser halo and is the closest SwiftUI offers.
            .shadow(color: Color.junoCanvas.opacity(0.8), radius: 5)
            .shadow(color: Color.junoCanvas.opacity(0.55), radius: 15)
    }

    @ViewBuilder
    private var auraLayer: some View {
        if let aura {
            // The empty state's full bloom. Docked is for a transcript that has
            // messages to stay out of the way of; here the sentence is the only
            // thing on screen and the light is meant to reach it.
            JunoMobileAuraLayer(light: aura, docked: false)
        }
    }

    /// Runs the two beats. Delays rather than a single spring, because the
    /// website's stagger is what gives the greeting its cadence — the name
    /// arriving a moment after the phrase is the difference between a sentence
    /// being said and a block being shown.
    private func play() {
        guard !phraseIn else { return }
        guard !reduceMotion else {
            phraseIn = true
            nameIn = true
            return
        }
        withAnimation(JunoMobileMotion.riseIn.delay(0.06)) { phraseIn = true }
        withAnimation(JunoMobileMotion.riseIn.delay(0.18)) { nameIn = true }
    }

    /// One sentence, with one half made invisible.
    ///
    /// `.clear` and not an omission: both copies must lay out the *whole* string
    /// or they would break lines differently and the two beats would land in
    /// different places.
    private func greetingText(showsName: Bool) -> AttributedString {
        var result = AttributedString(firstName == nil ? phrase : "\(phrase), ")
        if showsName { result.foregroundColor = .clear }
        guard let firstName else { return result }
        var name = AttributedString(firstName)
        name.font = JunoSerif.greetingName(compact: compact)
        name.foregroundColor = showsName ? nameColour : .clear
        result.append(name)
        return result
    }

    /// The name's step in lightness *away* from the light behind it — up on dark
    /// paper, down on light — so accent type and accent glow can never meet in
    /// the middle. `globals.css`'s `.empty-greeting__name`, including its two
    /// deliberate asymmetries: the dark step is additive and clamped rather than
    /// proportional (multiplying moves the palest accents furthest, which is
    /// backwards), and amber takes a deeper light-mode step of its own because
    /// hue near 39° carries far more luminance per unit of lightness.
    private var nameColour: Color {
        let accent = JunoAccentSelection.shared.current
        let light = accent.hsl(dark: false)
        let dark = accent.hsl(dark: true)
        return Color.junoAdaptive(
            light: JunoColorToken(
                hsl: accent == .amber
                    ? (h: light.h, s: light.s, l: light.l * 0.68)
                    : (h: light.h, s: light.s * 0.94, l: light.l * 0.82)
            ),
            dark: JunoColorToken(
                hsl: (h: dark.h, s: dark.s, l: min(0.78, max(0.52, dark.l + 0.14)))
            )
        )
    }

    private var plainGreeting: String {
        firstName.map { "\(phrase), \($0)" } ?? phrase
    }
}
