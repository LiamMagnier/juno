import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoDesignSystem
@testable import JunoCodeUI

/// Messages between conversations in the Studio thread: they become their own
/// rows (never the reader's message), worded "Sent to ‘…’", "From ‘…’" and
/// "‘…’ is idle again". With `JUNO_SNAPSHOT_DIR` set, the rows and the setting
/// are also drawn offscreen to PNGs for review.
@MainActor
final class CrossConversationRowsTests: XCTestCase {
    private let session = CodeSessionID()

    private func event(_ sequence: Int, _ payload: SessionEventPayload) -> SessionEvent {
        SessionEvent(id: "e\(sequence)", sessionID: session, sequence: sequence, timestamp: Date(timeIntervalSince1970: 1_760_000_000 + Double(sequence)), payload: payload)
    }

    private let received = ConversationMessageEvent(
        direction: .received, peerRef: "chat:c_release", peerTitle: "Release prep", peerProduct: "chat",
        text: "Is the cart total fix merged? The release notes need the commit.", hop: 0, chainID: "ch", linkID: "l1"
    )
    private let sent = ConversationMessageEvent(
        direction: .sent, peerRef: "chat:c_release", peerTitle: "Release prep", peerProduct: "chat",
        text: "Merged in 4f2a. The total now rounds once, at checkout.", hop: 1, chainID: "ch", linkID: "l2", status: "queued"
    )
    private let notice = ConversationMessageEvent(
        direction: .notice, peerRef: "code:r9", peerTitle: "Fix the cart total", peerProduct: "code", text: "Idle again.", hop: 1
    )

    func testMessagesBuildTheirOwnRowsAndNeverAUserRow() {
        let items = StudioThreadItems.build(
            events: [
                event(1, .conversationMessage(received)),
                event(2, .assistantMessage(AssistantMessageEvent(text: "Checking the branch."))),
                event(3, .conversationMessage(sent)),
                event(4, .conversationMessage(notice)),
            ],
            groups: [],
            pendingApprovalIDs: [],
            showReasoning: false
        )
        let messages = items.compactMap { item -> ConversationMessageEvent? in
            if case let .conversationMessage(_, event) = item { return event }
            return nil
        }
        XCTAssertEqual(messages.map(\.direction), [.received, .sent, .notice])
        XCTAssertFalse(items.contains { if case .user = $0 { return true } else { return false } })
        XCTAssertEqual(StudioConversationMessageRow.line(for: received), "From ‘Release prep’")
        XCTAssertEqual(StudioConversationMessageRow.line(for: sent), "Sent to ‘Release prep’")
        XCTAssertEqual(StudioConversationMessageRow.line(for: notice), "‘Fix the cart total’ is idle again")
    }

    func testTheSettingDefaultsOnAndASessionsOwnChoiceWins() {
        let store = UserDefaults(suiteName: "cross-\(UUID().uuidString)")!
        let defaults = CodeDefaults(store: store)
        XCTAssertTrue(defaults.crossMessagesEnabled)
        XCTAssertTrue(defaults.crossMessagesEnabled(forSession: "s"))
        defaults.setCrossMessages(false, forSession: "s")
        XCTAssertFalse(defaults.crossMessagesEnabled(forSession: "s"))
        defaults.crossMessagesEnabled = false
        XCTAssertFalse(defaults.crossMessagesEnabled(forSession: "other"))
        defaults.setCrossMessages(true, forSession: "other")
        XCTAssertTrue(defaults.crossMessagesEnabled(forSession: "other"))
        XCTAssertFalse(CodeDefaults(store: store).crossMessagesEnabled, "kept across launches")
    }

    // MARK: - Snapshots (offscreen; JUNO_SNAPSHOT_DIR)

    func testRenderRowsAndSetting() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the cross-conversation rows.")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for dark in [false, true] {
            let suffix = dark ? "dark" : "light"
            try await render(rows(open: { _ in }), size: CGSize(width: 720, height: 420), dark: dark, to: directory.appendingPathComponent("mac-code-rows-\(suffix).png"))
            try await render(
                Form { StudioCrossConversationSettings() }.formStyle(.grouped),
                size: CGSize(width: 680, height: 200), dark: dark,
                to: directory.appendingPathComponent("mac-code-setting-\(suffix).png")
            )
        }
    }

    private func rows(open: @escaping @MainActor (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            StudioConversationMessageRow(event: received, open: open)
            Text("Yes. The fix is merged; I am sending the commit to Release prep.")
                .font(Studio.Font.label)
                .foregroundStyle(Studio.Ink.primary)
                .padding(.leading, 17)
            StudioConversationMessageRow(event: sent, open: open)
            StudioConversationMessageRow(event: notice, open: open)
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Studio.Surface.canvas)
    }

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, to url: URL) async throws {
        let hosting = NSHostingView(
            rootView: view
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, dark ? .dark : .light)
                .environment(\.junoSnapshotOpaqueGlass, true)
        )
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = hosting
        for _ in 0..<6 {
            try await Task.sleep(for: .milliseconds(80))
            hosting.layoutSubtreeIfNeeded()
        }
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        window.contentView = nil
    }
}
