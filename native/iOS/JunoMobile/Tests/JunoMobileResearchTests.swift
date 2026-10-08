import JunoChatKit
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import UIKit
import XCTest

@testable import JunoMobile

/// Deep Research on the phone: the report the reader opens, and — with
/// `JUNO_SNAPSHOT_DIR` set — offscreen renders of the working view, the
/// report's card and the reader at iPhone size, light and dark.
@MainActor
final class JunoMobileResearchTests: XCTestCase {
    func testTheReportAnAnswerCarriesOpensWithItsSectionsAndSources() throws {
        let report = PreviewResearch.report
        XCTAssertEqual(report.title, "Heat pumps in a 1930s solid-wall semi")
        XCTAssertEqual(report.id, "message:a-heat")
        XCTAssertEqual(report.sources.count, 6)
        XCTAssertEqual(report.citationCount, 6)
        XCTAssertEqual(report.headings.first?.title, "The short answer")
        XCTAssertFalse(report.headings.contains { $0.title == report.title }, "the title is the cover's, not a section")
        XCTAssertEqual(report.question, PreviewResearch.question)
        XCTAssertNotNil(report.lede)
    }

    func testTheInChatTurnReadsAsAWorkingRun() {
        let run = NativeResearchRun.inChat(message: PreviewResearch.liveMessage(), live: true, question: PreviewResearch.question)
        XCTAssertEqual(run.phase, .reading)
        XCTAssertEqual(run.questions.count, 4)
        XCTAssertEqual(run.sources.first?.title, PreviewResearch.sources.first?.title, "pages keep their own titles")
        XCTAssertEqual(run.goal, PreviewResearch.question)
    }

    func testTheReportExportsAsAPDF() throws {
        let data = try XCTUnwrap(NativeResearchReportPDF.data(for: PreviewResearch.report))
        XCTAssertTrue(data.starts(with: Array("%PDF".utf8)))
    }

    // MARK: Snapshots

    func testSnapshots() throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render the research snapshots.")
        }
        let directory = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            try render(
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    NativeResearchLiveView(
                        run: NativeResearchRun.inChat(
                            message: PreviewResearch.liveMessage(), live: true, question: PreviewResearch.question
                        ),
                        actions: NativeResearchLiveActions(stop: {}),
                        compact: true,
                        frozenElapsed: 188
                    )
                }
                .padding(.horizontal, JunoSpace.regular),
                name: "ios-research-live-inchat-\(suffix)", style: style
            )
            try render(
                NativeResearchLiveView(
                    run: PreviewResearch.liveRun,
                    actions: NativeResearchLiveActions(stop: {}, pause: {}, guide: { _ in nil }),
                    compact: true,
                    frozenElapsed: 252
                )
                .padding(.horizontal, JunoSpace.regular),
                name: "ios-research-live-run-\(suffix)", style: style
            )
            try render(
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    Text(PreviewResearch.answerProse)
                        .junoFont(size: 15, relativeTo: .body)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                    NativeResearchReportCard(content: .report(PreviewResearch.report), open: {})
                    NativeResearchReportCard(
                        content: .writing(title: "Heat pumps in a 1930s solid-wall semi", words: 1_240, section: "What it costs"),
                        open: nil
                    )
                }
                .padding(JunoSpace.regular),
                name: "ios-research-card-\(suffix)", style: style
            )
            try render(
                JunoMobileResearchReportView(report: PreviewResearch.report, close: {}),
                name: "ios-research-reader-\(suffix)", style: style, height: 852
            )
            try render(
                NativeResearchReportArticle(report: PreviewResearch.report, audit: PreviewResearch.audit, compact: true)
                    .padding(.horizontal, JunoSpace.roomy)
                    .padding(.vertical, JunoSpace.section),
                name: "ios-research-article-\(suffix)", style: style
            )
        }
        try render(
            NativeResearchReportArticle(report: PreviewResearch.report, compact: true)
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.vertical, JunoSpace.section)
                .environment(\.dynamicTypeSize, .accessibility1),
            name: "ios-research-article-ax1-light", style: .light, height: 1_800
        )
    }

    /// Hosts the view in a window on the app's own scene, never shown, and
    /// draws its hierarchy — which, unlike `ImageRenderer`, draws scroll views
    /// and navigation bars for real.
    private func render<V: View>(
        _ view: V, name: String, style: UIUserInterfaceStyle, width: CGFloat = 393, height: CGFloat? = nil
    ) throws {
        let root = view
            .fixedSize(horizontal: false, vertical: height == nil)
            .frame(width: width, height: height, alignment: .top)
            .background(Color.junoCanvas)
            .environment(\.locale, Locale(identifier: "en_US"))
            .transaction { $0.disablesAnimations = true }
        let host = UIHostingController(rootView: root)
        host.overrideUserInterfaceStyle = style
        let fitted = host.sizeThatFits(in: CGSize(width: width, height: height ?? 10_000))
        let size = CGSize(width: width, height: height ?? max(1, fitted.height))
        // The host app's scene can connect a moment after the first test
        // starts; wait for it rather than fail the render.
        let deadline = Date().addingTimeInterval(10)
        while UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).isEmpty, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: size.width, height: size.height)
        window.overrideUserInterfaceStyle = style
        window.rootViewController = host
        window.windowLevel = .normal - 1
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds, format: format).image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        let data = try XCTUnwrap(image.pngData())
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }
}
