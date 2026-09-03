import Testing
@testable import JunoDesktop

/// Guards the launch fallback in `JunoDesktopAppDelegate`.
///
/// When SwiftUI withholds the default `WindowGroup` — extra launch arguments
/// are treated as documents on macOS 27, so a `--juno-ui-preview` launch came
/// up with a menu bar and no window — the delegate recovers one turn later by
/// invoking File › New Window *by its menu title*. That only works while the
/// title the delegate searches for and the title `JunoDesktopCommands`
/// declares stay one shared constant: a literal edited on either side
/// silently breaks every launch that carries arguments, which includes the
/// preview-harness launches visual QA depends on. Neither
/// `defaultLaunchBehavior(.presented)` nor `handlesExternalEvents` changes the
/// withholding on the current SDK, so the fallback stands and this pins the
/// constant it stands on.
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
