import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

struct DesktopChatError: View {
    let message: String
    let canRetry: Bool
    let retry: () -> Void

    var body: some View {
        GroupBox {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
            JunoIconView(.triangleAlert, size: 16)
                .foregroundStyle(Color.junoDanger)
            Text(message)
                .font(.callout)
                .textSelection(.enabled)
            Spacer(minLength: JunoSpace.snug)
            if canRetry {
                Button("Retry", action: retry)
                    .contentShape(.rect)
            }
            }
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The card treatment plus a danger-coloured glyph, rather than a red wash
        // behind the text. A tinted fill needs an opacity nobody owns and it drops
        // the contrast of the very message the reader has to act on; the glyph and
        // the status ramp carry the meaning without touching legibility.
        .junoCard()
    }
}

/// The note under a reply that stopped before it finished — for now, only the
/// row that carries **Continue**, which left the action row in Phase 2 stage 1.
///
/// Stage 4 rewrites this into the full note (every finish reason, the error
/// box beside it, §6.5 of the Phase 2 brief). Until then it appears only where
/// Continue does: on the newest reply, with nothing running, that stopped at
/// its token limit or lost its stream. The sentence is the web's, verbatim
/// (`message-item.tsx`).
struct DesktopFinishNote: View {
    let reason: NativeChatFinishReason
    let continueResponse: () -> Void

    private var sentence: String {
        switch reason {
        case .networkError: "The stream was interrupted. The partial answer was preserved."
        default: "The model stopped at its token limit."
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.close) {
            JunoIconView(.info, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(sentence)
                .junoFont(size: 13, relativeTo: .callout)
                .junoSecondaryInk()
                .frame(maxWidth: .infinity, alignment: .leading)
            // Carry on from here, not "again": the refresh arrow is Retry, and
            // this keeps the answer and writes past its end.
            Button(action: continueResponse) {
                Label {
                    Text("Continue")
                } icon: {
                    JunoIconView(.cornerDownRight, size: 14)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .contentShape(.rect)
            .accessibilityIdentifier("juno.desktop.chat.message-continue")
        }
    }
}
