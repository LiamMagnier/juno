import Foundation

/// A one-shot latch used to resume a `CheckedContinuation` exactly once.
///
/// `ASWebAuthenticationSession` can invoke its completion handler *during*
/// `start()` — the crash backtrace that motivated this shows
/// `_startDryRun:` calling `_endSessionWithCallbackURL:error:` synchronously
/// inside the `start()` call. If `start()` then also returns `false`, both the
/// completion path and the start-failure path try to resume the same
/// continuation, and resuming a checked continuation twice is a fatal error.
///
/// Main-actor isolated on purpose: both resume paths hop to the main actor
/// before claiming, so the latch needs no lock and its ordering is the actor's.
@MainActor
public final class WebAuthenticationResumeLatch {
    private var isClaimed = false

    public init() {}

    /// Returns `true` exactly once, for the first caller; `false` after that.
    /// Callers must resume the continuation only when this returns `true`.
    public func claim() -> Bool {
        guard !isClaimed else { return false }
        isClaimed = true
        return true
    }
}
