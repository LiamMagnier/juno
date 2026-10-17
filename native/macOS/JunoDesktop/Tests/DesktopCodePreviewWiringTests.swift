import Foundation
import JunoCodeUI
import Testing
@testable import JunoDesktop

/// The Code Preview's ties to the app: plain HTTP to loopback dev servers is
/// declared, and an auto-open request names the workspace however its path
/// is spelled.
struct DesktopCodePreviewWiringTests {
    @Test
    func theAppDeclaresLoopbackHTTPForThePreview() throws {
        let ats = try #require(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any])
        #expect(ats["NSAllowsLocalNetworking"] as? Bool == true)
        // Only local networking: arbitrary loads stay off.
        #expect(ats["NSAllowsArbitraryLoads"] == nil)
    }

    @Test
    @MainActor
    func autoOpenMatchesTheWorkspaceAcrossSpellings() throws {
        let folder = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-preview-wiring-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // Evaluate on the test's actor before Swift Testing forms its
        // nonisolated assertion autoclosures (SDK 26/27 macro compatibility).
        let identical = DesktopCodeWorkspace.samePath(folder.path, folder.path)
        let normalized = DesktopCodeWorkspace.samePath(folder.path + "/", folder.resolvingSymlinksInPath().path)
        let parent = DesktopCodeWorkspace.samePath(folder.path, folder.deletingLastPathComponent().path)
        let absent = DesktopCodeWorkspace.samePath(nil, folder.path)
        #expect(identical)
        #expect(normalized)
        #expect(!parent)
        #expect(!absent)
    }

    @Test
    func theAutoOpenSettingIsOnUntilTurnedOff() {
        let key = CodeAutoOpenSettings.defaultsKey
        let saved = UserDefaults.standard.object(forKey: key)
        defer { UserDefaults.standard.set(saved, forKey: key) }
        UserDefaults.standard.removeObject(forKey: key)
        #expect(CodeAutoOpenSettings.isEnabled)
        CodeAutoOpenSettings.isEnabled = false
        #expect(!CodeAutoOpenSettings.isEnabled)
    }
}
