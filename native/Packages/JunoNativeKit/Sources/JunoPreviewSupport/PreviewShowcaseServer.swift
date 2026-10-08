#if DEBUG
import Foundation

/// The product-shot account's server answers for the pages a capture opens:
/// Maya's library and her Orbit roster. Only under `--juno-preview-scenario
/// showcase`; every other scenario keeps the harness's own bodies.
enum PreviewShowcaseServer {
    static var isActive: Bool {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--juno-preview-scenario"), index + 1 < arguments.count
        else { return false }
        return arguments[index + 1] == "showcase"
    }

    static func body(path: String, method: String, query: [URLQueryItem] = []) -> Data? {
        guard isActive, method == "GET" else { return nil }
        if path == "/api/library" { return Data(library.utf8) }
        if path == "/api/agents" { return Data(agents.utf8) }
        if path == "/api/research" {
            // The research chat's own list (and the completion watcher's live
            // list); every other chat has none.
            let conversation = query.first { $0.name == "conversationId" }?.value
            let live = query.contains { $0.name == "live" }
            return Data((conversation == "conv-research" || live ? researchList : #"{"runs":[]}"#).utf8)
        }
        if path == "/api/research/rr_heat_live" { return Data(researchRun.utf8) }
        return nil
    }

    private static func iso(_ offset: TimeInterval) -> String {
        PreviewShowcaseConversation.iso(offset)
    }

    private static var library: String {
        let files: [(String, String, String, Int, TimeInterval)] = [
            ("lib-1", "Field Notes 2.0 press kit.pdf", "application/pdf", 4_812_000, -2 * 3_600),
            ("lib-2", "Launch email — final.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 48_200, -5 * 3_600),
            ("lib-3", "Beta survey results.csv", "text/csv", 212_000, -26 * 3_600),
            ("lib-4", "Q3 metrics.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 96_400, -3 * 86_400),
            ("lib-5", "Brand guidelines.pdf", "application/pdf", 12_400_000, -9 * 86_400),
            ("lib-6", "Pricing page draft.md", "text/markdown", 8_900, -12 * 86_400),
            ("lib-7", "Investor update — September.pdf", "application/pdf", 1_240_000, -32 * 86_400),
        ]
        let items = files.map { file in
            #"{"id":"\#(file.0)","fileName":"\#(file.1)","mimeType":"\#(file.2)","size":\#(file.3),"kind":"FILE","createdAt":"\#(iso(file.4))","conversationId":null,"projectId":null}"#
        }.joined(separator: ",")
        return #"{"items":[\#(items)],"attachments":[],"counts":{"all":7,"IMAGE":0,"FILE":7},"total":7,"storage":{"usedBytes":18816400,"quotaBytes":5368709120}}"#
    }

    private static var agents: String {
        let roster: [(String, String, String, String, String)] = [
            ("ag-iris", "Iris", "Research lead", "working", "Reading three reports on solid-wall insulation."),
            ("ag-theo", "Theo", "Inbox and calendar", "waiting", "Waiting for you to approve two replies."),
            ("ag-nora", "Nora", "Launch copy", "idle", "Finished the launch email this morning."),
        ]
        let rows = roster.enumerated().map { index, agent in
            #"{"id":"\#(agent.0)","name":"\#(agent.1)","role":"\#(agent.2)","conversationId":"conv-\#(agent.0)","status":"active","sortOrder":\#(index),"createdAt":"\#(iso(-40 * 86_400))","updatedAt":"\#(iso(-3_600))","state":"\#(agent.3)","stateSentence":"\#(agent.4)","needsYou":\#(agent.3 == "waiting" ? 2 : 0)}"#
        }.joined(separator: ",")
        return #"{"agents":[\#(rows)]}"#
    }

    // MARK: Research

    private static var researchList: String {
        #"{"runs":[{"id":"rr_heat_live","conversationId":"conv-research","state":"investigating","phase":"reading","live":true,"createdAt":"\#(iso(-255))","title":"Heat pumps in a 1930s solid-wall semi","goal":"\#(PreviewShowcaseConversation.researchQuestion)"}]}"#
    }

    /// A deep research four minutes in: its plan, what it is reading, what it
    /// has found, the sources so far and the steer Maya gave it.
    private static var researchRun: String {
        #"""
        {"run":{"id":"rr_heat_live","conversationId":"conv-research","goal":"\#(PreviewShowcaseConversation.researchQuestion)",
         "state":"investigating","title":"Heat pumps in a 1930s solid-wall semi","phase":"reading",
         "phaseDetail":{"domain":"historicengland.org.uk"},
         "plan":{"approach":"Compare what government and trade bodies publish on costs and grants with what installers and owners of pre-war homes report, then check what solid walls change.",
          "objectives":[
           {"id":"o1","question":"Will a heat pump keep a solid-wall semi warm in January?","status":"covered"},
           {"id":"o2","question":"What does an install cost after grants?","status":"partially_covered"},
           {"id":"o3","question":"Do solid walls rule it out?","status":"searching"},
           {"id":"o4","question":"How do running costs compare with gas?"}
          ]},
         "counts":{"found":12,"read":6,"cited":0,"searches":9,"pages":6},
         "workingMs":252000,"createdAt":"\#(iso(-255))",
         "latestFindings":[
          {"id":"f1","claim":"Most 1930s semis need two or three larger radiators rather than a full refit once the loft is insulated.","quote":"","url":"https://energysavingtrust.org.uk/advice/air-source-heat-pumps/","title":"Air source heat pumps"},
          {"id":"f2","claim":"The Boiler Upgrade Scheme takes £7,500 off an air source install in England and Wales.","quote":"","url":"https://www.gov.uk/apply-boiler-upgrade-scheme","title":"Boiler Upgrade Scheme"}
         ],
         "sources":[
          {"id":"s1","url":"https://energysavingtrust.org.uk/advice/air-source-heat-pumps/","title":"Air source heat pumps — Energy Saving Trust","read":true},
          {"id":"s2","url":"https://www.gov.uk/apply-boiler-upgrade-scheme","title":"Apply for the Boiler Upgrade Scheme — GOV.UK","read":true},
          {"id":"s3","url":"https://historicengland.org.uk/advice/technical-advice/retrofit-and-energy-efficiency-in-historic-buildings/","title":"Retrofit in older homes — Historic England","read":true},
          {"id":"s4","url":"https://www.ofgem.gov.uk/energy-price-cap","title":"Energy price cap — Ofgem","read":false}
         ],
         "steering":[{"text":"Focus on England; the house is in Leeds.","appliedAtRound":null}]},
         "events":[],"lastSeq":41,"maxSeq":41}
        """#
    }
}
#endif
