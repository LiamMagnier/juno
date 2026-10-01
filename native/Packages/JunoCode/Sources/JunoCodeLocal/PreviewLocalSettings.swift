import Foundation

/// The reader's Preview decisions for each checkout, kept on this Mac only,
/// never in the repository (CODE_AGENT_SPEC §4.2, §4.4, §4.5):
///
/// - configurations approved "Always for this configuration", by name and
///   content hash, so a changed configuration is asked about again;
/// - configurations allowed to use the internet, the same way;
/// - whether `preview_browser eval` is enabled (off by default);
/// - whether the page keeps its sign-in between opens (off by default).
public final class PreviewLocalSettings: @unchecked Sendable {
    public struct Project: Codable, Hashable, Sendable {
        public var approvedConfigurations: Set<String> = []
        public var internetConfigurations: Set<String> = []
        /// Asked about and kept offline: not asked again for the same bytes.
        public var offlineConfigurations: Set<String> = []
        public var allowEval = false
        public var persistSignIn = false

        public init() {}
    }

    private struct File: Codable {
        var projects: [String: Project] = [:]
    }

    public let fileURL: URL
    private let lock = NSLock()
    private var cache: File?

    public static var defaultFileURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support
            .appendingPathComponent("Juno", isDirectory: true)
            .appendingPathComponent("code", isDirectory: true)
            .appendingPathComponent("preview-settings.json")
    }

    /// The reader's settings; a throwaway file in a test run.
    public static let shared = PreviewRegistry.isTestProcess
        ? PreviewLocalSettings(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-preview-settings-\(getpid()).json"))
        : PreviewLocalSettings()

    public init(fileURL: URL = PreviewLocalSettings.defaultFileURL) {
        self.fileURL = fileURL
    }

    public func project(_ checkoutRoot: URL) -> Project {
        lock.lock()
        defer { lock.unlock() }
        return loadLocked().projects[Self.key(checkoutRoot)] ?? Project()
    }

    public func update(_ checkoutRoot: URL, _ change: (inout Project) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        var file = loadLocked()
        var project = file.projects[Self.key(checkoutRoot)] ?? Project()
        change(&project)
        file.projects[Self.key(checkoutRoot)] = project
        cache = file
        save(file)
    }

    public func isApproved(_ configuration: ResolvedPreviewConfiguration, in checkoutRoot: URL) -> Bool {
        project(checkoutRoot).approvedConfigurations.contains(configuration.approvalKey)
    }

    public func approve(_ configuration: ResolvedPreviewConfiguration, in checkoutRoot: URL) {
        update(checkoutRoot) { $0.approvedConfigurations.insert(configuration.approvalKey) }
    }

    /// The network the configuration runs with: the file's, raised to the
    /// internet only by the reader's own answer for these bytes.
    public func effectiveNetwork(for configuration: ResolvedPreviewConfiguration, in checkoutRoot: URL) -> PreviewNetworkPolicy {
        if configuration.network == .internet { return .internet }
        return project(checkoutRoot).internetConfigurations.contains(configuration.approvalKey) ? .internet : .loopback
    }

    public func setInternet(_ allowed: Bool, for configuration: ResolvedPreviewConfiguration, in checkoutRoot: URL) {
        update(checkoutRoot) { project in
            if allowed {
                project.internetConfigurations.insert(configuration.approvalKey)
                project.offlineConfigurations.remove(configuration.approvalKey)
            } else {
                project.internetConfigurations.remove(configuration.approvalKey)
                project.offlineConfigurations.insert(configuration.approvalKey)
            }
        }
    }

    /// Whether to ask about the internet for these bytes: not yet answered.
    public func shouldAskAboutInternet(for configuration: ResolvedPreviewConfiguration, in checkoutRoot: URL) -> Bool {
        let project = project(checkoutRoot)
        return configuration.network == .loopback
            && !project.internetConfigurations.contains(configuration.approvalKey)
            && !project.offlineConfigurations.contains(configuration.approvalKey)
    }

    static func key(_ checkoutRoot: URL) -> String {
        checkoutRoot.resolvingSymlinksInPath().standardizedFileURL.path
    }

    private func loadLocked() -> File {
        if let cache { return cache }
        let file = (try? Data(contentsOf: fileURL)).flatMap { try? JSONDecoder().decode(File.self, from: $0) } ?? File()
        cache = file
        return file
    }

    private func save(_ file: File) {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(file).write(to: fileURL, options: .atomic)
        } catch {
            // Kept in memory for this run; the reader is asked again next launch.
        }
    }
}
