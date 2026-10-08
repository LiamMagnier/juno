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

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass

    var body: some View {
        GlassEffectContainer {
            if isShown {
                if reduceTransparency || snapshotOpaqueGlass {
                    // The opaque stand-in: the popover's fill and a hairline,
                    // under Reduce Transparency and in offscreen snapshots,
                    // which cannot draw glass.
                    Button(action: action) {
                        face
                            .foregroundStyle(Color.junoForeground)
                            .background(Circle().fill(Color.junoPopover))
                            .overlay(Circle().strokeBorder(Color.junoBorder, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .contentShape(Circle())
                    .modifier(ScrollToLatestLabels())
                } else {
                    // The glass picks its own ink against what scrolls under
                        // it (it turns dark over a dark run of text), so the
                        // arrow takes the system's primary style rather than
                        // a fixed ink that vanished on the darkened glass.
                    Button(action: action) { face.foregroundStyle(.primary) }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .contentShape(Circle())
                        .glassEffectTransition(.materialize)
                        .modifier(ScrollToLatestLabels())
                }
            }
        }
    }

    private var face: some View {
        JunoIconView(.arrowDown, size: 16)
            .frame(width: 32, height: 32)
    }
}

private struct ScrollToLatestLabels: ViewModifier {
    func body(content: Content) -> some View {
        content
            .help("Scroll to latest")
            .accessibilityLabel("Scroll to latest")
            .accessibilityIdentifier("juno.desktop.chat.scroll-to-latest")
    }
}
