import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// Messages between conversations in the Mac Chat transcript, drawn offscreen
/// at 2× in both appearances: a received row, the reply under it, a sent row
/// and an idle notice. Set `JUNO_CROSS_SNAPSHOT_DIR` (through xcodebuild, as
/// `TEST_RUNNER_JUNO_CROSS_SNAPSHOT_DIR`) and the suite writes
/// `<dir>/mac-chat-cross-<light|dark>.png`. The wording is asserted always.
@MainActor
@Suite(.serialized)
struct CrossConversationSnapshotTests {
    static let received = NativeCrossMessage(
        id: "x1", direction: .received, peerRef: "env:dev1/s_cart", peerTitle: "Fix the cart total", peerProduct: "code",
        text: "The cart total fix is merged in 4f2a. Rounding now happens once, at checkout.",
        status: "delivered", createdAt: Date(timeIntervalSince1970: 1_760_000_000), read: false
    )
    static let sent = NativeCrossMessage(
        id: "x2", direction: .sent, peerRef: "chat:c_notes", peerTitle: "Release notes", peerProduct: "chat",
        text: "Add the cart total fix (4f2a) under Fixes.", status: "queued",
        createdAt: Date(timeIntervalSince1970: 1_760_000_060), read: true
    )
    static let notice = NativeCrossMessage(
        id: "x3", direction: .notice, peerRef: "chat:c_notes", peerTitle: "Release notes", peerProduct: "chat",
        text: "Idle again.", status: "answered", createdAt: Date(timeIntervalSince1970: 1_760_000_120), read: true
    )

    @Test func rowsSayWhoItWasFromOrTo() {
        #expect(Self.received.line == "From ‘Fix the cart total’")
        #expect(Self.sent.line == "Sent to ‘Release notes’")
        #expect(Self.notice.line == "‘Release notes’ is idle again")
        #expect(Self.sent.peerChatID == "c_notes")
        #expect(Self.received.peerChatID == nil, "a Code thread opens in Code, not as a chat")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["JUNO_CROSS_SNAPSHOT_DIR"] != nil))
    func drawsTheRows() async throws {
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_CROSS_SNAPSHOT_DIR"]!)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for dark in [false, true] {
            let view = VStack(alignment: .leading, spacing: JunoSpace.section) {
                DesktopCrossMessageRow(message: Self.received, open: { _ in })
                Text("Thanks. I have added it to the release notes and told that chat.")
                    .junoFont(size: 15, relativeTo: .body)
                    .foregroundStyle(Color.junoForeground)
                DesktopCrossMessageRow(message: Self.sent, open: { _ in })
                DesktopCrossMessageRow(message: Self.notice, open: { _ in })
                Spacer(minLength: 0)
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.junoCanvas)
            _ = try await PremiumRenderer.render(
                view, size: CGSize(width: 760, height: 420), framed: false, isDark: dark,
                into: directory.appendingPathComponent("mac-chat-cross-\(dark ? "dark" : "light").png")
            )
        }
    }
}
