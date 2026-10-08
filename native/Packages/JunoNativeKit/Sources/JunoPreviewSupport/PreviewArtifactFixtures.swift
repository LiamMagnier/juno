#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoStorage
import JunoSync

/// A conversation that made a spreadsheet, a document and a deck — the
/// semantic artifact types — with their stored rows, plus canned answers for
/// the lifecycle routes (history, a version's body, duplicate, download,
/// Recently deleted, restore).
///
/// Open it with `--juno-preview-conversation conv-deliverables`; the
/// artifacts list (`--juno-preview-tab artifacts`) shows the three rows and
/// its Recently Deleted.
public enum PreviewArtifactFixtures {
    public static let conversationID = "conv-deliverables"

    struct Fixture {
        let id: String
        let identifier: String
        let type: String
        let title: String
        /// Oldest first.
        let versions: [String]
    }

    static let workbookV1 = #"""
    {"kind":"spreadsheet","version":1,"title":"Q3 budget","sheets":[{"name":"Budget","cells":{"A1":{"v":"Line","bold":true},"B1":{"v":"Jul","bold":true},"A2":{"v":"Rent"},"B2":{"v":2400}},"columns":{},"freeze":{"rows":1,"cols":0},"tables":[],"charts":[]}],"names":{}}
    """#

    static let workbook = #"""
    {"kind":"spreadsheet","version":1,"title":"Q3 budget","sheets":[
    {"name":"Budget","cells":{
    "A1":{"v":"Line","bold":true},"B1":{"v":"Jul","bold":true},"C1":{"v":"Aug","bold":true},"D1":{"v":"Sep","bold":true},"E1":{"v":"Quarter","bold":true},"F1":{"v":"Share","bold":true},
    "A2":{"v":"Rent"},"B2":{"v":2400,"fmt":"\"$\"#,##0"},"C2":{"v":2400,"fmt":"\"$\"#,##0"},"D2":{"v":2400,"fmt":"\"$\"#,##0"},"E2":{"f":"SUM(B2:D2)","fmt":"\"$\"#,##0"},"F2":{"f":"E2/E$7","fmt":"0.0%"},
    "A3":{"v":"Payroll"},"B3":{"v":18500,"fmt":"\"$\"#,##0"},"C3":{"v":18500,"fmt":"\"$\"#,##0"},"D3":{"v":21000,"fmt":"\"$\"#,##0"},"E3":{"f":"SUM(B3:D3)","fmt":"\"$\"#,##0"},"F3":{"f":"E3/E$7","fmt":"0.0%"},
    "A4":{"v":"Software"},"B4":{"v":1240,"fmt":"\"$\"#,##0"},"C4":{"v":1310,"fmt":"\"$\"#,##0"},"D4":{"v":1310,"fmt":"\"$\"#,##0"},"E4":{"f":"SUM(B4:D4)","fmt":"\"$\"#,##0"},"F4":{"f":"E4/E$7","fmt":"0.0%"},
    "A5":{"v":"Marketing"},"B5":{"v":3000,"fmt":"\"$\"#,##0"},"C5":{"v":4500,"fmt":"\"$\"#,##0"},"D5":{"v":6000,"fmt":"\"$\"#,##0"},"E5":{"f":"SUM(B5:D5)","fmt":"\"$\"#,##0"},"F5":{"f":"E5/E$7","fmt":"0.0%"},
    "A6":{"v":"Travel"},"B6":{"v":800,"fmt":"\"$\"#,##0"},"C6":{"v":0,"fmt":"\"$\"#,##0"},"D6":{"v":1900,"fmt":"\"$\"#,##0"},"E6":{"f":"SUM(B6:D6)","fmt":"\"$\"#,##0"},"F6":{"f":"E6/E$7","fmt":"0.0%"},
    "A7":{"v":"Total","bold":true},"B7":{"f":"SUM(B2:B6)","fmt":"\"$\"#,##0","bold":true},"C7":{"f":"SUM(C2:C6)","fmt":"\"$\"#,##0","bold":true},"D7":{"f":"SUM(D2:D6)","fmt":"\"$\"#,##0","bold":true},"E7":{"f":"SUM(E2:E6)","fmt":"\"$\"#,##0","bold":true},"F7":{"f":"E7/E7","fmt":"0.0%"},
    "A9":{"v":"Runway (months)"},"B9":{"f":"ROUND(Cash/(E7/3),1)"}
    },"columns":{"A":{"width":18}},"freeze":{"rows":1,"cols":1},"tables":[],"charts":[]},
    {"name":"Assumptions","cells":{"A1":{"v":"Cash on hand","bold":true},"B1":{"v":412000,"fmt":"\"$\"#,##0"}},"columns":{"A":{"width":16}},"freeze":{"rows":0,"cols":0},"tables":[],"charts":[]}
    ],"names":{"Cash":"Assumptions!$B$1"}}
    """#

    static let document = #"""
    {"kind":"document","version":1,"title":"Launch plan","metadata":{},"styles":{},
    "sources":[{"id":"src1","title":"State of Notes Apps 2026","url":"https://example.com/notes-2026","publisher":"Example Research"}],
    "blocks":[
    {"id":"b1","type":"heading","level":1,"text":"Field Notes launch plan"},
    {"id":"b2","type":"paragraph","style":"lead","text":"We launch on **October 21** with a two-week waitlist and a public beta for everyone on it."},
    {"id":"b3","type":"heading","level":2,"text":"Why now"},
    {"id":"b4","type":"paragraph","text":"Note-taking apps grew 18% this year, and most of that growth came from people switching, not first-time users [@src1]."},
    {"id":"b5","type":"list","ordered":true,"items":[{"text":"Open the waitlist on October 7","level":0},{"text":"Invite the first 2,000 on October 14","level":0},{"text":"Public beta on October 21","level":0},{"text":"Press embargo lifts at 9:00 PT","level":1}]},
    {"id":"b6","type":"callout","tone":"warning","title":"Risk","text":"Sync must hold at 10× today's load before invitations go out."},
    {"id":"b7","type":"table","header":["Milestone","Owner","Date"],"rows":[["Waitlist","Maya","Oct 7"],["Invites","Sam","Oct 14"],["Beta","Liam","Oct 21"]],"caption":"Owners and dates"}
    ],
    "comments":[{"id":"c1","blockId":"b4","author":"Maya","text":"Can we cite the switching number directly?","createdAt":"2026-10-06T10:00:00.000Z"}],
    "revisions":[{"id":"r1","blockId":"b2","kind":"replace","text":"We launch on **October 21** with a two-week waitlist.","author":"Alevr","createdAt":"2026-10-06T11:00:00.000Z","status":"pending"}]}
    """#

    static let deck = #"""
    {"kind":"presentation","version":1,"title":"Q3 review",
    "theme":{"headingFont":"Calibri","bodyFont":"Calibri","background":"#FFFFFF","text":"#1F2328","accent":"#2F6FEB","muted":"#6E7781"},
    "master":{"slideNumbers":true},
    "slides":[
    {"id":"s1","layout":"title","title":"Q3 review","subtitle":"Field Notes · October 2026","elements":[]},
    {"id":"s2","layout":"content","title":"Highlights","elements":[{"type":"text","id":"e1","region":"body","paragraphs":[{"text":"Weekly actives up 32%","level":0,"bullet":true},{"text":"Sync failures down to 0.04%","level":0,"bullet":true},{"text":"Two enterprise pilots signed","level":0,"bullet":true},{"text":"Both renew in January","level":1,"bullet":true}]}],"notes":"Lead with the actives number; it is the one the board asked about."},
    {"id":"s3","layout":"content","title":"Revenue by month","elements":[{"type":"chart","id":"e2","chartType":"column","categories":["Jul","Aug","Sep"],"series":[{"name":"2026","values":[42,51,63]},{"name":"2025","values":[30,33,35]}],"showLegend":true}]},
    {"id":"s4","layout":"two-column","title":"Next quarter","elements":[{"type":"text","id":"e3","region":"left","paragraphs":[{"text":"Ship","level":0,"bold":true},{"text":"Shared notebooks","level":0,"bullet":true},{"text":"iPad handwriting","level":0,"bullet":true}]},{"type":"text","id":"e4","region":"right","paragraphs":[{"text":"Hire","level":0,"bold":true},{"text":"Two sync engineers","level":0,"bullet":true},{"text":"A designer","level":0,"bullet":true}]}]}
    ]}
    """#

    static let fixtures: [Fixture] = [
        Fixture(id: "art-sheet", identifier: "q3-budget", type: "SPREADSHEET", title: "Q3 budget", versions: [workbookV1, workbook]),
        Fixture(id: "art-doc", identifier: "launch-plan", type: "DOCUMENT", title: "Launch plan", versions: [document]),
        Fixture(id: "art-deck", identifier: "q3-review", type: "PRESENTATION", title: "Q3 review", versions: [deck]),
    ]

    private static func payload(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private static func compact(_ body: String) -> String {
        body.split(separator: "\n").joined()
    }

    static func tag(_ fixture: Fixture) -> String {
        "<juno:artifact identifier=\"\(fixture.identifier)\" type=\"\(fixture.type.lowercased())\" title=\"\(fixture.title)\">"
            + compact(fixture.versions.last ?? "") + "</juno:artifact>"
    }

    /// The conversation, its two messages and the three stored artifacts.
    static func records(
        _ a: StorageAccountID,
        iso: (TimeInterval) -> String = PreviewFixtures.iso
    ) -> [StoredRecord] {
        var out: [StoredRecord] = []
        out.append(PreviewFixtures.record(a, "conversation", conversationID, 3, payload([
            "id": conversationID, "title": "Q3 planning pack", "model": "anthropic:claude-sonnet-4-6",
            "kind": "chat", "pinned": false, "archivedAt": NSNull(),
            "createdAt": iso(-4000), "updatedAt": iso(-3000), "lastMessageAt": iso(-3000),
        ])))
        out.append(PreviewFixtures.record(a, "message", "msg-d1", 1, payload([
            "id": "msg-d1", "conversationId": conversationID, "role": "user",
            "content": "Put together the Q3 pack: the budget as a spreadsheet, the launch plan as a document, and a short review deck.",
            "createdAt": iso(-3100),
        ])))
        let answer = "Here's the pack. The budget totals each line and its share of the quarter; the plan carries Maya's open question; the deck is four slides.\n\n"
            + fixtures.map(tag).joined(separator: "\n\n")
        out.append(PreviewFixtures.record(a, "message", "msg-d2", 1, payload([
            "id": "msg-d2", "conversationId": conversationID, "role": "assistant", "content": answer,
            "model": "anthropic:claude-sonnet-4-6", "promptTokens": 6200, "completionTokens": 4100,
            "costMicroUsd": 38000, "createdAt": iso(-3000),
        ])))
        for fixture in fixtures {
            out.append(PreviewFixtures.record(a, "artifact", fixture.id, 2, payload([
                "id": fixture.id, "conversationId": conversationID, "messageId": "msg-d2",
                "identifier": fixture.identifier, "title": fixture.title, "type": fixture.type,
                "language": NSNull(), "currentVersion": fixture.versions.count,
                "createdAt": iso(-3000), "updatedAt": iso(-3000 + Double(fixture.versions.count) * 60),
            ])))
            for (index, body) in fixture.versions.enumerated() {
                out.append(PreviewFixtures.record(a, "artifact_version", "\(fixture.id)-v\(index + 1)", 1, payload([
                    "id": "\(fixture.id)-v\(index + 1)", "artifactId": fixture.id, "version": index + 1,
                    "content": compact(body), "createdAt": iso(-3000 + Double(index) * 60),
                ])))
            }
        }
        return out
    }

    // MARK: Routes

    private static func artifactObject(_ fixture: Fixture, id: String? = nil, title: String? = nil) -> [String: Any] {
        let versions = fixture.versions.enumerated().map { index, body -> [String: Any] in
            ["version": index + 1, "content": compact(body), "origin": index == 0 ? "generated" : "edit",
             "createdAt": PreviewFixtures.iso(-3000 + Double(index) * 60)]
        }
        return [
            "id": id ?? fixture.id, "identifier": fixture.identifier, "type": fixture.type,
            "title": title ?? fixture.title, "language": NSNull(), "currentVersion": fixture.versions.count,
            "content": compact(fixture.versions.last ?? ""), "versions": versions, "messageId": "msg-d2",
            "createdAt": PreviewFixtures.iso(-3000), "updatedAt": PreviewFixtures.iso(-2900),
        ]
    }

    private static var deleted: [String: Any] {
        [
        "id": "art-deck-old", "identifier": "board-deck", "title": "Board deck (draft)", "type": "PRESENTATION",
        "language": NSNull(), "version": 3, "conversationId": NSNull(), "conversationTitle": NSNull(),
        "projectId": NSNull(), "derivedFromId": NSNull(),
        "createdAt": PreviewFixtures.iso(-400000), "updatedAt": PreviewFixtures.iso(-200000),
        "deletedAt": PreviewFixtures.iso(-86400), "purgeAt": PreviewFixtures.iso(86400 * 29), "preview": NSNull(),
        ]
    }

    /// A canned body for an artifact route, or nil when the path is not one
    /// of these fixtures'.
    static func response(for request: NativeBearerRequest) -> HTTPResponse? {
        let parts = request.path.split(separator: "/").map(String.init)
        guard parts.count >= 2, parts[0] == "api", parts[1] == "artifacts" else { return nil }
        func json(_ object: [String: Any], status: Int = 200) -> HTTPResponse? {
            let body = Data(payload(object).utf8)
            return HTTPResponse(
                statusCode: status,
                headers: try! HTTPHeaders(["content-type": "application/json"]),
                body: body
            )
        }
        if parts.count == 2 {
            let deletedList = request.queryItems.contains { $0.name == "deleted" && $0.value == "1" }
            return json(["items": deletedList ? [deleted] : []])
        }
        let id = parts[2]
        if parts.count == 4, parts[3] == "restore", id == "art-deck-old", let source = fixtures.last {
            return json(["artifact": artifactObject(source, id: id, title: "Board deck (draft)")])
        }
        guard let fixture = fixtures.first(where: { $0.id == id }) else { return nil }
        switch parts.count {
        case 3:
            return json(["artifact": artifactObject(fixture)])
        case 4 where parts[3] == "export":
            let format = ["SPREADSHEET": "xlsx", "DOCUMENT": "docx", "PRESENTATION": "pptx"][fixture.type] ?? "xlsx"
            return json(["formats": [format]])
        case 4 where parts[3] == "duplicate":
            return json(["artifact": artifactObject(fixture, id: "\(id)-copy", title: "\(fixture.title) (copy)"),
                         "url": "/a/\(id)-copy"], status: 201)
        case 4 where parts[3] == "download":
            let zip = request.queryItems.contains { $0.name == "format" && $0.value == "zip" }
            let name = zip ? "\(fixture.title).zip" : "\(fixture.title).json"
            return HTTPResponse(
                statusCode: 200,
                headers: try! HTTPHeaders([
                    "content-type": zip ? "application/zip" : "application/json",
                    "content-disposition": "attachment; filename=\"\(name)\"",
                ]),
                body: zip ? Data([0x50, 0x4B, 0x05, 0x06] + Array(repeating: 0, count: 18)) : Data(compact(fixture.versions.last ?? "").utf8)
            )
        case 4 where parts[3] == "versions":
            let rows = fixture.versions.indices.reversed().map { index -> [String: Any] in
                ["version": index + 1, "origin": index == 0 ? "generated" : "edit",
                 "createdAt": PreviewFixtures.iso(-3000 + Double(index) * 60)]
            }
            return json(["currentVersion": fixture.versions.count, "draft": NSNull(), "versions": rows, "nextBefore": NSNull()])
        case 5 where parts[3] == "versions":
            guard let number = Int(parts[4]), fixture.versions.indices.contains(number - 1) else { return nil }
            return json(["version": [
                "version": number, "origin": number == 1 ? "generated" : "edit",
                "content": compact(fixture.versions[number - 1]),
                "createdAt": PreviewFixtures.iso(-3000 + Double(number - 1) * 60),
            ]])
        default:
            return nil
        }
    }
}
#endif
