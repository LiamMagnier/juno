import Foundation

/// Shares short-lived discovery across consecutive window captures.
/// Images and per-session exclusion/consent decisions are never cached.
actor CaptureContentCache<Value: Sendable> {
    private let load: @Sendable () async throws -> Value
    private let lifetime: Duration
    private let now: @Sendable () -> ContinuousClock.Instant
    private var cached: (Value, ContinuousClock.Instant)?
    private var pending: (UUID, Task<Value, Error>)?

    init(
        lifetime: Duration = .milliseconds(750),
        now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now },
        load: @escaping @Sendable () async throws -> Value
    ) {
        self.lifetime = lifetime
        self.now = now
        self.load = load
    }

    func value() async throws -> Value {
        try Task.checkCancellation()
        if let (value, expires) = cached, now() < expires { return value }
        let id: UUID
        let task: Task<Value, Error>
        if let active = pending {
            (id, task) = active
        } else {
            id = UUID()
            task = Task { try await load() }
            pending = (id, task)
        }
        do {
            let value = try await task.value
            if pending?.0 == id {
                cached = (value, now().advanced(by: lifetime))
                pending = nil
            }
            try Task.checkCancellation()
            return value
        } catch {
            if pending?.0 == id { pending = nil }
            throw error
        }
    }

    func invalidate() {
        cached = nil
        // An older in-flight read must not repopulate an invalidated cache.
        pending = nil
    }
}
