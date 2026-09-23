import Foundation
import XCTest
@testable import JunoChatKit

final class NativeRunTimelineTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_758_000_000)

    private func event(
        _ id: String,
        _ kind: NativeChatActivity.Kind,
        _ title: String,
        detail: String? = nil,
        at offset: TimeInterval? = nil,
        seq: Int? = nil,
        call: NativeToolCall? = nil,
        segment: NativeReasoningSegment? = nil,
        commentary: NativeRunCommentary? = nil,
        tool: NativeToolDetail? = nil
    ) -> NativeChatActivity {
        NativeChatActivity(
            id: id, kind: kind, title: title, detail: detail, url: nil,
            createdAt: offset.map { start.addingTimeInterval($0) },
            seq: seq, call: call, segment: segment, commentary: commentary, tool: tool
        )
    }

    // MARK: The legacy adapter

    /// Today's rows: a connector call that carries its detail becomes a call;
    /// an approval request is dropped (its outcome is unknown); a warning is a
    /// notice; the reasoning comes first; facts and timing come from the rest.
    func testTheLegacyAdapterReadsTodaysRows() {
        let rows = [
            event("c", .context, "Reading the conversation context", detail: "3 messages", at: 0),
            event("m", .model, "Selected model", detail: "Anthropic · Claude Sonnet 4.6", at: 0.1),
            event("e", .reasoning, "Reasoning mode enabled", detail: "High effort", at: 0.1),
            event("w1", .warning, "Model changed", detail: "Routed to a faster model.", at: 0.2),
            event("t0", .tool, "Linear needs approval", detail: "linear__create_issue", at: 1),
            event("t1", .tool, "Using Linear", detail: "linear__search_issues", at: 2, tool: NativeToolDetail(
                server: "Linear", name: "linear__search_issues", args: "{}", result: "[]", status: "ok", durationMs: 840
            )),
            event("t2", .tool, "Using Linear", detail: "linear__create_issue", at: 3, tool: NativeToolDetail(
                server: "Linear", name: "linear__create_issue", status: "failed"
            )),
            event("v", .visit, "Visited source", detail: "swift.org", at: 4),
            event("wr", .write, "Writing the answer", at: 12.4),
            event("d", .done, "Finished response", at: 19),
        ]
        let view = NativeRunView.build(activity: rows, reasoning: "Thinking it through.", reasoningParts: nil)

        XCTAssertFalse(view.typed)
        XCTAssertEqual(view.items.map(\.id), ["reasoning", "w1", "t1", "t2"])
        XCTAssertEqual(view.calls.map(\.tool), ["mcp", "mcp"])
        XCTAssertEqual(view.calls.map(\.status), [.succeeded, .failed])
        XCTAssertEqual(view.calls.first?.connectorLabel, "Linear")
        XCTAssertEqual(view.calls.first?.toolTitle, "Search issues")
        XCTAssertEqual(view.counts.failedTools, 1)
        XCTAssertEqual(view.counts.warnings, 1)
        XCTAssertEqual(view.counts.connectorsUsed, ["Linear"])
        XCTAssertEqual(view.facts.model, "Anthropic · Claude Sonnet 4.6")
        XCTAssertEqual(view.facts.effort, "High effort")
        XCTAssertEqual(view.facts.context, "3 messages")
        XCTAssertEqual(view.timing.workedMs, 12_400)
    }

    /// Reasoning parts become one item each; a turn with nothing but an answer
    /// has nothing to show.
    func testReasoningPartsAndTheTrivialTurn() {
        let parted = NativeRunView.build(activity: [], reasoning: "a b", reasoningParts: ["First part.", "Second part."])
        XCTAssertEqual(parted.items.map(\.id), ["reasoning-0", "reasoning-1"])
        XCTAssertTrue(parted.hasContent(sourceCount: 0))

        let trivial = NativeRunView.build(activity: [event("wr", .write, "Writing the answer", at: 0.2)], reasoning: nil)
        XCTAssertTrue(trivial.items.isEmpty)
        XCTAssertFalse(trivial.hasContent(sourceCount: 0))
        XCTAssertTrue(trivial.hasContent(sourceCount: 2), "sources alone earn the line")
    }

    // MARK: The typed timeline

    /// With `seq`, the order is the server's, reasoning is sliced by its
    /// segments, commentary stays out of the answer, and calls keep their
    /// records.
    func testTheTypedTimelineIsOrderedBySequence() {
        let reasoning = "Plan the search.Compare the two."
        let search = NativeToolCall(
            callID: "c1", tool: "web_search", status: .succeeded, round: 0,
            figure: NativeToolCall.Figure(kind: "results", n: 8),
            web: NativeToolCall.Web(query: "swift 6 adoption")
        )
        let fetch = NativeToolCall(
            callID: "c2", tool: "web_fetch", status: .running, round: 1,
            web: NativeToolCall.Web(requestedURL: "https://www.swift.org/blog/")
        )
        let rows = [
            event("f", .visit, "Visited source", seq: 4, call: fetch),
            event("s1", .reasoning, "Thinking", seq: 1, segment: NativeReasoningSegment(round: 0, offset: 0)),
            event("k", .search, "Searching the web", seq: 2, call: search),
            event("cm", .reasoning, "Commentary", seq: 3, commentary: NativeRunCommentary(round: 0, text: "Let me check.", inline: true)),
            event("s2", .reasoning, "Thinking", seq: 5, segment: NativeReasoningSegment(round: 1, offset: 16)),
        ]
        let view = NativeRunView.build(activity: rows, reasoning: reasoning)

        XCTAssertTrue(view.typed)
        XCTAssertEqual(view.items.map(\.id), ["s1", "k", "cm", "f", "s2"])
        guard case .reasoning(_, let first) = view.items[0], case .reasoning(_, let second) = view.items[4] else {
            return XCTFail("expected reasoning at both ends")
        }
        XCTAssertEqual(first, "Plan the search.")
        XCTAssertEqual(second, "Compare the two.")
        XCTAssertEqual(view.counts.searches, 1)

        let phase = NativeRunPhase.derive(
            view: view, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: false
        )
        XCTAssertEqual(phase, .reading)
        XCTAssertEqual(
            NativeToolPresentation.liveLabel(phase: phase, view: view, elapsed: 5, recovering: false),
            "Reading swift.org"
        )
    }

    // MARK: Phases

    func testPhasesFollowTheSpecsOrder() {
        let thinking = NativeRunView.build(activity: [], reasoning: "Hmm.")
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: false),
            .thinking
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: true),
            .waiting
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: true, failed: false, finishReason: nil, answerStarted: true, awaitingApproval: false),
            .answering
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: false, failed: false, finishReason: .userStopped, answerStarted: true, awaitingApproval: false),
            .stopped
        )
        XCTAssertEqual(
            NativeRunPhase.derive(view: thinking, live: false, failed: true, finishReason: .error, answerStarted: false, awaitingApproval: false),
            .failed
        )
        let empty = NativeRunView.build(activity: [], reasoning: nil)
        XCTAssertEqual(
            NativeRunPhase.derive(view: empty, live: true, failed: false, finishReason: nil, answerStarted: false, awaitingApproval: false),
            .queued
        )
    }

    /// "Thinking", a provider headline over it, and the escalation rungs as
    /// captions inside the line — never replacing the label (SPEC §7.10).
    func testTheThinkingLadder() {
        let plain = NativeRunView.build(activity: [], reasoning: "Working it out.")
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .thinking, view: plain, elapsed: 4, recovering: false), "Thinking")
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .thinking, view: plain, elapsed: 130, recovering: false), "Thinking")
        XCTAssertEqual(NativeRunPacing.escalation(working: 130), 1)
        XCTAssertEqual(NativeRunPacing.escalation(working: 700), 2)
        XCTAssertEqual(
            NativeToolPresentation.caption(stalledFor: nil, escalation: 2)?.text,
            "Still working. You can leave; the answer will be here."
        )
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .thinking, view: plain, elapsed: 4, recovering: true), "Reconnecting…")
        let headed = NativeRunView.build(activity: [], reasoning: "**Weighing the options**\n\nFirst, the costs.")
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .thinking, view: headed, elapsed: 4, recovering: false), "Weighing the options")
    }

    // MARK: Words

    /// SPEC §7.6.2: "Thought for" when the run reasoned or ran any call,
    /// "Answered in" when neither; at most two facts, in order.
    func testTheSummaryLineGrammar() {
        let thought = NativeRunView.build(activity: [], reasoning: "Hmm.")
        XCTAssertEqual(NativeToolPresentation.summaryLead(thought, workedMs: 12_400)?.text, "Thought for 12s")
        XCTAssertEqual(NativeToolPresentation.summaryLead(thought, workedMs: 64_000)?.text, "Thought for 1m 4s")
        XCTAssertEqual(NativeToolPresentation.summaryLead(thought, workedMs: nil)?.text, "Thought process")
        XCTAssertEqual(NativeToolPresentation.summaryFacts(thought, sourceCount: 5).map(\.text), ["5 sources"])

        let worked = NativeRunView.build(
            activity: [event("t", .tool, "Using Linear", tool: NativeToolDetail(server: "Linear", name: "linear__x", status: "ok"))],
            reasoning: nil
        )
        XCTAssertEqual(NativeToolPresentation.summaryLead(worked, workedMs: 3_000)?.text, "Thought for 3s", "DECISIONS wins: never \"Worked for\"")
        XCTAssertEqual(NativeToolPresentation.summaryFacts(worked, sourceCount: 1).map(\.text), ["1 source", "used Linear"])

        let answered = NativeRunView.build(activity: [], reasoning: nil)
        XCTAssertEqual(NativeToolPresentation.summaryLead(answered, workedMs: 2_000)?.text, "Answered in 2s")

        let code = NativeRunView.build(activity: [
            event("r1", .tool, "Using Run code", seq: 1, call: NativeToolCall(callID: "r1", tool: "run_code", status: .succeeded)),
            event("s1", .search, "Searching the web", seq: 2, call: NativeToolCall(callID: "s1", tool: "web_search", status: .succeeded)),
        ], reasoning: nil)
        XCTAssertEqual(
            NativeToolPresentation.summaryLine(code, workedMs: 12_000, sourceCount: 5).text,
            "Thought for 12s · 5 sources · ran code",
            "the DECISIONS example, exactly"
        )
        XCTAssertEqual(NativeToolPresentation.summaryFacts(code, sourceCount: 0).map(\.text), ["ran code", "1 search"])
    }

    /// SPEC §7.6's table, §7.6.1's failure phrases and the figures.
    func testToolPhrasesAndFailures() {
        let search = NativeToolCall(callID: "a", tool: "web_search", status: .running, web: NativeToolCall.Web(query: "rust async runtimes compared in depth for servers"))
        XCTAssertEqual(NativeToolPresentation.runningLine(search).text, "Searching the web for \u{201C}rust async runtimes compared in depth f…\u{201D}")
        var done = search
        done.status = .succeeded
        XCTAssertTrue(NativeToolPresentation.phrase(done).hasPrefix("Searched the web for"))

        let timeout = NativeToolCall(callID: "b", tool: "web_fetch", status: .failed, timeoutMs: 20_000, args: ["domain": "nature.com"], errorCode: "timeout")
        XCTAssertEqual(NativeToolPresentation.phrase(timeout), "Couldn't open nature.com · Timed out after 20s")
        let denied = NativeToolCall(callID: "c", tool: "mcp", connectorLabel: "GitHub", toolTitle: "Create issue", status: .denied)
        XCTAssertEqual(NativeToolPresentation.phrase(denied), "GitHub · Create issue · You declined this")
        XCTAssertFalse(NativeToolPresentation.readsAsFailure(denied), "a denial is never a failure")
        let running = NativeToolCall(callID: "c2", tool: "mcp", connectorLabel: "GitHub", toolTitle: "Create issue", status: .running)
        XCTAssertEqual(NativeToolPresentation.phrase(running), "GitHub · Create issue")
        var used = running
        used.status = .succeeded
        XCTAssertEqual(NativeToolPresentation.phrase(used), "Used GitHub")

        let code = NativeToolCall(callID: "d", tool: "run_code", status: .succeeded, figure: NativeToolCall.Figure(kind: "files", n: 2))
        XCTAssertEqual(NativeToolPresentation.figure(code), "2 files created")
        let exit = NativeToolCall(callID: "e", tool: "run_code", status: .succeeded, figure: NativeToolCall.Figure(kind: "exit", value: "0"))
        XCTAssertEqual(NativeToolPresentation.figure(exit), "Exit code 0")
        let chars = NativeToolCall(callID: "f", tool: "web_fetch", status: .succeeded, figure: NativeToolCall.Figure(kind: "chars", n: 12_480))
        XCTAssertEqual(NativeToolPresentation.figure(chars), "\(12_480.formatted()) characters")
        let calc = NativeToolCall(callID: "g", tool: "calculate", status: .succeeded, figure: NativeToolCall.Figure(kind: "value", value: "42"))
        XCTAssertEqual(NativeToolPresentation.figure(calc), "Result 42")
        let pages = NativeToolCall(callID: "h", tool: "read_document", status: .running, args: ["action": "read", "file": "Annual report 2025 final version.pdf", "pages": "3–7"])
        XCTAssertEqual(NativeToolPresentation.phrase(pages), "Reading Annual report 2…inal version.pdf · Pages 3–7")
        let task = NativeToolCall(callID: "i", tool: "start_task", status: .succeeded, args: ["title": "Draft the brief"])
        XCTAssertEqual(NativeToolPresentation.phrase(task), "Started a task \u{201C}Draft the brief\u{201D}")
        XCTAssertEqual(NativeToolPresentation.clock(seconds: 64), "1:04")
        XCTAssertEqual(NativeToolPresentation.clock(seconds: 9), "9s")
    }

    /// Every notice code has words, and only the five must-act codes count as
    /// warnings.
    func testNoticeCopy() {
        let codes = [
            "model_changed", "skill_not_applied", "connector_unavailable", "usage_limit", "stall",
            "finish_length", "finish_sensitive", "tool_budget", "web_off_lockdown", "provenance_refused",
            "hostile_content", "search_degraded", "research_skipped", "private_tools_limited", "tools_capped",
        ]
        for code in codes {
            let line = NativeToolPresentation.noticeLine(NativeRunNotice(code: code), title: "LEGACY", detail: nil).text
            XCTAssertFalse(line.isEmpty, code)
            XCTAssertFalse(line.contains("LEGACY"), "\(code) must not fall back to the English title")
        }
        XCTAssertEqual(
            NativeToolPresentation.noticeLine(
                NativeRunNotice(code: "connector_unavailable", params: ["connector": "GitHub", "reason": "auth_expired"]),
                title: "", detail: nil
            ).text,
            "GitHub couldn't connect · Sign in again in Settings"
        )
        XCTAssertEqual(
            NativeToolPresentation.noticeLine(NativeRunNotice(code: "tool_budget", params: ["steps": "10"]), title: "", detail: nil).text,
            "Stopped using tools after 10 steps"
        )
        XCTAssertEqual(NativeRunNotice.mustActCodes, ["finish_length", "usage_limit", "connector_unavailable", "hostile_content", "research_skipped"])
        XCTAssertEqual(NativeToolPresentation.noticeLine(NativeRunNotice(code: "unheard_of"), title: "Old words", detail: nil).text, "Old words")
    }

    /// The live line coalesces reads and searches started together, waits
    /// with the approval, and settles to the summary.
    func testLiveLines() {
        let start = Date(timeIntervalSince1970: 0)
        let reads = NativeRunView.build(activity: [
            event("r1", .visit, "Visited source", seq: 1, call: NativeToolCall(callID: "r1", tool: "web_fetch", status: .running, startedAt: start, args: ["domain": "a.com"])),
            event("r2", .visit, "Visited source", seq: 2, call: NativeToolCall(callID: "r2", tool: "web_fetch", status: .running, startedAt: start.addingTimeInterval(0.4), args: ["domain": "b.com"])),
        ], reasoning: nil)
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .reading, view: reads, elapsed: 2, recovering: false), "Reading 2 sources")
        XCTAssertEqual(NativeToolPresentation.liveLabel(phase: .waiting, view: reads, elapsed: 2, recovering: false), "Waiting for your approval")
        XCTAssertEqual(NativeToolPresentation.stoppedLine(workedMs: 12_000).text, "Stopped after 12s")
        XCTAssertEqual(NativeToolPresentation.failedRunLine(workedMs: 12_000).text, "Couldn't finish · 12s")
        XCTAssertEqual(NativeToolPresentation.caption(stalledFor: 31, escalation: 0)?.text, "No response for 31s")
        XCTAssertEqual(NativeToolPresentation.caption(stalledFor: nil, escalation: 1)?.text, "Still thinking. This can take a few minutes.")
    }

    /// The pacer: a label stays, changes are spaced, the newest wins, and the
    /// settled phases skip the wait.
    func testTheLabelPacer() {
        var pacer = NativeRunLabelPacer()
        let t0 = Date(timeIntervalSince1970: 0)
        XCTAssertTrue(pacer.offer(phase: .thinking, subject: "", now: t0))
        XCTAssertFalse(pacer.offer(phase: .searching, subject: "c1", now: t0.addingTimeInterval(0.3)))
        XCTAssertEqual(pacer.nextCheck(phase: .searching, subject: "c1"), t0.addingTimeInterval(0.7))
        XCTAssertTrue(pacer.offer(phase: .reading, subject: "c2", now: t0.addingTimeInterval(0.8)), "the newest phase wins")
        XCTAssertFalse(pacer.offer(phase: .reading, subject: "c3", now: t0.addingTimeInterval(1.5)), "a new subject waits 1.5s")
        XCTAssertTrue(pacer.offer(phase: .reading, subject: "c3", now: t0.addingTimeInterval(2.4)))
        XCTAssertTrue(pacer.offer(phase: .answering, subject: "", now: t0.addingTimeInterval(2.5)), "settling skips the dwell")
    }
}
