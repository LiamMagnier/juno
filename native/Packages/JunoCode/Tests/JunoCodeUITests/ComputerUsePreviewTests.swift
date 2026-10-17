import AppKit
import SwiftUI
import XCTest
import JunoScreenControl
import JunoCodeCore
@testable import JunoCodeUI

@MainActor
final class ComputerUsePreviewTests: XCTestCase {
    func testPointerUsesCapturedWindowCoordinatesWithLetterboxingAndNegativeDisplayOrigin() {
        let bounds = ScreenRect(x: -1200, y: -400, width: 800, height: 600)
        let size = CGSize(width: 336, height: 180)
        let image = CGSize(width: 1600, height: 1200)
        XCTAssertEqual(ComputerUsePreviewView.previewPoint(bounds.center, bounds: bounds, imageSize: image, viewport: size), CGPoint(x: 168, y: 90))
        XCTAssertEqual(ComputerUsePreviewView.previewPoint(ScreenPoint(x: -1200, y: -400), bounds: bounds, imageSize: image, viewport: size), CGPoint(x: 48, y: 0))
        XCTAssertNil(ComputerUsePreviewView.previewPoint(ScreenPoint(x: 0, y: 0), bounds: bounds, imageSize: image, viewport: size))
    }

    func testScreenChangeIsNeutralInBothTranscriptFormats() {
        let message = "The screen changed; take a new screenshot."
        let step = StudioScreenStep(eventID: "step", verb: "Clicked", app: "Safari", succeeded: false, outcome: message)
        XCTAssertTrue(step.isRecovering)
        XCTAssertFalse(step.isFailure)
        XCTAssertEqual(StudioScreenStepRow.caption(for: step), ComputerStepPresentation.refreshMessage)
        let action = CodeV2.ComputerAction(id: "action", createdAt: "now", callId: "call", action: .click, status: .failed, error: message)
        XCTAssertEqual(action.caption, ComputerStepPresentation.refreshMessage)
    }

    /// Offscreen visual review: no foreground app is opened or captured.
    func testRenderWorkingAndPausedPreview() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the computer use preview.")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = NSImage(size: CGSize(width: 800, height: 600), flipped: false) { rect in
            NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
            rect.fill()
            NSColor(calibratedWhite: 0.2, alpha: 1).setFill()
            NSRect(x: 0, y: 550, width: 800, height: 50).fill()
            ("Projects" as NSString).draw(at: NSPoint(x: 35, y: 480), withAttributes: [.font: NSFont.systemFont(ofSize: 30, weight: .semibold), .foregroundColor: NSColor.white])
            NSColor.systemOrange.setFill()
            NSBezierPath(roundedRect: NSRect(x: 535, y: 470, width: 220, height: 48), xRadius: 9, yRadius: 9).fill()
            ("Create project" as NSString).draw(at: NSPoint(x: 563, y: 485), withAttributes: [.font: NSFont.systemFont(ofSize: 19, weight: .medium), .foregroundColor: NSColor.black])
            for i in 0..<3 {
                NSColor(calibratedWhite: 0.18, alpha: 1).setFill()
                NSBezierPath(roundedRect: NSRect(x: 35, y: 340 - i * 94, width: 720, height: 72), xRadius: 12, yRadius: 12).fill()
                ("Project \(i + 1)" as NSString).draw(at: NSPoint(x: 60, y: 364 - i * 94), withAttributes: [.font: NSFont.systemFont(ofSize: 20), .foregroundColor: NSColor.white])
            }
            return true
        }
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed())
        model.apply(ComputerActionCue(
            sessionID: "snapshot", label: "Click Create project in Safari", point: ScreenPoint(x: 640, y: 106),
            appName: "Safari", phase: .acting, thumbnail: target.tiffRepresentation,
            windowFrame: ScreenRect(x: 0, y: 0, width: 800, height: 600)
        ))
        let presence = ScreenPresenceCenter()
        for dark in [true, false] {
            for paused in [false, true] {
                model.apply(ComputerActionCue(sessionID: "snapshot", label: "", point: nil, appName: "Safari", phase: .paused(paused)))
                presence.apply(ScreenPresenceState(holder: ScreenControlHolder(id: "snapshot", kind: .codeSession, title: "Create projects", appName: "Safari"), paused: paused))
                let view = ComputerUsePreviewView(model: model, presence: presence)
                    .environment(\.colorScheme, dark ? .dark : .light)
                let host = NSHostingView(rootView: view)
                host.frame = CGRect(x: 0, y: 0, width: 336, height: 282)
                let window = NSWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 336, height: 282), styleMask: [.borderless], backing: .buffered, defer: false)
                window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                window.contentView = host
                for _ in 0..<4 { try await Task.sleep(for: .milliseconds(80)); host.layoutSubtreeIfNeeded() }
                let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: rep)
                try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: directory.appendingPathComponent("computer-preview-\(dark ? "dark" : "light")-\(paused ? "paused" : "working").png"))
                window.contentView = nil
            }
        }
    }
}
