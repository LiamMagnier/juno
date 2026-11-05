import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoCodeKit

/// The iPhone's Runs screen (REA 8): the list, Stop, and Approve / Deny, with
/// the owner check in front of a high-risk approve.
@MainActor
final class LiveRunsModelTests: XCTestCase {
    private let account = try! AccountID("account-a")
    private let t0 = Date(timeIntervalSince1970: 1_792_400_000)

    // MARK: Decoding

    func testTheSnapshotDecodesBothKindsOfRun() async throws {
        let transport = RunsTransport(responses: [.init(status: 200, body: Self.snapshotJSON)])
        let runs = try await NativeLiveRunsClient(sender: transport).snapshot(for: account)

        XCTAssertEqual(runs.map(\.key), ["code:mac-1:s-1", "work:run-1"])
        let code = runs[0]
        XCTAssertEqual(code.ref, .code(deviceID: "mac-1", sessionID: "s-1"))
        XCTAssertEqual(code.status, .waitingApproval)
        XCTAssertEqual(code.steps, 3)
        XCTAssertEqual(code.currentAction, "Running tests")
        XCTAssertEqual(code.costUSD, 0.42)
        XCTAssertEqual(code.approvals.first?.id, "req-1")
        XCTAssertEqual(code.approvals.first?.requiresOwnerToApprove, true)
        XCTAssertTrue(code.needsYou)

        let work = runs[1]
        XCTAssertEqual(work.ref, .work(runID: "run-1"))
        XCTAssertEqual(work.target, .cloud)
        XCTAssertTrue(work.usesComputer)
        XCTAssertNil(work.costUSD)
        XCTAssertFalse(work.needsYou)
        let requests = await transport.requests
        XCTAssertEqual(requests.first?.path, "/api/runs/live")
    }

    /// One row this build cannot read must not blank the whole screen.
    func testAnUnreadableRowIsSkippedNotFatal() throws {
        let runs = try NativeLiveRunsClient.decodeRuns([
            "runs": .array([
                .object(["key": .string("broken")]),
                try XCTUnwrap(Self.runObject(key: "work:ok", ref: .work(runID: "ok"))),
            ]),
        ])
        XCTAssertEqual(runs.map(\.key), ["work:ok"])
    }

    func testStopAndApprovalBodiesNameTheRunAndTheExactRequest() async throws {
        let transport = RunsTransport(responses: [
            .init(status: 202, body: #"{"outcome":"stop_requested","commandId":"c1"}"#),
            .init(status: 200, body: #"{"approval":{"id":"wa-1"}}"#),
        ])
        let client = NativeLiveRunsClient(sender: transport)
        let outcome = try await client.stop(.code(deviceID: "mac-1", sessionID: "s-1"), for: account)
        XCTAssertEqual(outcome, .requested)
        let approval = LiveRunApproval(
            id: "wa-1", summary: "Pay", risk: "irreversible", highRisk: true,
            actionDigest: String(repeating: "a", count: 64), requestedAt: t0
        )
        try await client.decide(.work(runID: "run-1"), approval: approval, approve: false, for: account)

        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.path), ["/api/runs/stop", "/api/runs/approval"])
        let stopBody = try Self.json(requests[0].body)
        XCTAssertEqual((stopBody["run"] as? [String: String])?["deviceId"], "mac-1")
        let answer = try Self.json(requests[1].body)
        XCTAssertEqual(answer["approvalId"] as? String, "wa-1")
        XCTAssertEqual(answer["approve"] as? Bool, false)
        XCTAssertEqual(answer["actionDigest"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual((answer["run"] as? [String: String])?["runId"], "run-1")
    }

    // MARK: List

    func testRefreshFillsTheListAndReportsTheChange() async throws {
        let service = FakeRuns()
        await service.setSnapshot([run("code:a", approvals: [approval("r1")])])
        let model = LiveRunsModel(client: service)
        var changes: [([String], [String])] = []
        model.onChange = { previous, current in changes.append((previous.map(\.key), current.map(\.key))) }
        model.start(for: account)

        await model.refresh()
        await model.refresh()

        XCTAssertEqual(model.runs.map(\.key), ["code:a"])
        XCTAssertEqual(model.phase, .live)
        XCTAssertEqual(model.pendingApprovalCount, 1)
        XCTAssertEqual(changes.count, 1, "an unchanged snapshot is not a change")
        XCTAssertEqual(changes.first?.1, ["code:a"])
    }

    func testSigningOutForgetsEveryRunAndState() async throws {
        let service = FakeRuns()
        await service.setSnapshot([run("code:a")])
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()
        await model.stop(model.runs[0])

        model.stop()

        XCTAssertTrue(model.runs.isEmpty)
        XCTAssertTrue(model.stopStates.isEmpty)
        XCTAssertEqual(model.phase, .idle)
        XCTAssertFalse(model.isStarted)
    }

    func testARefusalIsFailedButAnOutageIsReconnecting() async throws {
        let service = FakeRuns()
        await service.setSnapshotError(LiveRunsError.server(statusCode: 403, code: "forbidden", message: "No."))
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()
        XCTAssertEqual(model.phase, .failed("No."))

        await service.setSnapshotError(LiveRunsError.server(statusCode: 503, code: nil, message: "Down"))
        await model.refresh()
        XCTAssertEqual(model.phase, .reconnecting)
    }

    // MARK: Stop

    func testStopMovesThroughItsStatesAndASecondPressInFlightIsIgnored() async throws {
        let service = FakeRuns()
        await service.setSnapshot([run("code:a")])
        await service.holdStops()
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()
        let target = model.runs[0]

        let first = Task { await model.stop(target) }
        await service.waitForStopCalls(1)
        XCTAssertEqual(model.stopStates["code:a"], .stopping)
        await model.stop(target)
        let calls = await service.stopCalls
        XCTAssertEqual(calls.count, 1, "a press while one is in flight sends nothing")

        await service.releaseStops(with: .requested)
        await first.value
        XCTAssertEqual(model.stopStates["code:a"], .requested)
    }

    func testAStopOnAFinishedRunReadsStoppedAndTheStateClearsWhenTheRunLeaves() async throws {
        let service = FakeRuns()
        await service.setSnapshot([run("work:w")])
        await service.setStopOutcome(.stopped)
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()
        await model.stop(model.runs[0])
        XCTAssertEqual(model.stopStates["work:w"], .stopped)

        await service.setSnapshot([])
        await model.refresh()
        XCTAssertNil(model.stopStates["work:w"])
    }

    func testAFailedStopSaysWhy() async throws {
        let service = FakeRuns()
        await service.setSnapshot([run("code:a")])
        await service.setStopError(LiveRunsError.server(statusCode: 403, code: "not_paired", message: "Pair this iPhone first."))
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()
        await model.stop(model.runs[0])
        XCTAssertEqual(model.stopStates["code:a"], .failed("Pair this iPhone first."))
    }

    // MARK: Approvals

    func testAHighRiskApproveAsksTheOwnerAndSendsNothingWhenRefused() async throws {
        let service = FakeRuns()
        let risky = approval("r1", risk: "irreversible", high: true)
        await service.setSnapshot([run("work:w", approvals: [risky])])
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()

        var asked = 0
        let sent = await model.decide(risky, on: model.runs[0], approve: true) {
            asked += 1
            return false
        }
        XCTAssertFalse(sent)
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(model.approvalStates["r1"], .idle)
        let decisions = await service.decisions
        XCTAssertTrue(decisions.isEmpty)

        let confirmed = await model.decide(risky, on: model.runs[0], approve: true) { true }
        XCTAssertTrue(confirmed)
        XCTAssertEqual(model.approvalStates["r1"], .sent)
        let after = await service.decisions
        XCTAssertEqual(after.map(\.approve), [true])
    }

    func testARoutineApproveAndAnyDenyDoNotAsk() async throws {
        let service = FakeRuns()
        let routine = approval("r1", risk: "edit", high: false)
        let risky = approval("r2", risk: "command", high: true)
        await service.setSnapshot([run("code:a", approvals: [routine, risky])])
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()

        var asked = 0
        await model.decide(routine, on: model.runs[0], approve: true) { asked += 1; return true }
        await model.decide(risky, on: model.runs[0], approve: false) { asked += 1; return true }
        XCTAssertEqual(asked, 0)
        let decisions = await service.decisions
        XCTAssertEqual(decisions.map(\.id), ["r1", "r2"])
    }

    /// The server's "low" never talks the phone out of asking about a word it
    /// does not know.
    func testAnUnknownRiskWordStillNeedsTheOwner() {
        let odd = approval("r1", risk: "purchase", high: false)
        XCTAssertTrue(odd.requiresOwnerToApprove)
        XCTAssertFalse(approval("r2", risk: "neutral", high: false).requiresOwnerToApprove)
    }

    func testARefusedAnswerIsShownAsRefusedAndASentOneCannotBeSentAgain() async throws {
        let service = FakeRuns()
        let first = approval("r1")
        let second = approval("r2")
        await service.setSnapshot([run("code:a", approvals: [first, second])])
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()

        await model.decide(first, on: model.runs[0], approve: false) { true }
        let again = await model.decide(first, on: model.runs[0], approve: false) { true }
        XCTAssertFalse(again)
        let decisions = await service.decisions
        XCTAssertEqual(decisions.count, 1)

        await service.setDecideError(LiveRunsError.server(statusCode: 409, code: "already_decided", message: "Answered on your Mac."))
        await model.decide(second, on: model.runs[0], approve: true) { true }
        XCTAssertEqual(model.approvalStates["r2"], .refused("Answered on your Mac."))
    }

    func testAnApprovalAnsweredElsewhereLeavesTheListAndItsState() async throws {
        let service = FakeRuns()
        let pending = approval("r1")
        await service.setSnapshot([run("code:a", approvals: [pending])])
        let model = LiveRunsModel(client: service)
        model.start(for: account)
        await model.refresh()
        await model.decide(pending, on: model.runs[0], approve: false) { true }

        await service.setSnapshot([run("code:a")])
        await model.refresh()
        XCTAssertNil(model.approvalStates["r1"])
        XCTAssertEqual(model.pendingApprovalCount, 0)
    }

    func testNewlyPendingApprovalsAreOnlyTheNewOnes() {
        let before = [run("code:a", approvals: [approval("r1")])]
        let after = [
            run("code:a", approvals: [approval("r1"), approval("r2")]),
            run("work:w", approvals: [approval("w1")]),
        ]
        let fresh = LiveRunsModel.newlyPendingApprovals(previous: before, current: after)
        XCTAssertEqual(fresh.map(\.approval.id), ["r2", "w1"])
        XCTAssertEqual(fresh.map(\.run.key), ["code:a", "work:w"])
    }

    // MARK: Live Activity

    func testTheActivityPlanStartsUpdatesAndEndsByRun() {
        let runs = [run("a"), run("b"), run("c")]
        let first = LiveRunActivityPlan.plan(active: [], runs: runs, limit: 2)
        XCTAssertEqual(first.start.map(\.runKey), ["a", "b"])
        XCTAssertTrue(first.end.isEmpty)

        let second = LiveRunActivityPlan.plan(active: ["a", "b"], runs: [run("b"), run("c")], limit: 2)
        XCTAssertEqual(second.end, ["a"], "a run that left the list has finished")
        XCTAssertEqual(second.update.map(\.runKey), ["b"])
        XCTAssertEqual(second.start.map(\.runKey), ["c"])

        let last = LiveRunActivityPlan.plan(active: ["b", "c"], runs: [], limit: 2)
        XCTAssertEqual(last.end, ["b", "c"])
    }

    func testTheActivitySummarySaysWhatTheRunNeeds() {
        XCTAssertEqual(LiveRunActivitySummary(run("a", approvals: [approval("r1")])).statusLine, "Needs your approval")
        XCTAssertEqual(LiveRunActivitySummary(run("a", approvals: [approval("r1"), approval("r2")])).statusLine, "2 approvals waiting")
        XCTAssertEqual(LiveRunActivitySummary(run("a", computer: true)).statusLine, "Using the computer")
        XCTAssertEqual(LiveRunActivitySummary(run("a", online: false)).statusLine, "Mac is offline")
        XCTAssertEqual(LiveRunActivitySummary(run("a", status: .paused)).statusLine, "Paused")
    }

    // MARK: Fixtures

    private func approval(_ id: String, risk: String = "edit", high: Bool = false) -> LiveRunApproval {
        LiveRunApproval(id: id, summary: "Do \(id)", risk: risk, highRisk: high, requestedAt: t0)
    }

    private func run(
        _ key: String, approvals: [LiveRunApproval] = [], status: LiveRunStatus = .running,
        computer: Bool = false, online: Bool = true
    ) -> LiveRun {
        LiveRun(
            key: key, ref: key.hasPrefix("work") ? .work(runID: key) : .code(deviceID: "mac", sessionID: key),
            kind: key.hasPrefix("work") ? .work : .code, title: "Run \(key)", hostName: "Studio",
            target: .mac, status: approvals.isEmpty ? status : .waitingApproval, rawStatus: status.rawValue,
            steps: 2, currentAction: "Reading files", usesComputer: computer, startedAt: t0,
            updatedAt: t0, costUSD: nil, hostOnline: online, canStop: true, approvals: approvals
        )
    }

    private static func runObject(key: String, ref: LiveRunRef) -> JunoJSONValue? {
        .object([
            "key": .string(key), "ref": ref.json, "title": .string("T"),
            "startedAt": .string("2026-10-18T09:00:00.000Z"), "updatedAt": .string("2026-10-18T09:01:00.000Z"),
        ])
    }

    private static func json(_ body: Data?) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any])
    }

    private static let snapshotJSON = """
    {"runs":[
      {"key":"code:mac-1:s-1","ref":{"kind":"code","deviceId":"mac-1","sessionId":"s-1"},"kind":"code",
       "title":"Tidy the README","hostName":"Studio","target":"mac","status":"waiting_approval",
       "rawStatus":"awaiting_approval","steps":3,"currentAction":"Running tests","usesComputer":false,
       "startedAt":"2026-10-18T09:00:00.000Z","updatedAt":"2026-10-18T09:01:00.000Z","costUsd":0.42,
       "hostOnline":true,"canStop":true,
       "approvals":[{"id":"req-1","summary":"Run rm -rf build","detail":null,"risk":"command","highRisk":true,
                     "actionDigest":null,"requestedAt":"2026-10-18T09:00:30.000Z","expiresAt":null}]},
      {"key":"work:run-1","ref":{"kind":"work","runId":"run-1"},"kind":"work","title":"Book flights",
       "hostName":null,"target":"cloud","status":"running","rawStatus":"running","steps":5,
       "currentAction":"Clicking Search","usesComputer":true,"startedAt":"2026-10-18T08:58:00Z",
       "updatedAt":"2026-10-18T09:01:00Z","costUsd":null,"hostOnline":true,"canStop":true,"approvals":[]}
    ],"generatedAt":"2026-10-18T09:01:00.000Z"}
    """
}

// MARK: - Fakes

private actor RunsTransport: NativeAuthenticatedRequestSending {
    struct Canned { let status: Int; let body: String }
    private var responses: [Canned]
    private(set) var requests: [NativeBearerRequest] = []

    init(responses: [Canned]) { self.responses = responses }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let next = responses.isEmpty ? Canned(status: 500, body: "{}") : responses.removeFirst()
        return HTTPResponse(statusCode: next.status, headers: HTTPHeaders(), body: Data(next.body.utf8))
    }
}

private actor FakeRuns: LiveRunsServing {
    struct Decision: Equatable { let id: String; let approve: Bool }

    private var snapshot: [LiveRun] = []
    private var snapshotError: (any Error)?
    private var stopOutcome: LiveRunStopOutcome = .requested
    private var stopError: (any Error)?
    private var decideError: (any Error)?
    private var holding = false
    private var held: [CheckedContinuation<LiveRunStopOutcome, Never>] = []
    private(set) var stopCalls: [LiveRunRef] = []
    private(set) var decisions: [Decision] = []

    func setSnapshot(_ runs: [LiveRun]) { snapshot = runs; snapshotError = nil }
    func setSnapshotError(_ error: any Error) { snapshotError = error }
    func setStopOutcome(_ outcome: LiveRunStopOutcome) { stopOutcome = outcome }
    func setStopError(_ error: any Error) { stopError = error }
    func setDecideError(_ error: any Error) { decideError = error }
    func holdStops() { holding = true }

    func releaseStops(with outcome: LiveRunStopOutcome) {
        holding = false
        for continuation in held { continuation.resume(returning: outcome) }
        held = []
    }

    func waitForStopCalls(_ count: Int) async {
        while stopCalls.count < count { await Task.yield() }
    }

    func snapshot(for _: AccountID) async throws -> [LiveRun] {
        if let snapshotError { throw snapshotError }
        return snapshot
    }

    func stream(for _: AccountID) async throws -> AsyncThrowingStream<[LiveRun], any Error> {
        let runs = snapshot
        return AsyncThrowingStream { continuation in
            continuation.yield(runs)
            continuation.finish()
        }
    }

    func stop(_ ref: LiveRunRef, for _: AccountID) async throws -> LiveRunStopOutcome {
        stopCalls.append(ref)
        if let stopError { throw stopError }
        if holding {
            return await withCheckedContinuation { held.append($0) }
        }
        return stopOutcome
    }

    func decide(_: LiveRunRef, approval: LiveRunApproval, approve: Bool, for _: AccountID) async throws {
        if let decideError { throw decideError }
        decisions.append(Decision(id: approval.id, approve: approve))
    }
}
