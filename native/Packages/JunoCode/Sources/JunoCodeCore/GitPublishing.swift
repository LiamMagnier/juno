import Foundation

/// Where a push of the current branch goes. Never a force push.
public struct GitPushTarget: Hashable, Codable, Sendable {
    public let remote: String
    public let localBranch: String
    public let remoteBranch: String
    /// The branch has no upstream yet; the push sets it.
    public let setsUpstream: Bool

    public init(remote: String, localBranch: String, remoteBranch: String, setsUpstream: Bool) {
        self.remote = remote
        self.localBranch = localBranch
        self.remoteBranch = remoteBranch
        self.setsUpstream = setsUpstream
    }

    /// "origin/juno/fix-settings".
    public var displayTarget: String { "\(remote)/\(remoteBranch)" }
}

/// Publishing the current branch, for the agent's `git_push` tool
/// (CODE_AGENT_SPEC §5.3). Kept apart from `GitServicing`, whose operations
/// never leave the machine: a push reaches another host, so the tool that
/// uses this is pinned to asking every time, in every mode, and no rule,
/// hook, goal or grant silences it.
public protocol GitPublishing: Sendable {
    /// The exact target a push of the current branch would use.
    func pushTarget() async throws -> GitPushTarget
    /// Pushes exactly `target`, re-resolving it first and refusing when it
    /// changed. Returns what Git printed.
    func push(to target: GitPushTarget) async throws -> String
}
