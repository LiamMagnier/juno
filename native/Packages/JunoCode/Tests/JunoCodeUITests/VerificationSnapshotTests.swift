import AppKit
import SwiftUI
import XCTest
import JunoCodeCore
import JunoDesignSystem
@testable import JunoCodeUI

/// Lane B's surfaces rendered to PNGs for review by eye: the run report, the
/// recipe card, the recorded checks and the review findings, light and dark.
///
/// Off unless `JUNO_SNAPSHOT_DIR` names a folder, like `StudioSnapshotTests`:
/// hosted offscreen and drawn with `cacheDisplay`, so no screen access at all.
@MainActor
final class VerificationSnapshotTests: XCTestCase {
    private var directory: URL?

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set JUNO_SNAPSHOT_DIR to render Studio snapshots.")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directory = url
    }

    private func page<V: View>(_ content: V) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            content
            Spacer(minLength: 0)
        }
        .frame(maxWidth: Studio.Metrics.measure)
        .padding(Studio.Metrics.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Studio.Surface.canvas)
    }

    func testRenderRunReport() async throws {
        let report = VStack(alignment: .leading, spacing: JunoSpace.section) {
            StudioAssistantMessage(text: "The settings menu now opens on pointerdown, and the outside-click handler ignores the opening press.")
            StudioRunReportRow(event: RunOutcomeEvent(
                endReason: .doneChecked,
                summary: "Done: the settings menu opens on click again.",
                verification: "Checked with `npm run typecheck` and `npx vitest run src/components`",
                checks: [
                    RunOutcomeCheck(label: "npm run typecheck", passed: true, detail: "passed · 11 s · after the last edit"),
                    RunOutcomeCheck(label: "npx vitest run src/components", passed: true, detail: "passed · 38 tests · 9 s · after the last edit"),
                    RunOutcomeCheck(label: "Preview /settings, desktop and phone", passed: true, detail: "no new console errors · menu opened · 2 screenshots"),
                    RunOutcomeCheck(label: "Review", passed: true, detail: "no correctness findings · 1 note"),
                ],
                notChecked: ["Safari (the Preview is WebKit)"],
                left: ["Consider removing the unused onOpenChange prop (src/components/SettingsMenu.tsx:12) (review, P3)"]
            ))
            StudioRunReportRow(event: RunOutcomeEvent(
                endReason: .checksFailing,
                summary: "The menu opens, but one test still fails.",
                verification: "`npm test` still fails (2 tests)",
                checks: [
                    RunOutcomeCheck(label: "npm test", passed: false, detail: "failed · 2 of 38 tests failed · 9 s · after the last edit"),
                ],
                notChecked: ["Not checked since the last edit"]
            ))
        }
        for dark in [false, true] {
            try await render(page(report), size: CGSize(width: 860, height: 720), dark: dark, name: "verify-run-report-\(dark ? "dark" : "light")")
        }
    }

    func testRenderVerifyRecipeCard() async throws {
        let recipe = VerifyRecipe(checks: [
            VerifyCheck(id: "web-typecheck", kind: .typecheck, run: .shell("npm run typecheck"), paths: ["src/**"]),
            VerifyCheck(id: "web-lint", kind: .lint, run: .shell("npm run lint"), paths: ["src/**"]),
            VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), targeted: "npx vitest run {tests}", paths: ["src/**"]),
            VerifyCheck(id: "code-test", kind: .test, run: .argv(["swift", "test", "--package-path", "native/Packages/JunoCode"]), paths: ["native/Packages/JunoCode/**"]),
            VerifyCheck(id: "apps-api-go-test", kind: .test, run: .argv(["go", "test", "./..."]), paths: ["apps/api/**"], cwd: "apps/api"),
        ])
        for (ticked, name) in [(false, "off"), (true, "on")] {
            let model = VerificationModel()
            model.preview(.init(recipe: recipe, kind: .discovered), runWithoutAsking: ticked)
            for dark in [false, true] {
                try await render(
                    page(StudioVerifyRecipeCard(model: model, accept: {})),
                    size: CGSize(width: 860, height: 560),
                    dark: dark,
                    name: "verify-recipe-card-\(name)-\(dark ? "dark" : "light")"
                )
            }
        }
        let changed = VerificationModel()
        changed.preview(.init(recipe: VerifyRecipe(checks: [recipe.checks[2]]), kind: .changed(digest: "abc")))
        try await render(page(StudioVerifyRecipeCard(model: changed, accept: {})), size: CGSize(width: 860, height: 360), dark: false, name: "verify-recipe-card-changed-light")
    }

    func testRenderVerificationRows() async throws {
        let rows = VStack(alignment: .leading, spacing: JunoSpace.regular) {
            StudioAssistantMessage(text: "Running the checks for the files I changed.")
            StudioVerificationRow(record: VerificationRecord(
                checkID: "web-typecheck", command: "npm run typecheck", kind: .typecheck, exitCode: 0, passed: true,
                workspaceRevision: 4, durationMs: 11_200, excerpt: "passed"
            ))
            StudioVerificationRow(record: VerificationRecord(
                checkID: "web-test", command: "npx vitest run src/components/SettingsMenu.test.tsx", kind: .test, exitCode: 1, passed: false,
                workspaceRevision: 4, durationMs: 9_100,
                excerpt: "2 of 38 tests failed\n FAIL  src/components/SettingsMenu.test.tsx > opens on click\nAssertionError: expected menu to be open\n ❯ src/components/SettingsMenu.test.tsx:41:22"
            ))
            StudioVerificationRow(record: VerificationRecord(
                command: "swift test --package-path native/Packages/JunoCode", kind: .test, exitCode: 0, passed: true,
                workspaceRevision: 5, durationMs: 94_000, excerpt: "1,322 tests passed"
            ))
        }
        for dark in [false, true] {
            try await render(page(rows), size: CGSize(width: 860, height: 420), dark: dark, name: "verify-rows-\(dark ? "dark" : "light")")
        }
    }

    func testRenderReviewFindingsRow() async throws {
        let rows = VStack(alignment: .leading, spacing: JunoSpace.section) {
            StudioReviewFindingsRow(record: ReviewRecord(
                round: 1,
                findings: [
                    ReviewFinding(priority: .p3, confidence: 0.7, path: "src/components/SettingsMenu.tsx", line: 12, title: "The onOpenChange prop is unused"),
                    ReviewFinding(priority: .p1, confidence: 0.85, path: "src/components/SettingsMenu.tsx", line: 41,
                                  title: "Menu closes on the same pointerdown that opens it",
                                  body: "The document listener added in the same tick sees the opening press and closes the menu."),
                    ReviewFinding(priority: .p2, confidence: 0.62, title: "Phone width is not handled", criterion: "c2"),
                ],
                overall: .incorrect,
                workspaceRevision: 4
            ))
            StudioReviewFindingsRow(record: ReviewRecord(round: 2, findings: [], overall: .correct, workspaceRevision: 5))
        }
        for dark in [false, true] {
            try await render(page(rows), size: CGSize(width: 860, height: 420), dark: dark, name: "verify-review-findings-\(dark ? "dark" : "light")")
        }
    }

    // MARK: - Rendering (the StudioSnapshotTests pattern)

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) async throws {
        guard let directory else { return }
        let hosting = NSHostingView(
            rootView: view
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, dark ? .dark : .light)
                .environment(\.junoSnapshotOpaqueGlass, true)
        )
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: CGRect(origin: CGPoint(x: -10_000, y: -10_000), size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        for _ in 0..<6 {
            try await Task.sleep(for: .milliseconds(80))
            hosting.layoutSubtreeIfNeeded()
        }
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            XCTFail("No bitmap for \(name)")
            return
        }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try data.write(to: directory.appendingPathComponent(name + ".png"))
        window.contentView = nil
    }
}
