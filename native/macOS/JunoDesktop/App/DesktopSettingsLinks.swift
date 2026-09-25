import SwiftUI

/// The Settings rows that lead to a page in the main window: Memory's
/// "Manage", Connectors' "Browse Apps", a Mac in Devices and Devices' "See what
/// Juno always asks first".
///
/// Each is an optional closure that stays nil until Phase 4's page router is
/// merged (seam 10, brief §2.3). **While a hook is nil the control it drives is
/// absent, not disabled.**
@MainActor
@Observable
final class DesktopSettingsLinks {
    static let shared = DesktopSettingsLinks()

    /// Opens the Memory page.
    var openMemory: (() -> Void)?
    /// Opens the Connections page ("Browse apps").
    var openConnections: (() -> Void)?
    /// Opens one Mac's page, by its Work host id.
    var openHost: ((String) -> Void)?
    /// Opens the Permissions page.
    var openPermissions: (() -> Void)?

    init() {}
}
