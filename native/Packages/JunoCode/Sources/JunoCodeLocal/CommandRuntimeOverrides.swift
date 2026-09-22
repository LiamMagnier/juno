import Foundation
import os

/// The part of a command's environment the reader controls from settings:
/// extra variables and whether the network is reachable.
///
/// A reference shared between the workspace's executor and the session that
/// reads the settings, so a change applies to the next command without
/// rebuilding the workspace — the executor is created once per folder, while
/// settings are re-read at the start of every run.
public final class CommandRuntimeOverrides: Sendable {
    private struct State: Sendable {
        var environment: [String: String] = [:]
        var allowsNetwork: Bool = true
        var writablePaths: [String] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    public init() {}

    public var environment: [String: String] { state.withLock { $0.environment } }
    public var allowsNetwork: Bool { state.withLock { $0.allowsNetwork } }
    public var writablePaths: [String] { state.withLock { $0.writablePaths } }

    public func update(environment: [String: String], allowsNetwork: Bool, writablePaths: [String]) {
        state.withLock {
            $0.environment = environment
            $0.allowsNetwork = allowsNetwork
            $0.writablePaths = writablePaths
        }
    }
}
