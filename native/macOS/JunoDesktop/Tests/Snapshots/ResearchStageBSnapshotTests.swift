import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 5 Stage B, research (B6), light and dark: the recap card, the
/// clarify gate and the report window — `$JUNO_SNAPSHOT_DIR/<name>-<light|dark>.png`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Phase 5 Stage B research snapshots."
    ),
    .serialized
)
struct ResearchStageBSnapshotTests {
    private typealias F = ResearchStageBFixtures

    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    @Test
    func theLiveResearchWorkspaceDraws() async throws {
        try await render(
            DesktopResearchRow(run: TranscriptSnapshotFixtures.liveResearchRun, open: {})
                .padding(JunoSpace.roomy)
                .environment(\.junoSnapshotRunElapsed, 42),
            name: "research-live-cover"
        )
        try await render(
            DesktopResearchPanel(run: TranscriptSnapshotFixtures.liveResearchRun, control: { _ in }, close: {})
                .frame(height: 680),
            name: "research-live-panel",
            width: 380
        )
    }

    @Test
    func theRecapDraws() async throws {
        try await render(
            TranscriptSnapshotFixtures.column {
                TranscriptSnapshotFixtures.row(F.question)
                ResearchRecapCard(run: F.recapRun, openReport: {}, inspect: {}, dismiss: {})
                ResearchRecapCard(run: F.stoppedRun, openReport: nil, inspect: {}, dismiss: {})
            },
            name: "research-recap"
        )
    }

    @Test
    func theClarifyGateDraws() async throws {
        try await render(
            TranscriptSnapshotFixtures.column {
                TranscriptSnapshotFixtures.row(F.question)
                DesktopResearchClarifyCard(run: F.clarifyRun, atTail: true, busy: false, error: nil, submit: { _ in })
            },
            name: "research-clarify-gate"
        )
    }

    @Test
    func theReportWindowDraws() async throws {
        let document = try #require(ResearchReportDocument(run: F.recapRun))
        try await render(
            VStack(spacing: 0) {
                F.titleBar(document)
                ResearchReportReader(document: document)
                    .frame(height: 672)
            }
            .junoAccentTint(),
            name: "research-report-window",
            width: 880
        )
    }

    private func render<V: View>(_ view: V, name: String, width: CGFloat = TranscriptSnapshotRenderer.columnWidth) async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: name, width: width, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

@MainActor
enum ResearchStageBFixtures {
    static let start = Date(timeIntervalSince1970: 1_790_000_000)

    static let question = TranscriptSnapshotFixtures.message(
        "q-heat", .user, "Research whether a heat pump makes sense for a 1930s semi with solid walls."
    ).with { $0.createdAt = start }

    static let sources: [NativeResearchRun.Source] = [
        .init(id: "s1", url: URL(string: "https://www.energysavingtrust.org.uk/advice/air-source-heat-pumps/")!, title: "Air source heat pumps", read: true),
        .init(id: "s2", url: URL(string: "https://www.gov.uk/apply-boiler-upgrade-scheme")!, title: "Apply for the Boiler Upgrade Scheme", read: true),
        .init(id: "s3", url: URL(string: "https://www.historicengland.org.uk/advice/technical-advice/retrofit-and-energy-efficiency-in-historic-buildings/")!, title: "Retrofit and energy efficiency in historic buildings", read: true),
        .init(id: "s4", url: URL(string: "https://www.heatpumps.org.uk/resources/")!, title: "Heat Pump Association resources", read: true),
        .init(id: "s5", url: URL(string: "https://www.which.co.uk/reviews/air-source-heat-pumps")!, title: "Air source heat pumps explained", read: false),
    ]

    static let report = """
    <juno:artifact identifier="research-report-rr_heat" type="MARKDOWN" title="Heat pumps in a 1930s solid-wall semi">
    A heat pump can work in a 1930s solid-wall semi, but only once the heat loss is brought down and the radiators are sized for lower flow temperatures [1].

    ## Bottom line

    Insulate the loft and draught-proof first; most homes of this age then need two or three larger radiators rather than a full refit [1][3].

    ## What it costs

    Typical installs quoted between £10,400 and £14,900 before the grant; the Boiler Upgrade Scheme takes £7,500 off [2].

    ### Running costs

    At a seasonal efficiency near 3, running costs land close to a modern gas boiler's [4].

    ## Solid walls

    Internal wall insulation helps most but needs care with damp; breathable materials are advised for older brick [3].

    ## What to do next

    Ask two installers for a room-by-room heat loss survey and compare their radiator plans side by side.
    </juno:artifact>
    """

    /// A finished web background run: a report on the run and no message.
    static let recapRun: NativeResearchRun = {
        var run = NativeResearchRun(
            id: "rr_heat", conversationID: "conv-1", goal: "Heat pump for a 1930s semi with solid walls",
            state: "completed", title: "Heat pumps for older homes", phase: .done,
            questions: [
                .init(id: "o1", question: "Will it heat the house in January?", status: "covered"),
                .init(id: "o2", question: "What does it cost after grants?", status: "covered"),
                .init(id: "o3", question: "Do solid walls rule it out?", status: "partial"),
            ],
            counts: .init(found: 5, read: 4, cited: 4, searches: 7, pages: 4),
            createdAt: start.addingTimeInterval(20), finishedAt: start.addingTimeInterval(20 + 11 * 60 + 38),
            sources: sources, report: report
        )
        run.costMicroUsd = 377_214
        run.audit = .init(claims: 11, supported: 9, partiallySupported: 1, unsupported: 0, contradicted: 0, unverified: 1)
        return run
    }()

    /// Stopped by hand before it wrote anything.
    static let stoppedRun: NativeResearchRun = {
        var run = NativeResearchRun(
            id: "rr_stop", conversationID: "conv-1", goal: "Compare heat pump installers near Leeds",
            state: "cancelled", phase: .stopped,
            counts: .init(found: 3, read: 1),
            createdAt: start.addingTimeInterval(900), finishedAt: start.addingTimeInterval(900 + 142),
            sources: Array(sources.prefix(3)).enumerated().map { index, source in
                .init(id: source.id, url: source.url, title: source.title, read: index == 0)
            }
        )
        run.costMicroUsd = 41_730
        return run
    }()

    /// Waiting on the reader to fill in what the goal left open.
    static let clarifyRun: NativeResearchRun = {
        var run = NativeResearchRun(
            id: "rr_clarify", conversationID: "conv-1", userMessageID: "q-heat",
            goal: "Research whether a heat pump makes sense for a 1930s semi with solid walls.",
            state: "awaiting_clarification", phase: .awaitingClarification
        )
        run.clarifications = [
            .init(
                id: "c1", question: "Where is the house?", why: "Grants, installers and winter design temperatures differ by region.",
                suggestions: ["England", "Scotland", "Wales"], skippable: false
            ),
            .init(id: "c2", question: "How is it heated today?", suggestions: ["Gas boiler", "Oil", "Electric storage"]),
            .init(id: "c3", question: "Anything you have already ruled out?", why: "Juno will leave these out of the comparison."),
        ]
        return run
    }()

    /// The window's title and toolbar as the reader sees them — drawn by the
    /// system in the app, stood in for here because offscreen rendering has
    /// no title bar.
    static func titleBar(_ document: ResearchReportDocument) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 1) {
                Text(document.title)
                    .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                Text(document.subtitle)
                    .junoFont(size: 11, relativeTo: .caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer()
            ForEach([JunoIcon.copy, .download, .printer], id: \.self) { icon in
                JunoIconView(icon, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 28, height: 28)
            }
        }
        .padding(.leading, 84)
        .padding(.trailing, JunoSpace.regular)
        .frame(height: 48)
        .background(Color.junoCanvas)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
    }
}
