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

    static func body(path: String, method: String) -> Data? {
        guard isActive, method == "GET" else { return nil }
        if path == "/api/library" { return Data(library.utf8) }
        if path == "/api/agents" { return Data(agents.utf8) }
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
}
#endif
