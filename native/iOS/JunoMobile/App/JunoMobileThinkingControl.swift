import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import SwiftUI

/// The composer's Thinking control: a compact chip showing the current level,
/// which opens a small popover anchored directly above it holding a discrete
/// slider over exactly the levels the selected model supports.
///
/// It renders nothing at all for a model that cannot reason — an inert control
/// would be a lie about what the model does — and shows a non-adjustable "Auto"
/// state for the router, which chooses depth per message on the server.
struct JunoMobileThinkingControl: View {
    let scale: NativeThinkingScale
    @Binding var effort: NativeReasoningEffort?
    @Binding var fastMode: Bool
    @Binding var proMode: Bool

    @State private var presented = false
    /// Bumped every time the ladder lands on its deepest stop, so the flourish
    /// replays on each fresh arrival rather than once per app run.
    @State private var topArrivals = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var currentStop: NativeThinkingStop? {
        scale.stops.first { $0.effort == effort }
    }

    private var label: String {
        if scale.isAutomatic { return "Auto" }
        return currentStop?.label ?? "Off"
    }

    /// Whether the ladder is at its deepest rung — "Max" on the models that have
    /// one. The website reserves a whole visual language for this stop, and the
    /// chip is the phone's smallest honest share of it.
    private var atTopTier: Bool {
        guard !scale.isAutomatic, scale.stops.count > 1, let currentStop else { return false }
        return currentStop == scale.stops.last
    }

    var body: some View {
        if scale.isPresentable {
            Button {
                guard scale.isAdjustable else { return }
                presented = true
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoMobileThinkingLabel(text: label, ultra: atTopTier, pop: topArrivals)
                    if scale.isAdjustable {
                        Image(systemName: "chevron.up")
                            .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
                            .junoSecondaryInk()
                            // Turns over while the picker is up, as the web's
                            // chevron does.
                            .rotationEffect(.degrees(presented ? 180 : 0))
                            .animation(
                                JunoMotion.reduced(
                                    JunoMotion.outSoft(JunoMotion.Duration.base),
                                    when: reduceMotion
                                ),
                                value: presented
                            )
                    }
                }
                .foregroundStyle(scale.isAutomatic ? Color.secondary : Color.primary)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.tight)
                .modifier(JunoMobileComposerChipBackground())
                // The chip draws at its own height; the finger gets the same 44pt
                // the composer's round controls beside it already carry, in the
                // capsule shape the chip visibly is.
                .frame(minHeight: 44)
                .contentShape(Capsule(style: .continuous))
            }
            .buttonStyle(JunoMobileChipPressStyle())
            .disabled(!scale.isAdjustable)
            .onChange(of: atTopTier) { _, isTop in
                guard isTop else { return }
                topArrivals += 1
            }
            .accessibilityLabel("Thinking")
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(scale.isAdjustable ? "Opens the thinking level picker" : "")
            .accessibilityIdentifier("juno.mobile.chat-thinking")
            .popover(isPresented: $presented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
                JunoThinkingPopover(
                    scale: scale,
                    effort: $effort,
                    width: popoverWidth,
                    fastMode: $fastMode,
                    proMode: $proMode
                )
                    // Stays a compact anchored popover on iPhone too: a full
                    // sheet would detach the control from the value it sets.
                    // The fixed size is also what keeps it off the keyboard.
                    .presentationCompactAdaptation(.popover)
            }
            // Keyed on the scale: the catalog arrives after first render, so a
            // plain `.task` runs while the default model is still selected —
            // typically Auto, which is not adjustable — and never retries once
            // the real model lands.
            .task(id: scale) {
                #if DEBUG
                guard JunoComposerPreviewFlags.opensThinking, scale.isAdjustable else { return }
                try? await Task.sleep(nanoseconds: 500_000_000)
                presented = true
                #endif
            }
        }
    }

    /// Grows only with Dynamic Type; a fixed width keeps the popover compact
    /// and keeps its measuring content from feeding back into its own layout.
    private var popoverWidth: CGFloat {
        typeSize.isAccessibilitySize ? 320 : 268
    }

    private var accessibilityValue: String {
        if scale.isAutomatic { return "Chosen automatically for each message" }
        guard let currentStop else { return "Off" }
        let range = scale.stops.map(\.label).joined(separator: ", ")
        // The modes are announced here because they are set inside the popover
        // this chip opens: without them a VoiceOver reader has no way to learn
        // that Flash is on without opening the control to find out.
        var value = "\(currentStop.label). Available levels: \(range)"
        if scale.fastModeRateMultiplier != nil, fastMode { value += ". Flash on" }
        if scale.supportsProMode, proMode { value += ". Pro on" }
        return value
    }
}

// MARK: - The value, and what the deepest one looks like

/// The Thinking chip's current value.
///
/// Two behaviours, both the website's. The word crossfades when it changes,
/// because the chip is small enough that a straight swap reads as a glitch. And
/// the *deepest* stop is drawn differently: the browser gives its top tier a
/// panning violet ramp and a landing pop, and a "Max" that looks exactly like
/// "Low" throws that distinction away on the platform where the control is
/// smallest and most easily missed.
///
/// The pan is an offset gradient behind a text mask rather than a redrawn
/// gradient. An animated `foregroundStyle` does not interpolate — a `Color` is
/// not a `LinearGradient` — and a `TimelineView` would repaint every frame
/// directly on top of a Liquid Glass capsule, which re-samples what is behind it
/// every frame anyway. A `.offset` is owned by the compositor and costs the
/// composer's frame rate nothing.
private struct JunoMobileThinkingLabel: View {
    let text: String
    let ultra: Bool
    /// Increments on each fresh arrival at the deepest stop.
    let pop: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var popped = false

    var body: some View {
        label
            .id(text)
            .transition(.opacity)
            .animation(
                JunoMotion.reduced(
                    JunoMotion.outSoft(JunoMotion.Duration.base), when: reduceMotion, tier: .tint
                ),
                value: text
            )
            // `ultra-pop`: 1 → 1.18 at 45% → 1 over 420ms. The landing flourish
            // for arriving at the deepest stop, and the only moment this chip
            // ever moves.
            .scaleEffect(popped ? 1.18 : 1)
            .task(id: pop) {
                guard pop > 0, ultra, !reduceMotion else { return }
                withAnimation(
                    JunoMotion.reduced(
                        JunoMotion.outSoft(JunoMotion.Duration.base), when: reduceMotion
                    )
                ) { popped = true }
                try? await Task.sleep(for: .seconds(JunoMotion.Duration.base))
                guard !Task.isCancelled else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.exit, when: reduceMotion)) {
                    popped = false
                }
            }
    }

    @ViewBuilder
    private var label: some View {
        if ultra {
            JunoMobileThinkingRamp(text: text)
        } else {
            JunoMobileThinkingWord(text: text)
        }
    }
}

/// The deepest stop's drifting ramp.
///
/// A view of its own, and that is the whole point: the travel is driven by a
/// `@State` flag animated from `false` to `true`, so it can only start from a
/// flag that is *actually* false. Held one level up — on the chip's label, which
/// keeps its place in the composer's `HStack` whichever tier is selected — the
/// flag survived leaving the top tier still `true`, and coming back re-ran the
/// `onAppear` against a value that was already at its destination: SwiftUI has
/// nothing to interpolate, so the ramp froze at the far end of its travel for the
/// rest of the session. Here the state is born and dies with the branch that
/// draws it.
private struct JunoMobileThinkingRamp: View {
    let text: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var panned = false

    /// `--ultra-from` / `--ultra-to`, with the account's accent at both ends so
    /// the ramp leaves and returns to the colour the rest of the app is in.
    private var ramp: [Color] {
        let from = Color.junoAdaptive(
            light: JunoColorToken(hsl: (h: 252, s: 1, l: 0.68)),
            dark: JunoColorToken(hsl: (h: 252, s: 1, l: 0.76))
        )
        let to = Color.junoAdaptive(
            light: JunoColorToken(hsl: (h: 271, s: 0.91, l: 0.65)),
            dark: JunoColorToken(hsl: (h: 271, s: 0.93, l: 0.73))
        )
        return [.junoAccent, from, to, from, .junoAccent]
    }

    var body: some View {
        JunoMobileThinkingWord(text: text)
            .hidden()
            .overlay {
                LinearGradient(colors: ramp, startPoint: .leading, endPoint: .trailing)
                    // Three times the word's width, travelling a third of that
                    // each way: the ramp is always over the glyphs, so the
                    // colour drifts rather than sweeping past.
                    .scaleEffect(x: 3, anchor: .center)
                    .offset(x: panned ? 26 : -26)
            }
            .mask { JunoMobileThinkingWord(text: text) }
            .onAppear {
                withAnimation(
                    JunoMotion.ambient(
                        JunoMotion.outSoft(12).repeatForever(autoreverses: true),
                        when: reduceMotion
                    )
                ) {
                    panned = true
                }
            }
    }
}

/// The word itself, shared by both branches so the two states typeset
/// identically — the ramp is a mask of exactly these glyphs.
private struct JunoMobileThinkingWord: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .monospacedDigit()
            .lineLimit(1)
    }
}

// MARK: - Shared chip background

/// The composer's small controls all share one Liquid Glass capsule, so the
/// model chip and the Thinking chip read as parts of the same control row
/// rather than as two unrelated buttons.
///
/// **The capsule is also the hit area, and it has to say so.** Liquid Glass is
/// drawn by a layer of the system's own, not by content of ours, so a chip whose
/// only real content is a word and a chevron is touchable *only over the word
/// and the chevron* — the 10pt padding and the glass between them are dead. That
/// left the Thinking chip with a live band roughly 13pt wide inside a 56pt
/// capsule, and its centre — dragged rightwards by the chevron — landed in the
/// gap, so a tap dead in the middle of the control did nothing at all. The model
/// chip escaped only because its label is wide enough that its centre still
/// falls on a glyph. `contentShape` makes the whole capsule the target for both,
/// which is what it looks like and what a thumb aims at.
struct JunoMobileComposerChipBackground: ViewModifier {
    func body(content: Content) -> some View {
        // These controls live inside the composer, so refracting glass here
        // creates a capsule-inside-a-capsule and makes the row feel like a
        // stack of floating controls. A quiet opaque fill keeps the model and
        // thinking choices legible in both appearances; transient pickers still
        // use the system sheet/popover treatment when opened.
        content
            .background(Color.junoMuted, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 1))
            .contentShape(Capsule())
    }
}
