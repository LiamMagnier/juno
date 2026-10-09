import AppKit
import Foundation
import JunoChatKit
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import Testing
import WebKit

@testable import JunoDesktop

/// The exercise card and Run on the Mac (owner, 2026-10-09: "On IOS & MacOS
/// add the new exercices tool and the ability to run code like we did on the
/// website"), light and dark — `$JUNO_SNAPSHOT_DIR/practice-<name>-<light|dark>.png`.
///
/// A run's output is the web's own console document (``PreviewConsoleDocs``,
/// generated from src/lib/sandbox/console-doc.ts) actually run in a web view:
/// SQLite and Pyodide load from jsdelivr, so this suite needs the network. The
/// picture reaches the card through ``JunoCodeRunStills``, because a web view
/// renders out of process and `cacheDisplay` cannot photograph it.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the practice snapshots."
    ),
    .serialized
)
struct PracticeSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    private static let question = TranscriptSnapshotFixtures.message(
        "p-q", .user, "Donne-moi des exercices SQL sur la base HR, avec la possibilité de tester mes requêtes."
    )

    @Test
    func theExerciseCardDraws() async throws {
        let answer = TranscriptSnapshotFixtures.message("p-ex", .assistant, PreviewPracticeFixtures.exerciseAnswer)
        for (state, name) in [("empty", "exercise-empty"), ("typed", "exercise-typed"), ("run", "exercise-run"), ("sent", "exercise-sent")] {
            try await render(name: name, blocks: []) {
                TranscriptSnapshotFixtures.column {
                    TranscriptSnapshotFixtures.row(Self.question)
                    TranscriptSnapshotFixtures.row(answer, newest: true)
                }
                .environment(\.junoLiveUIExerciseSeeds, PreviewPracticeFixtures.seeds(for: state))
                .environment(\.junoLiveUIHost, JunoLiveUIHost(onPrompt: { _ in }))
            }
        }
    }

    @Test
    func codeBlocksRunAndAreColoured() async throws {
        let answer = TranscriptSnapshotFixtures.message("p-code", .assistant, PreviewPracticeFixtures.codeAnswer)
        for (blocks, name) in [(Set<String>(), "code-coloured"), (["sql"], "sql-run"), (["python"], "python-run")] {
            try await render(name: name, blocks: blocks) {
                TranscriptSnapshotFixtures.column {
                    TranscriptSnapshotFixtures.row(answer, newest: true)
                }
            }
        }
    }

    // MARK: Rendering

    private func render<V: View>(name: String, blocks: Set<String>, @ViewBuilder _ view: () -> V) async throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let dark = appearance == .darkAqua
            let stills = try await Self.stills(dark: dark)
            let url = try await TranscriptSnapshotRenderer.render(
                view()
                    .environment(\.junoCodeRunner, JunoCodeRunner { _, _, _ in throw CancellationError() })
                    .environment(\.junoCodeRunStills, JunoCodeRunStills { language, code, isDark in
                        isDark == dark ? stills[Self.key(language, code)] : nil
                    })
                    .environment(\.junoCodeRunOpensBlocks, blocks),
                name: "practice-\(name)",
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }

    private static func key(_ language: String, _ code: String) -> String {
        language + "\u{0}" + code.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static var cache: [Bool: [String: JunoCodeRunStill]] = [:]

    /// Every fixture document in one appearance, run and photographed once.
    private static func stills(dark: Bool) async throws -> [String: JunoCodeRunStill] {
        if let cached = cache[dark] { return cached }
        var out: [String: JunoCodeRunStill] = [:]
        for doc in PreviewConsoleDocs.all where doc.theme == (dark ? "dark" : "light") {
            out[key(doc.language, doc.code)] = try await ConsoleStill.capture(html: doc.html, dark: dark)
        }
        cache[dark] = out
        return out
    }
}

/// Runs one console document and photographs its output at the height it
/// posts.
@MainActor
private final class ConsoleStill: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private var status: JunoCodeRunStatus?
    private var height: CGFloat = 44

    static func capture(html: String, dark: Bool, width: CGFloat = 760, timeout: TimeInterval = 60) async throws -> JunoCodeRunStill {
        let still = ConsoleStill()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            window.addEventListener('message', function (e) {
              var d = e.data; if (!d || typeof d !== 'object') return;
              if (d.type === 'juno:console-size' || d.type === 'juno:status')
                window.webkit.messageHandlers.still.postMessage({ type: d.type, height: Number(d.height) || 0, status: String(d.status || '') });
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController.add(still, name: "still")
        defer { configuration.userContentController.removeScriptMessageHandler(forName: "still") }
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 420), configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        webView.loadHTMLString(html, baseURL: nil)

        let start = Date()
        while still.status != .done && still.status != .error {
            guard Date().timeIntervalSince(start) < timeout else { throw SnapshotStills.Failure.timedOut }
            try await Task.sleep(for: .milliseconds(100))
        }
        try await Task.sleep(for: .milliseconds(400))
        webView.frame.size.height = min(420, still.height)
        try await Task.sleep(for: .milliseconds(300))
        let image = try await webView.takeSnapshot(configuration: WKSnapshotConfiguration())
        var rect = CGRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
            throw SnapshotStills.Failure.snapshotFailed("no bitmap")
        }
        return JunoCodeRunStill(image: cg, scale: CGFloat(cg.width) / image.size.width, status: still.status ?? .done)
    }

    nonisolated func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let type = body["type"] as? String
        let height = (body["height"] as? NSNumber)?.doubleValue ?? 0
        let status = (body["status"] as? String).flatMap(JunoCodeRunStatus.init(rawValue:))
        MainActor.assumeIsolated {
            if type == "juno:console-size", height > 0 { self.height = CGFloat(height) }
            if type == "juno:status", let status { self.status = status }
        }
    }
}
