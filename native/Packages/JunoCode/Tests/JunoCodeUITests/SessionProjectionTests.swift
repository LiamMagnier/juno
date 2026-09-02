import Foundation
import Testing
import JunoCodeCore
@testable import JunoCodeUI

/// The work-log projection: every tool call the transcript records lands in
/// the group as a record, and the group's title is a sentence about them.
@MainActor
struct SessionProjectionTests {
    private let sessionID = CodeSessionID(value: "sess-projection")

    private func event(_ sequence: Int, _ payload: SessionEventPayload) -> SessionEvent {
        SessionEvent(
            id: "event-\(sequence)",
            sessionID: sessionID,
            sequence: sequence,
            timestamp: Date(timeIntervalSince1970: 1_000 + Double(sequence)),
            payload: payload
        )
    }

    @Test
    func toolCallsBecomeRecordsWithTheirOutcome() {
        let projection = SessionProjection()
        projection.reduce(events: [
            event(1, .userPrompt(UserPromptEvent(text: "Fix it"))),
            event(2, .toolProposed(ToolProposedEvent(
                toolCallID: "call-1", toolName: "read_file", input: .null,
                risk: .read, summary: "Read Sources/App.swift"
            ))),
            event(3, .toolStarted(ToolStartedEvent(toolCallID: "call-1"))),
            event(4, .toolOutput(ToolOutputEvent(toolCallID: "call-1", channel: .stdout, text: "line 1\nline 2\n"))),
            event(5, .toolCompleted(ToolCompletedEvent(
                toolCallID: "call-1", status: .succeeded, resultSummary: "42 lines", durationSeconds: 0.4
            ))),
            event(6, .toolProposed(ToolProposedEvent(
                toolCallID: "call-2", toolName: "run_command", input: .null,
                risk: .execute, summary: "Run swift build"
            ))),
            event(7, .toolCompleted(ToolCompletedEvent(
                toolCallID: "call-2", status: .failed, resultSummary: "exit 1", durationSeconds: 3
            ))),
            event(8, .assistantMessage(AssistantMessageEvent(text: "Done."))),
        ])

        #expect(projection.narrativeGroups.count == 1)
        let group = projection.narrativeGroups[0]
        #expect(group.status == .completed)
        #expect(group.toolCallRecords.count == 2)
        #expect(group.toolCallRecords[0].id == "call-1")
        #expect(group.toolCallRecords[0].status == .succeeded)
        #expect(group.toolCallRecords[0].durationSeconds == 0.4)
        #expect(group.toolCallRecords[0].resultSummary == "42 lines")
        #expect(group.toolCallRecords[0].outputLines == ["line 1", "line 2"])
        #expect(group.toolCallRecords[1].status == .failed)
        #expect(group.hasDetail)
        #expect(group.eventIDs.contains("event-2"))
        #expect(group.eventIDs.contains("event-7"))
    }

    @Test
    func theTitleIsASentenceAboutTheWork() {
        let title = SessionProjection.title(for: [
            ToolTally(name: "read_file", count: 3),
            ToolTally(name: "grep", count: 1),
            ToolTally(name: "run_command", count: 2),
            ToolTally(name: "apply_patch", count: 3),
        ])
        #expect(title == "Read 4 files · ran 2 commands · edited 3 files")
        #expect(SessionProjection.title(for: [ToolTally(name: "read_file", count: 1)]) == "Read 1 file")
        #expect(SessionProjection.title(for: []) == "Working")
    }

    @Test
    func aGroupInterruptedByAnErrorCancelsItsOpenCalls() {
        let projection = SessionProjection()
        projection.reduce(events: [
            event(1, .userPrompt(UserPromptEvent(text: "Go"))),
            event(2, .toolProposed(ToolProposedEvent(
                toolCallID: "call-1", toolName: "run_tests", input: .null,
                risk: .execute, summary: "Run the tests"
            ))),
            event(3, .toolStarted(ToolStartedEvent(toolCallID: "call-1"))),
            event(4, .errorOccurred(ErrorEvent(message: "Provider went away", isRecoverable: false))),
        ])
        let group = projection.narrativeGroups[0]
        #expect(group.status == .interrupted)
        #expect(group.toolCallRecords[0].status == .cancelled)
    }

    @Test
    func compactionClosesTheOpenGroupAndIsNotAStep() {
        let projection = SessionProjection()
        projection.reduce(events: [
            event(1, .userPrompt(UserPromptEvent(text: "Go"))),
            event(2, .toolProposed(ToolProposedEvent(
                toolCallID: "call-1", toolName: "read_file", input: .null,
                risk: .read, summary: "Read a file"
            ))),
            event(3, .compaction(CompactionEvent(
                summary: "Older turns summarised.", beforeMessageCount: 12, afterMessageCount: 4
            ))),
        ])
        #expect(projection.narrativeGroups.count == 1)
        #expect(projection.narrativeGroups[0].status == .completed)
        #expect(projection.narrativeGroups[0].toolCallRecords.count == 1)
    }

    @Test
    func outputIsBoundedPerRecord() {
        let projection = SessionProjection()
        let limit = ActivityNarrativeGroup.ToolCallRecord.maximumOutputLines
        let text = (0..<(limit + 10)).map { "line \($0)" }.joined(separator: "\n") + "\n"
        projection.reduce(events: [
            event(1, .toolProposed(ToolProposedEvent(
                toolCallID: "call-1", toolName: "run_command", input: .null,
                risk: .execute, summary: "Run"
            ))),
            event(2, .toolOutput(ToolOutputEvent(toolCallID: "call-1", channel: .stdout, text: text))),
        ])
        let record = projection.narrativeGroups[0].toolCallRecords[0]
        #expect(record.outputLines.count == limit)
        #expect(record.outputLines.last == "line \(limit + 9)")
    }
}
