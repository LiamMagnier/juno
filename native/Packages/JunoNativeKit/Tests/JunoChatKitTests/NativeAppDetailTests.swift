import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoChatKit

/// An app's details: standing grants and their revocation, and last used
/// (`app-detail-sheet.tsx`, `/api/approvals/grants`, `/api/connectors/usage`).
final class NativeAppDetailTests: XCTestCase {
    private let account = try! AccountID("account-apps")

    private let gmail = NativeConnector(
        id: "composio:gmail", slug: "gmail", source: .composio, kind: "composio_app",
        label: "Gmail", detail: "", connected: true, configured: true
    )

    func testGrantsAndUsageDecodeTheRoutesShapes() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/approvals/grants": .json(grantsJSON),
            "GET /api/connectors/usage": .json(usageJSON),
        ])
        let client = NativeAppAccessClient(sender: transport)

        let grants = try await client.grants(for: account)
        XCTAssertEqual(grants.map(\.id), ["g1", "g2", "g3"], "a row without a connector is dropped")
        XCTAssertEqual(grants[0].action, "Send an email")
        XCTAssertEqual(grants[0].scopeLine, "Allowed everywhere")
        XCTAssertEqual(grants[1].scopeLine, "Allowed in one project")
        XCTAssertEqual(grants[2].action, "github_create_issue", "no action falls back to the tool")

        let usage = try await client.usage(for: account)
        XCTAssertEqual(usage.count, 2)
        XCTAssertEqual(usage["composio:gmail"]?.conversationTitle, "Weekly plan")
        XCTAssertNil(usage["github"]?.conversationID)
    }

    @MainActor
    func testModelMatchesTheAppBySlugAndRevokesBackToAskFirst() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/approvals/grants": .json(grantsJSON),
            "GET /api/connectors/usage": .json(usageJSON),
            "DELETE /api/approvals/grants/g1": .json(#"{"revoked":true}"#),
        ])
        let model = NativeAppDetailModel(connector: gmail, client: NativeAppAccessClient(sender: transport), accountID: account)
        XCTAssertNil(model.grants)
        XCTAssertEqual(model.usage, .loading)

        await model.load()
        XCTAssertEqual(model.grants?.map(\.id), ["g1", "g2"], "gmail and composio:gmail both match; github does not")
        guard case .loaded(let usage) = model.usage else { return XCTFail("usage not loaded") }
        XCTAssertEqual(usage?.toolName, "GMAIL_SEND_EMAIL")

        await model.revoke(try XCTUnwrap(model.grants?.first))
        XCTAssertEqual(model.grants?.map(\.id), ["g2"])
        XCTAssertNil(model.grantError)
        let recorded = await transport.recorded()
        let revoke = try XCTUnwrap(recorded.last)
        XCTAssertEqual(revoke.method, .delete)
        XCTAssertEqual(revoke.path, "/api/approvals/grants/g1")
    }

    @MainActor
    func testFailedRevokeKeepsTheGrantAndSaysSo() async throws {
        let transport = MemoryTransport(routes: [
            "GET /api/approvals/grants": .json(grantsJSON),
            "GET /api/connectors/usage": .json(#"{"usage":{}}"#),
            "DELETE /api/approvals/grants/g1": .json(#"{"error":"boom"}"#, status: 500),
        ])
        let model = NativeAppDetailModel(connector: gmail, client: NativeAppAccessClient(sender: transport), accountID: account)
        await model.load()
        XCTAssertEqual(model.usage, .loaded(nil), "never used reads as loaded-and-empty")
        await model.revoke(try XCTUnwrap(model.grants?.first))
        XCTAssertEqual(model.grants?.count, 2)
        XCTAssertEqual(model.grantError, "Couldn’t change that. It still runs without asking; try again.")
    }

    @MainActor
    func testUnreachableRoutesReadAsNothingRatherThanForever() async throws {
        let transport = MemoryTransport(routes: [:])
        let model = NativeAppDetailModel(connector: gmail, client: NativeAppAccessClient(sender: transport), accountID: account)
        await model.load()
        XCTAssertEqual(model.grants, [])
        XCTAssertEqual(model.usage, .loaded(nil))
    }

    func testUsedWhenReadsLikeTheWeb() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_GB")
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-08T15:00:00Z"))
        func used(_ iso: String, chat: String? = nil, title: String? = nil) throws -> NativeConnectorUsage {
            NativeConnectorUsage(
                at: try XCTUnwrap(ISO8601DateFormatter().date(from: iso)), toolName: "GMAIL_SEND_EMAIL",
                conversationID: chat, conversationTitle: title
            )
        }
        XCTAssertEqual(try used("2026-10-08T09:05:00Z").when(now: now, calendar: calendar, locale: locale), "Today at 09:05")
        XCTAssertEqual(try used("2026-10-07T23:30:00Z").when(now: now, calendar: calendar, locale: locale), "Yesterday at 23:30")
        XCTAssertEqual(try used("2026-10-03T18:40:00Z").when(now: now, calendar: calendar, locale: locale), "3 October at 18:40")
        XCTAssertEqual(try used("2025-12-24T08:00:00Z").when(now: now, calendar: calendar, locale: locale), "24 December 2025 at 08:00")
        XCTAssertEqual(
            try used("2026-10-08T09:05:00Z", chat: "c1", title: "Weekly plan").line(now: now, calendar: calendar, locale: locale),
            "Today at 09:05, GMAIL_SEND_EMAIL in Weekly plan"
        )
        XCTAssertEqual(
            try used("2026-10-08T09:05:00Z", chat: "c1", title: "").line(now: now, calendar: calendar, locale: locale),
            "Today at 09:05, GMAIL_SEND_EMAIL in a chat"
        )
        XCTAssertEqual(
            try used("2026-10-08T09:05:00Z").line(now: now, calendar: calendar, locale: locale),
            "Today at 09:05, GMAIL_SEND_EMAIL"
        )
    }

    func testIdentifiersCoverSlugForms() {
        XCTAssertEqual(NativeAppDetailModel.identifiers(for: gmail), ["composio:gmail", "gmail"])
    }
}

private let grantsJSON = #"""
{"grants":[
  {"id":"g1","connectorId":"composio:gmail","projectId":null,"toolName":"GMAIL_SEND_EMAIL","action":"Send an email","maxRiskClass":"write","createdAt":"2026-10-01T10:00:00.000Z"},
  {"id":"g2","connectorId":"gmail","projectId":"p1","toolName":"GMAIL_CREATE_DRAFT","action":"Create a draft","maxRiskClass":"write","createdAt":"2026-09-30T10:00:00.000Z"},
  {"id":"g3","connectorId":"github","projectId":null,"toolName":"github_create_issue","createdAt":"2026-09-29T10:00:00.000Z"},
  {"id":"g4","toolName":"orphan"}
]}
"""#

private let usageJSON = #"""
{"usage":{
  "composio:gmail":{"at":"2026-10-08T09:05:00.000Z","toolName":"GMAIL_SEND_EMAIL","access":"write","conversationId":"c1","conversationTitle":"Weekly plan"},
  "github":{"at":"2026-10-02T09:05:00.000Z","toolName":"github_search","access":"read","conversationId":null,"conversationTitle":null},
  "broken":{"toolName":"x"}
}}
"""#
