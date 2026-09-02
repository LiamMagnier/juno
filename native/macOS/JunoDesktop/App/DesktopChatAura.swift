import Foundation
import JunoDesignSystem
import SwiftUI

// MARK: - Choreography

/// The distances and beats the chat surface's motion travels, in the website's
/// own numbers.
///
/// **Not a motion ladder.** This used to be `DesktopChatMotion`, which carried
/// four `Animation` values beside the shared ``JunoMotion`` — a second ladder
/// with the same curves written as raw numbers, which is exactly what the
/// motion gate exists to refuse. The curves now live on ``JunoMotion``
/// (`canvasEnter`, `riseIn`, `exit`, `standard`); what remains here is the
/// geometry those curves move through and the delays between beats, which are
/// not animations and belong to this surface alone.
enum DesktopChoreography {
    /// The web's `slide-in-from-right-4`. Sixteen points, not a full-width sweep:
    /// opening reads as the card handing off to the workspace beside it rather
    /// than as a scene change.
    static let canvasSlide: CGFloat = 16
    /// `rise-in`'s `translateY(8px) → 0`.
    static let riseDistance: CGFloat = 8
    /// The greeting's first beat — the web's `[animation-delay:60ms]`.
    static let greetingPhraseBeat = Duration.milliseconds(60)
    /// Its second — `[animation-delay:180ms]` on the name.
    static let greetingNameBeat = Duration.milliseconds(180)
}

// MARK: - Aura inputs

/// The four inputs ``JunoComposerAura`` is driven by, held where both the
/// greeting and the composer can reach them.
///
/// On this Mac the bloom is mounted behind the **greeting**, not behind the
/// composer — the literal reading of the note the stylesheet already carries,
/// that "the greeting reads ON the aura". But every value that drives it is
/// known only inside ``DesktopComposer``: which lab is selected, how hard it is
/// set to think, whether the field has focus, whether a message has just left.
/// The greeting is that composer's sibling, and `@State` cannot span two
/// siblings — so the inputs live here and the composer publishes into them,
/// exactly as ``DesktopTasksSurface`` carries the Tasks page's selection across
/// two columns of the same window.
///
/// There is deliberately no `mounted` flag or instance count. Exactly one aura
/// exists at a time because the two branches of the conversation column are
/// mutually exclusive; a second instance would double every alpha and break the
/// `--aura` × `--aura-lit` × `--aura-pulse` arithmetic the design system's own
/// tests pin.
@MainActor
@Observable
final class DesktopChatAuraState {
    /// The selected model's lab. Empty before a catalog has arrived, which
    /// ``JunoProviderGlow/glow(providerID:dark:)`` answers with the account's
    /// accent — the web's `--aura-provider` fallback, not another lab's colour.
    var providerID = ""
    /// How hard the model is set to think, 0…1, from
    /// ``JunoProviderGlow/auraThink(effort:hasEffortControl:)``.
    var think = JunoProviderGlow.unaskedThink
    /// True while the composer holds focus: typing warms the bloom.
    var focused = false
    /// One swell per accepted send. Written only by ``fireSendSwell()``.
    private(set) var sending = false

    private var swellReset: Task<Void, Never>?

    /// Fires the send swell and clears it on a timer.
    ///
    /// A timer, and never an animation-completion callback. The website hit
    /// exactly this bug: it drove the swell from a CSS class removed on
    /// `animationend`, and under `prefers-reduced-motion` the keyframes are
    /// switched off — so the event never arrived and the class stuck for the rest
    /// of the session. A timer fires whether or not anything animated, which is
    /// the property that matters.
    func fireSendSwell() {
        swellReset?.cancel()
        sending = true
        swellReset = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1150))
            guard !Task.isCancelled else { return }
            self?.sending = false
        }
    }
}

/// The bloom itself, wired to ``DesktopChatAuraState``.
///
/// A view rather than a `View` extension so the colour-scheme read that picks
/// the lab's light happens inside SwiftUI's dependency tracking: the tint is
/// resolved per appearance, and switching the Mac to dark re-derives it instead
/// of keeping whatever was resolved when the window opened.
struct DesktopChatAuraLayer: View {
    let state: DesktopChatAuraState
    /// `false` is the empty state's full bloom; `true` the dialled-down variant
    /// that pools around the capsule inside an open conversation.
    let docked: Bool
    /// The conversation column's measured height, which is what the aura's
    /// `54vh` / `26vh` caps are taken against. Left `nil` the box falls back to
    /// the absolute cap alone, which is a taller bloom than the web draws on a
    /// short window.
    let viewport: CGFloat?

    @Environment(\.colorScheme) private var colorScheme
    /// The swell flag, one update behind the state's. See below.
    @State private var sending = false

    var body: some View {
        JunoComposerAura(
            tint: JunoProviderGlow.glow(
                providerID: state.providerID,
                dark: colorScheme == .dark
            ),
            think: state.think,
            focused: state.focused,
            sending: sending,
            docked: docked,
            viewport: viewport
        )
        // Re-armed rather than passed straight through.
        //
        // ``JunoComposerAura`` swells on the **rising edge** of `sending`, so an
        // instance born with it already true never sees one. That is exactly what
        // happens on the first message of a new chat: sending is what flips the
        // column from the greeting to the transcript, so the aura that was asked
        // to swell is torn down and a docked one is built in its place mid-swell.
        // Seeding false and raising the edge on the next pass hands the new bloom
        // the swell the old one was showing — which is what the browser gets for
        // free, because a CSS animation starts when the class is present on an
        // element as it is created.
        .onChange(of: state.sending, initial: true) { _, isSending in
            sending = isSending
        }
    }
}

// MARK: - The greeting

/// The home greeting, laid out the way the web lays it out, on the light it is
/// meant to be read on.
///
/// The web's `grid-cols-[1fr_auto_1fr]` (`empty-state.tsx`) is not incidental:
/// only the middle cell carries text, so the phrase sits on the column's **true**
/// horizontal centre and the mark flanks it without moving it. An `HStack` of
/// mark + text centres the *pair* instead, which pushes the greeting left of
/// centre by half the mark — and the composer directly beneath it is centred, so
/// the two read as misaligned. Reproduced here with two equally-flexible outer
/// cells, which is what `1fr … 1fr` means.
///
/// The serif is real Newsreader, not a fallback: the faces are copied into the
/// app bundle's `Resources` and `ATSApplicationFontsPath` is `.`, so
/// ``JunoSerif/isBundled`` resolves the PostScript names and `greeting(compact:)`
/// returns the custom face. Nothing here should ask for `Font.custom("Newsreader")`
/// — that family name resolves nothing and falls back to the system sans in
/// silence.
struct DesktopDraftGreeting: View {
    let profileName: String?
    /// Retained in the screen contract while older preview fixtures migrate;
    /// ordinary chat no longer uses model-coloured decorative lighting.
    let aura: DesktopChatAuraState
    /// The column's measured height, forwarded to the aura's `vh` caps.
    let viewport: CGFloat?

    /// The web's `sm:h-[1.83rem]` mark, at the root font size the site ships.
    private static let markSize: CGFloat = 29

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Pinned once, at first appearance.
    ///
    /// `JunoGreeting.phrase(forHour:)` picks at random by default — the web's
    /// own client-side behaviour, so the greeting varies between visits. Read
    /// from a computed property it would have re-rolled on *every* body
    /// evaluation, which the entrance animation below would have made obvious:
    /// the sentence would change words mid-rise.
    @State private var phrase: String
    @State private var phraseRisen = true
    @State private var nameRisen = true

    init(profileName: String?, aura: DesktopChatAuraState, viewport: CGFloat?) {
        self.profileName = profileName
        self.aura = aura
        self.viewport = viewport
        _phrase = State(
            initialValue: JunoGreeting.phrase(
                forHour: Calendar.current.component(.hour, from: Date())
            )
        )
    }

    private var firstName: String? {
        JunoGreeting.firstName(from: profileName)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            // The mark's cell: flexible, contents end-aligned, so the mark hugs
            // the phrase from the left exactly as `justify-end pr-[0.38em]` does.
            // It rides the first beat, as it does on the web.
            JunoMark(size: Self.markSize)
                .padding(.trailing, JunoSpace.regular)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .opacity(phraseRisen ? 1 : 0)
                .offset(y: phraseRisen ? 0 : DesktopChoreography.riseDistance)

            sentence

            // The web's mirror column, balancing the mark's flexible cell on the
            // other side of the phrase.
            //
            // `maxHeight: 0` is the whole fix for the home screen's dead space.
            // The note that used to sit here said `Color.clear` "has no intrinsic
            // size, so it can only ever absorb slack — it cannot report a height
            // back up". That is true of the WIDTH and false of the height: a
            // `Color` is greedy in both axes, so this cell quietly grew to the
            // full height of the column, took the greeting's row with it, and
            // pushed the composer to the floor of the window. The draft screen
            // read as a greeting stranded at the top of a void with a composer
            // parked at the bottom, instead of the pair the VStack around it is
            // written to centre.
            //
            // Constraining the height rather than swapping in a `Spacer` keeps
            // the horizontal behaviour identical: this has to be a flexible CELL
            // mirroring `frame(maxWidth: .infinity)` opposite, not a spring.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: 0)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, JunoSpace.region)
        .accessibilityElement(children: .combine)
        .task { await rise() }
    }

    /// The sentence, as two stacked copies of itself.
    ///
    /// The web rises the phrase at 60ms and the name at 180ms, which needs the
    /// two halves to be separately animatable — and two `Text`s in a stack is
    /// exactly the arrangement that broke the phone's greeting onto two lines the
    /// moment either half grew. So the *layout* stays what it always was: one
    /// string, wrapped as one sentence. Each copy carries the whole sentence and
    /// paints only its own half, the other half being the same glyphs at
    /// `Color.clear` — identical metrics, so the two land on top of each other to
    /// the pixel, and each can be lifted on its own beat.
    private var sentence: some View {
        ZStack {
            greetingText(showing: .phrase)
                .opacity(phraseRisen ? 1 : 0)
                .offset(y: phraseRisen ? 0 : DesktopChoreography.riseDistance)

            greetingText(showing: .name)
                .opacity(nameRisen ? 1 : 0)
                .offset(y: nameRisen ? 0 : DesktopChoreography.riseDistance)
                // The visible sentence is already carried whole by the copy
                // above; announcing the second would read the name twice.
                .accessibilityHidden(true)
        }
    }

    private enum GreetingHalf {
        case phrase
        case name
    }

    private func greetingText(showing half: GreetingHalf) -> some View {
        Text(attributedSentence(showing: half))
            .font(JunoSerif.greeting(compact: false))
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            // `.empty-greeting`'s halo: `text-shadow: 0 0 10px hsl(var(--background)/.8),
            // 0 0 30px hsl(var(--background)/.55)` — the page's own background
            // shaped to the glyphs. It restores local contrast against the bloom
            // without a plate, a blur or a second colour, and it costs nothing
            // where there is no light behind the text. CSS blur radius is twice
            // SwiftUI's, hence 5 and 15.
            .shadow(color: Color.junoCanvasWarm.opacity(0.8), radius: 5)
            .shadow(color: Color.junoCanvasWarm.opacity(0.55), radius: 15)
    }

    private func attributedSentence(showing half: GreetingHalf) -> AttributedString {
        var text = AttributedString(firstName == nil ? phrase : "\(phrase), ")
        text.foregroundColor = half == .phrase ? Color.primary : Color.clear
        if let firstName {
            var name = AttributedString(firstName)
            name.font = JunoSerif.greetingName(compact: false)
            name.foregroundColor = half == .name ? nameInk : Color.clear
            text.append(name)
        }
        return text
    }

    /// The name's step in lightness *away* from the light behind it — down on
    /// paper, up on a warm near-black — so accent type and accent glow can never
    /// meet in the middle.
    ///
    /// The name is set in the very accent the bloom is made of: same hue, close
    /// luminance, the worst case there is for legibility. This is
    /// `globals.css`'s `.empty-greeting__name`, including its two deliberate
    /// asymmetries — the dark step is additive and clamped rather than
    /// proportional (multiplying moves the palest accents furthest, which is
    /// backwards, and violet arrived as white with a faint cast), and amber takes
    /// a deeper light-mode step of its own because a hue near 39° carries far
    /// more luminance per unit of lightness than violet or teal do.
    private var nameInk: Color {
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

    /// The two-beat entrance.
    ///
    /// Under Reduce Motion both halves are simply present — the web drops the
    /// `rise-in` keyframe entirely behind `motion-safe:`, and a greeting that
    /// fades where it does not rise would be inventing motion the preference
    /// asked us not to make. A cancelled sleep falls through rather than
    /// throwing out of the task, so a greeting torn down mid-beat is still fully
    /// visible if it is put back.
    private func rise() async {
        guard !reduceMotion else {
            phraseRisen = true
            nameRisen = true
            return
        }
        try? await Task.sleep(for: DesktopChoreography.greetingPhraseBeat)
        withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)) {
            phraseRisen = true
        }
        try? await Task.sleep(
            for: DesktopChoreography.greetingNameBeat - DesktopChoreography.greetingPhraseBeat
        )
        withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)) {
            nameRisen = true
        }
    }
}
