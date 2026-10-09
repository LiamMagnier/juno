import SwiftUI

// MARK: - The one prominent button

/// The surface's one primary action, opaque and in the account's accent:
/// `.buttonStyle(.junoProminent)`.
///
/// **Why a style and not the environment's tint.** `.borderedProminent` fills
/// with whatever `tint` its environment carries, and falls back to the app's
/// accent colour — which Juno leaves to the system (the asset catalogue sets no
/// global accent, so focus rings and unstyled selection stay the platform's),
/// and the system's is the reader's own, blue by default. The accent tint is
/// applied only *below* the view that owns the toolbar (§0.4), so every
/// prominent button above or beside that point came out system blue: the
/// sheets presented from the split view, the legacy Work window, a card drawn
/// outside the chat column (the approval card's verb in its snapshot), and
/// every one of them had to remember a `.junoAccentTint()` of its own.
///
/// The style carries the accent itself, read inside a view body so a change in
/// Settings redraws it, so a prominent button is on brand wherever it is drawn
/// and no call site has a tint to forget. It is the system's own
/// `.borderedProminent` underneath — the press, the metrics, the disabled and
/// inactive-window states and `.defaultAction`'s Return are all AppKit's.
///
/// One per surface (§0.4). On the Mac it is `.glassProminent` in the accent
/// (round 3: the owner asked for Liquid Glass controls throughout); the phone
/// keeps the opaque `.borderedProminent`.
public struct JunoProminentButtonStyle: PrimitiveButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        JunoProminentButton(configuration: configuration)
    }
}

private struct JunoProminentButton: View {
    let configuration: PrimitiveButtonStyleConfiguration

    var body: some View {
        #if os(macOS)
        // Mac round 3 (owner, 2026-10-09): the primary action is the system's
        // tinted Liquid Glass, with an opaque stand-in under Reduce
        // Transparency and offscreen (JunoGlassControls.swift).
        JunoGlassButton(configuration: configuration, prominent: true)
        #else
        Button(configuration)
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .contentShape(.rect)
        #endif
    }
}

public extension PrimitiveButtonStyle where Self == JunoProminentButtonStyle {
    /// `.buttonStyle(.junoProminent)` — the surface's one primary action, in
    /// the Juno accent wherever it is drawn.
    static var junoProminent: JunoProminentButtonStyle { JunoProminentButtonStyle() }
}

// MARK: - The one prominent menu

public extension View {
    /// A `Menu` drawn as the page's one prominent button, in the Juno accent
    /// (the Artifacts page's New ▾). A menu takes no `PrimitiveButtonStyle`
    /// of ours — its label is not a `Button` — so the system's prominent
    /// style is applied here, where the accent is fixed with it, rather than
    /// at call sites that would inherit the system blue.
    func junoProminentMenu() -> some View {
        #if os(macOS)
        junoGlassMenu(.capsule, prominent: true)
        #else
        buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
        #endif
    }
}
