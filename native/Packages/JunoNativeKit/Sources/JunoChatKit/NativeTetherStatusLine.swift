import JunoCore
import JunoDesignSystem
import SwiftUI

/// The one line a turn shows while Tether brings its stream back
/// (JunoCore/Tether.swift), the native twin of the web's
/// `src/components/chat/connection-status.tsx`:
///
///     Reconnecting in 4s      an attempt is scheduled
///     Reconnecting…           an attempt is under way
///     Waiting for network     the device is offline; nothing to retry against
///     Waiting for connection  parked; continues on the next trigger
///
/// Words, never a bare spinner, and nothing that moves: the dot is still. Only
/// the countdown ticks, and VoiceOver hears the phase rather than a number
/// every second.
public struct NativeTetherStatusLine: View {
    public let connection: TetherView

    public init(connection: TetherView) {
        self.connection = connection
    }

    public var body: some View {
        Group {
            if connection.phase == .reconnecting, connection.retryAt != nil {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    line(now: context.date)
                }
            } else {
                line(now: .now)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(connection.accessibilityLabel)
    }

    private func line(now: Date) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Circle()
                .fill(connection.phase == .reconnecting ? Color.orange.opacity(0.8) : Color.secondary.opacity(0.6))
                .frame(width: 6, height: 6)
            Text(connection.label(now: now))
                .monospacedDigit()
                .lineLimit(1)
        }
        .junoCaption()
        .foregroundStyle(.secondary)
    }
}
