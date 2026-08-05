import Foundation
import JunoCodeCore

/// Which delegated agents are still working, and the one line each is showing.
///
/// Lifted out of ``SessionController`` because it answers a question the rest of
/// that class does not: a sub-agent's events arrive on a *different* session id
/// and must never be appended to this session's transcript. Keeping the
/// membership test next to the ticker it feeds is what makes that rule legible
/// — it used to be a `Set` and a dictionary maintained in five separate places.
struct SessionSubagentIndex: Equatable {
    /// Sessions whose events belong to a child agent of this run.
    private(set) var running: Set<CodeSessionID> = []
    /// What each child is doing right now, in the app's own words.
    private(set) var activity: [CodeSessionID: String] = [:]

    func isRunning(_ sessionID: CodeSessionID) -> Bool {
        running.contains(sessionID)
    }

    /// Applies a lifecycle update. A terminal status forgets the child entirely
    /// rather than leaving a stale "still working" line behind it.
    mutating func apply(_ update: SubagentUpdateEvent) {
        guard let child = update.childSessionID else { return }
        if update.status.isTerminal {
            running.remove(child)
            activity.removeValue(forKey: child)
        } else {
            running.insert(child)
            activity[child] = update.currentActivity
        }
    }

    /// Updates the ticker from a step the child itself emitted.
    ///
    /// The proposal's summary is the same sentence the transcript prints for
    /// that call — "Read Sources/App.swift", "Search for `parentSessionID`" — so
    /// the panel says what the agent is doing in the app's own words rather than
    /// in a vocabulary invented for the panel.
    mutating func applyStep(_ event: SessionEvent) {
        switch event.payload {
        case let .toolProposed(proposed):
            activity[event.sessionID] = proposed.summary
        case .assistantMessage:
            activity[event.sessionID] = "Writing its result"
        case let .errorOccurred(error):
            activity[event.sessionID] = error.message
        default:
            break
        }
    }

    /// Reads the delegated sub-agents out of a restored transcript.
    ///
    /// Only the unfinished ones end up indexed: a finished agent's session is
    /// closed, so anything still arriving on it is somebody re-opening it, not
    /// this run continuing.
    mutating func rebuild(from events: [SessionEvent]) {
        running = []
        activity = [:]
        for event in events {
            guard case let .subagentUpdated(update) = event.payload else { continue }
            apply(update)
        }
    }
}
