import Foundation
import JunoChatKit
import Testing
import WebKit

@testable import JunoDesktop

/// The artifact sandbox, run for real: a scripted page in exactly the web view
/// the transcript's card and the canvas use (``ArtifactRuntimeSandbox``),
/// offscreen, never in a window.
///
/// The Phase 2 brief's addendum asks for this proof. The web's scripted
/// previews are dead in production — its app CSP is inherited into the
/// `srcdoc` frame (Artifacts & Design audit, X-01) — so the Mac does not copy
/// them: its page's own scripts must actually run, in a sandbox with no
/// network, and speak back only through the status and console channels.
@MainActor
@Suite(.serialized)
struct ArtifactRuntimeSandboxTests {
    @Test
    func aScriptedArtifactRunsAndItsScriptsWritesCanBeReadBack() async throws {
        let html = NativeArtifactRuntimeDocument.build(kind: .html, content: """
            <p id="out">not run</p>
            <script>
              document.getElementById('out').textContent = 'ran:' + (6 * 7);
              window.__written = 'by the artifact';
              console.log('hello from the page');
            </script>
            """, language: nil)
        let sandbox = ArtifactRuntimeSandbox(html: html)

        try await waitUntil { sandbox.runtime.status == .done || sandbox.runtime.status == .error }
        #expect(sandbox.runtime.status == .done)
        #expect(try await read(sandbox, "document.getElementById('out').textContent") == "ran:42")
        #expect(try await read(sandbox, "window.__written") == "by the artifact")
        #expect(sandbox.runtime.entries.contains { $0.text == "hello from the page" })
    }

    @Test
    func theSandboxHasNoNetworkAndItsOwnStorage() async throws {
        let html = NativeArtifactRuntimeDocument.build(kind: .html, content: """
            <script>
              localStorage.setItem('theme', 'dark');
              window.__stored = localStorage.getItem('theme');
              var img = new Image();
              img.onload = function () { window.__image = 'reached'; };
              img.onerror = function () { window.__image = 'blocked'; };
              img.src = 'https://www.apple.com/favicon.ico';
              fetch('https://www.apple.com/').then(
                function () { window.__fetch = 'reached'; },
                function () { window.__fetch = 'blocked'; }
              );
              var s = document.createElement('script');
              s.onload = function () { window.__script = 'reached'; };
              s.onerror = function () { window.__script = 'blocked'; };
              s.src = 'https://cdn.tailwindcss.com';
              document.head.appendChild(s);
            </script>
            """, language: nil)
        let sandbox = ArtifactRuntimeSandbox(html: html)

        try await waitUntil { sandbox.runtime.status == .done || sandbox.runtime.status == .error }
        #expect(try await read(sandbox, "window.__stored") == "dark")
        for probe in ["window.__image", "window.__fetch", "window.__script"] {
            try await waitUntil { (try? await read(sandbox, probe))?.isEmpty == false }
            #expect(try await read(sandbox, probe) == "blocked", "\(probe) reached the network")
        }
    }

    @Test
    func aThrowingPageReportsErrorOnTheStatusChannel() async throws {
        let html = NativeArtifactRuntimeDocument.build(
            kind: .html,
            content: "<script>document.getElementById('missing').textContent = 'x';</script>",
            language: nil
        )
        let sandbox = ArtifactRuntimeSandbox(html: html)

        try await waitUntil { sandbox.runtime.status == .error }
        #expect(sandbox.runtime.errorCount == 1)
    }

    // MARK: Helpers

    /// A page value as a string ("" for undefined) — `evaluateJavaScript`
    /// refuses to hand back `undefined` itself.
    private func read(_ sandbox: ArtifactRuntimeSandbox, _ expression: String) async throws -> String {
        let value = try await sandbox.webView.evaluateJavaScript("String((\(expression)) ?? '')")
        return value as? String ?? ""
    }

    private func waitUntil(
        timeout: TimeInterval = 10,
        _ condition: () async -> Bool
    ) async throws {
        let start = Date()
        while await !condition() {
            guard Date().timeIntervalSince(start) < timeout else {
                Issue.record("timed out after \(timeout)s")
                return
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}
