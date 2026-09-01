import Foundation
import JunoCodeCore

/// Adapts the existing append-only store to the cross-client protocol without
/// changing its on-disk format. The store's historical sequence is zero-based;
/// protocol sequences are one-based so a cursor of zero unambiguously means
/// "no event has been applied" on every transport.
public enum CodeSessionStoreProtocolAdapter {
    public static func envelope(from event: SessionEvent) -> CodeSessionEventEnvelope {
        CodeSessionEventEnvelope(
            id: event.id,
            sessionID: event.sessionID,
            sequence: event.sequence + 1,
            occurredAt: event.timestamp,
            payload: event.payload
        )
    }
}

public extension CodeSessionStore {
    /// Returns the durable local transcript through the same cursor semantics
    /// that the relay and future CLI use. This is read-only: the local store
    /// remains authoritative for event persistence during the migration.
    func protocolEvents(after cursor: CodeSessionEventCursor) -> [CodeSessionEventEnvelope] {
        events(for: cursor.sessionID)
            .map(CodeSessionStoreProtocolAdapter.envelope)
            .filter { $0.sequence > cursor.afterSequence }
    }
}
