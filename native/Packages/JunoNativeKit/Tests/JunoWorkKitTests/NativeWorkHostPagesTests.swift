import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

/// Phase 4 Stage C: the host detail, update and revoke routes the Permissions
/// pages read, the automation history and fire-token routes, and the web's
/// words for both.
final class NativeWorkHostPagesTests: XCTestCase {
    private let account = try! AccountID("account-hosts")

    // MARK: - Host detail

    func testHostDetailDecodesManifestGrantsAndCounts() async throws {
        let transport = HostTransport(routes: ["/api/work/hosts/host-1": Self.response(hostDetailJSON)])
        let client = NativeWorkClient(transport: transport)

        let detail = try await client.host(id: "host-1", for: account)

        XCTAssertEqual(detail.host.displayName, "Studio Mac")
        XCTAssertEqual(detail.host.platform, "macos")
        XCTAssertEqual(detail.host.appVersion, "1.7.0")
        XCTAssertEqual(detail.host.toggles, [.allowsFileWork, .allowsBrowser])
        XCTAssertTrue(detail.host.allows(.enabled))
        XCTAssertFalse(detail.host.allows(.allowsShell))
        XCTAssertEqual(detail.host.advertisedToggles, [.enabled, .allowsFileWork, .allowsBrowser, .allowsComputerUse])
        XCTAssertEqual(detail.host.approvalPolicy, .balanced)
        XCTAssertEqual(detail.host.advertisedPolicy, .balanced)
        // The manifest's list, read through its object form.
        XCTAssertEqual(detail.host.capabilities, ["local_files", "local_browser", "local_computer_use"])
        XCTAssertEqual(detail.host.allowedApps, ["com.apple.Safari"])
        XCTAssertEqual(detail.host.blockedApps, [])
        XCTAssertEqual(detail.pendingCommands, 2)
        XCTAssertEqual(detail.routableCapabilities, ["local_files", "local_browser"])
        let grants = try XCTUnwrap(detail.grants)
        XCTAssertEqual(grants.map(\.displayName), ["Invoices", "Contracts"])
        XCTAssertEqual(grants.first?.accessMode, "read_write_no_delete")
        XCTAssertNil(grants.first?.lastUsedAt)
        XCTAssertNotNil(grants.last?.revokedAt)
    }

    /// An older server sends neither the pending count nor the routable list,
    /// and a legacy host stores its capabilities as a bare list.
    func testHostDetailIsTolerantOfAnOlderServer() async throws {
        let transport = HostTransport(routes: ["/api/work/hosts/host-2": Self.response(legacyHostJSON)])
        let client = NativeWorkClient(transport: transport)

        let detail = try await client.host(id: "host-2", for: account)

        XCTAssertEqual(detail.pendingCommands, 0)
        XCTAssertEqual(detail.routableCapabilities, [])
        XCTAssertEqual(detail.grants, [])
        XCTAssertEqual(detail.host.capabilities, ["local_files"])
        XCTAssertEqual(detail.host.advertisedToggles, [])
        XCTAssertNil(detail.host.advertisedPolicy)
        XCTAssertNotNil(detail.host.revokedAt)
        // An unreadable ceiling reads as the strictest.
        XCTAssertEqual(detail.host.approvalPolicy, .conservative)
    }

    // MARK: - Update and revoke

    func testUpdateBodiesAreTheRoutesOwnShape() async throws {
        let transport = HostTransport(routes: ["/api/work/hosts/host-1": Self.response(patchedJSON)])
        let client = NativeWorkClient(transport: transport)

        let result = try await client.updateHost(id: "host-1", .toggle(.allowsShell, true), for: account)
        XCTAssertEqual(result.refused, [.allowsShell])
        _ = try await client.updateHost(id: "host-1", NativeWorkHostPatch(approvalPolicy: .conservative), for: account)
        _ = try await client.updateHost(id: "host-1", NativeWorkHostPatch(restore: true), for: account)

        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.count, 3)
        XCTAssertTrue(requests.allSatisfy { $0.method == .patch && $0.path == "/api/work/hosts/host-1" })
        XCTAssertEqual(try body(requests[0]), .object(["allowsShell": .bool(true)]))
        XCTAssertEqual(try body(requests[1]), .object(["approvalPolicy": .string("conservative")]))
        XCTAssertEqual(try body(requests[2]), .object(["revoked": .bool(false)]))
    }

    func testRevokeIsADeleteThatCountsCancelledInstructions() async throws {
        let transport = HostTransport(routes: ["/api/work/hosts/host-1": Self.response(revokedJSON)])
        let client = NativeWorkClient(transport: transport)

        let result = try await client.revokeHost(id: "host-1", for: account)

        XCTAssertEqual(result.cancelledCommands, 3)
        XCTAssertNotNil(result.host.revokedAt)
        let requests = await transport.recordedRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.method, .delete)
        XCTAssertNil(request.body)
    }

    func testAHostileHostIDNeverReachesTheTransport() async throws {
        let transport = HostTransport()
        let client = NativeWorkClient(transport: transport)
        do {
            _ = try await client.revokeHost(id: "../sessions", for: account)
            XCTFail("Expected an invalid identifier")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .invalidIdentifier)
        }
        let requests = await transport.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    // MARK: - The model

    /// This Mac first, then the others as sent, then the revoked ones.
    func testThisMacSortsFirstAndRevokedLast() {
        let hosts = [
            Self.host("a"), Self.host("revoked", revoked: true), Self.host("this"), Self.host("b"),
        ]
        XCTAssertEqual(
            NativeWorkHostsModel.ordered(hosts, thisMac: "this").map(\.hostID),
            ["this", "a", "b", "revoked"]
        )
        XCTAssertEqual(
            NativeWorkHostsModel.ordered(hosts, thisMac: nil).map(\.hostID),
            ["a", "this", "b", "revoked"]
        )
    }

    @MainActor
    func testAFailedRefreshKeepsTheLastAnswers() async throws {
        let transport = HostTransport(routes: ["/api/work/hosts": Self.response(hostListJSON)])
        let model = NativeWorkHostsModel(client: NativeWorkClient(transport: transport))
        await model.start(for: account)
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.hosts.count, 1)

        await transport.set(route: "/api/work/hosts", Self.response(#"{"error":"boom"}"#, status: 503))
        await model.refresh()
        XCTAssertEqual(model.phase, .ready)
        XCTAssertTrue(model.lastRefreshFailed)
        XCTAssertEqual(model.hosts.count, 1)
    }

    @MainActor
    func testAMissingHostAndARefusalAreToldApart() async throws {
        let transport = HostTransport(routes: [
            "/api/work/hosts": Self.response(hostListJSON),
            "/api/work/hosts/gone": Self.response(#"{"error":"Not found"}"#, status: 404),
            "/api/work/hosts/host-1": Self.response(
                #"{"error":"host_revoked","message":"This Mac was revoked. Restore it first."}"#, status: 409
            ),
        ])
        let model = NativeWorkHostsModel(client: NativeWorkClient(transport: transport))
        await model.start(for: account)

        await model.loadHost(id: "gone")
        XCTAssertTrue(model.missingIDs.contains("gone"))

        let outcome = await model.update(id: "host-1", .toggle(.allowsShell, true))
        XCTAssertEqual(outcome, .declined("This Mac was revoked. Restore it first."))
    }

    // MARK: - Automations

    func testHistoryReadsWorkAndCodeRunsTogether() async throws {
        let transport = HostTransport(routes: ["/api/work/schedules/auto-1/runs": Self.response(historyJSON)])
        let client = NativeWorkAutomationClient(sender: transport)

        let history = try await client.history(for: "auto-1", accountID: account)

        XCTAssertEqual(history.runs.map(\.attempt), [3])
        XCTAssertEqual(history.runs.first?.terminalDetail, "The Mac was away, so this fire was skipped.")
        XCTAssertEqual(history.codeRuns.map(\.id), ["task-9"])
        XCTAssertEqual(history.codeRuns.first?.pullRequestURL, "https://github.com/juno/app/pull/12")
        let requests = await transport.recordedRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.queryItems.first?.value, "10")
    }

    func testChangesCarryTheServersSentences() async throws {
        let transport = HostTransport(routes: [
            "/api/work/schedules/auto-1": Self.response(patchedScheduleJSON),
        ])
        let client = NativeWorkAutomationClient(sender: transport)

        let change = try await client.changeEnabled(id: "auto-1", enabled: false, for: account)

        XCTAssertEqual(change.notes, ["Nothing new will start.", "One run already under way carries on."])
        XCTAssertEqual(change.schedule.runKind, "code")
        XCTAssertTrue(change.schedule.isCode)
        XCTAssertFalse(change.schedule.isEditableHere)
        XCTAssertTrue(change.schedule.hasFireToken)
        XCTAssertEqual(change.schedule.codeRepository, "juno/app")
        XCTAssertNotNil(change.schedule.fireTokenIssuedAt)
    }

    func testFireTokensArePostedAndDeleted() async throws {
        let transport = HostTransport(routes: [
            "/api/work/schedules/auto-1/token": Self.response(
                #"{"token":"jfire_abc","issuedAt":"2026-09-20T08:00:00.000Z","url":"/api/work/schedules/auto-1/fire"}"#
            ),
        ])
        let client = NativeWorkAutomationClient(sender: transport)

        let token = try await client.issueFireToken(id: "auto-1", for: account)
        try await client.revokeFireToken(id: "auto-1", for: account)

        XCTAssertEqual(token.token, "jfire_abc")
        XCTAssertEqual(token.url, "/api/work/schedules/auto-1/fire")
        XCTAssertNotNil(token.issuedAt)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.map(\.method), [.post, .delete])
    }

    /// A 4xx with a sentence is the route talking to the reader; a 5xx, a
    /// bare refusal and a 401 get the page's own sentence instead.
    func testOnlyARefusalWithASentenceIsShownAsIs() {
        XCTAssertEqual(
            NativeWorkServerSentence.refusal(
                WorkRemoteError.server(statusCode: 409, message: "That Mac is asleep.", retryable: false)
            ),
            "That Mac is asleep."
        )
        XCTAssertNil(NativeWorkServerSentence.refusal(
            WorkRemoteError.server(statusCode: 503, message: "Upstream down", retryable: true)
        ))
        XCTAssertNil(NativeWorkServerSentence.refusal(
            WorkRemoteError.server(statusCode: 401, message: "Sign in", retryable: false)
        ))
        XCTAssertNil(NativeWorkServerSentence.refusal(
            WorkRemoteError.server(
                statusCode: 400, message: "Juno could not update Work automations (400).", retryable: false
            )
        ))
    }

    // MARK: - The web's words

    func testTriggersAreDescribedAsTheWebDescribesThem() {
        typealias C = NativeWorkScheduleCopy
        XCTAssertEqual(C.describe(kind: "weekly", config: ["weekday": .number(1), "hour": .number(8), "minute": .number(5)]),
                       "Every Monday at 08:05")
        XCTAssertEqual(C.describe(kind: "hourly", config: ["minute": .number(7)]), "Every hour at 07 past")
        XCTAssertEqual(C.describe(kind: "once", config: [
            "year": .number(2026), "month": .number(10), "day": .number(2), "hour": .number(9), "minute": .number(0),
        ]), "Once, on 2 October 2026 at 09:00")
        XCTAssertEqual(C.describe(kind: "email_filter", config: ["from": .array([.string("@stripe.com")])]),
                       "When an email arrives from @stripe.com")
        XCTAssertEqual(C.describe(kind: "api", config: [:]), "When something calls the fire URL")
        XCTAssertEqual(C.describe(kind: "future_kind", config: [:]), "future_kind")
        XCTAssertEqual(C.clockKinds.map(\.kind), ["once", "hourly", "daily", "weekdays", "weekly", "monthly", "yearly", "cron"])
        XCTAssertEqual(C.eventKinds.last?.label, "Something calls it")
    }

    func testTheRowsSentences() {
        typealias C = NativeWorkScheduleCopy
        XCTAssertEqual(C.notifySentence("none"), "No email unless a run gets stuck")
        XCTAssertNil(C.notifySentence("weekly_digest"))
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(C.timeAgo(now.addingTimeInterval(-30), now: now), "just now")
        XCTAssertEqual(C.timeAgo(now.addingTimeInterval(-5 * 60), now: now), "5m ago")
        XCTAssertEqual(C.timeAgo(now.addingTimeInterval(-26 * 3_600), now: now), "yesterday")
        XCTAssertEqual(C.ceiling(""), 0)
        XCTAssertNil(C.ceiling("-1"))
        XCTAssertNil(C.ceiling("ten"))
    }

    func testTheFloorIsTheWebsTenActionsInOrder() {
        XCTAssertEqual(
            NativeWorkPermissionsCopy.alwaysAsks.map(\.action),
            JunoWorkAlwaysConfirmAction.allCases.map(\.rawValue).filter { action in
                NativeWorkPermissionsCopy.alwaysAsks.contains { $0.action == action }
            }
        )
        XCTAssertEqual(NativeWorkPermissionsCopy.alwaysAsks.count, 10)
        XCTAssertEqual(NativeWorkPermissionsCopy.refusal([.allowsShell]),
                       "This Mac has not offered shell commands, so it stays off. Switch it on in Juno on the Mac itself first.")
        XCTAssertEqual(NativeWorkPermissionsCopy.refusal([.allowsBrowser, .allowsShell, .allowsBackground]),
                       "This Mac has not offered your browser, shell commands and working while you are away, so it stays off. Switch it on in Juno on the Mac itself first.")
    }

    // MARK: - Helpers

    private func body(_ request: NativeBearerRequest) throws -> JunoJSONValue {
        try JSONDecoder().decode(JunoJSONValue.self, from: XCTUnwrap(request.body))
    }

    private static func host(_ id: String, revoked: Bool = false) -> WorkHostSummary {
        WorkHostSummary(
            hostID: id, deviceID: "d-\(id)", displayName: id, state: "idle", enabled: true,
            capabilities: [], activeRunCount: 0, queuedRunCount: 0, lastSeenAt: Date(),
            revokedAt: revoked ? Date() : nil
        )
    }

    private static func response(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

/// Answers by path; streams are never opened by these routes.
private actor HostTransport: NativeWorkTransport {
    private var routes: [String: HTTPResponse]
    private var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse] = [:]) {
        self.routes = routes
    }

    func set(route: String, _ response: HTTPResponse) {
        routes[route] = response
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return routes[request.path]
            ?? HTTPResponse(statusCode: 500, headers: HTTPHeaders(), body: Data(#"{"error":"missing fixture"}"#.utf8))
    }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        HTTPByteStreamResponse(
            statusCode: 500,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            bytes: AsyncThrowingStream { $0.finish() }
        )
    }

    func recordedRequests() -> [NativeBearerRequest] {
        requests
    }
}

private let hostDetailJSON = #"""
{
  "host": {
    "id": "host-1", "deviceId": "device-1", "displayName": "Studio Mac", "platform": "macos",
    "appVersion": "1.7.0", "protocolVersion": 3, "enabled": true,
    "allowsFileWork": true, "allowsBrowser": true, "allowsComputerUse": false,
    "allowsShell": false, "allowsBackground": false,
    "capabilities": {
      "toggles": {"enabled": true, "allowsFileWork": true, "allowsBrowser": true, "allowsComputerUse": true, "allowsShell": false},
      "capabilities": ["local_files", "local_browser", "local_computer_use"],
      "approvalPolicy": "balanced"
    },
    "capabilitiesVersion": 1,
    "allowedApps": ["com.apple.Safari", 7], "blockedApps": {}, "allowedDomains": [],
    "approvalPolicy": "balanced", "state": "online", "lastSeenAt": "2026-09-25T08:00:00.000Z",
    "activeRunCount": 1, "queuedRunCount": 0, "revokedAt": null, "futureField": {"a": 1}
  },
  "grants": [
    {"id": "g-1", "kind": "local_folder", "displayName": "Invoices", "accessMode": "read_write_no_delete", "hostId": "host-1", "revokedAt": null, "lastUsedAt": null},
    {"id": "g-2", "kind": "local_folder", "displayName": "Contracts", "accessMode": "read", "hostId": "host-1", "revokedAt": "2026-09-01T08:00:00.000Z", "lastUsedAt": "2026-08-30T08:00:00.000Z"}
  ],
  "pendingCommands": 2,
  "routableCapabilities": ["local_files", "local_browser"]
}
"""#

private let legacyHostJSON = #"""
{
  "host": {
    "id": "host-2", "deviceId": "device-2", "displayName": "Old Mac", "state": "offline",
    "enabled": false, "capabilities": ["local_files"], "approvalPolicy": "yolo",
    "lastSeenAt": "2026-09-01T08:00:00.000Z", "activeRunCount": 0, "queuedRunCount": 0,
    "revokedAt": "2026-09-02T08:00:00.000Z"
  }
}
"""#

private let patchedJSON = #"""
{
  "host": {
    "id": "host-1", "deviceId": "device-1", "displayName": "Studio Mac", "state": "idle",
    "enabled": true, "capabilities": [], "lastSeenAt": "2026-09-25T08:00:00.000Z",
    "activeRunCount": 0, "queuedRunCount": 0, "revokedAt": null
  },
  "refused": ["allowsShell", "somethingNew"]
}
"""#

private let revokedJSON = #"""
{
  "host": {
    "id": "host-1", "deviceId": "device-1", "displayName": "Studio Mac", "state": "idle",
    "enabled": true, "capabilities": [], "lastSeenAt": "2026-09-25T08:00:00.000Z",
    "activeRunCount": 0, "queuedRunCount": 0, "revokedAt": "2026-09-25T09:00:00.000Z"
  },
  "cancelledCommands": 3
}
"""#

private let hostListJSON = #"""
{"hosts": [{"id": "host-1", "deviceId": "device-1", "displayName": "Studio Mac", "state": "idle", "enabled": true, "capabilities": [], "lastSeenAt": "2026-09-25T08:00:00.000Z", "activeRunCount": 0, "queuedRunCount": 0, "revokedAt": null}]}
"""#

private let historyJSON = #"""
{
  "runs": [
    {"id": "run-1", "sessionId": "s-1", "scheduleId": "auto-1", "origin": "schedule", "status": "cancelled",
     "requestedTarget": "local", "effectiveTarget": null, "hostId": null, "attempt": 3,
     "terminalDetail": "The Mac was away, so this fire was skipped.",
     "createdAt": "2026-09-24T07:00:00.000Z", "startedAt": null, "finishedAt": null}
  ],
  "codeRuns": [
    {"id": "task-9", "title": "Bump deps", "status": "done", "conversationId": "conv-9",
     "prUrl": "https://github.com/juno/app/pull/12", "branch": "juno/bump", "createdAt": "2026-09-23T07:00:00.000Z"},
    {"title": "no id, dropped"}
  ]
}
"""#

private let patchedScheduleJSON = #"""
{
  "schedule": {
    "id": "auto-1", "sessionId": "s-1", "name": "Nightly deps", "enabled": false,
    "instructions": "Bump dependencies.", "instructionsVersion": 1, "target": "cloud", "hostId": null,
    "timezone": "Europe/Paris", "runConfig": {}, "runConfigVersion": 1,
    "runKind": "code", "codeConfig": {"repo": {"owner": "juno", "name": "app"}}, "codeConfigVersion": 1,
    "hasFireToken": true, "fireTokenIssuedAt": "2026-09-20T08:00:00.000Z",
    "budget": {"maxCostMicroUsd": 0, "maxTokens": 0, "maxRuntimeMs": 0},
    "unattendedPolicy": "pause_for_approval", "hostOfflinePolicy": "skip", "maxConcurrentRuns": 1,
    "notifyPolicy": "on_attention", "missedRunPolicy": "run_once", "retryPolicy": {},
    "lastRunAt": null, "nextRunAt": null, "legacyScheduledTaskId": null,
    "createdAt": "2026-08-01T07:00:00.000Z", "updatedAt": "2026-09-25T07:00:00.000Z",
    "triggers": [{"id": "t-1", "kind": "api", "config": {"acceptsText": false}, "configVersion": 1, "enabled": true, "lastFiredAt": null, "dedupeWindowSec": 0}]
  },
  "scheduling": "Nothing new will start.",
  "runs": {"explanation": "One run already under way carries on."}
}
"""#
