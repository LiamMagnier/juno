#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// Live UI drawn offscreen, through the real markdown path, in both
/// appearances: `$JUNO_SNAPSHOT_DIR/live-ui/<sample>-<light|dark>.png`.
/// Skipped unless JUNO_SNAPSHOT_DIR is set. The samples are the web gallery's
/// (`contracts/live-ui/samples.json`), so the two platforms can be compared
/// picture for picture. Liquid Glass is composited by the window server and
/// cannot be photographed offscreen; the explorer's card draws without it here.
@MainActor
final class LiveUISnapshotTests: XCTestCase {
    private static let samplesURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("contracts/live-ui/samples.json")

    func testRendersSamples() async throws {
        guard let dir = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the Live UI snapshots.")
        }
        let out = URL(fileURLWithPath: dir).appendingPathComponent("live-ui", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let data = try Data(contentsOf: Self.samplesURL)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let samples = try XCTUnwrap(root["samples"] as? [[String: String]])
        for sample in samples {
            let id = try XCTUnwrap(sample["id"])
            let reply = try XCTUnwrap(sample["reply"])
            for dark in [false, true] {
                try await render(
                    JunoLessonText(reply).environment(\.junoProseStyle, .reading),
                    name: id,
                    width: 680,
                    dark: dark,
                    into: out
                )
            }
            if id == "bill" {
                // Mid-stream: the first two-thirds of the block.
                let cut = reply.index(reply.startIndex, offsetBy: reply.count * 2 / 5)
                try await render(
                    JunoLessonText(String(reply[..<cut]), streaming: true).environment(\.junoProseStyle, .reading),
                    name: "bill-streaming",
                    width: 680,
                    dark: false,
                    into: out
                )
                try await render(
                    JunoLessonText(reply).environment(\.junoProseStyle, .reading),
                    name: "bill-phone",
                    width: 375,
                    dark: false,
                    into: out
                )
            }
        }
    }

    private func render<V: View>(_ view: V, name: String, width: CGFloat, dark: Bool, into dir: URL) async throws {
        let appearance: NSAppearance.Name = dark ? .darkAqua : .aqua
        let rootView = view
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .background(Color.junoCanvas)
            .environment(\.colorScheme, dark ? .dark : .light)
            .environment(\.locale, Locale(identifier: "en_US"))
            .transaction { $0.disablesAnimations = true }
        let host = NSHostingView(rootView: rootView)
        let window = NSWindow(
            contentRect: CGRect(x: -20_000, y: -20_000, width: width, height: 10),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: appearance)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        var size = CGSize(width: width, height: max(1, host.fittingSize.height))
        window.setContentSize(size)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(400))
        host.layoutSubtreeIfNeeded()
        size.height = max(1, host.fittingSize.height)
        window.setContentSize(size)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        window.close()
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: dir.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png"))
    }
}
#endif
