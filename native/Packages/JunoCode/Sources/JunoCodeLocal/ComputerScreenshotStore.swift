import Foundation
import JunoCodeCore
import JunoScreenControl

/// Where the screenshots behind `computer_action` items live (Code v2 SPEC
/// §3.12): `~/Library/Application Support/Alevr/computer-use/shots/<session>/
/// <call>.jpg`, referenced as `alevr-shot://<session>/<call>.jpg`.
///
/// The thread's timeline reads them back; the env server serves them to the
/// web from the same folder. They are the reader's own screen, so they stay
/// on this Mac, in a 0700 folder, at most ``perSessionLimit`` per session,
/// and go with the session (``remove(sessionID:)``) — never synced.
public actor ComputerScreenshotStore {
    public static var defaultRoot: URL {
        DesktopLockFile.defaultDirectory.appendingPathComponent("shots", isDirectory: true)
    }

    public static let shared = ComputerScreenshotStore()

    public let root: URL
    public let perSessionLimit: Int

    public init(root: URL = ComputerScreenshotStore.defaultRoot, perSessionLimit: Int = 300) {
        self.root = root
        self.perSessionLimit = max(1, perSessionLimit)
    }

    /// Writes a frame and returns its reference, or nil when the disk said no.
    public func store(sessionID: String, callID: String, frame: EncodedFrame) -> String? {
        let ref = ComputerActionItems.screenshotRef(sessionID: sessionID, callID: callID, mediaType: frame.mediaType)
        guard let url = url(for: ref) else { return nil }
        let folder = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try frame.data.write(to: url, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            return nil
        }
        prune(folder)
        return ref
    }

    /// The bytes behind a reference.
    public func data(for ref: String) -> Data? {
        guard let url = url(for: ref) else { return nil }
        return try? Data(contentsOf: url)
    }

    /// The file a reference names, inside the root; nil for anything else
    /// (another scheme, `..`, an absolute path).
    public nonisolated func url(for ref: String) -> URL? {
        let prefix = "alevr-shot://"
        guard ref.hasPrefix(prefix) else { return nil }
        let parts = ref.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2,
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && ComputerActionItems.sanitize($0) == $0 })
        else { return nil }
        let url = root.appendingPathComponent(parts[0], isDirectory: true).appendingPathComponent(parts[1])
        guard url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/") else { return nil }
        return url
    }

    public func remove(sessionID: String) {
        let folder = root.appendingPathComponent(ComputerActionItems.sanitize(sessionID), isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
    }

    /// Oldest first beyond the limit.
    private func prune(_ folder: URL) {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
        ), files.count > perSessionLimit else { return }
        let dated = files.map { url -> (URL, Date) in
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return (url, date)
        }
        for (url, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(files.count - perSessionLimit) {
            try? FileManager.default.removeItem(at: url)
        }
    }
}
