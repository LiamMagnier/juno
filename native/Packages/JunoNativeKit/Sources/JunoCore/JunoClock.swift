import Foundation

/// Time is injected into stateful services so expiry and retry behavior is testable.
public protocol JunoClock: Sendable {
    func now() async -> Date
    func sleep(for duration: Duration) async throws
}

public struct SystemJunoClock: JunoClock, Sendable {
    public init() {}

    public func now() async -> Date {
        Date()
    }

    public func sleep(for duration: Duration) async throws {
        try await ContinuousClock().sleep(for: duration)
    }
}
