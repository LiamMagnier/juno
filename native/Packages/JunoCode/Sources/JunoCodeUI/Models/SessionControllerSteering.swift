import Foundation

/// Safe mid-run direction for the local and Remote Code surfaces.
///
/// Juno's orchestrator deliberately owns exactly one executor per session. A
/// second concurrent `submit` would race tool calls, approvals and conversation
/// persistence, so steering is an explicit execution boundary instead: stop the
/// current run, wait for the session's persisted status to settle, then submit
/// the new direction through the ordinary composer path. The session identity,
/// transcript, permissions, goal and workspace stay the same.
@MainActor
public extension SessionController {
    /// Interrupt the current run, if any, and continue this session with `text`.
    ///
    /// Returns true only when the ordinary send path accepted the direction and
    /// cleared the composer. A paused/blocked goal, unavailable transport or a
    /// session that failed to settle leaves the draft in place and returns false.
    @discardableResult
    func interruptAndSend(_ text: String) async -> Bool {
        let direction = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !direction.isEmpty else { return false }

        if isRunning {
            await stop()

            // `AgentOrchestrator.stop()` waits for the run task and its terminal
            // store write. The controller observes that store on MainActor, so
            // allow the observation hop to land before calling the normal send
            // guard. This is bounded: if the state never settles, `send()` is not
            // attempted and no second executor can be created.
            for _ in 0..<40 where isRunning {
                try? await Task.sleep(for: .milliseconds(25))
            }
            guard !isRunning else { return false }
        }

        composerText = direction
        await send()
        return composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
