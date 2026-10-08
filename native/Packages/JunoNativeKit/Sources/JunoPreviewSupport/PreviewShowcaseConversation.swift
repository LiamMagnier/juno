#if DEBUG
import Foundation
import JunoStorage
import JunoSync

/// The product-shot conversation: Maya's launch plan, with the shapes a real
/// answer has — headings, a list, a table, a quote and a code block — so the
/// transcript can be looked at as it reads, not as a sentence of lorem.
///
/// Timed against the clock rather than the fixtures' fixed base, so the
/// sidebar's Today / Yesterday / Previous 7 days sections read as they would
/// for someone using the app this week. Sample content only.
enum PreviewShowcaseConversation {
    static func iso(_ offset: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }

    static func record(_ a: StorageAccountID, _ namespace: String, _ id: String, _ json: String) -> StoredRecord {
        StoredRecord(
            accountID: a,
            key: RecordKey(namespace: namespace, id: id),
            revision: 3,
            updatedAt: Date(),
            payload: Data(json.utf8)
        )
    }

    /// JSON-escapes a Markdown body for a message record.
    private static func escaped(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text], options: [])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }

    static let launchQuestion = "We launch Field Notes 2.0 on the 14th. Can you turn my notes into a plan for the last two weeks?"

    static let launchAnswer = """
    ## Two weeks to launch

    You have three things to land before the 14th: a stable build, a clear story, and the people who will tell it. Here is the order I would take them in.

    ### Week 1: lock the product

    - **Mon–Tue.** Freeze features and cut the release candidate.
    - **Wednesday.** Send the beta group the build with a three-question survey.
    - **Friday.** Triage the feedback and fix only what blocks the launch.

    ### Week 2: tell the story

    | Day | Owner | Deliverable |
    | --- | --- | --- |
    | Mon | Maya | Press kit and product shots |
    | Wed | Sam | Launch email, scheduled |
    | Thu | Priya | New pricing page, behind a flag |
    | Fri 14th | Everyone | Ship at 9:00, announce at 9:30 |

    > One risk to watch: the pricing page depends on the billing migration. If that slips past Wednesday, launch on the current plans and announce the new pricing a week later.
    """

    static let flagQuestion = "How should Priya gate the new pricing page?"

    static let flagAnswer = """
    Keep it behind a server flag so you can flip it at 9:30 without a deploy:

    ```ts
    export async function pricingPage(user: User) {
      const enabled = await flags.isOn("pricing-v2", { user })
      return enabled ? <PricingV2 /> : <Pricing />
    }
    ```

    Turn it on for the team on Thursday, check the checkout end to end, then open it to everyone with the announcement.
    """

    /// Messages for `conv-1`, the pinned launch plan.
    static func messages(_ a: StorageAccountID) -> [StoredRecord] {
        [
            record(a, "message", "sc-1", """
            {"id":"sc-1","conversationId":"conv-1","role":"user","content":\(escaped(launchQuestion)),"createdAt":"\(iso(-900))"}
            """),
            record(a, "message", "sc-2", """
            {"id":"sc-2","conversationId":"conv-1","role":"assistant","content":\(escaped(launchAnswer)),"reasoning":"The build has to be stable before anyone can write about it, so the product work goes first and the story second.","model":"anthropic:claude-sonnet-4-6","promptTokens":2210,"completionTokens":540,"createdAt":"\(iso(-880))"}
            """),
            record(a, "message", "sc-3", """
            {"id":"sc-3","conversationId":"conv-1","role":"user","content":\(escaped(flagQuestion)),"createdAt":"\(iso(-420))"}
            """),
            record(a, "message", "sc-4", """
            {"id":"sc-4","conversationId":"conv-1","role":"assistant","content":\(escaped(flagAnswer)),"model":"anthropic:claude-sonnet-4-6","promptTokens":2890,"completionTokens":180,"createdAt":"\(iso(-400))"}
            """),
        ]
    }

    // MARK: Live UI

    /// The bill splitter from `contracts/live-ui/samples.json` ("bill"): an
    /// answer carrying a ```live-ui block — sliders, a stepper, metrics and a
    /// table that recompute in place.
    static let liveQuestion = "Here's the receipt from Trattoria Moro, there were 4 of us. How much does everyone owe with a 10% tip?"
    static let liveAnswer = "With a 10% tip the bill comes to **€148.99**, so each of the four of you owes **€37.25**.\n\n```live-ui\n{\"title\":\"Trattoria Moro, split evenly\",\"currency\":\"EUR\",\n \"data\":{\"items\":[{\"item\":\"Burrata\",\"price\":14},{\"item\":\"Cacio e pepe\",\"price\":16.5},{\"item\":\"Pizza diavola\",\"price\":15},{\"item\":\"Branzino\",\"price\":27},{\"item\":\"Tiramisu (2)\",\"price\":18},{\"item\":\"Etna Rosso, bottle\",\"price\":38},{\"item\":\"Sparkling water\",\"price\":6.95}]},\n \"let\":{\"subtotal\":\"sum(items.price)\",\"service\":\"subtotal * tip\",\"total\":\"subtotal + service\",\"each\":\"total / people\",\"roundUp\":\"ceil(each)\"},\n \"ui\":[\n  {\"type\":\"row\",\"children\":[\n   {\"type\":\"slider\",\"id\":\"tip\",\"label\":\"Tip\",\"min\":0,\"max\":0.25,\"step\":0.01,\"value\":0.1,\"format\":\"percent\"},\n   {\"type\":\"stepper\",\"id\":\"people\",\"label\":\"People\",\"min\":1,\"max\":12,\"value\":4}]},\n  {\"type\":\"row\",\"children\":[\n   {\"type\":\"metric\",\"label\":\"Each person pays\",\"value\":\"each\",\"format\":\"currency\",\"emphasis\":true,\"hint\":\"Round up to {{fmt(roundUp,'currency',0)}} and the table leaves {{fmt(roundUp * people - total,'currency')}} extra\"},\n   {\"type\":\"metric\",\"label\":\"Total with tip\",\"value\":\"total\",\"format\":\"currency\",\"hint\":\"{{fmt(service,'currency')}} of it is tip\"}]},\n  {\"type\":\"table\",\"rows\":\"items\",\"columns\":[{\"label\":\"Item\",\"value\":\"item\"},{\"label\":\"Price\",\"value\":\"price\",\"format\":\"currency\"},{\"label\":\"Each, with tip\",\"value\":\"price * (1 + tip) / people\",\"format\":\"currency\"}]},\n  {\"type\":\"row\",\"children\":[\n   {\"type\":\"button\",\"label\":\"Split by who ordered what\",\"prompt\":\"Split the Trattoria Moro receipt by who ordered what instead of evenly, keeping a {{fmt(tip,'percent',0)}} tip.\"},\n   {\"type\":\"button\",\"label\":\"Copy each share\",\"copy\":\"fmt(each,'currency')\"}]}]}\n```\n\nItaly doesn't expect a tip on top of the *coperto*, so 5% or rounding up is also perfectly normal there."

    // MARK: Research

    static let researchQuestion = "Does a heat pump make sense for a 1930s semi with solid walls, and what would it cost?"

    static let checklist = """
    # Field Notes 2.0 — launch checklist

    ## Week 1
    - [x] Freeze features (Mon)
    - [x] Cut the release candidate (Tue)
    - [ ] Beta build and three-question survey (Wed)
    - [ ] Triage feedback; fix blockers only (Fri)

    ## Week 2
    - [ ] Press kit and product shots — Maya
    - [ ] Launch email, scheduled — Sam
    - [ ] Pricing page behind `pricing-v2` — Priya
    - [ ] Ship 9:00, announce 9:30 — everyone
    """

    static let budget = """
    <!doctype html><html><head><meta charset="utf-8"><style>
    body{font:14px -apple-system,system-ui;margin:24px;color:#1d1d1f}h1{font-size:20px;margin:0 0 4px}p{color:#6e6e73;margin:0 0 16px}
    table{border-collapse:collapse;width:100%}th,td{padding:8px 10px;border-bottom:1px solid #e5e5ea;text-align:left}th{color:#6e6e73;font-weight:500}
    td.n{text-align:right;font-variant-numeric:tabular-nums}tr.t td{font-weight:600;border-bottom:0}
    @media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#1c1c1e}th,p{color:#98989d}th,td{border-color:#38383a}}
    </style></head><body><h1>Launch budget</h1><p>Field Notes 2.0, two weeks to the 14th</p>
    <table><tr><th>Line</th><th>Owner</th><th class="n">Budget</th><th class="n">Spent</th></tr>
    <tr><td>Product shots</td><td>Maya</td><td class="n">€1,800</td><td class="n">€1,240</td></tr>
    <tr><td>Press kit design</td><td>Maya</td><td class="n">€900</td><td class="n">€900</td></tr>
    <tr><td>Launch email tool</td><td>Sam</td><td class="n">€120</td><td class="n">€0</td></tr>
    <tr><td>Pricing page copy</td><td>Priya</td><td class="n">€600</td><td class="n">€450</td></tr>
    <tr><td>Paid social, launch week</td><td>Sam</td><td class="n">€2,500</td><td class="n">€0</td></tr>
    <tr class="t"><td>Total</td><td></td><td class="n">€5,920</td><td class="n">€2,590</td></tr></table></body></html>
    """

    /// The extra chats the showcase week holds: a live-UI answer and a deep
    /// research that is still working.
    static func extraRecords(_ a: StorageAccountID) -> [StoredRecord] {
        [
            record(a, "conversation", "conv-live", """
            {"id":"conv-live","title":"Splitting the Trattoria Moro bill","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":false,"archivedAt":null,"createdAt":"\(iso(-7_200))","updatedAt":"\(iso(-7_000))","lastMessageAt":"\(iso(-7_000))"}
            """),
            record(a, "message", "lv-1", """
            {"id":"lv-1","conversationId":"conv-live","role":"user","content":\(escaped(liveQuestion)),"createdAt":"\(iso(-7_100))"}
            """),
            record(a, "message", "lv-2", """
            {"id":"lv-2","conversationId":"conv-live","role":"assistant","content":\(escaped(liveAnswer)),"model":"anthropic:claude-sonnet-4-6","createdAt":"\(iso(-7_000))"}
            """),
            record(a, "artifact", "art-checklist", """
            {"id":"art-checklist","conversationId":"conv-1","messageId":"sc-2","identifier":"launch-checklist","title":"Launch checklist","type":"MARKDOWN","language":null,"currentVersion":1,"createdAt":"\(iso(-870))","updatedAt":"\(iso(-870))"}
            """),
            record(a, "artifact_version", "artv-checklist", """
            {"id":"artv-checklist","artifactId":"art-checklist","version":1,"content":\(escaped(checklist)),"createdAt":"\(iso(-870))"}
            """),
            record(a, "artifact", "art-budget", """
            {"id":"art-budget","conversationId":"conv-1","messageId":"sc-2","identifier":"launch-budget","title":"Launch budget","type":"HTML","language":null,"currentVersion":2,"createdAt":"\(iso(-860))","updatedAt":"\(iso(-500))"}
            """),
            record(a, "artifact_version", "artv-budget-1", """
            {"id":"artv-budget-1","artifactId":"art-budget","version":1,"content":\(escaped(budget)),"createdAt":"\(iso(-860))"}
            """),
            record(a, "artifact_version", "artv-budget-2", """
            {"id":"artv-budget-2","artifactId":"art-budget","version":2,"content":\(escaped(budget)),"createdAt":"\(iso(-500))"}
            """),
            record(a, "conversation", "conv-research", """
            {"id":"conv-research","title":"Heat pump for the Leeds house","model":"anthropic:claude-opus-4-6","kind":"chat","pinned":false,"archivedAt":null,"createdAt":"\(iso(-600))","updatedAt":"\(iso(-250))","lastMessageAt":"\(iso(-250))"}
            """),
            record(a, "message", "rs-1", """
            {"id":"rs-1","conversationId":"conv-research","role":"user","content":\(escaped(researchQuestion)),"createdAt":"\(iso(-260))"}
            """),
        ]
    }
}
#endif
