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
/// One per surface (§0.4). It is opaque: glass is chrome (§0.1), so this is
/// never `.glassProminent`.
public struct JunoProminentButtonStyle: PrimitiveButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        JunoProminentButton(configuration: configuration)
    }
}

private struct JunoProminentButton: View {
    let configuration: PrimitiveButtonStyleConfiguration

    var body: some View {
        Button(configuration)
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .contentShape(.rect)
    }
}

public extension PrimitiveButtonStyle where Self == JunoProminentButtonStyle {
    /// `.buttonStyle(.junoProminent)` — the surface's one primary action, in
    /// the Juno accent wherever it is drawn.
    static var junoProminent: JunoProminentButtonStyle { JunoProminentButtonStyle() }
}
