import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Why a reply ended short of its end, in the web's words (`message-item.tsx`,
/// verbatim). Nil for an answer that simply finished.
enum DesktopFinishCopy {
    static func sentence(for reason: NativeChatFinishReason?) -> String? {
        switch reason {
        case .length: "The model stopped at its token limit."
        case .networkError: "The stream was interrupted. The partial answer was preserved."
        case .userStopped: "Stopped by user."
        case .toolCalls: "The model requested tools, but no tool flow is enabled for this request."
        case .sensitive: "The provider stopped the response for safety reasons."
        default: nil
        }
    }
}

/// The note under a reply that stopped short (brief §6.5): one quiet row in
/// the muted well — radius 12, a 70% hairline, 14 × 10 of padding — with the
/// reason in 13pt secondary and, where the reply can be carried on, Continue.
///
/// A partial answer that then failed keeps the failure mark and its error
/// sentence here; a finish (token limit, stopped, interrupted) is information
/// and wears the info mark.
struct DesktopTurnNote: View {
    let sentence: String
    var isFailure = false
    /// Present on the newest reply, with nothing running, when it stopped at
    /// its token limit or lost its stream.
    var continueResponse: (() -> Void)? = nil
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            JunoIconView(isFailure ? .error : .info, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(sentence)
                .junoFont(size: 13, relativeTo: .callout)
                .junoSecondaryInk()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let continueResponse {
                // Carry on from here, not "again": the refresh arrow is Retry,
                // and this keeps the answer and writes past its end.
                Button(action: continueResponse) {
                    Label {
                        Text("Continue")
                    } icon: {
                        JunoIconView(.cornerDownRight, size: 14)
                    }
                    .frame(minHeight: 28)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                // The web's outline button: neutral. The column's accent tint
                // would otherwise turn a bordered button coral, and coral is
                // the send disc's and the one prominent button's (§0.4).
                .tint(nil)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.desktop.chat.message-continue")
            }
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoMuted)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(contrast == .increased ? 1 : 0.7), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

/// A reply that failed with nothing to show for it (brief §6.5 and §0
/// correction 6): the destructive tone at 5% (light) or 14% (dark) under a 40%
/// hairline, radius 12, the sentence in 13pt destructive ink beside the failure
/// mark on its first line — and, on the newest turn with nothing running,
/// Try Again.
///
/// Inside the turn, where the answer would have been, above its sources: the
/// failure belongs to this reply, not to the bottom of the transcript.
struct DesktopTurnError: View {
    let message: String
    var retry: (() -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.close) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(.error, size: 16)
                    .alignmentGuide(.firstTextBaseline) { dimensions in dimensions[.bottom] - 3 }
                Text(message)
                    .junoFont(size: 13, relativeTo: .callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .foregroundStyle(Color.junoDestructiveInk)
            if let retry {
                Button(action: retry) {
                    Label {
                        Text("Try again")
                    } icon: {
                        JunoIconView(.refresh, size: 14)
                    }
                    .frame(minHeight: 28)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                // Destructive-tinted, as the web's outline is: the tone of the
                // box it sits in, never the accent.
                .tint(Color.junoDestructiveInk)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.desktop.chat.message-retry")
            }
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoDestructive.opacity(colorScheme == .dark ? 0.14 : 0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoDestructive.opacity(0.4), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }
}
