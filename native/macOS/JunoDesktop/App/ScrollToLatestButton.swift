import JunoDesignSystem
import SwiftUI

/// Back to the newest turn (spec §6.13, brief §6.7): a 32pt glass circle with
/// the arrow, centred 12pt above the composer, there only while the reader is
/// away from the bottom.
///
/// One of the transcript's two allow-listed glass sites: it floats over the
/// reading column, where it has to read as chrome and not as a line of the
/// answer. Gone, it is out of the hierarchy — so out of the tab order and of
/// VoiceOver — not merely transparent.
struct ScrollToLatestButton: View {
    let isShown: Bool
    let action: () -> Void

    var body: some View {
        GlassEffectContainer {
            if isShown {
                Button(action: action) {
                    JunoIconView(.arrowDown, size: 16)
                        .foregroundStyle(Color.junoForeground)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .contentShape(Circle())
                .glassEffectTransition(.materialize)
                .help("Scroll to latest")
                .accessibilityLabel("Scroll to latest")
                .accessibilityIdentifier("juno.desktop.chat.scroll-to-latest")
            }
        }
    }
}
