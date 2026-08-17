import Foundation

/// Safe, sanitized developer toolchain discovery for subprocess execution in
/// Juno Code.
///
/// By default, Juno uses a scrubbed environment to prevent host secrets and
/// tokens from leaking into child processes. However, developers frequently
/// install Node, Bun, PNPM, Vite, Rust, and Go through version managers
/// (`nvm`, `mise`, `asdf`, `fnm`, `volta`, `bun`, `cargo`).
///
/// This helper discovers standard toolchain binary directories located in the
/// user's home folder, validates that they exist on disk, and builds a sanitized
/// `PATH` without inheriting arbitrary environment variables or sensitive
/// credentials.
public enum ToolchainEnvironment: Sendable {
    public static let defaultBasePaths: [String] = [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
    ]

    public static let defaultBasePATH = defaultBasePaths.joined(separator: ":")

    /// Computes a sanitized `PATH` string combining standard system paths and
    /// discovered developer toolchain directories.
    public static func resolvedPATH(homeDirectory: String = NSHomeDirectory()) -> String {
        var paths: [String] = []

        // Discovered user toolchain paths (checked first so project/user toolchains take precedence)
        let candidates = candidateToolchainDirectories(homeDirectory: homeDirectory)
        for candidate in candidates {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: candidate, isDirectory: &isDir), isDir.boolValue {
                if !paths.contains(candidate) {
                    paths.append(candidate)
                }
            }
        }

        // Standard system paths
        for systemPath in defaultBasePATH.split(separator: ":").map(String.init) {
            if !paths.contains(systemPath) {
                paths.append(systemPath)
            }
        }

        return paths.joined(separator: ":")
    }

    private static func candidateToolchainDirectories(homeDirectory: String) -> [String] {
        var candidates: [String] = [
            "\(homeDirectory)/.local/bin",
            "\(homeDirectory)/.local/share/mise/shims",
            "\(homeDirectory)/.asdf/shims",
            "\(homeDirectory)/.asdf/bin",
            "\(homeDirectory)/.fnm/current/bin",
            "\(homeDirectory)/.local/share/fnm/current/bin",
            "\(homeDirectory)/.volta/bin",
            "\(homeDirectory)/.bun/bin",
            "\(homeDirectory)/.cargo/bin",
            "\(homeDirectory)/go/bin",
            "\(homeDirectory)/.yarn/bin",
            "\(homeDirectory)/.pnpm",
            "\(homeDirectory)/Library/pnpm",
        ]

        // Check NVM installed versions (e.g. ~/.nvm/versions/node/v20.x.x/bin)
        let nvmNodeRoot = "\(homeDirectory)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmNodeRoot) {
            let sortedVersions = versions.sorted { left, right in
                left.localizedStandardCompare(right) == .orderedDescending
            }
            for version in sortedVersions {
                candidates.append("\(nvmNodeRoot)/\(version)/bin")
            }
        }

        return candidates
    }
}
