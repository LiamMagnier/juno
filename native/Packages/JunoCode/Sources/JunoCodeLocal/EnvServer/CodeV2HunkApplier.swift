import Foundation
import JunoCodeCore

/// Accept / Reject for one hunk of an env-server session's diff (DESIGN
/// §5.16 Changes), done with the repository's own git:
/// - **Accept** stages exactly that hunk (`git apply --cached`), so a later
///   commit takes what was reviewed;
/// - **Reject** reverses it in the working tree (`git apply -R`).
///
/// `--recount` lets a hunk apply after neighbouring hunks moved its lines,
/// and `--check` runs first so a failure leaves nothing half-applied.
public struct CodeV2HunkApplier: Sendable {
    public enum Operation: Sendable { case accept, reject }

    public enum Failure: Error, Equatable, LocalizedError {
        case gitFailed(String)
        public var errorDescription: String? {
            switch self {
            case let .gitFailed(message):
                message.isEmpty ? "Git could not apply that hunk." : "Git could not apply that hunk: \(message)"
            }
        }
    }

    public let gitPath: String

    public init(gitPath: String = "/usr/bin/git") {
        self.gitPath = gitPath
    }

    public static func arguments(_ operation: Operation, check: Bool) -> [String] {
        var args = ["apply", "--recount", "--whitespace=nowarn"]
        switch operation {
        case .accept: args.append("--cached")
        case .reject: args.append("-R")
        }
        if check { args.append("--check") }
        args.append("-")
        return args
    }

    public func apply(_ operation: Operation, hunk: DiffHunk, path: String, in directory: URL) async throws {
        // A folder that is not a repository has no index to stage into: the
        // change is already in the file, so accepting it only records the
        // decision. (Reject goes through the env server either way.)
        if operation == .accept, !Self.isInsideRepository(directory) { return }
        let patch = CodeV2UnifiedDiff.patch(for: hunk, path: path)
        try await run(Self.arguments(operation, check: true), patch: patch, in: directory)
        try await run(Self.arguments(operation, check: false), patch: patch, in: directory)
    }

    /// True when the folder, or a folder above it, holds a `.git` (a
    /// repository or a worktree's `.git` file).
    public static func isInsideRepository(_ directory: URL) -> Bool {
        var url = directory.standardizedFileURL
        while true {
            if FileManager.default.fileExists(atPath: url.appendingPathComponent(".git").path) { return true }
            // Standardized at every step, not only the first: the parent of
            // the directory URL `file:///` is `file:///../`, then `/../..`,
            // and so on, so a folder outside any repository walked upwards
            // forever and Accept hung.
            let parent = url.deletingLastPathComponent().standardizedFileURL
            if parent.path == url.path || parent.path.isEmpty { return false }
            url = parent
        }
    }

    private func run(_ arguments: [String], patch: String, in directory: URL) async throws {
        let gitPath = self.gitPath
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: gitPath)
            process.arguments = arguments
            process.currentDirectoryURL = directory
            let input = Pipe()
            let errors = Pipe()
            process.standardInput = input
            process.standardError = errors
            process.standardOutput = FileHandle.nullDevice
            try process.run()
            input.fileHandleForWriting.write(Data(patch.utf8))
            try input.fileHandleForWriting.close()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                throw Failure.gitFailed(message.split(separator: "\n").first.map(String.init) ?? "")
            }
        }.value
    }
}
