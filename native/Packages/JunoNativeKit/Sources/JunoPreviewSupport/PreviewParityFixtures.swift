#if DEBUG
import Foundation
import JunoAPI

/// Canned answers for the iPhone's parity screens — the inbox, the launch
/// announcement, server search, sign-in security and Routines — in the routes'
/// exact wire shapes, so the preview world runs the real clients' decoders.
/// Names and numbers are invented and plausible, never a real account's.
public enum PreviewParityFixtures {
    /// The body for a request these screens make, or nil for anyone else's.
    public static func body(path: String, method: HTTPMethod, query: [URLQueryItem], empty: Bool = false) -> Data? {
        switch (method, path) {
        case (.get, "/api/notifications"):
            return Data((empty ? #"{"notifications":[],"unreadCount":0,"nextBefore":null}"# : notificationsJSON).utf8)
        case (.get, "/api/notifications/count"):
            return Data((empty ? #"{"unreadCount":0,"urgent":false}"# : #"{"unreadCount":2,"urgent":true}"#).utf8)
        case (.post, "/api/notifications"):
            return Data(#"{"ok":true}"#.utf8)
        case (.get, "/api/announcements"):
            return Data((empty ? #"{"announcement":null}"# : announcementJSON).utf8)
        case (.get, "/api/search"):
            let asked = query.first { $0.name == "q" }?.value ?? ""
            return Data(searchJSON(query: asked, empty: empty).utf8)
        case (.get, "/api/account/mfa"):
            return Data(#"{"enabled":false,"pending":false,"recoveryCodesRemaining":0,"hasPassword":true}"#.utf8)
        case (.get, "/api/work/schedules"):
            return Data((empty ? #"{"schedules":[]}"# : schedulesJSON).utf8)
        default:
            break
        }
        if method == .patch, path.hasPrefix("/api/notifications/") { return Data(#"{"ok":true}"#.utf8) }
        if method == .post, path.hasPrefix("/api/announcements/") { return Data(#"{"ok":true}"#.utf8) }
        if method == .get, path.hasPrefix("/api/work/schedules/"), path.hasSuffix("/runs") {
            return Data(runsJSON.utf8)
        }
        if method == .get, path.hasPrefix("/api/work/schedules/") {
            let one = schedule(
                id: "routine-brief", name: "Morning brief", enabled: true, kind: "weekdays",
                config: #"{"hour":8,"minute":0}"#, next: 0.6, last: -0.4
            )
            return Data(("{\"schedule\":" + one + "}").utf8)
        }
        return nil
    }

    private static let day: TimeInterval = 86_400

    private static func iso(_ offset: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }

    // MARK: Inbox

    static var notificationsJSON: String {
        """
        {
          "notifications": [
            {"id":"pn-1","type":"approval","title":"Iris needs your OK to send the invoice batch","body":"Three invoices to Northwind, €4,180 in total.","priority":"urgent","actionable":true,"href":"/agents/agent-iris","agent":{"id":"agent-iris","name":"Iris","avatar":{"shape":"orb","tone":"sage","eyes":"soft","mark":"none"}},"readAt":null,"createdAt":"\(iso(-12 * 60))"},
            {"id":"pn-2","type":"work","title":"Your competitor scan is ready","body":"Twelve sources, four pricing changes worth a look.","priority":"normal","actionable":false,"href":"/chat/preview-conversation","agent":null,"readAt":null,"createdAt":"\(iso(-3 * 3_600))"},
            {"id":"pn-3","type":"news","title":"Morning brief ran","body":"Weekday routine · 8:00","priority":"low","actionable":false,"href":null,"agent":null,"readAt":"\(iso(-day))","createdAt":"\(iso(-day - 600))"},
            {"id":"pn-4","type":"agent","title":"Atlas finished tidying the Q3 folder","body":"Moved 41 files and flagged 2 duplicates.","priority":"normal","actionable":false,"href":"/agents/agent-atlas","agent":{"id":"agent-atlas","name":"Atlas","avatar":{"shape":"square","tone":"ink","eyes":"wide","mark":"none"}},"readAt":"\(iso(-2 * day))","createdAt":"\(iso(-3 * day))"}
          ],
          "unreadCount": 2,
          "nextBefore": "preview-cursor"
        }
        """
    }

    static let announcementJSON = #"""
    {"announcement":{"id":"preview-launch","title":"A faster Auto","description":"Auto now picks between twelve models and answers simple questions in under a second, without you choosing anything.","imageUrl":null,"videoUrl":null,"provider":"anthropic","modelName":"Claude Opus 4.8","newsLabel":"Read More","newsHref":"https://alevr.com/news","ctaLabel":"Try it","ctaHref":"/chat"}}
    """#

    // MARK: Search

    static func searchJSON(query: String, empty: Bool) -> String {
        let escaped = query.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        guard !empty else {
            return #"{"query":"\#(escaped)","total":0,"partial":false,"groups":[],"coverage":[]}"#
        }
        return """
        {
          "query": "\(escaped)",
          "total": 3,
          "partial": true,
          "groups": [
            {"type":"memory","label":"Memory","hits":[
              {"id":"memory:pm1","type":"memory","title":"Prefers answers with a short summary first","titleMarks":[],"snippet":null,"href":"/memory?entry=pm1","locator":null,"projectId":null,"updatedAt":"\(iso(-2 * day))","score":0.8}
            ]},
            {"type":"knowledge","label":"Knowledge","hits":[
              {"id":"knowledge:pk1","type":"knowledge","title":"Lisbon offsite plan.pdf","titleMarks":[],"snippet":{"text":"…the offsite runs Tuesday to Thursday, with the planning day first…","marks":[]},"href":"/library?doc=pk1","locator":"Page 4","projectId":null,"updatedAt":"\(iso(-5 * day))","score":0.6}
            ]},
            {"type":"work","label":"Tasks","hits":[
              {"id":"work:preview-work","type":"work","title":"Draft the quarterly plan","titleMarks":[],"snippet":{"text":"Pull last quarter’s numbers into a plan.","marks":[]},"href":"/chat/preview-conversation","locator":"Done","projectId":null,"updatedAt":"\(iso(-day))","score":0.5}
            ]}
          ],
          "coverage": [
            {"type":"memory","state":"complete","detail":null},
            {"type":"knowledge","state":"partial","detail":"Two documents are still being indexed."},
            {"type":"work","state":"complete","detail":null}
          ]
        }
        """
    }

    // MARK: Routines

    static func schedule(
        id: String, name: String, enabled: Bool, kind: String, config: String, next: Double?, last: Double?
    ) -> String {
        let nextValue = next.map { "\"\(iso($0 * day))\"" } ?? "null"
        let lastValue = last.map { "\"\(iso($0 * day))\"" } ?? "null"
        return """
        {"id":"\(id)","sessionId":"session-\(id)","name":"\(name)","enabled":\(enabled),"instructions":"Summarise my inbox and calendar for the day ahead, and flag anything that needs a reply before noon.","instructionsVersion":1,"target":"cloud","hostId":null,"timezone":"Europe/Lisbon","runConfig":{},"runConfigVersion":1,"budget":{"maxCostMicroUsd":0,"maxTokens":0,"maxRuntimeMs":0},"unattendedPolicy":"pause_for_approval","hostOfflinePolicy":"skip","maxConcurrentRuns":1,"notifyPolicy":"on_attention","missedRunPolicy":"run_once","retryPolicy":{},"lastRunAt":\(lastValue),"nextRunAt":\(nextValue),"legacyScheduledTaskId":null,"createdAt":"\(iso(-30 * day))","updatedAt":"\(iso(-2 * day))","triggers":[{"id":"trigger-\(id)","kind":"\(kind)","config":\(config),"configVersion":1,"enabled":true,"lastFiredAt":null,"dedupeWindowSec":0}]}
        """
    }

    static var schedulesJSON: String {
        """
        {"schedules":[
          \(schedule(id: "routine-brief", name: "Morning brief", enabled: true, kind: "weekdays", config: #"{"hour":8,"minute":0}"#, next: 0.6, last: -0.4)),
          \(schedule(id: "routine-pricing", name: "Competitor pricing", enabled: true, kind: "weekly", config: #"{"weekday":1,"hour":9,"minute":30}"#, next: 3, last: -4)),
          \(schedule(id: "routine-invoices", name: "Chase unpaid invoices", enabled: false, kind: "monthly", config: #"{"monthday":1,"hour":10,"minute":0}"#, next: nil, last: -20))
        ]}
        """
    }

    static var runsJSON: String {
        """
        {"runs":[
          {"id":"run-p1","sessionId":"session-routine-brief","scheduleId":"routine-brief","origin":"schedule","status":"done","requestedTarget":"cloud","effectiveTarget":"cloud","hostId":null,"createdAt":"\(iso(-0.4 * day))","startedAt":"\(iso(-0.4 * day))","finishedAt":"\(iso(-0.4 * day + 95))"},
          {"id":"run-p2","sessionId":"session-routine-brief","scheduleId":"routine-brief","origin":"schedule","status":"done","requestedTarget":"cloud","effectiveTarget":"cloud","hostId":null,"createdAt":"\(iso(-1.4 * day))","startedAt":"\(iso(-1.4 * day))","finishedAt":"\(iso(-1.4 * day + 80))"},
          {"id":"run-p3","sessionId":"session-routine-brief","scheduleId":"routine-brief","origin":"manual","status":"failed","requestedTarget":"cloud","effectiveTarget":"cloud","hostId":null,"createdAt":"\(iso(-2.4 * day))","startedAt":"\(iso(-2.4 * day))","finishedAt":"\(iso(-2.4 * day + 30))"}
        ]}
        """
    }
}
#endif
