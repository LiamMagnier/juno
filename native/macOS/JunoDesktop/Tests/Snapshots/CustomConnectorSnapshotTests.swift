import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI
import Testing

@testable import JunoDesktop

/// Bring your own MCP server, drawn offscreen in both appearances: the
/// Connections grid with custom tiles and the add tile, the add sheet's two
/// steps and a refusal, and the manage sheet signed in and signed out.
///
/// Off by default: set `JUNO_CUSTOM_MCP_SNAPSHOT_DIR` (through xcodebuild, as
/// `TEST_RUNNER_JUNO_CUSTOM_MCP_SNAPSHOT_DIR`) and the suite writes
/// `<dir>/<name>-<light|dark>.png`. Sample data only, served by a canned
/// sender through the real clients and models.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_CUSTOM_MCP_SNAPSHOT_DIR"] != nil,
        "Set JUNO_CUSTOM_MCP_SNAPSHOT_DIR to render the custom MCP server snapshots."
    ),
    .serialized
)
struct CustomConnectorSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_CUSTOM_MCP_SNAPSHOT_DIR"]!)
    }

    nonisolated static let names = [
        "custom-mcp-grid",
        "custom-mcp-add-address",
        "custom-mcp-add-refused",
        "custom-mcp-add-ready",
        "custom-mcp-add-existing",
        "custom-mcp-manage",
        "custom-mcp-manage-signed-out",
    ]

    @Test(arguments: names)
    func draws(_ name: String) async throws {
        let account = try AccountID("account-custom-mcp-snapshots")
        let model = NativeConnectorModel(client: NativeConnectorClient(sender: CustomMCPSnapshotSender()))
        await model.start(for: account)

        let view: AnyView
        var width: CGFloat = 520
        switch name {
        case "custom-mcp-grid":
            width = 1040
            view = AnyView(DesktopConnectionsScreen(model: model).frame(height: 820).junoAccentTint())
        case "custom-mcp-add-address":
            let draft = try #require(model.makeCustomConnectorDraft())
            view = AnyView(sheet(DesktopAddServerSheet(draft: draft, signIn: { _ in }, close: {})))
        case "custom-mcp-add-refused":
            let draft = try #require(model.makeCustomConnectorDraft())
            draft.address = "https://notes.example.com/mcp"
            await draft.check()
            view = AnyView(sheet(DesktopAddServerSheet(draft: draft, signIn: { _ in }, close: {})))
        case "custom-mcp-add-ready":
            let draft = try #require(model.makeCustomConnectorDraft())
            draft.address = "https://mcp.linear.app/mcp"
            await draft.check()
            view = AnyView(sheet(DesktopAddServerSheet(draft: draft, signIn: { _ in }, close: {})))
        case "custom-mcp-add-existing":
            let draft = try #require(model.makeCustomConnectorDraft())
            draft.address = "https://docs.acme.dev/mcp"
            await draft.check()
            view = AnyView(sheet(DesktopAddServerSheet(draft: draft, signIn: { _ in }, close: {})))
        case "custom-mcp-manage":
            let editor = try #require(model.makeCustomConnectorEditor(id: "mcp:lin0000001"))
            await editor.load()
            view = AnyView(sheet(DesktopManageServerSheet(editor: editor, signIn: { _ in }, close: {})))
        case "custom-mcp-manage-signed-out":
            let editor = try #require(model.makeCustomConnectorEditor(id: "mcp:doc0000002"))
            await editor.load()
            view = AnyView(sheet(DesktopManageServerSheet(editor: editor, signIn: { _ in }, close: {})))
        default:
            Issue.record("Unknown shot \(name)")
            return
        }

        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                view,
                name: name,
                width: width,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }

    /// A sheet as it sits over the dimmed page: its own ground, on a margin
    /// of the canvas so the edge is visible in both appearances.
    private func sheet<V: View>(_ content: V) -> some View {
        content
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .padding(JunoSpace.section)
            .frame(maxWidth: .infinity)
            .junoAccentTint()
    }
}

/// The routes the two sheets and the grid read, answered with sample data.
private struct CustomMCPSnapshotSender: NativeAuthenticatedRequestSending {
    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        let key = "\(request.method.rawValue) \(request.path)"
        let body: String
        switch key {
        case "GET /api/connectors":
            body = directory
        case "GET /api/connectors/composio/catalog":
            body = #"{"items":[{"slug":"gmail","name":"Gmail","logo":null,"connected":false,"noAuth":false,"managedAuth":true},{"slug":"slack","name":"Slack","logo":null,"connected":false,"noAuth":false,"managedAuth":true}],"cursor":null,"categories":[]}"#
        case "POST /api/connectors/custom/probe":
            let sent = String(decoding: request.body ?? Data(), as: UTF8.self)
            if sent.contains("linear") {
                body = #"{"ok":true,"url":"https://mcp.linear.app/mcp","host":"mcp.linear.app","authHost":"linear.app","suggestedName":"Linear","existing":null}"#
            } else if sent.contains("acme") {
                body = #"{"ok":true,"url":"https://docs.acme.dev/mcp","host":"docs.acme.dev","authHost":"auth.acme.dev","suggestedName":"Acme Docs","existing":{"id":"mcp:doc0000002","name":"Acme Docs"}}"#
            } else {
                body = #"{"ok":false,"url":"https://notes.example.com/mcp","reason":"no_oauth","message":"This server doesn’t sign in with OAuth, so Juno can’t connect to it. Servers that take an API key aren’t supported yet."}"#
            }
        case "GET /api/connectors/custom/mcp%3Alin0000001":
            body = #"{"connector":\#(linear)}"#
        case "GET /api/connectors/custom/mcp%3Adoc0000002":
            body = #"{"connector":\#(docs)}"#
        default:
            body = #"{"error":"not_found"}"#
            return HTTPResponse(statusCode: 404, headers: HTTPHeaders(), body: Data(body.utf8))
        }
        return HTTPResponse(statusCode: 200, headers: HTTPHeaders(), body: Data(body.utf8))
    }
}

private let directory = #"""
{"connectors":[
  {"id":"github","kind":"oauth_app","label":"GitHub","description":"Pull requests, issues, and code browsing.","capability":"Let the model read your repositories.","configured":true,"connected":true,"accountLabel":"maya-okafor"},
  {"id":"notion","kind":"oauth_app","label":"Notion","description":"Search and read pages across your workspace.","capability":"Let the model search and read your pages.","configured":true,"connected":false,"accountLabel":null},
  {"id":"mcp:lin0000001","kind":"custom_mcp","label":"Linear","description":"Issues, projects and cycles","capability":"Let the model use the tools on mcp.linear.app.","configured":true,"connected":true,"accountLabel":"mcp.linear.app","url":"https://mcp.linear.app/mcp","toolCount":5},
  {"id":"mcp:doc0000002","kind":"custom_mcp","label":"Acme Docs","description":"MCP server at docs.acme.dev","capability":"Let the model use the tools on docs.acme.dev.","configured":true,"connected":false,"accountLabel":"docs.acme.dev","url":"https://docs.acme.dev/mcp","toolCount":null}
],"composioConfigured":true}
"""#

private let linear = #"""
{"id":"mcp:lin0000001","name":"Linear","url":"https://mcp.linear.app/mcp","host":"mcp.linear.app","description":"Find, create and update issues, projects and cycles in your Linear workspace.","serverName":"linear","connected":true,"connectedAt":"2026-09-27T10:00:00.000Z","disabledTools":["delete_issue"],"tools":[
  {"name":"list_issues","title":"List issues","description":"Issues matching a filter, newest first.","access":"read"},
  {"name":"get_issue","title":"Get issue","description":"One issue with its comments and history.","access":"read"},
  {"name":"search_documents","description":"Full-text search across project documents.","access":"read"},
  {"name":"create_issue","title":"Create issue","description":"Files a new issue in a team.","access":"write"},
  {"name":"update_issue","title":"Update issue","description":"Changes an issue’s state, assignee, labels or estimate.","access":"write"},
  {"name":"delete_issue","title":"Delete issue","description":"Moves an issue to the trash.","access":"unknown"}
],"toolsCheckedAt":"2026-09-27T10:00:01.000Z","createdAt":"2026-09-27T09:59:00.000Z"}
"""#

private let docs = #"""
{"id":"mcp:doc0000002","name":"Acme Docs","url":"https://docs.acme.dev/mcp","host":"docs.acme.dev","description":null,"serverName":null,"connected":false,"connectedAt":null,"disabledTools":[],"tools":null,"toolsCheckedAt":null,"createdAt":"2026-09-27T09:00:00.000Z"}
"""#
