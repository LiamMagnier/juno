import Foundation
import Testing
@testable import JunoCodeCore

/// The compaction event is a durable transcript row, so it has to survive the
/// store's JSON round trip — including older records that never carried it.
struct CompactionEventTests {
    @Test
    func roundTripsThroughJSON() throws {
        let event = SessionEvent(
            id: "e-1",
            sessionID: CodeSessionID(value: "s-1"),
            sequence: 9,
            timestamp: Date(timeIntervalSince1970: 1_700_000_000),
            payload: .compaction(
                CompactionEvent(
                    summary: "Older turns summarised.",
                    beforeMessageCount: 14,
                    afterMessageCount: 5,
                    beforeTokens: 91_000,
                    requestedByUser: true
                )
            )
        )
        let data = try JSONEncoder().encode(event)
        let decoded = try JSONDecoder().decode(SessionEvent.self, from: data)
        #expect(decoded == event)
        guard case let .compaction(compaction) = decoded.payload else {
            Issue.record("expected a compaction payload")
            return
        }
        #expect(compaction.messageCountSummary == "14 → 5 messages")
        #expect(compaction.requestedByUser)
    }

    @Test
    func aConfigurationWithoutACustomAgentStillDecodes() throws {
        // The shape an older store wrote, before `customAgentID` existed.
        let json = """
        {"modelID":"anthropic:claude-sonnet-5","behavior":"code","role":"engineer",\
        "permissionMode":"askBeforeChanges","location":"local","computerUseEnabled":false}
        """
        let configuration = try JSONDecoder().decode(
            AgentConfiguration.self,
            from: Data(json.utf8)
        )
        #expect(configuration.customAgentID == nil)

        var chosen = configuration
        chosen.customAgentID = "juno:reviewer"
        let data = try JSONEncoder().encode(chosen)
        let decoded = try JSONDecoder().decode(AgentConfiguration.self, from: data)
        #expect(decoded.customAgentID == "juno:reviewer")
    }
}
