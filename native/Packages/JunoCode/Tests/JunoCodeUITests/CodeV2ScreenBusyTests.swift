import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoDesignSystem
import JunoScreenControl
@testable import JunoCodeUI

/// Screen's waiting line: it names the conversation that really has the app,
/// never this one, and only for a step refused because the app was taken.
@MainActor
final class CodeV2ScreenBusyTests: XCTestCase {
    private func refused(app: String = "Safari", status: CodeV2.ItemStatus = .declined, error: String? = nil) -> CodeV2.ComputerAction {
        CodeV2.ComputerAction(
            id: "ca_1", createdAt: "2026-10-11T17:30:00Z", callId: "1", action: .openApp, target: app, status: status, app: app,
            error: error ?? "‘Book the train’ is using \(app) right now."
        )
    }

    private func hold(id: String, thread: String, title: String, bundle: String?, app: String?, exclusive: Bool = false) -> ScreenControlHold {
        ScreenControlHold(
            holder: ScreenControlHolder(id: id, kind: .connectedAgent, title: title, appName: app, threadID: thread),
            bundleID: bundle, exclusive: exclusive
        )
    }

    func testItNamesTheOtherConversationThatHasTheApp() throws {
        let holds = [hold(id: "agent:t2", thread: "t2", title: "Book the train", bundle: "com.apple.safari", app: "Safari")]
        let busy = try XCTUnwrap(CodeV2ScreenBusy.resolve(conversationID: "t1", actions: [refused()], holds: holds))
        XCTAssertEqual(busy.title, "Waiting for ‘Book the train’")
        XCTAssertEqual(busy.holderID, "agent:t2")
        XCTAssertEqual(busy.conversationID, "t2")
        XCTAssertEqual(busy.app, "Safari")
        XCTAssertFalse(busy.detail.contains("—"))
    }

    func testNeverBusyForItself() {
        // The 1.10.10 report: this thread's own hold was shown as "another session".
        let own = [hold(id: "agent:t1", thread: "t1", title: "Open Safari for me", bundle: "com.apple.safari", app: "Safari")]
        XCTAssertNil(CodeV2ScreenBusy.resolve(conversationID: "t1", actions: [refused()], holds: own))
        let child = [hold(id: "agent:t1:agent:c1", thread: "t1", title: "Open Safari for me", bundle: "com.apple.safari", app: "Safari")]
        XCTAssertNil(CodeV2ScreenBusy.resolve(conversationID: "t1", actions: [refused()], holds: child))
    }

    func testNotBusyOnceTheHoldIsGoneOrForOtherFailures() {
        XCTAssertNil(CodeV2ScreenBusy.resolve(conversationID: "t1", actions: [refused()], holds: []))
        let holds = [hold(id: "agent:t2", thread: "t2", title: "Book the train", bundle: "com.apple.notes", app: "Notes")]
        XCTAssertNil(CodeV2ScreenBusy.resolve(conversationID: "t1", actions: [refused()], holds: holds), "another app is no reason to wait")
        let safari = [hold(id: "agent:t2", thread: "t2", title: "Book the train", bundle: "com.apple.safari", app: "Safari")]
        XCTAssertNil(CodeV2ScreenBusy.resolve(
            conversationID: "t1", actions: [refused(status: .failed, error: "Alevr needs Accessibility to use apps.")], holds: safari
        ))
    }

    func testAWholeScreenHolderBlocksAnyApp() throws {
        let holds = [hold(id: "work:r1", thread: "work:r1", title: "Tidy downloads", bundle: nil, app: nil, exclusive: true)]
        let busy = try XCTUnwrap(CodeV2ScreenBusy.resolve(
            conversationID: "t1", actions: [refused(error: "Alevr is already using apps for ‘Tidy downloads’. It must finish before anything else can use apps.")], holds: holds
        ))
        XCTAssertTrue(busy.wholeScreen)
    }

    /// The panel, light and dark, offscreen. Off unless `JUNO_SNAPSHOT_DIR` is set.
    func testSnapshotTheBusyPanel() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the Screen busy panel.")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let surface = CodeV2Gallery.Surface.screenBusy
        for dark in [false, true] {
            let size = surface.size
            let hosting = NSHostingView(
                rootView: CodeV2Gallery.view(surface)
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
            let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            try data.write(to: directory.appendingPathComponent("\(surface.rawValue)-\(dark ? "dark" : "light").png"))
            window.contentView = nil
        }
    }
}
