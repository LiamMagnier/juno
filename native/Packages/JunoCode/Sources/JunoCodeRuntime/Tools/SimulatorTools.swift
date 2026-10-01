import Foundation
import JunoCodeCore

/// The screen tools: the computer-use vocabulary (§3.4) and the Simulator
/// tools (§5.14).
///
/// Owned by Lane C (computer use and Simulator tools).
/// Empty in the seams commit (CODE_AGENT_SPEC §6.0): the lane registers its
/// tools here and the session reaches them through `CodeToolProviders`, so no
/// shared file changes when they land.
public struct ScreenToolProvider: CodeToolProvider {
    public init() {}

    public func tools(for _: CodeToolProviderContext) async -> [any CodeTool] {
        []
    }
}
