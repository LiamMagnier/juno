#if DEBUG
import Foundation
import JunoStorage
import JunoSync

/// Builds realistic in-memory fixtures for the UI Preview harness. Everything
/// here is synthetic — no real account data is ever read or written.
public enum PreviewFixtures {
    private static let base = Date(timeIntervalSince1970: 1_753_000_000)

    private static func iso(_ offset: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: base.addingTimeInterval(offset))
    }

    private static func record(
        _ accountID: StorageAccountID,
        _ namespace: String,
        _ id: String,
        _ revision: UInt64,
        _ json: String
    ) -> StoredRecord {
        StoredRecord(
            accountID: accountID,
            key: RecordKey(namespace: namespace, id: id),
            revision: revision,
            updatedAt: base,
            payload: Data(json.utf8)
        )
    }

    private static let loremLong = String(
        repeating: "Juno keeps the reasoning transparent and the answer concise. ",
        count: 60
    )

    /// The account settings row every scenario carries so Settings is populated.
    private static func settings(_ accountID: StorageAccountID) -> StoredRecord {
        record(accountID, "settings", "settings-preview", 3, """
        {"id":"settings-preview","theme":"SYSTEM","accent":"coral","defaultModel":"anthropic:claude-sonnet-4-6","customInstructions":"Prefer clear, structured answers with short paragraphs.","responseLanguage":"English","uiLocale":"auto","personality":"concise","memoryEnabled":true,"voiceId":null,"favoriteModels":["anthropic:claude-sonnet-4-6","openai:gpt-5"],"emailBudgetAlerts":true,"emailWeeklyDigest":false,"updatedAt":"\(iso(0))"}
        """)
    }

    private static func memorySummary(_ accountID: StorageAccountID) -> StoredRecord {
        // The store persists the summary under its own namespace/key.
        record(accountID, "native_memory_summary", "summary", 1, """
        {"content":"Works on the Juno native apps. Prefers concise, structured answers. Based in Europe/Paris.","updatedAt":"\(iso(-3600))","entryCount":3}
        """)
    }

    /// Full representative content across every product surface.
    public static func records(
        for scenario: PreviewScenario,
        accountID: StorageAccountID
    ) -> [StoredRecord] {
        switch scenario {
        case .empty, .loading:
            return [settings(accountID)]
        case .manyItems:
            return manyRecords(accountID)
        case .longText:
            return longTextRecords(accountID)
        default:
            return normalRecords(accountID)
        }
    }

    private static func normalRecords(_ a: StorageAccountID) -> [StoredRecord] {
        var out: [StoredRecord] = [settings(a), memorySummary(a)]

        // Conversations (one pinned, one archived, one project-linked).
        out.append(record(a, "conversation", "conv-1", 5, """
        {"id":"conv-1","title":"Designing the native sidebar","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":true,"archivedAt":null,"createdAt":"\(iso(-7200))","updatedAt":"\(iso(-600))","lastMessageAt":"\(iso(-600))"}
        """))
        out.append(record(a, "conversation", "conv-2", 4, """
        {"id":"conv-2","title":"Weekend trip planning","model":"openai:gpt-5","kind":"chat","pinned":false,"archivedAt":null,"createdAt":"\(iso(-86400))","updatedAt":"\(iso(-5400))","lastMessageAt":"\(iso(-5400))"}
        """))
        out.append(record(a, "conversation", "conv-3", 3, """
        {"id":"conv-3","title":"Old brainstorm","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":false,"archivedAt":"\(iso(-172800))","createdAt":"\(iso(-259200))","updatedAt":"\(iso(-172800))","lastMessageAt":"\(iso(-172800))"}
        """))
        out.append(record(a, "conversation", "conv-proj", 6, """
        {"id":"conv-proj","title":"Astro report draft","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":false,"archivedAt":null,"projectId":"proj-1","createdAt":"\(iso(-90000))","updatedAt":"\(iso(-1200))","lastMessageAt":"\(iso(-1200))"}
        """))

        // Messages for conv-1: user + assistant with reasoning.
        out.append(record(a, "message", "msg-1", 1, """
        {"id":"msg-1","conversationId":"conv-1","role":"user","content":"How should the macOS sidebar behave when the window gets narrow?","createdAt":"\(iso(-1200))"}
        """))
        out.append(record(a, "message", "msg-2", 1, """
        {"id":"msg-2","conversationId":"conv-1","role":"assistant","content":"Keep the sidebar resizable with sensible min/max widths, and let NavigationSplitView collapse it automatically at narrow widths. Persist the user's chosen width and the collapsed state across launches.","reasoning":"The user wants native behavior. NavigationSplitView already handles adaptive collapse; the key is persistence and reasonable bounds so the layout never feels cramped.","model":"anthropic:claude-sonnet-4-6","createdAt":"\(iso(-600))"}
        """))
        out.append(record(a, "message", "msg-3", 1, """
        {"id":"msg-3","conversationId":"conv-proj","role":"user","content":"Summarize the latest quasar observations for the report.","createdAt":"\(iso(-1800))"}
        """))
        out.append(record(a, "message", "msg-4", 1, """
        {"id":"msg-4","conversationId":"conv-proj","role":"assistant","content":"The latest observations show variable X-ray brightness consistent with an accreting supermassive black hole. I've grouped them by epoch below.","reasoning":"Grouping by epoch makes the trend legible for a report audience.","model":"anthropic:claude-sonnet-4-6","createdAt":"\(iso(-1200))"}
        """))

        // Projects (one starred).
        out.append(record(a, "project", "proj-1", 8, """
        {"id":"proj-1","name":"Astro research","nameSource":"user","instructions":"Track every quasar observation and keep citations precise.","starred":true,"createdAt":"\(iso(-200000))","updatedAt":"\(iso(-1200))"}
        """))
        out.append(record(a, "project", "proj-2", 4, """
        {"id":"proj-2","name":"Native apps","nameSource":"user","instructions":"Ship the macOS and iOS clients with real backend transport.","starred":false,"createdAt":"\(iso(-400000))","updatedAt":"\(iso(-80000))"}
        """))

        // Files (project + conversation).
        out.append(record(a, "attachment", "file-1", 2, """
        {"id":"file-1","conversationId":null,"messageId":null,"projectId":"proj-1","kind":"FILE","fileName":"quasar-notes.pdf","mimeType":"application/pdf","size":248000,"width":null,"height":null,"createdAt":"\(iso(-150000))"}
        """))
        out.append(record(a, "attachment", "file-2", 2, """
        {"id":"file-2","conversationId":"conv-1","messageId":null,"projectId":null,"kind":"IMAGE","fileName":"sidebar-mock.png","mimeType":"image/png","size":86000,"width":1280,"height":800,"createdAt":"\(iso(-3600))"}
        """))

        // Artifacts + versions.
        out.append(record(a, "artifact", "art-1", 3, """
        {"id":"art-1","conversationId":"conv-proj","messageId":"msg-4","identifier":"brightness-chart","title":"Quasar brightness chart","type":"HTML","language":null,"currentVersion":2,"createdAt":"\(iso(-100000))","updatedAt":"\(iso(-1200))"}
        """))
        out.append(record(a, "artifact_version", "artv-1", 1, """
        {"id":"artv-1","artifactId":"art-1","version":1,"content":"<html><body><h1>v1</h1></body></html>","createdAt":"\(iso(-100000))"}
        """))
        out.append(record(a, "artifact_version", "artv-2", 1, """
        {"id":"artv-2","artifactId":"art-1","version":2,"content":"<html><body><h1>Brightness by epoch</h1><p>Updated.</p></body></html>","createdAt":"\(iso(-1200))"}
        """))

        // Memory entries.
        out.append(record(a, "memory", "mem-1", 2, """
        {"id":"mem-1","content":"Prefers concise, structured answers.","source":"AUTO","kind":"FACT","sourceRef":"conv-1","createdAt":"\(iso(-500000))","updatedAt":"\(iso(-500000))"}
        """))
        out.append(record(a, "memory", "mem-2", 2, """
        {"id":"mem-2","content":"Building the Juno native macOS and iOS apps.","source":"MANUAL","kind":"FACT","sourceRef":"manual","createdAt":"\(iso(-400000))","updatedAt":"\(iso(-400000))"}
        """))
        out.append(record(a, "memory", "mem-3", 2, """
        {"id":"mem-3","content":"Never mention the discontinued beta program.","source":"MANUAL","kind":"SUPPRESSION","sourceRef":"manual","createdAt":"\(iso(-300000))","updatedAt":"\(iso(-300000))"}
        """))
        return out
    }

    private static func manyRecords(_ a: StorageAccountID) -> [StoredRecord] {
        var out: [StoredRecord] = [settings(a), memorySummary(a)]
        for i in 0..<40 {
            out.append(record(a, "conversation", "conv-\(i)", UInt64(i + 1), """
            {"id":"conv-\(i)","title":"Conversation number \(i) about native UI details","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":\(i < 2),"archivedAt":null,"createdAt":"\(iso(-Double(i) * 3600))","updatedAt":"\(iso(-Double(i) * 60))","lastMessageAt":"\(iso(-Double(i) * 60))"}
            """))
        }
        for i in 0..<24 {
            out.append(record(a, "project", "proj-\(i)", UInt64(i + 1), """
            {"id":"proj-\(i)","name":"Project \(i)","nameSource":"user","instructions":"Instructions for project \(i).","starred":\(i % 5 == 0),"createdAt":"\(iso(-Double(i) * 7200))","updatedAt":"\(iso(-Double(i) * 120))"}
            """))
        }
        for i in 0..<30 {
            out.append(record(a, "attachment", "file-\(i)", UInt64(i + 1), """
            {"id":"file-\(i)","conversationId":null,"messageId":null,"projectId":"proj-\(i % 24)","kind":"\(i % 3 == 0 ? "IMAGE" : "FILE")","fileName":"document-\(i).\(i % 3 == 0 ? "png" : "pdf")","mimeType":"\(i % 3 == 0 ? "image/png" : "application/pdf")","size":\(10000 + i * 5000),"width":null,"height":null,"createdAt":"\(iso(-Double(i) * 3600))"}
            """))
        }
        for i in 0..<20 {
            out.append(record(a, "artifact", "art-\(i)", UInt64(i + 1), """
            {"id":"art-\(i)","conversationId":"conv-\(i)","messageId":null,"identifier":"artifact-\(i)","title":"Artifact \(i)","type":"\(["HTML","MARKDOWN","SVG","CODE"][i % 4])","language":\(i % 4 == 3 ? "\"swift\"" : "null"),"currentVersion":1,"createdAt":"\(iso(-Double(i) * 4000))","updatedAt":"\(iso(-Double(i) * 200))"}
            """))
            out.append(record(a, "artifact_version", "artv-\(i)", 1, """
            {"id":"artv-\(i)","artifactId":"art-\(i)","version":1,"content":"Content for artifact \(i).","createdAt":"\(iso(-Double(i) * 4000))"}
            """))
        }
        for i in 0..<25 {
            out.append(record(a, "memory", "mem-\(i)", UInt64(i + 1), """
            {"id":"mem-\(i)","content":"Remembered fact number \(i) about the user's preferences.","source":"\(i % 2 == 0 ? "AUTO" : "MANUAL")","kind":"FACT","sourceRef":"manual","createdAt":"\(iso(-Double(i) * 5000))","updatedAt":"\(iso(-Double(i) * 5000))"}
            """))
        }
        return out
    }

    private static func longTextRecords(_ a: StorageAccountID) -> [StoredRecord] {
        var out: [StoredRecord] = [settings(a), memorySummary(a)]
        out.append(record(a, "conversation", "conv-long", 5, """
        {"id":"conv-long","title":"A deliberately very long conversation title that should truncate gracefully in the sidebar and navigation bar without breaking layout","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":false,"archivedAt":null,"createdAt":"\(iso(-7200))","updatedAt":"\(iso(-600))","lastMessageAt":"\(iso(-600))"}
        """))
        out.append(record(a, "message", "msg-long-1", 1, """
        {"id":"msg-long-1","conversationId":"conv-long","role":"user","content":"\(loremLong)","createdAt":"\(iso(-1200))"}
        """))
        out.append(record(a, "message", "msg-long-2", 1, """
        {"id":"msg-long-2","conversationId":"conv-long","role":"assistant","content":"\(loremLong)\(loremLong)","reasoning":"\(loremLong)","model":"anthropic:claude-sonnet-4-6","createdAt":"\(iso(-600))"}
        """))
        out.append(record(a, "project", "proj-long", 4, """
        {"id":"proj-long","name":"A project whose name is intentionally extremely long to test truncation and wrapping in list rows and detail headers across platforms","nameSource":"user","instructions":"\(loremLong)","starred":true,"createdAt":"\(iso(-200000))","updatedAt":"\(iso(-1200))"}
        """))
        out.append(record(a, "attachment", "file-long", 2, """
        {"id":"file-long","conversationId":null,"messageId":null,"projectId":"proj-long","kind":"FILE","fileName":"an-extremely-long-file-name-that-should-be-truncated-in-the-middle-or-end-without-breaking-the-row-layout.pdf","mimeType":"application/pdf","size":248000,"width":null,"height":null,"createdAt":"\(iso(-150000))"}
        """))
        out.append(record(a, "memory", "mem-long", 2, """
        {"id":"mem-long","content":"\(loremLong)","source":"MANUAL","kind":"FACT","sourceRef":"manual","createdAt":"\(iso(-400000))","updatedAt":"\(iso(-400000))"}
        """))
        return out
    }
}
#endif
