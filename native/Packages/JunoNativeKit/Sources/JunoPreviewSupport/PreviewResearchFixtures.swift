import Foundation
import JunoChatKit

/// One research, start to finish, for previews and offscreen snapshots on
/// both platforms: the question, the run while it works (as a background run
/// and as the in-chat rows today's server sends), and the finished answer
/// with its report.
public enum PreviewResearch {
    public static let start = Date(timeIntervalSince1970: 1_791_460_800)

    public static let question = "Does a heat pump make sense for a 1930s semi with solid walls, and what would it cost?"

    public static let sources: [NativeResearchRun.Source] = [
        .init(id: "s1", url: URL(string: "https://energysavingtrust.org.uk/advice/air-source-heat-pumps/")!, title: "Air source heat pumps: costs and savings", read: true),
        .init(id: "s2", url: URL(string: "https://www.gov.uk/apply-boiler-upgrade-scheme")!, title: "Apply for the Boiler Upgrade Scheme", read: true),
        .init(id: "s3", url: URL(string: "https://historicengland.org.uk/advice/technical-advice/retrofit-and-energy-efficiency-in-historic-buildings/")!, title: "Retrofit and energy efficiency in historic buildings", read: true),
        .init(id: "s4", url: URL(string: "https://www.heatpumps.org.uk/resources/")!, title: "Heat Pump Association: consumer resources", read: true),
        .init(id: "s5", url: URL(string: "https://www.nesta.org.uk/report/how-to-reduce-the-cost-of-heat-pumps/")!, title: "How to reduce the cost of heat pumps", read: true),
        .init(id: "s6", url: URL(string: "https://www.theguardian.com/environment/heat-pumps-older-homes")!, title: "Can a heat pump heat an old house?", read: true),
        .init(id: "s7", url: URL(string: "https://www.which.co.uk/reviews/air-source-heat-pumps")!, title: "Air source heat pumps explained", read: false),
        .init(id: "s8", url: URL(string: "https://www.ofgem.gov.uk/environmental-and-social-schemes/boiler-upgrade-scheme-bus")!, title: "Boiler Upgrade Scheme (BUS)", read: false),
        .init(id: "s9", url: URL(string: "https://www.mcscertified.com/find-an-installer/")!, title: "Find an MCS certified installer", read: false),
        .init(id: "s10", url: URL(string: "https://www.cse.org.uk/advice/solid-wall-insulation/")!, title: "Solid wall insulation", read: false),
        .init(id: "s11", url: URL(string: "https://www.ukgbc.org.uk/resources/retrofit-playbook/")!, title: "Retrofit playbook", read: false),
        .init(id: "s12", url: URL(string: "https://www.electrifiedthinking.co.uk/heat-loss-survey")!, title: "What a room-by-room heat loss survey tells you", read: false),
    ]

    public static let questions: [NativeResearchRun.Question] = [
        .init(id: "o1", question: "Will it keep the house warm in January?", status: "covered"),
        .init(id: "o2", question: "What does an install cost after the grant?", status: "covered"),
        .init(id: "o3", question: "Do solid walls rule it out, or just change the plan?", status: "searching"),
        .init(id: "o4", question: "How do running costs compare with a gas boiler?", status: "pending"),
    ]

    /// A web background run, mid-way: reading, with evidence coming in.
    public static let liveRun: NativeResearchRun = {
        var run = NativeResearchRun(
            id: "rr_heat_live", conversationID: "conv-research", userMessageID: "q-heat",
            goal: question, state: "investigating", title: "Heat pumps in a 1930s solid-wall semi",
            phase: .reading, phaseDomain: "historicengland.org.uk",
            approach: "Compare what government and trade bodies publish on costs and grants with what installers and owners of pre-war homes report, then check what solid walls change.",
            questions: questions,
            counts: .init(found: 12, read: 6, cited: 0, searches: 9, pages: 6),
            workingMs: 252_000,
            fetchedAt: start.addingTimeInterval(260),
            createdAt: start,
            findings: [
                .init(
                    id: "f1",
                    claim: "Most 1930s semis need two or three larger radiators rather than a full refit once the loft is insulated.",
                    quote: "",
                    url: URL(string: "https://energysavingtrust.org.uk/advice/air-source-heat-pumps/"),
                    title: "Air source heat pumps"
                ),
                .init(
                    id: "f2",
                    claim: "The Boiler Upgrade Scheme takes £7,500 off an air source install in England and Wales.",
                    quote: "",
                    url: URL(string: "https://www.gov.uk/apply-boiler-upgrade-scheme"),
                    title: "Boiler Upgrade Scheme"
                ),
            ],
            sources: sources,
            steering: [.init(text: "Focus on England; the house is in Leeds.", appliedAtRound: nil)]
        )
        run.derivesPhase = true
        run.lastSeq = 41
        run.maxSeq = 41
        return run
    }()

    // MARK: In the chat

    /// The rows today's server streams for an in-chat research turn
    /// (`deep-research.ts` `toActivity`), as far as reading and reviewing.
    public static let activity: [NativeChatActivity] = {
        var rows: [NativeChatActivity] = [
            .init(id: "a0", kind: .reasoning, title: "Working out what to look up", detail: nil, url: nil),
            .init(id: "a1", kind: .reasoning, title: "Planned the research: 4 questions to answer",
                  detail: "Weigh official cost and grant figures against what owners of pre-war homes report.", url: nil),
            .init(id: "a2", kind: .reasoning, title: "Starting the research", detail: nil, url: nil),
        ]
        for (index, question) in questions.enumerated() {
            rows.append(.init(id: "w\(index)", kind: .reasoning, title: "Sending a researcher", detail: question.question, url: nil))
        }
        let queries = ["heat pump 1930s semi solid walls", "boiler upgrade scheme 2026 amount", "heat pump running cost vs gas uk"]
        for (index, query) in queries.enumerated() {
            rows.append(.init(id: "q\(index)", kind: .search, title: "Searching the web", detail: query, url: nil))
        }
        for (index, source) in sources.prefix(6).enumerated() {
            rows.append(.init(id: "v\(index)", kind: .visit, title: "Reading source", detail: source.title, url: source.url.absoluteString))
        }
        rows.append(.init(id: "r1", kind: .context, title: "A researcher reported back", detail: "Loft insulation and larger radiators usually suffice in pre-war semis.", url: nil))
        rows.append(.init(id: "r2", kind: .reasoning, title: "Lead review: the evidence is ready", detail: "14 sourced findings", url: nil))
        return rows
    }()

    public static let citedSources: [NativeChatSource] = sources.prefix(6).map {
        NativeChatSource(title: $0.title, url: $0.url, snippet: "", cited: true, origin: "research")
    }

    public static let reportBody = """
    # Heat pumps in a 1930s solid-wall semi

    A heat pump can heat a 1930s solid-wall semi through a British January, but only once the heat loss is brought down and the radiators are sized for a lower flow temperature [1][3]. With the £7,500 grant, a typical install lands between £3,000 and £7,500 [2][5].

    ## The short answer

    Insulate the loft and draught-proof first. Most homes of this age then need two or three larger radiators rather than a full refit, and a correctly sized pump runs at a seasonal efficiency near 3 [1][4].

    ## Will it keep the house warm?

    Installers design to the local winter temperature, around −2 °C in Leeds, and a room-by-room heat loss survey sets the size [4]. Owners of pre-war homes report the house stays warm when the system is left running at a low, steady temperature rather than switched on and off like a boiler [6].

    ### Hot water

    A 200-litre cylinder covers a family of four; it needs a cupboard about 60 cm square [1].

    ## What it costs

    | Item | Typical cost | After grant |
    | --- | --- | --- |
    | Air source heat pump, installed | £10,500–£14,900 | £3,000–£7,400 |
    | Two or three larger radiators | £600–£1,500 | £600–£1,500 |
    | Loft insulation top-up | £300–£600 | £300–£600 |

    The Boiler Upgrade Scheme pays £7,500 to the installer, who takes it off the quote; it is open to homes in England and Wales with a valid EPC [2].

    ## Do solid walls rule it out?

    No, but they change the order of work. Internal wall insulation cuts heat loss the most and needs breathable materials to avoid damp in older brick [3]. Many owners skip walls entirely and accept a slightly larger pump [5][6].

    ## Running costs

    At a seasonal efficiency near 3 and today's tariffs, running costs land close to a modern gas boiler's, and below it on a heat-pump tariff [4][5].

    ## What to do next

    1. Ask two MCS-certified installers for a room-by-room heat loss survey.
    2. Compare their radiator plans side by side, not just the headline price.
    3. Top up the loft insulation before the survey; it can shrink the pump.
    """

    public static let answerProse = "Yes — a heat pump can heat a 1930s solid-wall semi through January once the loft is insulated and two or three radiators are upsized for a lower flow temperature [1][3]. After the £7,500 Boiler Upgrade Scheme grant, a typical install costs £3,000–£7,500 [2][5], and running costs land close to a modern gas boiler's [4]."

    /// The finished in-chat answer: prose, then the report artifact.
    public static func reportMessage(conversationID: String = "conv-research") -> NativeChatMessage {
        NativeChatMessage(
            id: "a-heat", conversationID: conversationID, clientID: nil, role: .assistant,
            content: answerProse + "\n\n<juno:artifact identifier=\"research-report\" type=\"MARKDOWN\" title=\"Heat pumps in a 1930s solid-wall semi\" language=\"md\">\n" + reportBody + "\n</juno:artifact>",
            reasoning: nil, model: "anthropic:claude-opus-4-6", createdAt: start.addingTimeInterval(700), revision: 1,
            sources: citedSources, activity: activity
        )
    }

    /// The in-chat turn while it works: reading, before the report starts.
    public static func liveMessage(conversationID: String = "conv-research", writing: Bool = false) -> NativeChatMessage {
        var content = ""
        if writing {
            let partial = reportBody.components(separatedBy: "## What it costs").first ?? reportBody
            content = answerProse + "\n\n<juno:artifact identifier=\"research-report\" type=\"MARKDOWN\" title=\"Heat pumps in a 1930s solid-wall semi\" language=\"md\">\n" + partial
        }
        return NativeChatMessage(
            id: writing ? "a-heat-writing" : "a-heat-live", conversationID: conversationID, clientID: nil, role: .assistant,
            content: content, reasoning: nil, model: "anthropic:claude-opus-4-6", createdAt: start.addingTimeInterval(1),
            revision: 0, sources: writing ? citedSources : [], isPending: true,
            activity: writing ? activity : Array(activity.dropLast(2)),
            runStartedAt: start, answerStartedAt: writing ? start.addingTimeInterval(400) : nil,
            researchRequested: true
        )
    }

    public static func questionMessage(conversationID: String = "conv-research") -> NativeChatMessage {
        NativeChatMessage(
            id: "q-heat", conversationID: conversationID, clientID: nil, role: .user,
            content: question, reasoning: nil, model: nil, createdAt: start, revision: 1
        )
    }

    /// The report the finished answer carries.
    public static var report: NativeResearchReport {
        NativeResearchReport(message: reportMessage(), question: question)!
    }

    /// The citation check on the finished answer.
    public static let audit = NativeResearchAudit(claims: [
        .init(text: "A heat pump can heat a 1930s solid-wall semi", label: "supported", links: [
            .init(sourceIndex: 1, stance: "supports", passage: "Most homes built before 1940 can be heated well by a heat pump once heat loss is reduced and emitters are sized correctly."),
        ]),
        .init(text: "The Boiler Upgrade Scheme pays £7,500", label: "supported", links: [
            .init(sourceIndex: 2, stance: "supports", passage: "You could get £7,500 off the cost and installation of an air source heat pump."),
        ]),
        .init(text: "Internal wall insulation needs breathable materials", label: "partially supported", links: [
            .init(sourceIndex: 3, stance: "supports", passage: "Vapour-open insulation systems reduce the risk of trapping moisture in solid masonry."),
        ]),
    ])
}
