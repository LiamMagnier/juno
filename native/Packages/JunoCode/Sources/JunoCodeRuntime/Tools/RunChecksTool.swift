import Foundation
import JunoCodeCore

/// The verification tools: `run_checks` (§1.8), which runs the project's
/// recorded checks and records their results.
///
/// Owned by Lane B (verification, self-review and report).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): the lane registers its
/// tools here and the session reaches them through `CodeToolProviders`, so no
/// shared file changes when they land.
public struct VerificationToolProvider: CodeToolProvider {
    public init() {}

    public func tools(for _: CodeToolProviderContext) async -> [any CodeTool] {
        []
    }
}
