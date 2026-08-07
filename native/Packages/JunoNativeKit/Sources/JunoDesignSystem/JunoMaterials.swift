import SwiftUI

/// Liquid Glass is reserved for floating chrome (composers, toolbars, floating
/// controls) — never the main reading surface. This helper applies the OS 26+
/// glass effect where available and falls back to a system material on the
/// minimum deployment targets, so one call adapts across OS versions.
///
/// Mechanically, glass on a scroller is wrong as well as off-brief: glass
/// samples what is behind it *right now*, so on a moving transcript the sample
/// changes every frame, the material shimmers and the text under it becomes
/// unreadable at unpredictable moments. The platform's answer for "content
/// passes under chrome" is not glass-on-content, it is the scroll edge effect —
/// `.scrollEdgeEffectStyle(.soft, for:)` on the scroller plus `.safeAreaBar(edge:)`
/// for the pinned bar.
public extension View {
    func junoFloatingGlass(cornerRadius: CGFloat = JunoRadius.floating) -> some View {
        modifier(JunoFloatingGlass(cornerRadius: cornerRadius))
    }
}

private struct JunoFloatingGlass: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.regularMaterial, in: shape)
        }
    }
}

/// A glass-or-material background for input capsules and floating controls,
/// usable directly in a `.background(...)`.
public struct JunoGlassBackground: View {
    private let cornerRadius: CGFloat

    public init(cornerRadius: CGFloat = JunoRadius.control) {
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, macOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            // Was `.quaternary.opacity(0.5)`. That is a translucent grey *fill*,
            // not a material: it does not blur, so on the warm canvas it read as
            // the dirt a grey shadow leaves rather than as a surface. Every
            // pre-26 fallback in the design system now stands on
            // `.regularMaterial` plus a hairline — the material because it is
            // what the HIG names for content that cannot be glass, and the
            // hairline because a plain material carries no rim of its own, where
            // real glass does.
            shape.fill(.regularMaterial)
                .overlay(shape.strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}

// MARK: - The accent, on glass

public extension View {
    /// **The one primary action on a surface**, in the system's own tinted glass.
    ///
    /// Use this in preference to tinting a glass background by hand, always.
    /// `GlassProminentButtonStyle` brings Apple's own tinted-glass contrast
    /// handling, its Increase Contrast substitution, its press flex and its
    /// metrics, and it keeps up when the platform moves — a hand-rolled capsule
    /// with a tinted glass background looks similar today and drifts the moment
    /// the platform does.
    ///
    /// **One per screen.** The HIG's rule on tinted glass is that colour is for
    /// emphasis only, and its own correct/incorrect illustration is literally
    /// one tinted button against several. Juno was breaking it on iOS with three
    /// competing accent-tinted glass treatments at three different dilutions.
    ///
    /// Pair the label with ``SwiftUI/Color/junoOnAccent``, never a literal white:
    /// the accent is an account setting and white fails contrast on two of the
    /// palettes.
    func junoProminentAction() -> some View {
        modifier(JunoProminentAction())
    }

    /// Accent-tinted glass for the rare primary affordance that genuinely cannot
    /// be a `Button` — a capsule that is a status *and* a target, say.
    ///
    /// **The tint is passed at full opacity, and that is the fix, not an
    /// oversight.** `Glass.tint(_:)` honours its colour's alpha, so diluting it
    /// — `Color.junoAccent.opacity(0.72)` was the shipping value on iOS — does
    /// not "soften" the glass. It removes the tint's ability to establish a
    /// predictable luminance under the label, which makes the label's contrast a
    /// function of whatever happens to be behind the capsule at that moment.
    /// That is the whole of the iOS accent-on-glass contrast failure.
    ///
    /// `.regular` and never `.clear`: `.regular` is the variant that adjusts the
    /// background's luminosity to protect the foreground, and every glass
    /// surface in Juno sits over a warm reading canvas or over text, so `.clear`
    /// — which is for rich media the content must stay prominent through — has
    /// no correct use anywhere in this app.
    func junoAccentGlass(in shape: some Shape, interactive: Bool = true) -> some View {
        modifier(JunoAccentGlass(shape: shape, interactive: interactive))
    }
}

private struct JunoProminentAction: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.buttonStyle(.glassProminent).tint(Color.junoAccent)
        } else {
            // Below 26 there is no glass at all, and `.borderedProminent` is the
            // platform's own answer for the same role. The explicit tint is
            // load-bearing on both branches: without it the button draws in the
            // *system* accent, which is how coral and system blue ended up on
            // the same screen.
            content.buttonStyle(.borderedProminent).tint(Color.junoAccent)
        }
    }
}

private struct JunoAccentGlass<S: Shape>: ViewModifier {
    let shape: S
    let interactive: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(
                .regular.tint(Color.junoAccent).interactive(interactive), in: shape
            )
        } else {
            content.background(Color.junoAccent, in: shape)
        }
    }
}
