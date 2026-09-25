import Foundation
import Testing
@testable import JunoChatKit

/// Research on today's server (Phase 5 Stage B, B6): runs with no derived
/// phase, the clarify gate, stopped-early runs, catching up, the working
/// clock from state changes, the recap's routing and the citation check.
struct NativeResearchRunStageBTests {
    private func view(_ run: String, events: String = "[]", lastSeq: Int = 0, maxSeq: Int = 0) -> Data {
        Data(#"{"run":\#(run),"events":\#(events),"lastSeq":\#(lastSeq),"maxSeq":\#(maxSeq)}"#.utf8)
    }

    // MARK: The clarify gate

    @Test
    func aRunWaitingOnDetailsIsAGateWithItsQuestions() throws {
        let run = try #require(NativeResearchRun.decodedView(view(#"""
        {"id":"rr_1","conversationId":"conv_1","goal":"Heat pumps for a 1930s semi","state":"awaiting_clarification",
         "plan":{"clarifications":[
           {"id":"c1","question":"Which country are you in?","why":"Grants and installers differ by country.","suggestions":["UK","Ireland"],"skippable":false},
           {"id":"c2","question":"Is the loft insulated?","suggestions":[]}
         ]},"costMicroUsd":"41250","createdAt":"2026-09-25T10:00:00.000Z"}
        """#)))
        #expect(run.phase == .awaitingClarification)
        #expect(!run.phase.isWorking)
        #expect(!run.phase.isTerminal)
        #expect(!run.derivesPhase)
        #expect(run.phaseLine.text == "Waiting for you to fill in a few details")
        #expect(run.clarifications.map(\.id) == ["c1", "c2"])
        #expect(run.clarifications[0].skippable == false)
        #expect(run.clarifications[0].suggestions == ["UK", "Ireland"])
        #expect(run.clarifications[1].skippable)
        #expect(run.clarifications[1].why == nil)
        #expect(run.costMicroUsd == 41_250)
        #expect(NativeResearchRun.Phase(state: "awaiting_clarification") == .awaitingClarification)
    }

    // MARK: Stopped early

    @Test
    func stoppedEarlyWithNoReportReadsAsStopped() throws {
        let empty = try #require(NativeResearchRun.decodedView(view(#"{"id":"rr_2","state":"partially_completed"}"#)))
        #expect(empty.phase == .stopped)
        let written = try #require(NativeResearchRun.decodedView(view(
            ##"{"id":"rr_3","state":"partially_completed","report":"# Findings\n\nWhat it had."}"##
        )))
        #expect(written.phase == .done)
        #expect(NativeResearchRun.stateSentence("partially_completed") == "Stopped early with what it had")
    }

    // MARK: Catching up

    @Test
    func aRunBehindTheServerIsReadAgainAtOnce() throws {
        let events = (1...3).map { #"{"seq":\#($0),"kind":"query_issued","payload":{"query":"q\#($0)"},"createdAt":"2026-09-25T10:00:0\#($0).000Z"}"# }
        let run = try #require(NativeResearchRun.decodedView(view(
            #"{"id":"rr_4","state":"investigating"}"#, events: "[\(events.joined(separator: ","))]", lastSeq: 3, maxSeq: 412
        )))
        #expect(run.lastSeq == 3)
        #expect(run.maxSeq == 412)
        #expect(run.isBehind)
        let caughtUp = try #require(NativeResearchRun.decodedView(view(#"{"id":"rr_4","state":"investigating"}"#, lastSeq: 412, maxSeq: 412), previous: run))
        #expect(!caughtUp.isBehind)
    }

    // MARK: The clock

    @Test
    func theClockCountsWorkingSpansOnlyLikeTheWeb() {
        let t0 = Date(timeIntervalSince1970: 1_790_000_000)
        let transitions = [
            NativeResearchRun.StateTransition(seq: 1, state: "planning", at: t0),
            NativeResearchRun.StateTransition(seq: 2, state: "awaiting_plan_confirmation", at: t0.addingTimeInterval(12)),
            NativeResearchRun.StateTransition(seq: 5, state: "investigating", at: t0.addingTimeInterval(95)),
            NativeResearchRun.StateTransition(seq: 9, state: "paused", at: t0.addingTimeInterval(155)),
        ]
        // 12s planning and 60s investigating; the plan gate and the pause are
        // not work.
        #expect(NativeResearchRun.workingElapsedMs(
            transitions: transitions, state: "paused", createdAt: t0, now: t0.addingTimeInterval(400)
        ) == 72_000)
        // Still working: the open span runs to now.
        #expect(NativeResearchRun.workingElapsedMs(
            transitions: Array(transitions.prefix(3)), state: "investigating", createdAt: t0,
            now: t0.addingTimeInterval(130)
        ) == 47_000)
        // No transitions: a working run counts from its creation, a waiting one has no clock.
        #expect(NativeResearchRun.workingElapsedMs(
            transitions: [], state: "investigating", createdAt: t0, now: t0.addingTimeInterval(9)
        ) == 9_000)
        #expect(NativeResearchRun.workingElapsedMs(
            transitions: [], state: "awaiting_clarification", createdAt: t0, now: t0.addingTimeInterval(9)
        ) == nil)
    }

    @Test
    func stateChangesAcrossPollsFeedTheClock() throws {
        let first = try #require(NativeResearchRun.decodedView(view(
            #"{"id":"rr_5","state":"investigating","createdAt":"2026-09-25T10:00:00.000Z"}"#,
            events: #"[{"seq":1,"kind":"state_changed","payload":{"state":"planning"},"createdAt":"2026-09-25T10:00:00.000Z"},{"seq":2,"kind":"plan_confirmed","payload":{"by":"user"},"createdAt":"2026-09-25T10:00:20.000Z"},{"seq":3,"kind":"state_changed","payload":{"state":"investigating"},"createdAt":"2026-09-25T10:00:20.000Z"}]"#,
            lastSeq: 3, maxSeq: 3
        )))
        #expect(first.transitions.map(\.state) == ["planning", "investigating"])
        #expect(first.confirmedBy == "user")
        #expect(first.workingMs != nil)
        let second = try #require(NativeResearchRun.decodedView(view(
            #"{"id":"rr_5","state":"reviewing"}"#,
            events: #"[{"seq":7,"kind":"state_changed","payload":{"state":"reviewing"},"createdAt":"2026-09-25T10:04:00.000Z"}]"#,
            lastSeq: 7, maxSeq: 7
        ), previous: first))
        #expect(second.transitions.map(\.seq) == [1, 3, 7])
        #expect(second.confirmedBy == "user")
    }

    // MARK: The report and where it is drawn

    @Test
    func theReportIsTheMarkdownArtifactsBodyAndTitle() {
        let wrapped = #"Here it is.<juno:artifact identifier="research-report" type="MARKDOWN" title="Heat pumps in older homes">## Summary\n\nThey work.</juno:artifact>"#
        #expect(NativeResearchRun.reportBody(wrapped) == #"## Summary\n\nThey work."#)
        #expect(NativeResearchRun.reportTitle(wrapped) == "Heat pumps in older homes")
        let generic = #"<juno:artifact type="MARKDOWN" title="Research report">Body</juno:artifact>"#
        #expect(NativeResearchRun.reportTitle(generic) == nil)
        #expect(NativeResearchRun.reportBody("  Plain text report.  ") == "Plain text report.")
    }

    @Test
    func theTranscriptDrawsARecapOnlyWhereNothingElseCarriesTheReport() {
        var run = NativeResearchRun(id: "rr_6", goal: "Heat pumps", state: "completed", phase: .done, report: "# Report")
        #expect(run.presentation == .recap)
        run.assistantMessageID = "msg_done"
        #expect(run.presentation == .none, "a completion message is the report")
        run.seenLive = true
        #expect(run.presentation == .row, "seen working, the row stays as Report ready")
        var inChat = NativeResearchRun(
            id: "rr_7", state: "completed", phase: .done,
            report: #"<juno:artifact identifier="research-report" type="MARKDOWN" title="x">y</juno:artifact>"#
        )
        inChat.confirmedBy = "auto"
        #expect(inChat.isInChatReport)
        #expect(inChat.presentation == .none, "its chat answer already carries it")
        let live = NativeResearchRun(id: "rr_8", state: "investigating", phase: .searching)
        #expect(live.presentation == .row)
        let nothing = NativeResearchRun(id: "rr_9", state: "cancelled", phase: .stopped)
        #expect(nothing.presentation == .none)
    }

    @Test
    func objectivesCoverageReadsAsAnswered() throws {
        let run = try #require(NativeResearchRun.decodedView(view(#"""
        {"id":"rr_10","state":"completed","plan":{"objectives":[
          {"id":"o1","question":"Do they work below zero?","status":"covered"},
          {"id":"o2","question":"What does install cost?","status":"partially_covered"},
          {"id":"o3","question":"Which grants apply?","status":"blocked"}
        ]},"auditSummary":{"claims":14,"supported":11,"partiallySupported":2,"unsupported":1,"contradicted":0,"unverified":0,"duplicateSources":1}}
        """#)))
        #expect(run.questions.map(\.status) == ["covered", "partial", "thin"])
        #expect(run.objectivesAnswered?.covered == 1)
        #expect(run.objectivesAnswered?.total == 3)
        #expect(run.audit?.headline == "11/14 claims supported · 1 unsupported · 2 partly supported")
    }

    // MARK: The citation check

    @Test
    func theAuditHeadlineIsTheWebs() {
        #expect(NativeResearchRun.AuditSummary(claims: 0).headline == "No checkable claims in this answer")
        #expect(NativeResearchRun.AuditSummary(claims: 9, supported: 9).headline == "Every claim checks out against its sources")
        #expect(
            NativeResearchRun.AuditSummary(claims: 9, supported: 6, contradicted: 1, unverified: 2).headline
                == "6/9 claims supported · 1 contradicted · 2 not checked"
        )
    }

    @Test
    func anAuditDecodesClaimByClaimAndNullIsNone() throws {
        let audit = try #require(NativeResearchAudit.decode(Data(#"""
        {"audit":{"runId":"rr_1","state":"completed","claims":[
          {"id":"c1","text":"Heat pumps keep working at -15°C.","type":"fact","status":"supported","label":"supported","links":[{"sourceIndex":2,"stance":"supports","strength":0.82,"passage":"Rated output holds down to -15°C.","locator":null,"codedReasons":[]}]},
          {"id":"c2","text":"Installs take a day.","type":"fact","status":"unverified","label":"unverified","links":[]}
        ],"sources":[],"summary":{"claims":2,"supported":1,"partiallySupported":0,"unsupported":0,"contradicted":0,"unverified":1,"duplicateSources":0}}}
        """#.utf8)))
        #expect(audit.claims.count == 2)
        #expect(audit.evidence(forSource: 2).map(\.link.passage) == ["Rated output holds down to -15°C."])
        #expect(audit.evidence(forSource: 1).isEmpty)
        #expect(NativeResearchAudit.verdict("partially supported") == "Partly supported")
        #expect(NativeResearchAudit.verdict("unverified") == "Not checked")
        #expect(NativeResearchAudit.decode(Data(#"{"audit":null}"#.utf8)) == nil)
    }
}
