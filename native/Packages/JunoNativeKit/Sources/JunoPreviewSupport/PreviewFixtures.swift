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

    /// Project instructions shaped like the ones people actually write: a long,
    /// tag-structured standing prompt rather than one polite sentence.
    ///
    /// The short version hid the problem this screen was rebuilt to fix. Real
    /// instructions run to dozens of lines of `<role>` / `<about_me>` prompt text,
    /// and unclamped they pushed the project's conversations and files off the
    /// bottom of the phone — so the fixture has to be long enough to clamp, or
    /// nothing about the clamp is being exercised.
    ///
    /// `\\n` is doubled: this is interpolated into a JSON string literal, so the
    /// escape has to survive Swift and reach the decoder intact.
    private static let promptShapedInstructions = [
        "<role>",
        "You are a research assistant on an observational astronomy project.",
        "Stay in this role for every conversation in this project.",
        "</role>",
        "<standing_context>",
        "Track every quasar observation and keep citations precise.",
        "Prefer primary sources; name the instrument and the epoch.",
        "When a measurement is uncertain, say so and give the error bars.",
        "Group observations by epoch when summarising more than three of them.",
        "</standing_context>",
        "<output>",
        "Lead with the finding, then the evidence, then the caveats.",
        "Never invent a citation. If you cannot find a source, say that instead.",
        "</output>",
    ].joined(separator: "\\n")

    /// A real Juno Design document, produced by the website's own operation layer
    /// (`tests/design-fixtures.ts`, the same source `npm run design:fixture` emits
    /// the Swift round-trip fixture from) and pasted here verbatim.
    ///
    /// Hand-written JSON was not an option: `DesignDocumentCodec` refuses a
    /// document that is missing a field or names a child it does not contain, so a
    /// fixture typed by hand would fail to decode and the design screen would show
    /// its refusal rather than a drawing — which is indistinguishable from the
    /// screen being broken.
    ///
    /// Small on purpose: one 375×812 frame, a card with a title, a field and a
    /// button. Enough to see that the renderer laid something out, few enough
    /// layers to check the outline against by eye.
    private static let designDocument = #"""
    {"activeModes":{},"animations":{},"assets":{},"collections":{},"comments":[],"components":{},"id":"design-signin","interactions":{},"migratedFrom":[],"name":"Sign-in screen","nodes":{"button":{"blendMode":"normal","blur":null,"boundVariables":{},"children":["buttonLabel"],"clipsContent":true,"constraints":{"horizontal":"min","vertical":"min"},"cornerRadius":8,"fills":[{"color":{"a":1,"b":0.9,"g":0.3,"r":0.2},"type":"solid"}],"height":48,"heightMode":"fixed","id":"button","layout":null,"layoutChild":{"absolute":false,"grow":false},"limits":{},"locked":false,"name":"Sign in button","opacity":1,"parentId":"card","rotation":0,"shadows":[],"strokes":[],"type":"frame","visible":true,"width":279,"widthMode":"fill","x":0,"y":0},"buttonLabel":{"blendMode":"normal","blur":null,"boundVariables":{},"characters":"Sign in","constraints":{"horizontal":"min","vertical":"min"},"cornerRadius":0,"fills":[{"color":{"a":1,"b":0.08,"g":0.06,"r":0.06},"type":"solid"}],"height":20,"heightMode":"hug","id":"buttonLabel","layoutChild":{"absolute":false,"grow":false},"limits":{},"locked":false,"name":"Label","opacity":1,"parentId":"button","rotation":0,"shadows":[],"strokes":[],"type":"text","typography":{"fontFamily":"Inter","fontSize":16,"fontWeight":400,"letterSpacing":0,"lineHeight":{"unit":"percent","value":140},"textAlign":"left","verticalAlign":"top"},"visible":true,"width":100,"widthMode":"fixed","x":90,"y":14},"card":{"blendMode":"normal","blur":null,"boundVariables":{},"children":["title","email","button"],"clipsContent":true,"constraints":{"horizontal":"min","vertical":"min"},"cornerRadius":16,"fills":[{"color":{"a":1,"b":1,"g":1,"r":1},"type":"solid"}],"height":240,"heightMode":"hug","id":"card","layout":{"align":"start","direction":"vertical","gap":16,"justify":"start","padding":{"bottom":24,"left":24,"right":24,"top":24},"wrap":false},"layoutChild":{"absolute":false,"grow":false},"limits":{},"locked":false,"name":"Card","opacity":1,"parentId":"screen","rotation":0,"shadows":[],"strokes":[],"type":"frame","visible":true,"width":327,"widthMode":"fixed","x":24,"y":200},"email":{"blendMode":"normal","blur":null,"boundVariables":{},"constraints":{"horizontal":"min","vertical":"min"},"cornerRadius":8,"fills":[{"color":{"a":1,"b":0.95,"g":0.6,"r":0.55},"type":"solid"}],"height":44,"heightMode":"fixed","id":"email","layoutChild":{"absolute":false,"grow":false},"limits":{},"locked":false,"name":"Email field","opacity":1,"parentId":"card","rotation":0,"shadows":[],"strokes":[],"type":"rectangle","visible":true,"width":279,"widthMode":"fill","x":0,"y":0},"screen":{"blendMode":"normal","blur":null,"boundVariables":{},"children":["card"],"clipsContent":true,"constraints":{"horizontal":"min","vertical":"min"},"cornerRadius":0,"fills":[{"color":{"a":1,"b":1,"g":1,"r":1},"type":"solid"}],"height":812,"heightMode":"fixed","id":"screen","layout":null,"layoutChild":{"absolute":false,"grow":false},"limits":{},"locked":false,"name":"Sign in","opacity":1,"parentId":null,"rotation":0,"shadows":[],"strokes":[],"type":"frame","visible":true,"width":375,"widthMode":"fixed","x":0,"y":0},"title":{"blendMode":"normal","blur":null,"boundVariables":{},"characters":"Welcome back","constraints":{"horizontal":"min","vertical":"min"},"cornerRadius":0,"fills":[{"color":{"a":1,"b":0.08,"g":0.06,"r":0.06},"type":"solid"}],"height":24,"heightMode":"hug","id":"title","layoutChild":{"absolute":false,"grow":false},"limits":{},"locked":false,"name":"Title","opacity":1,"parentId":"card","rotation":0,"shadows":[],"strokes":[],"type":"text","typography":{"fontFamily":"Inter","fontSize":16,"fontWeight":400,"letterSpacing":0,"lineHeight":{"unit":"percent","value":140},"textAlign":"left","verticalAlign":"top"},"visible":true,"width":279,"widthMode":"fill","x":0,"y":0}},"pages":[{"backgroundColor":{"a":1,"b":0.97,"g":0.96,"r":0.96},"children":["screen"],"id":"page1","name":"Page 1"}],"revision":1,"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00.000Z","variables":{}}
    """#

    /// `designDocument` escaped for embedding inside a JSON string literal.
    ///
    /// Every payload below is written as JSON in a Swift string, and the document
    /// is four kilobytes of JSON that has to sit inside one of those as a value.
    /// Escaping it by hand is not a thing anyone should do twice, and getting it
    /// subtly wrong yields a fixture that decodes to nothing.
    private static var designDocumentLiteral: String {
        guard let data = try? JSONEncoder().encode(designDocument),
              let quoted = String(data: data, encoding: .utf8)
        else { return "" }
        // JSONEncoder returns the value *with* its surrounding quotes; the call
        // sites write their own.
        return String(quoted.dropFirst().dropLast())
    }

    /// The account settings row every scenario carries so Settings is populated.
    private static func settings(_ accountID: StorageAccountID) -> StoredRecord {
        record(accountID, "settings", "settings-preview", 3, """
        {"id":"settings-preview","theme":"SYSTEM","accent":"coral","defaultModel":"anthropic:claude-opus-4-8","customInstructions":"Prefer clear, structured answers with short paragraphs.","responseLanguage":"English","uiLocale":"auto","personality":"concise","memoryEnabled":true,"voiceId":null,"favoriteModels":["anthropic:claude-opus-4-8","openai:gpt-5-6"],"emailBudgetAlerts":true,"emailWeeklyDigest":false,"updatedAt":"\(iso(0))"}
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
        {"id":"conv-1","title":"Designing the native sidebar","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":true,"archivedAt":null,"createdAt":"\(iso(-7200))","updatedAt":"\(iso(-480))","lastMessageAt":"\(iso(-480))"}
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
        //
        // The assistant's reply deliberately carries the WIRE FORMAT — a
        // `<juno:memory>` fact and a `<juno:artifact>` block — because a client
        // that renders `content` verbatim shows both to the reader, and that is
        // precisely how they shipped once: `juno` is a legal URI scheme, so
        // `<juno:memory>` came out of Apple's Markdown parser as a coral tappable
        // link labelled "juno:memory" mid-answer. A fixture that only ever
        // carries clean prose cannot catch that.
        out.append(record(a, "message", "msg-1", 1, """
        {"id":"msg-1","conversationId":"conv-1","role":"user","content":"How should the macOS sidebar behave when the window gets narrow?","createdAt":"\(iso(-1200))"}
        """))
        out.append(record(a, "message", "msg-2", 1, """
        {"id":"msg-2","conversationId":"conv-1","role":"assistant","content":"Keep the sidebar resizable with sensible min/max widths, and let NavigationSplitView collapse it automatically at narrow widths. Persist the user's chosen width and the collapsed state across launches.  <juno:memory>Liam prefers native NavigationSplitView behaviour over a hand-rolled sidebar.</juno:memory>  <juno:artifact identifier='sidebar-spec' type='markdown' title='Sidebar behaviour spec'>## Widths\\n\\n- min 220pt, max 360pt</juno:artifact>","reasoning":"The user wants native behavior. NavigationSplitView already handles adaptive collapse; the key is persistence and reasonable bounds so the layout never feels cramped.","model":"anthropic:claude-sonnet-4-6","promptTokens":8421,"completionTokens":612,"costMicroUsd":21400,"createdAt":"\(iso(-600))"}
        """))
        // The same design document as it arrives in a reply: a `<juno:artifact>`
        // block carrying the whole file. This is the only route either app has to
        // its design canvas — the artifacts library opens a stored design
        // document, but the canvas that hosts the editor is opened from the
        // transcript — so a fixture without it leaves that canvas unreachable.
        out.append(record(a, "message", "msg-5", 1, """
        {"id":"msg-5","conversationId":"conv-1","role":"user","content":"Draft the sign-in screen for the phone.","createdAt":"\(iso(-540))"}
        """))
        out.append(record(a, "message", "msg-6", 1, """
        {"id":"msg-6","conversationId":"conv-1","role":"assistant","content":"Here it is — a 375×812 frame with the card centred and the primary action at the bottom of it.  <juno:artifact identifier='signin-screen' type='design' title='Sign-in screen'>\(designDocumentLiteral)</juno:artifact>","model":"anthropic:claude-sonnet-4-6","promptTokens":9120,"completionTokens":880,"costMicroUsd":24100,"createdAt":"\(iso(-480))"}
        """))
        out.append(record(a, "message", "msg-3", 1, """
        {"id":"msg-3","conversationId":"conv-proj","role":"user","content":"Summarize the latest quasar observations for the report.","createdAt":"\(iso(-1800))"}
        """))
        out.append(record(a, "message", "msg-4", 1, """
        {"id":"msg-4","conversationId":"conv-proj","role":"assistant","content":"The latest observations show variable X-ray brightness consistent with an accreting supermassive black hole. I've grouped them by epoch below.","reasoning":"Grouping by epoch makes the trend legible for a report audience.","model":"anthropic:claude-sonnet-4-6","createdAt":"\(iso(-1200))"}
        """))

        // Projects (one starred).
        out.append(record(a, "project", "proj-1", 8, """
        {"id":"proj-1","name":"Astro research","nameSource":"user","instructions":"\(promptShapedInstructions)","starred":true,"createdAt":"\(iso(-200000))","updatedAt":"\(iso(-1200))"}
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

        // Pictures *on messages*: the photo the reader attached to a question
        // and the picture Juno generated in its answer. The transcript never
        // rendered either before — `NativeChatMessage` had no attachments at
        // all — so these are what let the image rows and the viewer be looked
        // at. The bytes are served by `PreviewImageFixtures`.
        out.append(record(a, "message", "msg-7", 1, """
        {"id":"msg-7","conversationId":"conv-1","role":"user","content":"Here's the view from the office tonight — can you make a poster-style version of it?","createdAt":"\(iso(-420))"}
        """))
        out.append(record(a, "message", "msg-8", 1, """
        {"id":"msg-8","conversationId":"conv-1","role":"assistant","content":"Here's a poster take on it — concentric rings picking up the sunset's coral, on the same warm ground the app uses. Tap it to see it full size, or ask for a different palette.","model":"openai:gpt-image-2","promptTokens":140,"completionTokens":0,"costMicroUsd":42000,"createdAt":"\(iso(-380))"}
        """))
        out.append(record(a, "attachment", "\(PreviewImageFixtures.userPhotoID)", 2, """
        {"id":"\(PreviewImageFixtures.userPhotoID)","conversationId":"conv-1","messageId":"msg-7","projectId":null,"kind":"IMAGE","fileName":"IMG_4821.jpg","mimeType":"image/jpeg","size":1830000,"width":1200,"height":800,"createdAt":"\(iso(-420))"}
        """))
        out.append(record(a, "attachment", "\(PreviewImageFixtures.generatedID)", 2, """
        {"id":"\(PreviewImageFixtures.generatedID)","conversationId":"conv-1","messageId":"msg-8","projectId":null,"kind":"IMAGE","fileName":"poster.png","mimeType":"image/png","size":920000,"width":1024,"height":1024,"createdAt":"\(iso(-380))"}
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

        // A DESIGN artifact, which nothing in either harness could reach before.
        //
        // The design screen is the one surface with no fixture behind it, and the
        // consequence was not theoretical: the bundled editor threw on mount on
        // both platforms for as long as it has existed, and neither the Mac's
        // capture set nor the phone's could show it, because there was no design
        // document in the world either app previews. A screen nobody can open is
        // a screen nobody looks at.
        out.append(record(a, "artifact", "art-design", 2, """
        {"id":"art-design","conversationId":"conv-1","messageId":"msg-6","identifier":"signin-screen","title":"Sign-in screen","type":"DESIGN","language":null,"currentVersion":1,"createdAt":"\(iso(-90000))","updatedAt":"\(iso(-900))"}
        """))
        out.append(record(a, "artifact_version", "artv-design", 1, """
        {"id":"artv-design","artifactId":"art-design","version":1,"content":"\(designDocumentLiteral)","createdAt":"\(iso(-90000))"}
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

    /// Realistic, varied conversation titles for the dense-list scenario.
    private static let manyTitles = [
        "Designing the native sidebar", "Astro report draft", "Weekend trip planning",
        "Swift optionals deep dive", "Portfolio redesign", "SQLite migration plan",
        "Liquid Glass experiments", "Quarterly OKRs", "Dinner recipe ideas",
        "Refactoring the sync engine", "SwiftUI layout bugs", "Marketing copy review",
        "Reading list for July", "API contract questions", "Onboarding flow rewrite",
        "Dark mode color audit", "Interview prep notes", "Bug triage backlog",
        "Vacation itinerary", "Accessibility checklist",
    ]

    /// Realistic, varied project names for the dense-list scenario.
    private static let manyProjectNames = [
        "Astro research", "Native apps", "Portfolio site", "Q3 planning",
        "Recipe collection", "Home renovation", "Reading notes", "Trip logistics",
        "Design system", "Interview prep", "Side project", "Budget tracker",
        "Machine learning", "Marketing site", "Open source", "Course notes",
        "Client work", "Personal wiki", "Photo archive", "Music theory",
        "Fitness plan", "Book draft", "Garden log", "Language study",
    ]

    private static func manyRecords(_ a: StorageAccountID) -> [StoredRecord] {
        var out: [StoredRecord] = [settings(a), memorySummary(a)]
        for i in 0..<40 {
            let title = manyTitles[i % manyTitles.count]
            out.append(record(a, "conversation", "conv-\(i)", UInt64(i + 1), """
            {"id":"conv-\(i)","title":"\(title)","model":"anthropic:claude-sonnet-4-6","kind":"chat","pinned":\(i < 2),"archivedAt":null,"createdAt":"\(iso(-Double(i) * 3600))","updatedAt":"\(iso(-Double(i) * 60))","lastMessageAt":"\(iso(-Double(i) * 60))"}
            """))
        }
        for i in 0..<24 {
            let name = manyProjectNames[i % manyProjectNames.count]
            out.append(record(a, "project", "proj-\(i)", UInt64(i + 1), """
            {"id":"proj-\(i)","name":"\(name)","nameSource":"user","instructions":"Keep answers concise and cite sources for \(name).","starred":\(i % 5 == 0),"createdAt":"\(iso(-Double(i) * 7200))","updatedAt":"\(iso(-Double(i) * 120))"}
            """))
        }
        for i in 0..<30 {
            let names = ["diagram", "report", "notes", "budget", "spec", "mockup", "export", "brief"]
            let name = "\(names[i % names.count])-\(i)"
            out.append(record(a, "attachment", "file-\(i)", UInt64(i + 1), """
            {"id":"file-\(i)","conversationId":null,"messageId":null,"projectId":"proj-\(i % 24)","kind":"\(i % 3 == 0 ? "IMAGE" : "FILE")","fileName":"\(name).\(i % 3 == 0 ? "png" : "pdf")","mimeType":"\(i % 3 == 0 ? "image/png" : "application/pdf")","size":\(10000 + i * 5000),"width":null,"height":null,"createdAt":"\(iso(-Double(i) * 3600))"}
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
