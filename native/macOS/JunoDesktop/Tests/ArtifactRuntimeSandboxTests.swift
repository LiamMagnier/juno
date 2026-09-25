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
/// React, TypeScript and Tailwind run too, from the runtimes the app bundles
/// (`Resources/ArtifactRuntime`): the test host is the app, so its bundle
/// serves them over `juno-runtime:` exactly as the transcript's does.
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

    // MARK: React, TypeScript and Tailwind, from the bundle

    /// A React component with a hook and Tailwind classes compiles with the
    /// bundled Babel, mounts on the bundled React 18 and is styled by the
    /// bundled Tailwind Play — the web's `reactDoc`, with nothing fetched.
    @Test
    func aReactComponentMountsWithItsHookAndTailwindStyles() async throws {
        let html = NativeArtifactRuntimeDocument.build(kind: .react, content: """
            import React, { useState, useEffect } from "react";

            export default function Counter() {
              const [count, setCount] = useState(0);
              useEffect(() => { setCount(6 * 7); }, []);
              return (
                <div id="card" className="p-4 bg-slate-900">
                  <p id="out" className="text-red-600 font-semibold">Count: {count}</p>
                </div>
              );
            }
            """, language: nil)
        let sandbox = ArtifactRuntimeSandbox(html: html)
        // A card's width, so the height channel has a layout to measure (a
        // zero-width page reports nothing).
        sandbox.webView.frame = CGRect(x: 0, y: 0, width: 720, height: 360)

        try await waitUntil { sandbox.runtime.status == .done || sandbox.runtime.status == .error }
        #expect(sandbox.runtime.status == .done)
        #expect(try await read(sandbox, "typeof React + '/' + React.version") == "object/18.3.1")
        // The effect ran after the first render: the hook's state reached the DOM.
        try await waitUntil { await text(sandbox, "#out") == "Count: 42" }
        #expect(await text(sandbox, "#out") == "Count: 42")
        // Tailwind Play writes its stylesheet as the component's classes
        // appear; the computed style is its answer.
        try await waitUntil { await style(sandbox, "#out", "color") == "rgb(220, 38, 38)" }
        #expect(await style(sandbox, "#out", "color") == "rgb(220, 38, 38)")
        #expect(await style(sandbox, "#out", "font-weight") == "600")
        #expect(await style(sandbox, "#card", "padding-top") == "16px")
        #expect(await style(sandbox, "#card", "background-color") == "rgb(15, 23, 42)")
        #expect(!sandbox.runtime.entries.contains { $0.level == .error })
        // The height channel still reports the mounted page.
        try await waitUntil { (sandbox.runtime.contentHeight ?? 0) > 0 }
        #expect((sandbox.runtime.contentHeight ?? 0) > 0)
    }

    /// A TSX component — an interface, a generic, typed props and state, an
    /// optional chain — goes through the web's TypeScript preset and mounts.
    @Test
    func aTSXComponentCompilesItsTypesAway() async throws {
        let html = NativeArtifactRuntimeDocument.build(kind: .code, content: """
            interface Item { id: number; label: string }
            type Props = { title?: string };

            const items: Item[] = [{ id: 1, label: "One" }, { id: 2, label: "Two" }];

            function List<T extends Item>({ rows }: { rows: T[] }) {
              return <ul id="list">{rows.map((row) => <li key={row.id}>{row.label}</li>)}</ul>;
            }

            export default function App({ title = "Typed" }: Props) {
              const [picked, setPicked] = useState<Item | null>(null);
              useEffect(() => { setPicked(items[1] as Item); }, []);
              return (
                <section className="text-sm">
                  <h1 id="title">{title}</h1>
                  <List rows={items} />
                  <p id="picked">{picked?.label ?? "none"}</p>
                </section>
              );
            }
            """, language: "tsx")
        let sandbox = ArtifactRuntimeSandbox(html: html)

        try await waitUntil { sandbox.runtime.status == .done || sandbox.runtime.status == .error }
        #expect(sandbox.runtime.status == .done)
        #expect(await text(sandbox, "#title") == "Typed")
        #expect(try await read(sandbox, "document.querySelectorAll('#list li').length") == "2")
        try await waitUntil { await text(sandbox, "#picked") == "Two" }
        #expect(await text(sandbox, "#picked") == "Two")
        try await waitUntil { await style(sandbox, "#title", "font-size") == "14px" }
        #expect(await style(sandbox, "#title", "font-size") == "14px")
    }

    /// A component that throws is caught by the document's error boundary:
    /// the real message on the page and in the console, and status Error.
    @Test
    func aThrowingComponentReportsItsRealError() async throws {
        let html = NativeArtifactRuntimeDocument.build(kind: .react, content: """
            export default function Broken() {
              const data: { rows?: string[] } = {};
              if (!data.rows) throw new Error("rows never arrived");
              return <p>unreachable</p>;
            }
            """, language: nil)
        let sandbox = ArtifactRuntimeSandbox(html: html)

        try await waitUntil { sandbox.runtime.status == .error }
        #expect(sandbox.runtime.status == .error)
        #expect(await text(sandbox, "[data-juno-error]").contains("rows never arrived"))
        #expect(sandbox.runtime.entries.contains { $0.level == .error && $0.text.contains("rows never arrived") })
    }

    /// A TypeScript program compiles with the bundled Babel and runs in the
    /// console runtime; what it prints comes back on the console channel.
    @Test
    func aTypeScriptProgramRunsInTheConsole() async throws {
        let html = NativeArtifactRuntimeDocument.build(kind: .code, content: """
            export function add(a: number, b: number): number { return a + b; }
            const total: number = add(40, 2);
            console.log(`total: ${total}`);
            """, language: "ts")
        let sandbox = ArtifactRuntimeSandbox(html: html)

        try await waitUntil { sandbox.runtime.status == .done || sandbox.runtime.status == .error }
        #expect(sandbox.runtime.status == .done)
        #expect(sandbox.runtime.entries.contains { $0.text == "total: 42" })
    }

    /// A full page that loads Tailwind, React, ReactDOM and Babel from CDNs
    /// itself — `crossorigin` included, as React's docs write it — runs on
    /// the bundled copies, its `text/babel` script compiled by Babel's own
    /// loader.
    @Test
    func aFullPagesOwnCDNRuntimesRunFromTheBundle() async throws {
        let html = NativeArtifactRuntimeDocument.build(kind: .html, content: """
            <!doctype html><html><head><meta charset="utf-8">
            <script src="https://cdn.tailwindcss.com"></script>
            <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
            <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            </head><body>
            <div id="root"></div>
            <script type="text/babel">
              function Hello() {
                const [name] = React.useState("bundle");
                return <h1 id="hello" className="text-red-600">Hello, {name}</h1>;
              }
              ReactDOM.createRoot(document.getElementById("root")).render(<Hello />);
            </script>
            </body></html>
            """, language: nil)
        let sandbox = ArtifactRuntimeSandbox(html: html)

        try await waitUntil { await text(sandbox, "#hello") == "Hello, bundle" }
        #expect(await text(sandbox, "#hello") == "Hello, bundle")
        try await waitUntil { await style(sandbox, "#hello", "color") == "rgb(220, 38, 38)" }
        #expect(await style(sandbox, "#hello", "color") == "rgb(220, 38, 38)")
    }

    // MARK: Helpers

    /// An element's text, or "" when it is not there.
    private func text(_ sandbox: ArtifactRuntimeSandbox, _ selector: String) async -> String {
        (try? await read(sandbox, "(document.querySelector(\(literal(selector))) || {}).textContent")) ?? ""
    }

    /// One computed style property of an element, or "" when it is not there.
    private func style(_ sandbox: ArtifactRuntimeSandbox, _ selector: String, _ property: String) async -> String {
        let element = "document.querySelector(\(literal(selector)))"
        return (try? await read(
            sandbox,
            "\(element) ? getComputedStyle(\(element)).getPropertyValue(\(literal(property))) : ''"
        )) ?? ""
    }

    private func literal(_ string: String) -> String {
        "'" + string.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'"
    }

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
