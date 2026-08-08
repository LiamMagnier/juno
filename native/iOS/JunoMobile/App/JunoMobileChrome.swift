import JunoDesignSystem
import SwiftUI

/// The chrome atoms shared by every screen in the phone app — the glass
/// containers, the card, the section header, and the deliberately-quiet loading
/// placeholder.
///
/// They live in one file because they *are* one decision: Liquid Glass for
/// floating controls, an opaque card for content, and nothing at all while data
/// is on its way.

// MARK: - Loading

/// What a screen shows while its data is still arriving: **nothing**.
///
/// Every list in this app reads from the on-device database first, so the wait
/// is milliseconds in the normal case and only a first-run or a cold sync takes
/// longer. A centred spinner over "Loading projects…" turned that into a full
/// screen of chrome announcing a wait that had usually already ended — and on a
/// phone it read as the app being slow rather than the data being fresh. An
/// empty canvas that fills in is calmer and, at the speeds involved, honest.
///
/// This is not a way to hide failure: every screen still renders its real error
/// and empty states. It only covers the in-between.
struct JunoMobileQuietLoading: View {
    var body: some View {
        Color.junoCanvas
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityHidden(true)
    }
}

// MARK: - Backdrop

extension View {
    /// Declares this screen's background — the canvas, laid down so that it also
    /// covers the strip the keyboard pushes into.
    ///
    /// **This is what `.background(Color.junoCanvas)` should have been.** A plain
    /// background is sized by the screen's safe area, and the keyboard's inset is
    /// not part of it, so raising a keyboard opened a band between the composer
    /// (or the search field, or the editor) and the top of the keyboard where
    /// nothing of ours painted. What showed there was the hosting container's own
    /// `systemBackground`: pure black in dark and pure white in light, against a
    /// canvas that is neither.
    ///
    /// It has to be applied *inside* a `NavigationStack` rather than around one,
    /// and that is measured rather than assumed: a canvas placed outside the
    /// stack, or on the drawer plate behind it, still left the band — the opaque
    /// view belongs to the navigation content itself, so only a layer above that
    /// content covers it. The rule that follows is the one this modifier exists
    /// to make cheap: **every navigation root and every presentation root carries
    /// it**, because those are the boundaries a new container is introduced at.
    func junoScreenCanvas() -> some View {
        background(Color.junoCanvas.ignoresSafeArea())
    }
}

// MARK: - Containers

/// A circular Liquid Glass container (OS 26+) with a material fallback, used for
/// the round chrome buttons: sidebar search, profile, sheet close.
struct JunoGlassCircle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}

// `JunoAccentGlassCapsule` used to live here: a hand-drawn capsule that painted
// `.regular.tint(Color.junoAccent.opacity(0.72))` behind a `.white` label, with
// an `opacity(0.82)` accent fill below OS 26.
//
// The dilution was the whole bug. `Glass.tint(_:)` honours its colour's alpha,
// so `.opacity(0.72)` does not "soften" the glass — it removes the tint's
// ability to establish a predictable luminance under the label, and the label's
// contrast becomes a function of whatever the capsule happens to be floating
// over at that moment. A white label on a card at 0.72 measured ~2.6:1 against
// coral-over-cream; at full strength the same label sits on the accent's own
// luminance and measures 4.6:1 (coral, `Color.junoOnAccent`), which is what the
// design system's `junoOnAccent` pairing is calibrated for.
//
// The replacement is not a fixed capsule at all. Every one of the nine call
// sites was a `Button` wrapped in `.buttonStyle(.plain)`, so the right answer is
// the system's own primary-action treatment — `junoProminentAction()` in the
// design system, which is `.glassProminent` + `.tint(Color.junoAccent)` above 26
// and `.borderedProminent` + the same tint below. That brings Apple's tinted-glass
// contrast handling, its Increase Contrast substitution, its press flex and its
// metrics, and the explicit tint stops the button drawing in the *system* accent.
// It is also how the Mac already draws the same role, so the two apps converge.

/// A neutral Liquid Glass capsule for a secondary control in a floating row.
struct JunoGlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}

/// A subtle pressed-state wash shared by sidebar and list rows.
///
/// The wash is the warm ink at 6%, not `Color.primary` at 6%: the platform label
/// colour is a pure neutral, and a pure-neutral scrim over a canvas whose whole
/// identity is that red is its highest channel reads as grey dirt rather than as
/// the row darkening.
struct JunoSidebarPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(configuration.isPressed ? Color.junoForeground.opacity(0.06) : .clear)
            )
    }
}

/// A content card: opaque, one step off the canvas, hairline outlined.
///
/// Content surfaces stay opaque on purpose — glass behind running text is where
/// legibility goes, and the material is reserved for chrome that floats.
struct JunoCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            )
    }
}

/// A page's editorial heading — the serif, as on the web.
struct JunoPageTitle: View {
    let title: LocalizedStringKey
    var subtitle: LocalizedStringKey?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .junoPageHeading(compact: true)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .junoSecondaryInk()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A quiet group label above a run of rows.
struct JunoGroupLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
            .junoSecondaryInk()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
    }
}

/// The recurring "this went wrong, here is the one thing to do about it" strip.
/// Always carries the server's own sentence — never a generic apology.
///
/// The colour is `Color.junoCaution`, not `.orange`. `.orange` is the system
/// palette's orange — a hue this app never chose, tuned for a neutral grey
/// background, and it landed here on a warm cream canvas next to the coral
/// accent looking like a third brand colour. `junoCaution` is the ramp's own
/// amber, contrast-checked against the canvas in both appearances (4.54:1
/// light), and it is the token every other "recoverable error, awaiting a
/// retry" state in the product already uses.
struct JunoInlineError: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.junoCaution)
                .font(.caption)
            Text(message)
                .junoCaption()
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                // 44pt of target, not the ~17pt the bare `Text` label had. This
                // is the recovery control on a failed screen — the one place in
                // a flow where a missed tap costs the most — and it was the
                // smallest button on it.
                Button(action: retry) {
                    Text("Retry")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.junoAccent)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoCaution.opacity(0.10))
        )
        // `.contain`, not `.combine`. Combining flattened the strip into a
        // single static label and took the Retry button's action with it, so a
        // VoiceOver user could hear that something had failed but had no way to
        // ask for it again.
        .accessibilityElement(children: .contain)
    }
}

/// A pill that states a live status in one word plus a colour: connected,
/// running, failed. The colour never carries the meaning alone.
struct JunoStatusPill: View {
    let text: String
    let tint: Color
    var filled = true

    var body: some View {
        Text(text)
            .junoFont(size: 12, relativeTo: .footnote, weight: .semibold)
            .foregroundStyle(filled ? tint : Color.junoMutedForeground)
            .padding(.horizontal, 9)
            .frame(minHeight: 22)
            .background(Capsule().fill(filled ? tint.opacity(0.14) : Color.junoMuted))
            .accessibilityLabel(text)
    }
}

// MARK: - Liquid Glass

/// The real Liquid Glass container, with a pre-OS-26 fallback.
///
/// `GlassEffectContainer` is not decoration: it is what tells the system which
/// glass elements belong to one another, so they refract a shared sample of the
/// content behind them and blend as they approach instead of each sampling
/// independently and seaming where they meet. Glass laid down outside a
/// container is a lone pane; inside one it is a system.
struct JunoGlass<Content: View>: View {
    var spacing: CGFloat? = nil
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

extension View {
    /// Applies real Liquid Glass in `shape`, falling back to a material.
    ///
    /// `interactive` is what makes the glass respond to touch — it flexes and
    /// scatters light under a finger. It belongs on anything tappable and
    /// nowhere else: a static panel that reacts to touch reads as a control.
    @ViewBuilder
    func junoGlass(
        in shape: some Shape,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.glassEffect(
                .regular.tint(tint).interactive(interactive), in: shape
            )
        } else {
            // `stroke`, not `strokeBorder`: the latter is only on
            // `InsettableShape`, and this takes any `Shape`.
            self.background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.junoHairline, lineWidth: 1))
        }
    }

    /// Marks this glass element so the system can track it across a transition.
    /// Without an id the container has nothing to match the element by, and the
    /// material cross-fades instead of moving.
    ///
    /// It deliberately does **not** set a transition. The default is
    /// `matchedGeometry`, which is the one that makes the material *stretch*
    /// between an element's old and new position — the whole reason to give a
    /// glass element an id in the first place. This used to chain
    /// `.glassEffectTransition(.materialize)` unconditionally, which explicitly
    /// opts out of geometry matching; `materialize` is for elements farther
    /// apart than their container's spacing, where there is no meaningful path
    /// to stretch along. Use ``junoGlassMaterialize(_:in:)`` for that case.
    @ViewBuilder
    func junoGlassID(_ id: some Hashable & Sendable, in namespace: Namespace.ID) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.glassEffectID(id, in: namespace)
        } else {
            self
        }
    }

    /// The same, for two glass elements far enough apart that stretching between
    /// them would read as a smear rather than as one thing moving.
    @ViewBuilder
    func junoGlassMaterialize(
        _ id: some Hashable & Sendable, in namespace: Namespace.ID
    ) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.glassEffectID(id, in: namespace)
                .glassEffectTransition(.materialize)
        } else {
            self
        }
    }
}

extension View {
    /// Wraps one glass element in a `GlassEffectContainer` so it blends with the
    /// chrome around it instead of sampling independently.
    @ViewBuilder
    func junoGlassSearchContainer() -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            GlassEffectContainer { self }
        } else {
            self
        }
    }
}

/// The system's own glass button style, with a pre-OS-26 fallback.
///
/// `.buttonStyle(.glass)` is a real component: it brings the press flex, the
/// light scatter and the platform's own shape and metrics, and it keeps up when
/// those change. A hand-rolled capsule with a glass background looks similar
/// today and drifts from the platform the moment the platform moves.
struct JunoGlassButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.buttonStyle(.glass)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}
