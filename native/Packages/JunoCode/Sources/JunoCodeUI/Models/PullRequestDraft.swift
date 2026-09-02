import Foundation
import JunoCodeCore

/// What `gh pr create` will be asked to open, as the sheet edits it.
///
/// A value rather than view state so the title and body a session proposes can
/// be pinned by a test: the generated body is the one piece of prose Juno writes
/// on the reader's behalf into a place other people read, and a body that says
/// "3 files changed" when four were is the kind of mistake nobody notices
/// until a reviewer does.
public struct PullRequestDraft: Equatable, Sendable {
    public var title: String
    public var body: String
    /// The branch to merge into. Empty asks `gh` to use the repository default.
    public var baseBranch: String
    public var isDraft: Bool

    public init(title: String, body: String, baseBranch: String = "", isDraft: Bool = false) {
        self.title = title
        self.body = body
        self.baseBranch = baseBranch
        self.isDraft = isDraft
    }

    /// Whether there is enough to open one. `gh` refuses an empty title, and a
    /// sheet that lets the reader press Create into that refusal is worse than
    /// a disabled button.
    public var canSubmit: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The arguments after `gh pr create`, exactly as they will be quoted.
    public var arguments: [String] {
        var arguments = ["pr", "create", "--title", title, "--body", body]
        let base = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !base.isEmpty {
            arguments += ["--base", base]
        }
        if isDraft {
            arguments.append("--draft")
        }
        return arguments
    }

    // MARK: - Generation

    /// A draft written from what the session did.
    ///
    /// - Parameters:
    ///   - sessionTitle: the session's own title, which is the reader's first
    ///     prompt trimmed to a line — the closest thing to a PR title Juno has.
    ///   - summary: the run's closing summary, when the run finished.
    ///   - changes: the tracked changes, for the file list and the stat.
    ///   - testsPassed: the last verification verdict, when there was one.
    ///   - branch: the current branch, named in the body so a reviewer reading
    ///     the description on GitHub knows what was pushed.
    public static func generated(
        sessionTitle: String,
        summary: String?,
        changes: [TrackedChange],
        testsPassed: Bool?,
        branch: String?
    ) -> PullRequestDraft {
        var title = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty || title == "New session" || title == "New conversation" {
            title = "Changes from Juno Code"
        }
        if title.count > 72 {
            title = String(title.prefix(69)).trimmingCharacters(in: .whitespaces) + "…"
        }

        var sections: [String] = []
        sections.append("## Summary")
        if let summary, !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sections.append(summary.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            sections.append(sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        if !changes.isEmpty {
            let added = changes.reduce(0) { $0 + $1.linesAdded }
            let removed = changes.reduce(0) { $0 + $1.linesRemoved }
            sections.append("")
            sections.append("## Changes")
            sections.append(
                "\(changes.count) \(changes.count == 1 ? "file" : "files") changed, +\(added) −\(removed)"
            )
            sections.append("")
            for change in changes.sorted(by: { $0.path < $1.path }) {
                sections.append("- `\(change.path)` — \(change.kind.rawValue), +\(change.linesAdded) −\(change.linesRemoved)")
            }
        }

        sections.append("")
        sections.append("## Verification")
        switch testsPassed {
        case .some(true): sections.append("Tests passed in the session.")
        case .some(false): sections.append("Tests were failing when the session ended.")
        case .none: sections.append("No test run was recorded in the session.")
        }

        if let branch, !branch.isEmpty {
            sections.append("")
            sections.append("_Opened from Juno Code on `\(branch)`._")
        } else {
            sections.append("")
            sections.append("_Opened from Juno Code._")
        }

        return PullRequestDraft(title: title, body: sections.joined(separator: "\n"))
    }
}
