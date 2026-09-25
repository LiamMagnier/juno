#if DEBUG
import Foundation
import JunoAPI

/// Canned responses for the Phase 4 Stage B pages — Memory, Skills and
/// Assistants — in their exact wire shapes, so the preview harness and the
/// page snapshots run the real clients' decoders against labelled preview
/// data. Nothing here is a real account's; names and numbers are invented and
/// plausible, never measured.
public enum PreviewAccountPageFixtures {
    /// The body for a request these pages make, or nil for anyone else's.
    public static func body(path: String, method: HTTPMethod, empty: Bool = false) -> Data? {
        if empty {
            switch (method, path) {
            case (.get, "/api/memory"): return Data(#"{"memories":[],"summary":null,"projectSummaries":[]}"#.utf8)
            case (.get, "/api/skills"): return Data(#"{"yours":[],"sources":[],"total":0,"truncated":false}"#.utf8)
            case (.get, "/api/assistants"): return Data(#"{"assistants":[]}"#.utf8)
            default: break
            }
        }
        switch (method, path) {
        case (.get, "/api/memory"): return Data(memoryJSON.utf8)
        case (.get, "/api/memory/edits"): return Data(#"{"edits":[]}"#.utf8)
        case (.get, "/api/memory/backfill"): return Data(#"{"remaining":0}"#.utf8)
        case (.get, "/api/memory/recap"):
            return Data(#"{"days":30,"themes":["Planning the Lisbon offsite","Rewriting the onboarding flow"],"conversations":14}"#.utf8)
        case (.get, "/api/skills"): return Data(skillsJSON.utf8)
        case (.get, "/api/assistants"): return Data(assistantsJSON.utf8)
        default:
            break
        }
        if method == .get, path.hasPrefix("/api/work/skills/"), path.hasSuffix("/versions") {
            return Data(versionsJSON.utf8)
        }
        if method == .get, path.hasPrefix("/api/work/skills/") {
            return Data(skillDetailJSON.utf8)
        }
        return nil
    }

    private static func iso(_ offset: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }

    private static let day: TimeInterval = 86_400

    // MARK: Memory

    public static var memoryJSON: String {
        """
        {
          "memories": [
            \(fact("m1", "Prefers answers with a short summary first, then the detail.", "preferences", "MANUAL", "manual", -2 * day)),
            \(fact("m2", "Writes in British English and uses metric units.", "preferences", "AUTO", "conv-1", -6 * day)),
            \(fact("m3", "Works as a product designer at a small studio in Lisbon.", "identity", "AUTO", "conv-1", -9 * day)),
            \(fact("m4", "Is building Juno, a native Mac and iPhone assistant.", "projects", "AUTO", "conv-2", -1 * day)),
            \(fact("m5", "Uses SwiftUI and Next.js day to day.", "workflows", "AUTO", "conv-2", -12 * day)),
            \(fact("m6", "Wants to ship the Mac redesign before the October release.", "goals", "MANUAL", "manual", -3 * day)),
            \(fact("m7", "Cites sources in APA for the thesis.", "studies", "AUTO", "conv-3", -20 * day, project: ("p-thesis", "Thesis"))),
            \(fact("m8", "Flying to Porto on Friday.", "temporary", "AUTO", "conv-1", -1 * day)),
            \(fact("m9", "Used imperial units.", "preferences", "AUTO", "conv-1", -40 * day, status: "superseded", supersededBy: "m2"))
          ],
          "summary": {
            "content": "Liam is a product designer in Lisbon who is building Juno, a native assistant for the Mac and iPhone.\\n\\n## How he likes answers\\nA short summary first, then the detail. British English and metric units.\\n\\n## What he is working on\\nThe Mac redesign, due before the October release, and a thesis that cites in APA.",
            "updatedAt": "\(iso(-2 * 3600))",
            "entryCount": 8
          },
          "projectSummaries": [
            {"projectId":"p-thesis","projectName":"Thesis","content":"A thesis on interface calm, cited in APA.","updatedAt":"\(iso(-5 * day))","entryCount":1}
          ]
        }
        """
    }

    private static func fact(
        _ id: String,
        _ content: String,
        _ category: String,
        _ source: String,
        _ sourceRef: String,
        _ offset: TimeInterval,
        project: (String, String)? = nil,
        status: String = "active",
        supersededBy: String? = nil
    ) -> String {
        let projectID = project.map { "\"\($0.0)\"" } ?? "null"
        let projectName = project.map { "\"\($0.1)\"" } ?? "null"
        let superseded = supersededBy.map { "\"\($0)\"" } ?? "null"
        return """
        {"id":"\(id)","content":"\(content)","source":"\(source)","kind":"FACT","sourceRef":"\(sourceRef)","createdAt":"\(iso(offset))","category":"\(category)","projectId":\(projectID),"projectName":\(projectName),"sourceMessageId":null,"confidence":0.9,"status":"\(status)","reason":null,"expiresAt":null,"lastUsedAt":"\(iso(offset / 2))","lastVerifiedAt":null,"supersededById":\(superseded),"sensitive":null}
        """
    }

    // MARK: Skills

    public static let skillsJSON = #"""
    {
      "yours": [
        {"id":"skill-invoices","slug":"file-invoices","name":"File the invoices","description":"Sorts incoming invoices into the right folder and renames them.","currentVersion":3,"enabled":true,"trust":"user_authored","autoSelect":true,"securityStatus":"clear","sourceId":null,"sourcePath":null,"requiresConsent":false},
        {"id":"skill-standup","slug":"weekly-standup","name":"Weekly stand-up","description":"Drafts Monday’s stand-up from last week’s chats and tasks.","currentVersion":1,"enabled":true,"trust":"user_authored","autoSelect":false,"securityStatus":"clear","sourceId":null,"requiresConsent":false},
        {"id":"skill-tone","slug":"house-tone","name":"House tone","description":"Rewrites a draft in the studio’s voice.","currentVersion":2,"enabled":false,"trust":"user_authored","autoSelect":false,"securityStatus":"clear","sourceId":null,"requiresConsent":false}
      ],
      "sources": [
        {"id":"src-anthropics","kind":"github","owner":"anthropics","repo":"skills","key":"github:anthropics/skills","ref":"main","path":"","commit":"4f1c2ab9e0","latestCommit":"9a7d3e1c55","enabled":true,"url":"https://github.com/anthropics/skills",
         "skills":[
           {"id":"skill-pdf","slug":"pdf","name":"PDF","description":"Reads, fills and merges PDF files.","currentVersion":1,"enabled":true,"trust":"untrusted","autoSelect":false,"securityStatus":"clear","sourceId":"src-anthropics","sourcePath":"document-skills/pdf/SKILL.md","requiresConsent":false},
           {"id":"skill-xlsx","slug":"xlsx","name":"Spreadsheets","description":"Builds and edits Excel workbooks with formulas.","currentVersion":2,"enabled":true,"trust":"untrusted","autoSelect":false,"securityStatus":"warning","sourceId":"src-anthropics","sourcePath":"document-skills/xlsx/SKILL.md","requiresConsent":true},
           {"id":"skill-brand","slug":"brand-guidelines","name":"Brand guidelines","description":"Applies a brand’s colours and type to a document.","currentVersion":1,"enabled":false,"trust":"untrusted","autoSelect":false,"securityStatus":"clear","sourceId":"src-anthropics","sourcePath":"brand-guidelines/SKILL.md","requiresConsent":false}
         ]},
        {"id":"src-vercel","kind":"github","owner":"vercel-labs","repo":"agent-skills","key":"github:vercel-labs/agent-skills","ref":"main","path":"","commit":"c0ffee1234","latestCommit":null,"enabled":true,"url":"https://github.com/vercel-labs/agent-skills",
         "skills":[
           {"id":"skill-deploy","slug":"deploy-preview","name":"Deploy preview","description":"Explains a failed preview deployment from its logs.","currentVersion":1,"enabled":true,"trust":"untrusted","autoSelect":false,"securityStatus":"blocked","sourceId":"src-vercel","requiresConsent":false}
         ]}
      ],
      "total": 7,
      "truncated": false
    }
    """#

    public static let skillDetailJSON = #"""
    {
      "skill":{"id":"skill-invoices","slug":"file-invoices","name":"File the invoices","description":"Sorts incoming invoices into the right folder and renames them.","currentVersion":3,"enabled":true,"trust":"user_authored","autoSelect":true,"securityStatus":"clear","projectId":null},
      "version":{"id":"ver-3","skillId":"skill-invoices","version":3,"instructions":"# File the invoices\n\nWhen an invoice arrives:\n\n1. Read the supplier and the date from the first page.\n2. Rename it **Supplier – YYYY-MM – Amount**.\n3. Move it to *Finance/Invoices/{year}*.\n\nIf the supplier is new, ask before creating a folder.","contract":{"resourceAttachmentIds":["att-template"]},"requestedTools":["files"],"securityStatus":"clear","securityScan":null,"requiresConsent":false,"createdAt":"2026-09-18T09:30:00.000Z"},
      "resources":[{"attachmentId":"att-template","fileName":"Invoice naming rules.pdf"}],
      "projectName":null,
      "source":null
    }
    """#

    public static let versionsJSON = #"""
    {"versions":[
      {"id":"ver-3","skillId":"skill-invoices","version":3,"instructions":"# File the invoices\nWhen an invoice arrives, read the supplier and the date.","createdAt":"2026-09-18T09:30:00.000Z","securityStatus":"clear","requiresConsent":false},
      {"id":"ver-2","skillId":"skill-invoices","version":2,"instructions":"Rename invoices by supplier and month.","createdAt":"2026-09-02T15:10:00.000Z","securityStatus":"clear","requiresConsent":false},
      {"id":"ver-1","skillId":"skill-invoices","version":1,"instructions":"Move invoices into the Finance folder.","createdAt":"2026-08-21T11:00:00.000Z","securityStatus":"clear","requiresConsent":false}
    ]}
    """#

    // MARK: Assistants

    public static let assistantsJSON = #"""
    {"assistants":[
      {"id":"asst-analyst","slug":"python-data-analyst","name":"Python data analyst","description":"Explores a dataset with pandas and explains the patterns that matter.","avatarIcon":"bot","systemPrompt":"You are a careful data analyst.","starterPrompts":["Analyze this dataset and explain the important patterns.","Plot the weekly trend."],"preferredModelId":"anthropic:claude-opus-4-8","isPinned":true,"version":4},
      {"id":"asst-essay","slug":"essay-coach","name":"Essay coach","description":"Tightens the argument in a student essay without rewriting its voice.","avatarIcon":"bot","systemPrompt":"Coach, do not rewrite.","starterPrompts":["Where is my argument weakest?"],"preferredModelId":null,"isPinned":false,"version":2},
      {"id":"asst-release","slug":"release-notes","name":"Release notes","description":"","avatarIcon":"bot","systemPrompt":"Write release notes from a changelog.","starterPrompts":[],"preferredModelId":"openai:gpt-5-6","isPinned":false,"version":1},
      {"id":"asst-french","slug":"french-tutor","name":"French tutor","description":"Conversation practice at B1, with gentle corrections at the end.","avatarIcon":"bot","systemPrompt":"Tutor in French.","starterPrompts":["Let’s talk about the weekend."],"preferredModelId":null,"isPinned":false,"version":3}
    ]}
    """#
}
#endif
