import AppKit
import Testing

@testable import JunoDesktop

/// The suite runs inside the app, and must not *be* the app (§2.1 of the
/// Phase 2 brief): no window, no Dock icon, no menu-bar item, and no
/// production store — whose Keychain prompt no test can answer.
@MainActor
struct DesktopTestHostTests {
    @Test
    func theGuardKnowsItIsUnderTest() {
        #expect(JunoTestHost.isActive)
    }

    @Test
    func theHostRunsAsAnAccessory() {
        #expect(NSApp.activationPolicy() == .accessory)
    }

    @Test
    func noMainWindowIsOpen() {
        let mainWindows = NSApp.windows.filter {
            $0.identifier?.rawValue.hasPrefix(JunoDesktopWindow.mainID) == true
        }
        #expect(mainWindows.isEmpty)
        #expect(!NSApp.windows.contains { $0.isVisible && $0.frame.width > 200 })
    }
}
