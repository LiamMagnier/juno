import Testing
@testable import JunoDesktop

/// Guards the launch fallback in `JunoDesktopAppDelegate`.
///
/// On the macOS 27 seeds this was written against, extra launch arguments were
/// treated as documents and SwiftUI withheld the default `WindowGroup` — a
/// `--juno-ui-preview` launch came up with a menu bar and no window — and the
/// delegate recovers one turn later by invoking File › New Window *by its menu
/// title*. That only works while the title the delegate searches for and the
/// title `JunoDesktopCommands` declares stay one shared constant: a literal
/// edited on either side silently breaks every launch that carries arguments,
/// which includes the preview-harness launches visual QA depends on.
///
/// Re-probed 2026-09-03 on Xcode 27.0 (27A5252f): the withholding no longer
/// reproduces, and the fallback is kept as a no-op safety net for other seeds.
/// This test still pins the constant it would stand on.
struct DesktopWindowLaunchTests {
    @Test
    func newWindowMenuTitleIsTheFileMenuItemTheFallbackInvokes() {
        #expect(JunoDesktopWindow.newWindowMenuTitle == "New Window")
    }

    @Test
    func windowIDsAreStable() {
        #expect(JunoDesktopWindow.mainID == "juno.main")
        #expect(JunoDesktopWindow.incognitoID == "juno.incognito")
        #expect(JunoDesktopWindow.shortcutsID == "juno.shortcuts")
    }
}
