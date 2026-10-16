#if canImport(CoreGraphics)
import CoreGraphics
import XCTest
@testable import JunoScreenControl

/// The presence caption sits on the display that holds the driven window, not
/// always on the main one.
final class ScreenPresenceLayoutTests: XCTestCase {
    /// AppKit global coordinates: the built-in display at the origin, and a
    /// larger external display to its right, top-aligned.
    private let builtIn = CGRect(x: 0, y: 0, width: 1512, height: 982)
    private let external = CGRect(x: 1512, y: -98, width: 1920, height: 1080)

    func testTheCaptionGoesOnTheScreenHoldingTheDrivenWindow() {
        let screens = [builtIn, external]
        let onExternal = CGRect(x: 1800, y: 200, width: 900, height: 600)
        XCTAssertEqual(ScreenPresenceLayout.screenIndex(holding: onExternal, screens: screens, mainIndex: 0), 1)
        let onBuiltIn = CGRect(x: 100, y: 100, width: 800, height: 500)
        XCTAssertEqual(ScreenPresenceLayout.screenIndex(holding: onBuiltIn, screens: screens, mainIndex: 1), 0)
    }

    func testAWindowAcrossTwoScreensBelongsToTheOneHoldingMostOfIt() {
        let screens = [builtIn, external]
        // 312 points on the built-in display, 688 on the external one.
        let straddling = CGRect(x: 1200, y: 300, width: 1000, height: 400)
        XCTAssertEqual(ScreenPresenceLayout.screenIndex(holding: straddling, screens: screens, mainIndex: 0), 1)
    }

    func testWithoutAKnownWindowTheCaptionFallsBackToTheMainScreen() {
        let screens = [builtIn, external]
        XCTAssertEqual(ScreenPresenceLayout.screenIndex(holding: nil, screens: screens, mainIndex: 1), 1)
        // A window off every screen (a stale frame) falls back too.
        let offscreen = CGRect(x: -5000, y: -5000, width: 100, height: 100)
        XCTAssertEqual(ScreenPresenceLayout.screenIndex(holding: offscreen, screens: screens, mainIndex: 0), 0)
        XCTAssertEqual(ScreenPresenceLayout.screenIndex(holding: nil, screens: screens, mainIndex: nil), 0)
        XCTAssertNil(ScreenPresenceLayout.screenIndex(holding: nil, screens: [], mainIndex: nil))
    }

    func testTheCaptionIsCentredBelowTheMenuBarOfItsScreen() {
        let visible = CGRect(x: 1512, y: -98, width: 1920, height: 1047)
        let frame = ScreenPresenceLayout.captionFrame(size: CGSize(width: 300, height: 36), visibleFrame: visible)
        XCTAssertEqual(frame.midX, visible.midX)
        XCTAssertEqual(frame.maxY, visible.maxY - 8)
        XCTAssertEqual(frame.size, CGSize(width: 300, height: 36))
    }

    func testTheOutlineFramesTheWindowFromOutside() {
        let window = CGRect(x: 100, y: 100, width: 800, height: 600)
        let outline = ScreenPresenceLayout.outlineFrame(around: window)
        XCTAssertTrue(outline.contains(window))
        XCTAssertEqual(outline, CGRect(x: 96, y: 96, width: 808, height: 608))
    }
}
#endif
