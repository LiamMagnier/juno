import JunoChatKit
import JunoStorage
import JunoSync
import SwiftUI

/// Switch to Dark / Light Mode, written once (Phase 3 seam 13).
///
/// The menu bar's ⇧⌘L (Stage A) and the ⌘K row (Stage B) each wrote the
/// account's theme their own way; both now read the drawn appearance and write
/// the other one here, as the web's ⌘⇧L does: explicitly light or dark, never
/// back to System.
@MainActor
enum DesktopThemeToggle {
    /// The appearance on screen: the account's explicit choice, otherwise the
    /// system's (what the window draws when the account says System).
    static func isDark(theme: NativeThemePreference?, drawn: ColorScheme) -> Bool {
        switch theme {
        case .dark: true
        case .light: false
        case .system, .none: drawn == .dark
        }
    }

    /// The toggle for a window, or nil while the account's settings have not
    /// been read (there is nothing to write to yet).
    static func action(
        settingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?,
        drawn: ColorScheme
    ) -> DesktopShellActions.ThemeToggle? {
        guard let settingsModel, let settings = settingsModel.settings else { return nil }
        let isDark = isDark(theme: settings.theme, drawn: drawn)
        return DesktopShellActions.ThemeToggle(isDark: isDark) {
            Task { await settingsModel.updateSettings(NativeSettingsPatch(theme: isDark ? .light : .dark)) }
        }
    }
}

/// Opens a Chat-window page from outside the window — Settings' links and
/// the menu bar — and brings the main window forward (Phase 3 seam 10).
///
/// The request goes through ``DesktopPageRouter`` (Phase 4), which the Chat
/// window follows when it shows. A main window showing Code switches to Chat
/// when it becomes active with a request pending (`JunoDesktopWorkspaceView`),
/// since Code has no page stack to push onto.
@MainActor
enum DesktopPageLinks {
    static func open(_ destination: DesktopDestination, route: DesktopPageRoute? = nil) {
        DesktopPageRouter.shared.open(destination, route: route)
        JunoDesktopWindow.presentMainWindow()
    }

    /// Wires Settings' page links (seam 10). Called once at launch; the hooks
    /// only ever open pages, so they need no account.
    static func install() {
        let links = DesktopSettingsLinks.shared
        links.openMemory = { open(.memory) }
        links.openConnections = { open(.connections) }
        links.openPermissions = { open(.permissions) }
        links.openHost = { id in open(.permissions, route: .host(id)) }
    }
}
