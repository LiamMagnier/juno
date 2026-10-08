#if DEBUG
import Foundation
import JunoAuth

/// Two Deep Research runs the harness serves in the server's own wire shape
/// (`GET /api/research?conversationId=…`, `GET /api/research/{id}`), so the
/// real client decodes them and the real transcript draws them:
///
/// - `rr_sc_live` — a run mid-way in "Heat pump for the Lisbon flat?", which
///   the conversation follows and draws as the live working view.
/// - `rr_sc_done` — a finished run in "Note-taking app pricing, 2026", whose
///   report card opens the reader; its sources include three of Maya's own
///   (a file, her mail, her calendar) on the reserved `private.invalid` host.
///   The completion notification route opens this one.
///
/// Only those two conversations get an answer; every other research request
/// keeps the harness's old empty reply, so nothing else starts following runs.
enum PreviewResearchRunFixtures {
    static let liveConversation = "conv-research-live"
    static let doneConversation = "conv-research-done"
    static let liveRunID = "rr_sc_live"
    static let doneRunID = "rr_sc_done"

    static let liveQuestion = "Would a heat pump work in our 1930s Lisbon flat, and what would it cost to run?"
    static let doneQuestion = "How are note-taking apps pricing in 2026? I need it for the Field Notes 2.0 pricing page."

    static func body(for request: NativeBearerRequest) -> Data? {
        guard request.method == .get, request.path.hasPrefix("/api/research") else { return nil }
        let now = Date()
        if request.path == "/api/research" {
            let conversation = request.queryItems.first { $0.name == "conversationId" }?.value
            switch conversation {
            case liveConversation: return json(["runs": [summary(live: true, now: now)]])
            case doneConversation: return json(["runs": [summary(live: false, now: now)]])
            default: return nil
            }
        }
        switch request.path {
        case "/api/research/\(liveRunID)": return json(["run": liveRun(now: now), "events": [], "lastSeq": 0, "maxSeq": 0])
        case "/api/research/\(doneRunID)": return json(["run": doneRun(now: now), "events": [], "lastSeq": 0, "maxSeq": 0])
        default: return nil
        }
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func json(_ object: [String: Any]) -> Data? {
        try? JSONSerialization.data(withJSONObject: object)
    }

    private static func summary(live: Bool, now: Date) -> [String: Any] {
        [
            "id": live ? liveRunID : doneRunID,
            "conversationId": live ? liveConversation : doneConversation,
            "state": live ? "investigating" : "completed",
            "phase": live ? "reading" : "done",
            "live": live,
            "createdAt": iso(now.addingTimeInterval(live ? -260 : -26 * 3_600)),
            "title": live ? "Heat pumps in a 1930s Lisbon flat" : "Note-taking app pricing in 2026",
            "goal": live ? liveQuestion : doneQuestion,
        ]
    }

    private static func liveRun(now: Date) -> [String: Any] {
        [
            "id": liveRunID, "conversationId": liveConversation, "goal": liveQuestion,
            "state": "investigating", "title": "Heat pumps in a 1930s Lisbon flat",
            "phase": "reading", "phaseDetail": ["domain": "adene.pt"],
            "plan": [
                "approach": "Compare what Portugal's energy agency and installers publish on air-to-water and air-to-air systems with what owners of older flats report, then price a year of running costs on today's tariffs.",
                "objectives": [
                    ["id": "o1", "question": "Will it keep a flat with single glazing warm in January?", "status": "covered"],
                    ["id": "o2", "question": "What does an install cost after the Fundo Ambiental grant?", "status": "covered"],
                    ["id": "o3", "question": "Can it go in without an outdoor unit on the façade?", "status": "searching"],
                    ["id": "o4", "question": "How do running costs compare with the gas boiler?", "status": "pending"],
                ],
            ],
            "questions": [
                ["id": "o1", "question": "Will it keep a flat with single glazing warm in January?", "status": "covered"],
                ["id": "o2", "question": "What does an install cost after the Fundo Ambiental grant?", "status": "covered"],
                ["id": "o3", "question": "Can it go in without an outdoor unit on the façade?", "status": "searching"],
                ["id": "o4", "question": "How do running costs compare with the gas boiler?", "status": "pending"],
            ],
            "counts": ["found": 14, "read": 7, "cited": 0, "searches": 11, "pages": 7],
            "workingMs": 252_000,
            "createdAt": iso(now.addingTimeInterval(-260)),
            "leadModel": ["id": "anthropic:claude-opus-4-8", "label": "Claude Opus 4.8"],
            "latestFindings": [
                ["id": "f1", "claim": "Lisbon's mild winters let an air-to-water pump run at a seasonal efficiency above 4, even in older buildings.", "quote": "", "url": "https://www.adene.pt/bombas-de-calor/", "title": "Bombas de calor — ADENE"],
                ["id": "f2", "claim": "The Fundo Ambiental programme covers up to 85% of a heat pump install, capped at €2,500 per home.", "quote": "", "url": "https://www.fundoambiental.pt/apoios-prr/edificios-mais-sustentaveis.aspx", "title": "Edifícios Mais Sustentáveis"],
                ["id": "f3", "claim": "Condominium rules often bar outdoor units on street façades; monoblock units inside a balcony are the usual workaround.", "quote": "", "url": "https://www.deco.proteste.pt/casa-energia/aquecimento", "title": "Aquecimento em apartamentos — DECO"],
            ],
            "sources": [
                ["id": "s1", "url": "https://www.adene.pt/bombas-de-calor/", "title": "Bombas de calor — ADENE", "read": true],
                ["id": "s2", "url": "https://www.fundoambiental.pt/apoios-prr/edificios-mais-sustentaveis.aspx", "title": "Edifícios Mais Sustentáveis", "read": true],
                ["id": "s3", "url": "https://www.deco.proteste.pt/casa-energia/aquecimento", "title": "Aquecimento em apartamentos", "read": true],
                ["id": "s4", "url": "https://www.erse.pt/precos/", "title": "Tarifas de eletricidade — ERSE", "read": true],
                ["id": "s5", "url": "https://www.idealista.pt/news/imobiliario/habitacao/bomba-de-calor", "title": "Quanto custa uma bomba de calor?", "read": false],
                ["id": "s6", "url": "https://www.dgeg.gov.pt/pt/areas-setoriais/energia/", "title": "Energia — DGEG", "read": false],
            ],
            "estimate": ["minutesUpTo": 9, "pagesUpTo": 30],
        ]
    }

    private static func doneRun(now: Date) -> [String: Any] {
        [
            "id": doneRunID, "conversationId": doneConversation, "goal": doneQuestion,
            "state": "completed", "title": "Note-taking app pricing in 2026", "phase": "done",
            "counts": ["found": 31, "read": 14, "cited": 8, "searches": 18, "pages": 14],
            "workingMs": 512_000,
            "createdAt": iso(now.addingTimeInterval(-26 * 3_600)),
            "finishedAt": iso(now.addingTimeInterval(-26 * 3_600 + 540)),
            "report": doneReport,
            "auditSummary": ["claims": 9, "supported": 7, "partiallySupported": 2, "unsupported": 0, "contradicted": 0, "unverified": 0],
            "sources": [
                ["id": "s1", "url": "https://bear.app/pricing/", "title": "Bear Pro pricing", "read": true],
                ["id": "s2", "url": "https://www.notion.com/pricing", "title": "Notion plans", "read": true],
                ["id": "s3", "url": "https://obsidian.md/pricing", "title": "Obsidian pricing", "read": true],
                ["id": "s4", "url": "https://craft.do/pricing", "title": "Craft plans", "read": true],
                ["id": "s5", "url": "https://www.goodnotes.com/pricing", "title": "Goodnotes pricing", "read": true],
                ["id": "s6", "url": "https://private.invalid/file/pricing-tiers", "title": "Pricing tiers.numbers", "read": true],
                ["id": "s7", "url": "https://private.invalid/mail/beta-feedback-pricing", "title": "Re: what would you pay for 2.0? (Priya Shah)", "read": true],
                ["id": "s8", "url": "https://private.invalid/calendar/pricing-review", "title": "Pricing review — Thursday 14:00", "read": true],
            ],
        ]
    }

    static let doneReport = """
    # Note-taking app pricing in 2026

    Most note apps now charge **$3–$5 a month** for a single tier, with a yearly plan at roughly two months free [1][3][4]. The ones that charge more sell team features, not notes [2]. Field Notes' own beta testers anchor on **$4** [7].

    ## The field

    | App | Monthly | Yearly | What paying unlocks |
    | --- | --- | --- | --- |
    | Bear | $2.99 | $29.99 | Sync, themes, export [1] |
    | Obsidian | $4 (Sync) | $48 | Sync across devices [3] |
    | Craft | $5 | $48 | Unlimited docs, AI [4] |
    | Goodnotes | — | $9.99 | All features, one price [5] |
    | Notion | $10 | $96 | Teams and admin [2] |

    ## What it means for Field Notes

    1. A single **Pro** tier at **$3.99** a month or **$34.99** a year sits inside the band and under Craft [4].
    2. Keep the free tier generous on capture; charge for sync and export, which is where every competitor draws the line [1][3].
    3. The internal pricing sheet already models $3.99 [6], and Thursday's review is the place to lock it [8].

    ## What testers said

    Seven of the twelve beta replies named a price; five said "about $4", two said "under $5" [7].
    """
}
#endif
