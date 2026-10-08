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
}
#endif
