import Foundation
import JunoCodeCore

/// Scans the granted workspace so a command's filesystem effects can be listed.
///
/// Bounded on purpose: it runs twice per command, and a repository with a
/// `node_modules` or a `.build` in it has far more files than anyone wants
/// walked on that cadence. Directories that are not source are skipped, and the
/// scan stops at a file ceiling and says so rather than getting slower and
/// slower on a large tree.
public struct WorkspaceChangeDetector: WorkspaceChangeDetecting {
    /// Directories never worth scanning: build products and dependency trees
    /// churn constantly and would drown the real edits in noise.
    public static let skippedDirectories: Set<String> = [
        ".git", ".build", ".swiftpm", "node_modules", ".next", "dist",
        "DerivedData", ".venv", "venv", "__pycache__", "target", ".gradle",
        ".juno-checkpoints",
    ]

    public static let defaultFileCeiling = 20_000

    private let rootURL: URL
    private let fileCeiling: Int

    public init(rootURL: URL, fileCeiling: Int = WorkspaceChangeDetector.defaultFileCeiling) {
        self.rootURL = rootURL
        self.fileCeiling = fileCeiling
    }

    public func snapshot() async -> WorkspaceSnapshot {
        // Hopped off the caller's executor: this is blocking file I/O, and it
        // runs twice around every command the agent issues.
        let root = rootURL.standardizedFileURL
        let ceiling = fileCeiling
        return await Task.detached(priority: .utility) {
            Self.scan(root: root, fileCeiling: ceiling)
        }.value
    }

    /// Synchronous by necessity: `FileManager`'s directory enumerator cannot be
    /// iterated from an async context, because doing so would block the
    /// cooperative pool's thread.
    private static func scan(root: URL, fileCeiling: Int) -> WorkspaceSnapshot {
        var stamps: [WorkspacePath: WorkspaceFileStamp] = [:]
        var truncated = false

        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return WorkspaceSnapshot(stamps: [:], wasTruncated: false)
        }

        while let url = enumerator.nextObject() as? URL {
            let values = try? url.resourceValues(forKeys: [
                .isDirectoryKey, .fileSizeKey, .contentModificationDateKey,
            ])
            if values?.isDirectory == true {
                if Self.skippedDirectories.contains(url.lastPathComponent) {
                    enumerator.skipDescendants()
                }
                continue
            }
            guard stamps.count < fileCeiling else {
                truncated = true
                break
            }
            // A path that will not validate as a workspace path is one no tool
            // could name anyway, so it is not worth reporting a change to.
            guard let relative = Self.relativePath(of: url, under: root),
                let path = try? WorkspacePath(relative)
            else { continue }
            stamps[path] = WorkspaceFileStamp(
                size: values?.fileSize ?? 0,
                modifiedAt: values?.contentModificationDate ?? .distantPast
            )
        }

        return WorkspaceSnapshot(stamps: stamps, wasTruncated: truncated)
    }

    private static func relativePath(of url: URL, under root: URL) -> String? {
        let full = url.standardizedFileURL.path
        let base = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard full.hasPrefix(base) else { return nil }
        return String(full.dropFirst(base.count))
    }
}
