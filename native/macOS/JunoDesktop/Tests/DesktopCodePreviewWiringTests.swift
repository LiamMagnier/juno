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
    func autoOpenMatchesTheWorkspaceAcrossSpellings() throws {
        let folder = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-preview-wiring-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(DesktopCodeWorkspace.samePath(folder.path, folder.path))
        #expect(DesktopCodeWorkspace.samePath(folder.path + "/", folder.resolvingSymlinksInPath().path))
        #expect(!DesktopCodeWorkspace.samePath(folder.path, folder.deletingLastPathComponent().path))
        #expect(!DesktopCodeWorkspace.samePath(nil, folder.path))
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
