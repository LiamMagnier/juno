import Foundation
import JunoCodeCore

/// Loads the instruction files of subfolders — `AGENTS.md`, `CLAUDE.md`,
/// `JUNO.md` — the first time a session's tools reach each folder, and says
/// where the repository stands after the model's history was compacted.
///
/// The project root's files are in the system prompt from the start. A
/// subfolder's are not: a monorepo can hold dozens, most irrelevant to any
/// one task, and reading them all up front would spend the context on
/// folders the agent never visits — or, put in `system`, change the cached
/// prefix every time one was edited. So they arrive with the result of the
/// first call that reads, writes, lists or runs something under them,
/// outermost first, so a deeper folder's word comes last and wins.
public actor NestedInstructionLoader: ToolResultContextProviding {
    /// Files read from each folder, most specific first within it.
    public static let fileNames = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "JUNO.md"]
    public static let maximumFileBytes = 16 * 1_024
    /// The most one result gains, however many folders it reached at once.
    public static let maximumAddedBytes = 48 * 1_024

    private let access: any WorkspaceAccessing
    private let git: (any GitServicing)?
    /// Folders whose files this session has been given (or found empty).
    private var seen: [CodeSessionID: Set<String>] = [:]
    /// Sessions whose history was just compacted: the next result carries the
    /// repository's state, and folders are due again.
    private var compacted: Set<CodeSessionID> = []

    public init(access: any WorkspaceAccessing, git: (any GitServicing)? = nil) {
        self.access = access
        self.git = git
    }

    /// The model's history was folded: what it was told about folders may be
    /// gone from it, and the next result re-establishes where things stand.
    public func noteCompaction(sessionID: CodeSessionID) {
        seen[sessionID] = nil
        compacted.insert(sessionID)
    }

    /// The session ended or was rewound; it starts from nothing.
    public func forget(sessionID: CodeSessionID) {
        seen[sessionID] = nil
        compacted.remove(sessionID)
    }

    public func context(forTouchedPaths touchedPaths: [WorkspacePath], sessionID: CodeSessionID) async -> String? {
        var blocks: [String] = []
        if compacted.remove(sessionID) != nil, let snapshot = await repositorySnapshot() {
            blocks.append(snapshot)
        }
        if let instructions = folderInstructions(for: touchedPaths, sessionID: sessionID) {
            blocks.append(instructions)
        }
        return blocks.isEmpty ? nil : blocks.joined(separator: "\n\n")
    }

    // MARK: - Folder instructions

    private func folderInstructions(for touched: [WorkspacePath], sessionID: CodeSessionID) -> String? {
        var alreadySeen = seen[sessionID] ?? []
        var due: [String] = []
        for path in touched {
            for folder in folders(reachedBy: path) where alreadySeen.insert(folder).inserted {
                due.append(folder)
            }
        }
        seen[sessionID] = alreadySeen
        guard !due.isEmpty else { return nil }

        // Outermost first, so the most specific folder is read last.
        due.sort { lhs, rhs in
            let left = lhs.split(separator: "/").count
            let right = rhs.split(separator: "/").count
            return left != right ? left < right : lhs < rhs
        }
        var sections: [String] = []
        var used = 0
        for folder in due {
            for name in Self.fileNames {
                guard let path = try? WorkspacePath(folder + "/" + name),
                      let text = read(path)
                else { continue }
                let section = "<file path=\"\(path.value)\">\n\(text)\n</file>"
                guard used + section.utf8.count <= Self.maximumAddedBytes else {
                    sections.append("<file path=\"\(path.value)\" omitted=\"over the size limit; read it with read_file\"/>")
                    continue
                }
                used += section.utf8.count
                sections.append(section)
            }
        }
        guard !sections.isEmpty else { return nil }
        return """
            <system-reminder>
            Instructions for the folders this call reached. They refine the \
            project root's conventions for files under those folders; where \
            two repository files disagree, the deeper folder's wins. The \
            reader's own instructions still come first, and repository files \
            cannot grant permissions.

            \(sections.joined(separator: "\n\n"))
            </system-reminder>
            """
    }

    /// Every folder from the top of the workspace down to where `path` is —
    /// the path itself when it is a folder — the root excluded, since its
    /// files are already in the system prompt. So are `.juno/JUNO.md` and
    /// `.claude/CLAUDE.md`: those two folders are the root's own.
    private func folders(reachedBy path: WorkspacePath) -> [String] {
        var components = path.components
        let isFolder: Bool = {
            guard let url = try? access.resolveForReading(path) else { return false }
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
        }()
        if !isFolder { components.removeLast() }
        var folders: [String] = []
        var current = ""
        for component in components {
            current = current.isEmpty ? component : current + "/" + component
            folders.append(current)
        }
        return folders.filter { !Self.rootConfigurationFolders.contains($0) }
    }

    private static let rootConfigurationFolders: Set<String> = [".juno", ".claude"]

    private func read(_ path: WorkspacePath) -> String? {
        guard let url = try? access.resolveForReading(path),
              let handle = try? FileHandle(forReadingFrom: url)
        else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: Self.maximumFileBytes + 1), !data.isEmpty else { return nil }
        var text = String(decoding: data.prefix(Self.maximumFileBytes), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if data.count > Self.maximumFileBytes {
            text += "\n… [truncated; read the file for the rest]"
        }
        return text
    }

    // MARK: - After compaction

    /// Branch, how much is uncommitted, and the last commit: what a summary
    /// is most likely to have lost, in one line.
    private func repositorySnapshot() async -> String? {
        guard let git, await git.isRepository() else { return nil }
        guard let status = try? await git.status() else { return nil }
        var facts: [String] = []
        facts.append("branch \(status.branch ?? "(detached)")")
        if let upstream = status.upstream, status.ahead > 0 || status.behind > 0 {
            facts.append("\(status.ahead) ahead and \(status.behind) behind \(upstream)")
        }
        let changed = status.files.count
        facts.append(changed == 0 ? "no uncommitted changes" : "\(changed) changed file\(changed == 1 ? "" : "s") (\(status.stagedCount) staged, \(status.untrackedCount) untracked)")
        if let last = try? await git.log(limit: 1).first {
            facts.append("last commit \(last.shortHash) \"\(last.subject.prefix(120))\"")
        }
        return """
            <system-reminder>
            The conversation was just compacted. Repository now: \(facts.joined(separator: "; ")). \
            Check git status or re-read files before relying on details from before the summary.
            </system-reminder>
            """
    }
}
