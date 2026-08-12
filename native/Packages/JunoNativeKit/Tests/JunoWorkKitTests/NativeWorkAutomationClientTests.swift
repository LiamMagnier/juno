import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

final class NativeWorkAutomationClientTests: XCTestCase {
    private let account = try! AccountID("account-automation")

    func testListPreservesUnknownTriggerAndBuildsBoundedQuery() async throws {
        let transport = AutomationTransport(routes: [
            "/api/work/schedules": Self.response(scheduleListJSON)
        ])
        let client = NativeWorkAutomationClient(sender: transport)

        let schedules = try await client.schedules(
            limit: 500,
            enabled: true,
            sessionID: "session-1",
            for: account
        )

        XCTAssertEqual(schedules.count, 1)
        let schedule = try XCTUnwrap(schedules.first)
        XCTAssertEqual(schedule.name, "Morning brief")
        XCTAssertEqual(schedule.triggers.last?.kind, "future_trigger")
        XCTAssertTrue(schedule.hasUnknownTrigger)
        XCTAssertEqual(schedule.triggers.last?.config["source"]?.stringValue, "new-service")
        XCTAssertEqual(schedule.budget.maxTokens, 12_000)
        XCTAssertEqual(schedule.model, "openai:gpt-5")

        let requests = await transport.recordedRequests()
        let request: NativeBearerRequest = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.queryItems.first?.value, "100")
        XCTAssertEqual(request.queryItems.first?.name, "limit")
        XCTAssertEqual(request.queryItems[1].value, "true")
        XCTAssertEqual(request.queryItems[2].value, "session-1")
    }

    func testCreateSendsFullScheduleContract() async throws {
        let transport = AutomationTransport(routes: [
            "/api/work/schedules": Self.response(scheduleEnvelopeJSON, status: 201)
        ])
        let client = NativeWorkAutomationClient(sender: transport)
        let draft = NativeWorkScheduleDraft(
            name: "Inbox sweep",
            instructions: "Sort messages and prepare a summary.",
            timezone: "Europe/Paris",
            target: .local,
            hostID: "host-1",
            triggers: [
                NativeWorkScheduleTriggerDraft(
                    kind: "daily",
                    config: ["hour": .number(8), "minute": .number(30)],
                    dedupeWindowSeconds: 900
                )
            ],
            budget: NativeWorkScheduleBudget(
                maxCostMicroUSD: 250_000,
                maxTokens: 12_000,
                maxRuntimeMilliseconds: 90_000
            ),
            model: "openai:gpt-5",
            requiredCapabilities: ["local_files"]
        )

        _ = try await client.create(draft, for: account)
        let requests = await transport.recordedRequests()
        let request: NativeBearerRequest = try XCTUnwrap(requests.first)
        let body: Data = try XCTUnwrap(request.body)
        let root: JunoJSONValue = try XCTUnwrap(try? JSONDecoder().decode(JunoJSONValue.self, from: body))
        guard case .object(let object) = root else {
            return XCTFail("Expected an object body")
        }
        XCTAssertEqual(object["target"]?.stringValue, "local")
        XCTAssertEqual(object["hostId"]?.stringValue, "host-1")
        XCTAssertEqual(object["model"]?.stringValue, "openai:gpt-5")
        XCTAssertEqual(object["budget"]?.objectValue?["maxTokens"]?.numberValue, 12_000)
        XCTAssertEqual(object["requiredCapabilities"]?.arrayValue?.first?.stringValue, "local_files")
        XCTAssertEqual(object["triggers"]?.arrayValue?.first?.objectValue?["kind"]?.stringValue, "daily")
    }

    func testPatchCanExplicitlyClearHost() async throws {
        let transport = AutomationTransport(routes: [
            "/api/work/schedules/schedule-1": Self.response(scheduleEnvelopeJSON)
        ])
        let client = NativeWorkAutomationClient(sender: transport)
        var draft = NativeWorkScheduleDraft(name: "Cloud now", instructions: "Do the work")
        draft.target = .cloud
        draft.hostID = nil

        _ = try await client.update(id: "schedule-1", draft, for: account)
        let requests = await transport.recordedRequests()
        let request: NativeBearerRequest = try XCTUnwrap(requests.first)
        let body: Data = try XCTUnwrap(request.body)
        let root: JunoJSONValue = try XCTUnwrap(try? JSONDecoder().decode(JunoJSONValue.self, from: body))
        let hostValue: JunoJSONValue = try XCTUnwrap(root.objectValue?["hostId"])
        XCTAssertEqual(hostValue, JunoJSONValue.null)
        XCTAssertEqual(request.method, .patch)
    }

    func testRunNowCarriesIdempotencyKeyAndDecodesSelection() async throws {
        let transport = AutomationTransport(routes: [
            "/api/work/schedules/schedule-1/run-now": Self.response(runNowJSON)
        ])
        let client = NativeWorkAutomationClient(sender: transport)

        let result = try await client.runNow(
            id: "schedule-1",
            idempotencyKey: "juno-work-schedule-key-1",
            for: account
        )

        XCTAssertEqual(result.run.id, "run-1")
        XCTAssertEqual(result.run.status, "queued")
        XCTAssertEqual(result.selection.target, "local")
        XCTAssertEqual(result.selection.hostID, "host-1")
        XCTAssertTrue(result.replay)
        let nextRunAt: Date = try XCTUnwrap(result.nextRunAt)
        XCTAssertEqual(nextRunAt.timeIntervalSince1970, 1_796_091_200, accuracy: 0.001)

        let requests = await transport.recordedRequests()
        let request: NativeBearerRequest = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/work/schedules/schedule-1/run-now")
        let body = try XCTUnwrap(request.body)
        let root = try XCTUnwrap(try? JSONDecoder().decode(JunoJSONValue.self, from: body))
        XCTAssertEqual(root.objectValue?["idempotencyKey"]?.stringValue, "juno-work-schedule-key-1")
    }

    func testHostileScheduleIDNeverReachesTransport() async throws {
        let transport = AutomationTransport()
        let client = NativeWorkAutomationClient(sender: transport)

        do {
            _ = try await client.runNow(id: "../other", idempotencyKey: "safe-key-1", for: account)
            XCTFail("Expected an invalid identifier")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .invalidIdentifier)
        }
        let requests = await transport.recordedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    private static func response(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private actor AutomationTransport: NativeAuthenticatedRequestSending {
    let routes: [String: HTTPResponse]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: HTTPResponse] = [:]) {
        self.routes = routes
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        return routes[request.path]
            ?? HTTPResponse(
                statusCode: 500,
                headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
    }

    func recordedRequests() -> [NativeBearerRequest] {
        requests
    }
}

private let scheduleListJSON = #"""
{
  "schedules": [
    {
      "id": "schedule-1",
      "sessionId": "session-1",
      "name": "Morning brief",
      "enabled": true,
      "instructions": "Summarise the inbox.",
      "instructionsVersion": 2,
      "target": "automatic",
      "hostId": null,
      "timezone": "Europe/Paris",
      "runConfig": {"model":"openai:gpt-5","requiredCapabilities":["web_search"]},
      "runConfigVersion": 1,
      "budget": {"maxCostMicroUsd":1000,"maxTokens":12000,"maxRuntimeMs":90000},
      "unattendedPolicy": "pause_for_approval",
      "hostOfflinePolicy": "skip",
      "maxConcurrentRuns": 1,
      "notifyPolicy": "on_attention",
      "missedRunPolicy": "run_once",
      "retryPolicy": {},
      "lastRunAt": null,
      "nextRunAt": "2026-08-13T07:00:00.000Z",
      "legacyScheduledTaskId": null,
      "createdAt": "2026-08-01T07:00:00.000Z",
      "updatedAt": "2026-08-01T07:00:00.000Z",
      "triggers": [
        {"id":"trigger-1","kind":"daily","config":{"hour":9,"minute":0},"configVersion":1,"enabled":true,"lastFiredAt":null,"dedupeWindowSec":0},
        {"id":"trigger-2","kind":"future_trigger","config":{"source":"new-service"},"configVersion":3,"enabled":true,"lastFiredAt":null,"dedupeWindowSec":60}
      ]
    }
  ]
}
"""#

private let scheduleEnvelopeJSON = #"""
{
  "schedule": {
    "id": "schedule-1", "sessionId": "session-1", "name": "Inbox sweep", "enabled": true,
    "instructions": "Do the work", "instructionsVersion": 1, "target": "cloud", "hostId": null,
    "timezone": "Europe/Paris", "runConfig": {}, "runConfigVersion": 1,
    "budget": {"maxCostMicroUsd":0,"maxTokens":0,"maxRuntimeMs":0},
    "unattendedPolicy":"pause_for_approval", "hostOfflinePolicy":"skip", "maxConcurrentRuns":1,
    "notifyPolicy":"on_attention", "missedRunPolicy":"run_once", "retryPolicy":{},
    "lastRunAt":null, "nextRunAt":"2026-08-14T07:00:00.000Z", "legacyScheduledTaskId":null,
    "createdAt":"2026-08-01T07:00:00.000Z", "updatedAt":"2026-08-01T07:00:00.000Z",
    "triggers":[{"id":"trigger-1","kind":"daily","config":{"hour":9,"minute":0},"configVersion":1,"enabled":true,"lastFiredAt":null,"dedupeWindowSec":0}]
  }
}
"""#

private let runNowJSON = #"""
{
  "run": {"id":"run-1","sessionId":"session-1","scheduleId":"schedule-1","origin":"manual","status":"queued","requestedTarget":"local","effectiveTarget":"local","hostId":"host-1","createdAt":"2026-08-12T08:00:00.000Z","startedAt":null,"finishedAt":null},
  "selection": {"target":"local","hostId":"host-1","explanation":"Pinned to your Mac.","missing":[],"degradation":[]},
  "nextRunAt":"2026-12-01T02:13:20.000Z",
  "replay":true
}
"""#

private extension JunoJSONValue {
    var objectValue: [String: JunoJSONValue]? {
        guard case .object(let object) = self else { return nil }
        return object
    }

    var arrayValue: [JunoJSONValue]? {
        guard case .array(let array) = self else { return nil }
        return array
    }
}
