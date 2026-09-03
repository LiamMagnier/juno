import SwiftUI
import JunoDesignSystem

/// The way back to the end of a record that is still growing.
///
/// The one piece of floating chrome the transcript carries, and therefore the
/// one thing in this column that is glass. It appears only when the reader has
/// left the bottom, which is the only moment it says anything they do not
/// already know.
struct CodeJumpToLatestChrome: View {
    let jump: () -> Void

    var body: some View {
        JunoDesktopGlass {
            Button(action: jump) {
                JunoIconView(.arrowDown, size: 14)
                    .junoInk()
                    .frame(width: 32, height: 32)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.circle)
            }
            .buttonStyle(.junoPress)
            .junoGlass(in: Circle(), interactive: true)
            .help("Jump to latest")
            .accessibilityLabel("Jump to latest")
            .accessibilityIdentifier("juno.code.transcript.jump-to-latest")
        }
    }
}
