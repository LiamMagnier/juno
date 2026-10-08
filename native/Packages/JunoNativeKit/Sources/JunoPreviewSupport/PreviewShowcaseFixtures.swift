#if DEBUG
import Foundation

/// The product-shot account's week, as wire-shaped JSON rows.
///
/// Maya Okafor leads product on Field Notes, a notes app shipping its 2.0. Her
/// chats are what a real person's sidebar holds — a launch plan, a poster for
/// the launch party, pricing copy, a hiring plan — and the two conversations the
/// screenshots open carry real content: a long, structured answer (headings, a
/// list, a table, a code block) and a photo with a generated picture in reply.
///
/// Timestamps are relative to *now*, so the sidebar groups them into Today,
/// Yesterday and Previous 7 days the way a live account would, rather than
/// filing every row under "Older".
///
/// Each row is built with `JSONSerialization`, never by string interpolation:
/// the answers carry quotes, backslashes and newlines, and a hand-escaped JSON
/// literal is a fixture that silently decodes to nothing.
enum PreviewShowcaseFixtures {
    typealias Row = (namespace: String, id: String, revision: UInt64, json: String)

    static let launchPlanID = "conv-1"
    static let posterID = "conv-poster"

    static func rows(now: Date) -> [Row] {
        func iso(_ offset: TimeInterval) -> String {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.string(from: now.addingTimeInterval(offset))
        }
        func json(_ object: [String: Any]) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
            return String(decoding: data, as: UTF8.self)
        }
        var out: [Row] = []

        // Conversations: (id, title, pinned, project, seconds ago).
        let chats: [(String, String, Bool, String?, TimeInterval)] = [
            (launchPlanID, "Launch plan for Field Notes 2.0", true, nil, -240),
            (posterID, "Poster for the launch party", false, nil, -2_400),
            ("conv-proj", "Beta feedback, week 3", false, "proj-1", -9_000),
            ("conv-2", "Pricing page copy", false, nil, -86_400 - 3_600),
            ("conv-4", "Onboarding email sequence", false, nil, -86_400 - 18_000),
            ("conv-5", "Q4 hiring plan", false, nil, -3 * 86_400),
            ("conv-6", "Lisbon offsite agenda", false, nil, -5 * 86_400),
            ("conv-7", "Interview questions for the iOS role", false, nil, -12 * 86_400),
        ]
        for (index, chat) in chats.enumerated() {
            var row: [String: Any] = [
                "id": chat.0, "title": chat.1, "model": "anthropic:claude-opus-4-8",
                "kind": "chat", "pinned": chat.2, "archivedAt": NSNull(),
                "createdAt": iso(chat.4 - 3_600), "updatedAt": iso(chat.4), "lastMessageAt": iso(chat.4),
            ]
            if let project = chat.3 { row["projectId"] = project }
            out.append(("conversation", chat.0, UInt64(8 - index % 3), json(row)))
        }

        func message(
            _ id: String, _ conversation: String, _ role: String, _ content: String,
            _ offset: TimeInterval, reasoning: String? = nil, model: String? = nil
        ) {
            var row: [String: Any] = [
                "id": id, "conversationId": conversation, "role": role,
                "content": content, "createdAt": iso(offset),
            ]
            if let reasoning { row["reasoning"] = reasoning }
            if let model {
                row["model"] = model
                row["promptTokens"] = 3_412
                row["completionTokens"] = 846
                row["costMicroUsd"] = 18_200
            }
            out.append(("message", id, 1, json(row)))
        }

        // The launch plan: one question, one long structured answer.
        message(
            "sc-msg-1", launchPlanID, "user",
            "Turn Tuesday's notes into a launch plan for Field Notes 2.0. We ship on November 12.",
            -420
        )
        message(
            "sc-msg-2", launchPlanID, "assistant", launchPlanAnswer, -400,
            reasoning: "Tuesday's notes give a ship date, a beta, and three open risks. Lead with the plan in one line, then dates in a table so owners are scannable, then what must be true by freeze, then risks. The announcement is scheduled from their CMS, so show the command.",
            model: "anthropic:claude-opus-4-8"
        )

        // The poster: a photo in, a generated picture out.
        message(
            "sc-msg-3", posterID, "user",
            "Here's the view from our rooftop last night. Can you turn it into a poster for the launch party?",
            -2_520
        )
        message(
            "sc-msg-4", posterID, "assistant",
            "Here it is: the evening sky kept as the ground, the sun set as the 2.0 mark, and the skyline reduced to one dark line so the type has room. Want the date and the address added in the brand face?",
            -2_400, model: "openai:gpt-image-2"
        )
        out.append(("attachment", PreviewImageFixtures.userPhotoID, 2, json([
            "id": PreviewImageFixtures.userPhotoID, "conversationId": posterID, "messageId": "sc-msg-3",
            "projectId": NSNull(), "kind": "IMAGE", "fileName": "IMG_2231.jpg", "mimeType": "image/jpeg",
            "size": 1_830_000, "width": 1_200, "height": 800, "createdAt": iso(-2_520),
        ])))
        out.append(("attachment", PreviewImageFixtures.generatedID, 2, json([
            "id": PreviewImageFixtures.generatedID, "conversationId": posterID, "messageId": "sc-msg-4",
            "projectId": NSNull(), "kind": "IMAGE", "fileName": "launch-party-poster.png", "mimeType": "image/png",
            "size": 920_000, "width": 1_024, "height": 1_024, "createdAt": iso(-2_400),
        ])))

        // A short exchange in the project chat, so search has messages to find.
        message(
            "sc-msg-5", "conv-proj", "user",
            "Group this week's beta feedback by theme and tell me what to fix first.",
            -9_200
        )
        message(
            "sc-msg-6", "conv-proj", "assistant",
            "Three themes cover 41 of the 52 reports. **Sync on cellular** (19) is the one to fix first: it is the only theme where people lost text. Search ranking (14) and the new editor's selection handles (8) can wait for 2.0.1.",
            -9_000, model: "anthropic:claude-opus-4-8"
        )

        for (index, chat) in liveUIChats.enumerated() {
            let offset = -Double(4 + index) * 86_400
            out.append(("conversation", chat.id, 3, json([
                "id": chat.id, "title": chat.title, "model": "anthropic:claude-opus-4-8",
                "kind": "chat", "pinned": false, "archivedAt": NSNull(),
                "createdAt": iso(offset - 600), "updatedAt": iso(offset), "lastMessageAt": iso(offset),
            ])))
            message("\(chat.id)-q", chat.id, "user", chat.prompt, offset - 60)
            message("\(chat.id)-a", chat.id, "assistant", chat.reply, offset, model: "anthropic:claude-opus-4-8")
        }

        // Library files: what Maya has attached across her chats and project.
        let files: [(String, String, String, String, Int, String?, TimeInterval)] = [
            ("sc-file-1", "FILE", "Field Notes 2.0 launch brief.pdf", "application/pdf", 412_000, "proj-1", -7_200),
            ("sc-file-2", "FILE", "Beta feedback, week 3.csv", "text/csv", 38_000, "proj-1", -9_400),
            ("sc-file-3", "FILE", "Pricing tiers.numbers", "application/vnd.apple.numbers", 96_000, nil, -90_000),
            ("sc-file-4", "IMAGE", "Onboarding, screen 2.png", "image/png", 640_000, nil, -100_000),
        ]
        for file in files {
            var row: [String: Any] = [
                "id": file.0, "conversationId": NSNull(), "messageId": NSNull(),
                "kind": file.1, "fileName": file.2, "mimeType": file.3, "size": file.4,
                "width": NSNull(), "height": NSNull(), "createdAt": iso(file.6),
            ]
            row["projectId"] = file.5 ?? NSNull()
            out.append(("attachment", file.0, 2, json(row)))
        }

        out.append(("project", "proj-1", 8, json([
            "id": "proj-1", "name": "Field Notes 2.0", "nameSource": "user",
            "instructions": "The notes app we are launching on November 12. Keep the voice warm and plain.",
            "starred": true, "createdAt": iso(-40 * 86_400), "updatedAt": iso(-9_000),
        ])))
        out.append(("project", "proj-2", 5, json([
            "id": "proj-2", "name": "Hiring", "nameSource": "user",
            "instructions": "Roles, interview loops and offers for the Field Notes team.",
            "starred": false, "createdAt": iso(-60 * 86_400), "updatedAt": iso(-3 * 86_400),
        ])))
        out.append(("project", "proj-3", 3, json([
            "id": "proj-3", "name": "Lisbon offsite", "nameSource": "user",
            "instructions": "Three days in Lisbon for the whole team in January.",
            "starred": false, "createdAt": iso(-20 * 86_400), "updatedAt": iso(-5 * 86_400),
        ])))
        return out
    }

    /// Two Live UI answers, copied verbatim from the shared samples
    /// (contracts/live-ui/samples.json), so the phone renders the same specs
    /// the web and the Mac are tested against.
    static let liveUIChats: [(id: String, title: String, prompt: String, reply: String)] = [
        ("conv-live-calc", "Retirement savings at 65", "I'm 32 with €25k saved. If I put away €600 a month, what will I have at 65?", #"""
At a 6% average yearly return you'd reach roughly **€925,000** by 65, about three and a half times the €262,600 you put in. Move the sliders to see how much the contribution and the return matter.

```live-ui
{"title":"Savings at retirement","currency":"EUR",
 "let":{"years":"retire - age","balance":"fv(rate / 12, years * 12, monthly, start)","paidIn":"start + monthly * 12 * years","growth":"balance - paidIn","income":"balance * 0.04 / 12"},
 "ui":[
  {"type":"grid","columns":2,"children":[
   {"type":"stepper","id":"age","label":"Age today","min":18,"max":70,"value":32},
   {"type":"slider","id":"retire","label":"Retire at","min":50,"max":75,"step":1,"value":65},
   {"type":"slider","id":"monthly","label":"Monthly saving","min":0,"max":3000,"step":50,"value":600,"format":"currency"},
   {"type":"slider","id":"rate","label":"Yearly return","min":0.01,"max":0.1,"step":0.005,"value":0.06,"format":"percent"}]},
  {"type":"number","id":"start","label":"Saved so far","value":25000,"min":0,"step":1000,"format":"currency"},
  {"type":"row","children":[
   {"type":"metric","label":"Balance at {{retire}}","value":"balance","format":"currency","emphasis":true,"hint":"{{fmt(growth,'currency',0)}} of it is growth"},
   {"type":"metric","label":"Monthly income at 4%","value":"income","format":"currency","hint":"The 4% rule, before tax"}]},
  {"type":"chart","kind":"area","title":"Balance by year","x":{"from":0,"to":"years","step":1,"var":"year","label":"Year"},"format":"currency",
   "series":[{"label":"Balance","y":"fv(rate / 12, year * 12, monthly, start)"},{"label":"Paid in","y":"start + monthly * 12 * year"}]},
  {"type":"text","tone":"muted","text":"Assumes a steady {{fmt(rate,'percent')}} return compounded monthly, in today's euros before inflation, fees and tax."}]}
```

Two things move this most: starting earlier and the return you actually get after fees. A 1% fee is roughly the difference between 6% and 5% here.
"""#),
        ("conv-live-trip", "A Saturday in Lisbon", "Plan a relaxed Saturday in Lisbon, mostly on foot, starting from Baixa.", #"""
Here's an easy loop: Baixa to Alfama in the morning, lunch by the river, and sunset in Bairro Alto. It's about 7 km of walking with one tram ride to save your legs on the hill.

```live-ui
{"title":"A slow Saturday in Lisbon",
 "ui":[
  {"type":"stops","stops":[
   {"name":"Praça do Comércio","time":"9:30","note":"Coffee and a pastel de nata at Confeitaria Nacional on the way","query":"Praça do Comércio, Lisbon"},
   {"name":"Tram 28 to Graça","time":"10:15","note":"Board at Martim Moniz to get a seat; 25 minutes","query":"Martim Moniz, Lisbon"},
   {"name":"Miradouro da Senhora do Monte","time":"10:45","note":"The best view over the castle and the river","query":"Miradouro da Senhora do Monte, Lisbon"},
   {"name":"Alfama and the Sé","time":"11:30","note":"Walk downhill through the lanes to the cathedral","query":"Sé de Lisboa"},
   {"name":"Lunch at Time Out Market","time":"13:30","note":"Busy but quick; go upstairs for a table","query":"Time Out Market Lisboa"},
   {"name":"LX Factory","time":"15:30","note":"Bookshop Ler Devagar, then coffee","query":"LX Factory, Lisbon"},
   {"name":"Miradouro de Santa Catarina","time":"18:45","note":"Sunset, then dinner in Bairro Alto","query":"Miradouro de Santa Catarina, Lisbon"}]},
  {"type":"checklist","id":"pack","title":"Before you go","items":["Comfortable shoes with grip (the cobbles are slippery)","A Viva Viagem card loaded for the tram",{"label":"Book dinner","note":"Bairro Alto fills up after 20:00 on Saturdays"},"Water and sunscreen"]},
  {"type":"button","label":"Make a rainy-day version","prompt":"Make a rainy-day version of this Lisbon Saturday, mostly indoors."}]}
```

If you'd rather skip the tram, the walk up to Graça is steep but only 20 minutes.
"""#),
    ]

    static let launchPlanAnswer = """
    Ship 2.0 to everyone on **November 12**, after a two-week public beta that opens October 27. The press embargo lifts at 9:00 PT on launch day.

    ## Milestones

    | Date | Milestone | Owner |
    | --- | --- | --- |
    | Oct 20 | Feature freeze | Daniel |
    | Oct 27 | Public beta, 2,000 TestFlight seats | Priya |
    | Nov 5 | App Store submission | Maya |
    | Nov 12 | Launch, embargo lifts 9:00 PT | Everyone |

    ## What has to be true by freeze

    1. Sync conflicts resolve without a dialog. The last open bug is FN-412.
    2. The new editor holds 60 fps on a 10,000-word note on an iPhone 15.
    3. The pricing page and the in-app paywall say the same thing.

    ## Risks

    - **Review time.** App Review has run three to four days this month, so submitting on November 5 leaves room for one resubmission.
    - **Beta feedback volume.** Route every report into one Linear view so nothing is answered twice.

    ## The announcement

    Schedule the post from the CMS rather than by hand, so it goes out with the embargo:

    ```bash
    fieldnotes publish announce-2-0 \\
      --at "2026-11-12T09:00:00-08:00" \\
      --channels blog,newsletter,x
    ```

    Want me to draft the beta invite email next?
    """

    /// The answer the harness streams when `--juno-preview-send` sends a turn:
    /// a few seconds of thinking, then this, paced like a real reply.
    static let streamedReasoning = "Three things are late: the editor's performance pass, the onboarding rewrite and the iPad layout. Only the editor blocks the launch story. Cutting the other two keeps November 12 without moving the beta."

    static let streamedAnswer = """
    Cut two things and keep the date. Neither is in the launch story, and both can ship in 2.0.1 three weeks later.

    ## Cut from 2.0

    - **The onboarding rewrite.** The current flow converts at 61%, and the new one has not been tested with anyone outside the team.
    - **The iPad sidebar layout.** iPad is 9% of active users, and the iPhone layout already scales.

    ## Keep, whatever it costs

    - **The editor performance pass.** "Fast on long notes" is the headline of the launch post; without it there is no story.
    - **Sync conflict handling.** Losing text is the one thing beta users will not forgive.
    """
}
#endif
