import AppKit
import WebKit
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// The agent's browser against real WebKit pages served by
/// `StaticPreviewServer`, in a host window that is never ordered front
/// (CODE_AGENT_SPEC §4.3, §6.4). No screen capture, no events posted to the
/// window server: input goes to the web view itself.
@MainActor
final class PreviewBrowserTests: XCTestCase {
    private var root: URL!
    private var server: StaticPreviewServer!
    private var page: PreviewPage!

    override func setUp() async throws {
        PreviewPage.backgroundHostMode = .offscreen
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-preview-browser-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try writeFixtures()
        server = try StaticPreviewServer(staticRootURL: root)
        page = PreviewPage(key: PreviewKey(checkoutRoot: root, name: "fixture-\(UUID().uuidString)"))
    }

    override func tearDown() async throws {
        page?.tearDown()
        server?.stop()
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private func write(_ name: String, _ html: String) throws {
        try html.write(to: root.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    private func writeFixtures() throws {
        // A Radix-style trigger: opens only on a trusted pointerdown.
        try write("menu.html", """
        <!doctype html><html><head><title>Menu</title></head><body>
        <button id="trigger" aria-haspopup="menu" aria-expanded="false">Settings</button>
        <div id="menu" role="menu" hidden><div role="menuitem">Sign out</div></div>
        <p id="state">closed</p>
        <script>
          const trigger = document.getElementById("trigger");
          trigger.addEventListener("pointerdown", (event) => {
            if (!event.isTrusted) return;
            document.getElementById("menu").hidden = false;
            trigger.setAttribute("aria-expanded", "true");
            document.getElementById("state").textContent = "open";
          });
          trigger.addEventListener("click", () => {
            if (document.getElementById("state").textContent !== "open") document.getElementById("state").textContent = "click without pointerdown";
          });
        </script></body></html>
        """)
        // A framework error overlay in a shadow root.
        try write("overlay.html", """
        <!doctype html><html><head><title>App</title></head><body><h1>Home</h1>
        <script>
          class Overlay extends HTMLElement {
            constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<div class='message'>[plugin:vite:react-babel] Unexpected token (12:4) in src/App.tsx</div>"; }
          }
          customElements.define("vite-error-overlay", Overlay);
          document.body.appendChild(document.createElement("vite-error-overlay"));
        </script></body></html>
        """)
        // Eighty hidden controls before the one that matters.
        var hidden = ""
        for index in 0..<80 { hidden += "<button style=\"display:none\">Hidden \(index)</button>" }
        try write("many.html", """
        <!doctype html><html><head><title>Many</title></head><body>\(hidden)
        <button id="target">Save changes</button></body></html>
        """)
        // Dialogs, popups and external links.
        try write("dialogs.html", """
        <!doctype html><html><head><title>Dialogs</title></head><body>
        <button id="delete" onclick="document.getElementById('result').textContent = 'confirmed: ' + confirm('Delete project?')">Delete project</button>
        <button id="popup" onclick="window.open('/other.html', '_blank')">Open details</button>
        <a id="external" href="https://example.com/">Docs</a>
        <button id="leave" onclick="location.href = 'https://example.com/'">Leave</button>
        <button id="boom" onclick="console.error('boom: menu is undefined')">Break</button>
        <p id="result">nothing yet</p></body></html>
        """)
        try write("other.html", "<!doctype html><html><head><title>Other</title></head><body><h1>Details</h1></body></html>")
        // A form with key handlers, and a password field.
        try write("form.html", """
        <!doctype html><html><head><title>Form</title></head><body>
        <form id="form"><label for="name">Name</label><input id="name" name="name">
        <label for="pw">Password</label><input id="pw" type="password" value="hunter2"><button type="submit">Save</button></form>
        <p id="keys">none</p><p id="submitted">no</p>
        <script>
          let trusted = 0;
          document.getElementById("name").addEventListener("keydown", (e) => { if (e.isTrusted) trusted++; document.getElementById("keys").textContent = "trusted " + trusted; });
          document.getElementById("form").addEventListener("submit", (e) => { e.preventDefault(); document.getElementById("submitted").textContent = "yes: " + document.getElementById("name").value; });
        </script></body></html>
        """)
        // Viewport and colour-scheme probe.
        try write("probe.html", """
        <!doctype html><html><head><title>Probe</title></head><body><p id="probe"></p>
        <script>
          const update = () => document.getElementById("probe").textContent = innerWidth + " " + (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
          update(); addEventListener("resize", update); matchMedia("(prefers-color-scheme: dark)").addEventListener("change", update);
        </script></body></html>
        """)
        try write("index.html", "<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1><a href=\"/menu.html\">Menu</a></body></html>")
        try write("login.html", """
        <!doctype html><html><head><title>Login</title></head><body>
        <form id="login"><label for="email">Email</label><input id="email"><button type="submit">Sign in</button></form>
        <p id="sent">no</p>
        <script>document.getElementById("login").addEventListener("submit", (e) => { e.preventDefault(); document.getElementById("sent").textContent = "yes"; });</script>
        </body></html>
        """)
    }

    private var engine: PreviewBrowserEngine {
        PreviewBrowserEngine(page: page, workspaceRoot: root, secrets: FakeSecrets())
    }

    /// An engine for a call the reader approved as consequential.
    private var approvedEngine: PreviewBrowserEngine {
        PreviewBrowserEngine(page: page, workspaceRoot: root, secrets: FakeSecrets(), allowsConsequential: true)
    }

    private struct FakeSecrets: PreviewSecretProviding {
        func secret(named name: String, checkoutRoot: URL) -> String? { name == "admin" ? "correct horse" : nil }
    }

    private func open(_ path: String) async throws {
        page.open(origin: server.url)
        _ = try await engine.perform(.navigate(path: path, url: nil, history: nil))
    }

    private func text(_ id: String) async throws -> String {
        try await page.webView.evaluateJavaScript("document.getElementById('\(id)').textContent") as? String ?? ""
    }

    private func ref(named name: String, in snapshot: String) throws -> String {
        let line = try XCTUnwrap(snapshot.split(separator: "\n").first { $0.contains("\"\(name)\"") }, snapshot)
        let range = try XCTUnwrap(line.range(of: #"e[0-9]+"#, options: .regularExpression))
        return String(line[range])
    }

    // MARK: - The offscreen host (spike, recorded in PROGRESS.md)

    /// A page that no pane shows is hidden to WebKit, yet snapshots, script
    /// and synthesized input still work: what the background host relies on.
    func testTheOffscreenHostTakesSnapshotsAndTrustedInput() async throws {
        try await open("/menu.html")
        let visibility = try await page.webView.evaluateJavaScript("document.visibilityState") as? String
        XCTAssertEqual(visibility, "hidden", "the offscreen host is hidden to WebKit (D-025's reason for the 1-pt fallback)")
        let shot = try await engine.perform(.screenshot(fullPage: false, scale: nil, clipRef: nil))
        XCTAssertEqual(shot.images.count, 1)
        XCTAssertNotNil(shot.screenshotHash)
    }

    // MARK: - PV-19 real input

    func testAMenuThatOpensOnlyOnPointerdownOpens() async throws {
        try await open("/menu.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let trigger = try ref(named: "Settings", in: snapshot.text)
        _ = try await engine.perform(.click(.ref(trigger), button: .left, count: 1, modifiers: []))
        let state = try await text("state")
        XCTAssertEqual(state, "open")
        let after = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        XCTAssertTrue(after.text.contains("menuitem \"Sign out\""), after.text)
        XCTAssertTrue(after.text.contains("expanded"), after.text)
    }

    func testTypingFiresTrustedKeysAndEnterSubmits() async throws {
        try await open("/form.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let name = try ref(named: "Name", in: snapshot.text)
        _ = try await engine.perform(.type(ref: name, text: "Ada", secret: nil, submit: true, replace: false))
        let keys = try await text("keys")
        let submitted = try await text("submitted")
        XCTAssertEqual(keys, "trusted 4", "A, d, a and Enter")
        XCTAssertEqual(submitted, "yes: Ada")
    }

    /// Password values never leave the page; typing into one needs a named
    /// secret, and the result shows ••••.
    func testPasswordFieldsTakeOnlyNamedSecrets() async throws {
        try await open("/form.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        XCTAssertFalse(snapshot.text.contains("hunter2"), snapshot.text)
        let password = try ref(named: "Password", in: snapshot.text)
        do {
            _ = try await engine.perform(.type(ref: password, text: "guess", secret: nil, submit: false, replace: true))
            XCTFail("a password field must refuse plain text")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("secret"), error.localizedDescription)
        }
        do {
            _ = try await engine.perform(.type(ref: password, text: nil, secret: "admin", submit: false, replace: true))
            XCTFail("typing a credential is on the always-confirm floor")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("always needs the reader's approval"), error.localizedDescription)
        }
        let typed = try await approvedEngine.perform(.type(ref: password, text: nil, secret: "admin", submit: false, replace: true))
        XCTAssertTrue(typed.text.contains("••••"), typed.text)
        XCTAssertFalse(typed.text.contains("correct horse"))
        let value = try await page.webView.evaluateJavaScript("document.getElementById('pw').value") as? String
        XCTAssertEqual(value, "correct horse")
    }

    // MARK: - PV-20 and PV-21 snapshot

    func testAShadowRootErrorOverlayIsReported() async throws {
        try await open("/overlay.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        XCTAssertTrue(snapshot.text.contains("error_overlay: [plugin:vite:react-babel] Unexpected token"), snapshot.text)
        XCTAssertNotNil(snapshot.overlay)
        let text = try await engine.perform(.text(maxChars: 6_000, ref: nil))
        XCTAssertTrue(text.text.contains("Unexpected token"), text.text)
    }

    func testTheTargetAfterEightyHiddenElementsGetsAVisibleRef() async throws {
        try await open("/many.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let line = try XCTUnwrap(snapshot.text.split(separator: "\n").first { $0.contains("\"Save changes\"") }, snapshot.text)
        XCTAssertFalse(line.contains("hidden"), String(line))
        XCTAssertTrue(line.hasPrefix("[e1]"), "on-screen elements come first: \(line)")
        let found = try await engine.perform(.find(query: "save", limit: 20))
        XCTAssertTrue(found.text.contains("\"Save changes\""), found.text)
    }

    // MARK: - PV-26 dialogs, popups, external navigation

    func testConfirmBecomesADialogTheAgentAnswers() async throws {
        try await open("/dialogs.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let delete = try ref(named: "Delete project", in: snapshot.text)
        let click = try await approvedEngine.perform(.click(.ref(delete), button: .left, count: 1, modifiers: []))
        XCTAssertTrue(click.text.contains("A confirm is waiting: \"Delete project?\""), click.text)
        XCTAssertEqual(page.pendingDialog?.kind, .confirm)
        _ = try await approvedEngine.perform(.dialog(accept: true, text: nil))
        try await Task.sleep(for: .milliseconds(150))
        let result = try await text("result")
        XCTAssertEqual(result, "confirmed: true")
        XCTAssertNil(page.pendingDialog)
    }

    func testWindowOpenLoadsInPlace() async throws {
        try await open("/dialogs.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let popup = try ref(named: "Open details", in: snapshot.text)
        _ = try await engine.perform(.click(.ref(popup), button: .left, count: 1, modifiers: []))
        _ = try await engine.perform(.waitFor(.url("/other.html"), timeoutSeconds: 5))
        XCTAssertEqual(page.currentURL?.path, "/other.html")
    }

    func testExternalNavigationIsRefused() async throws {
        try await open("/dialogs.html")
        do {
            _ = try await engine.perform(.navigate(path: nil, url: URL(string: "https://example.com/"), history: nil))
            XCTFail("external navigation must be refused")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("loopback"), error.localizedDescription)
        }
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let link = try ref(named: "Docs", in: snapshot.text)
        do {
            _ = try await engine.perform(.click(.ref(link), button: .left, count: 1, modifiers: []))
            XCTFail("a click on an external link must be refused")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("external navigation is not available"), error.localizedDescription)
        }
        // Script that sends the page away is cancelled by the policy.
        let leave = try ref(named: "Leave", in: snapshot.text)
        let result = try await engine.perform(.click(.ref(leave), button: .left, count: 1, modifiers: []))
        XCTAssertEqual(page.currentURL?.host, server.url.host)
        XCTAssertTrue(result.text.contains("External navigation to example.com is not available"), result.text)
    }

    // MARK: - The always-confirm floor

    /// Pressing Delete, by ref or by coordinates, needs an approval made for
    /// exactly that; so does accepting the page's "Delete project?".
    func testTheFloorRefusesAConsequentialPressThatWasNotApprovedAsSuch() async throws {
        try await open("/dialogs.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let delete = try ref(named: "Delete project", in: snapshot.text)
        do {
            _ = try await engine.perform(.click(.ref(delete), button: .left, count: 1, modifiers: []))
            XCTFail("a Delete press must be refused without a consequential approval")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("\"Delete project\""), error.localizedDescription)
        }
        let box = try await page.webView.evaluateJavaScript(
            "(() => { const r = document.getElementById('delete').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()"
        ) as? [NSNumber]
        let center = CGPoint(x: box?[0].doubleValue ?? 0, y: box?[1].doubleValue ?? 0)
        do {
            _ = try await engine.perform(.click(.point(center), button: .left, count: 1, modifiers: []))
            XCTFail("coordinates must not slip past the floor")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("always needs the reader's approval"), error.localizedDescription)
        }
        let state = try await text("result")
        XCTAssertEqual(state, "nothing yet", "nothing was pressed")

        _ = try await approvedEngine.perform(.click(.ref(delete), button: .left, count: 1, modifiers: []))
        do {
            _ = try await engine.perform(.dialog(accept: true, text: nil))
            XCTFail("accepting \"Delete project?\" is consequential")
        } catch is PreviewBrowserError {}
        _ = try await engine.perform(.dialog(accept: false, text: nil))
        let declined = try await text("result")
        XCTAssertEqual(declined, "confirmed: false", "dismissing is always allowed")
    }

    /// Enter that would submit through a "Sign in" button is refused unless
    /// approved as consequential; the button itself is the thing to ask about.
    func testEnterThatWouldSignInIsOnTheFloor() async throws {
        try await open("/login.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let email = try ref(named: "Email", in: snapshot.text)
        do {
            _ = try await engine.perform(.type(ref: email, text: "ada@example.com", secret: nil, submit: true, replace: false))
            XCTFail("Enter into a sign-in form must be refused")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("\"Sign in\""), error.localizedDescription)
        }
        do {
            _ = try await engine.perform(.key(chord: "Enter", repeat: 1))
            XCTFail("Enter must be refused too")
        } catch is PreviewBrowserError {}
        let sent = try await text("sent")
        XCTAssertEqual(sent, "no")
        _ = try await approvedEngine.perform(.key(chord: "Enter", repeat: 1))
        let after = try await text("sent")
        XCTAssertEqual(after, "yes")
    }

    // MARK: - Floor bypasses (adversarial review)

    private func centre(of id: String) async throws -> CGPoint {
        let box = try await page.webView.evaluateJavaScript(
            "(() => { const r = document.getElementById('\(id)').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()"
        ) as? [NSNumber]
        return CGPoint(x: box?[0].doubleValue ?? 0, y: box?[1].doubleValue ?? 0)
    }

    /// A drag that presses and releases on Delete clicks it: refused without
    /// an approval, by ref and by coordinates.
    func testADragOnAConsequentialControlIsRefused() async throws {
        try await open("/dialogs.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let delete = try ref(named: "Delete project", in: snapshot.text)
        do {
            _ = try await engine.perform(.drag(from: .ref(delete), to: .ref(delete)))
            XCTFail("a drag on Delete must be refused")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("always needs the reader's approval"), error.localizedDescription)
        }
        let point = try await centre(of: "delete")
        do {
            _ = try await engine.perform(.drag(from: .point(point), to: .point(point)))
            XCTFail("a drag by coordinates must be refused too")
        } catch is PreviewBrowserError {}
        XCTAssertNil(page.pendingDialog, "nothing was pressed")
        let result = try await text("result")
        XCTAssertEqual(result, "nothing yet")
    }

    /// A line break in typed text is Enter: into the sign-in form it is
    /// refused like submit, whatever the line break, and so is a raw `\r`
    /// key.
    func testALineBreakInTypedTextIsEnter() async throws {
        try await open("/login.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let email = try ref(named: "Email", in: snapshot.text)
        for text in ["ada@example.com\n", "ada@example.com\r", "ada@example.com\r\n", "ada@example.com\u{2028}"] {
            do {
                _ = try await engine.perform(.type(ref: email, text: text, secret: nil, submit: false, replace: true))
                XCTFail("a line break into a sign-in form must be refused: \(text.debugDescription)")
            } catch let error as PreviewBrowserError {
                XCTAssertTrue(error.localizedDescription.contains("\"Sign in\""), error.localizedDescription)
            }
        }
        do {
            _ = try await engine.perform(.key(chord: "\r", repeat: 1))
            XCTFail("a raw carriage return is Enter")
        } catch is PreviewBrowserError {}
        let sent = try await text("sent")
        XCTAssertEqual(sent, "no")
    }

    /// An approval is for the control the card named: if the page puts
    /// another name under the ref while the reader decides, nothing is
    /// pressed.
    func testAnApprovalIsBoundToTheNamedControl() async throws {
        try await open("/dialogs.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let delete = try ref(named: "Delete project", in: snapshot.text)
        let approval = PreviewFloorApproval(targets: [delete: .init(role: "button", name: "Delete project")])
        let bound = PreviewBrowserEngine(page: page, workspaceRoot: root, secrets: FakeSecrets(), floorApproval: approval)

        _ = try await page.webView.evaluateJavaScript("document.getElementById('delete').textContent = 'Delete account'")
        do {
            _ = try await bound.perform(.click(.ref(delete), button: .left, count: 1, modifiers: []))
            XCTFail("the approved Delete project is now Delete account")
        } catch let error as PreviewBrowserError {
            XCTAssertTrue(error.localizedDescription.contains("as approved"), error.localizedDescription)
        }
        XCTAssertNil(page.pendingDialog)

        _ = try await page.webView.evaluateJavaScript("document.getElementById('delete').textContent = 'Delete project'")
        _ = try await bound.perform(.click(.ref(delete), button: .left, count: 1, modifiers: []))
        XCTAssertEqual(page.pendingDialog?.message, "Delete project?")
        let wrongQuestion = PreviewBrowserEngine(
            page: page, workspaceRoot: root, secrets: FakeSecrets(),
            floorApproval: PreviewFloorApproval(dialogMessage: "Delete the draft?")
        )
        do {
            _ = try await wrongQuestion.perform(.dialog(accept: true, text: nil))
            XCTFail("an approval for another question accepts nothing")
        } catch is PreviewBrowserError {}
        _ = try await engine.perform(.dialog(accept: false, text: nil))
    }

    /// A page can send what it is given anywhere: `.env`, keys and dotfiles
    /// are never handed to a file input, asked by name or through a symlink.
    func testUploadNeverGivesAPageASecretFile() async throws {
        try write("upload.html", #"<!doctype html><html><head><title>Upload</title></head><body><input type="file" id="file" aria-label="Attachment"></body></html>"#)
        try "API_KEY=sk-live".write(to: root.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
        try "-----BEGIN PRIVATE KEY-----".write(to: root.appendingPathComponent("server.key"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("notes.txt"), withDestinationURL: root.appendingPathComponent(".env"))
        try await open("/upload.html")
        let snapshot = try await engine.perform(.snapshot(filter: "all", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let input = try ref(named: "Attachment", in: snapshot.text)
        for path in [".env", "server.key", "notes.txt"] {
            do {
                _ = try await engine.perform(.upload(ref: input, path: path))
                XCTFail("\(path) must not reach the page")
            } catch let error as PreviewBrowserError {
                XCTAssertTrue(error.localizedDescription.contains("secret"), error.localizedDescription)
            }
        }
        let count = try await page.webView.evaluateJavaScript("document.getElementById('file').files.length") as? NSNumber
        XCTAssertEqual(count?.intValue, 0)
    }

    /// A page no pane shows goes away with its stopped server; one a pane
    /// shows stays.
    func testAStoppedServersHiddenPageIsRetired() {
        let hidden = PreviewKey(checkoutRoot: root, name: "retire-\(UUID().uuidString)")
        _ = PreviewPageRegistry.shared.page(for: hidden)
        XCTAssertTrue(PreviewPageRegistry.shared.retireIfHidden(hidden))
        XCTAssertNil(PreviewPageRegistry.shared.existing(hidden))

        let shown = PreviewKey(checkoutRoot: root, name: "shown-\(UUID().uuidString)")
        let page = PreviewPageRegistry.shared.page(for: shown)
        let container = PreviewPageContainerView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        page.adopt(into: container)
        XCTAssertFalse(PreviewPageRegistry.shared.retireIfHidden(shown))
        XCTAssertNotNil(PreviewPageRegistry.shared.existing(shown))
        PreviewPageRegistry.shared.remove(shown)
    }

    /// Esc stops the agent for a while after it acted, not only during the
    /// 3 s glow; Stop clears it.
    func testEscapeStaysArmedBetweenAgentActions() async throws {
        try await open("/menu.html")
        XCTAssertFalse(page.agentRecentlyActive)
        _ = try await engine.perform(.click(.point(CGPoint(x: 20, y: 20)), button: .left, count: 1, modifiers: []))
        XCTAssertTrue(page.agentRecentlyActive)
        page.stopAgent()
        XCTAssertFalse(page.agentRecentlyActive)
        XCTAssertTrue(page.agentStopped)
        page.allowAgent()
    }

    // MARK: - PV-22 effects

    func testEachActionReportsConsoleErrorsSinceThePreviousAction() async throws {
        try await open("/dialogs.html")
        let snapshot = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        let boom = try ref(named: "Break", in: snapshot.text)
        let click = try await engine.perform(.click(.ref(boom), button: .left, count: 1, modifiers: []))
        XCTAssertTrue(click.text.contains("1 console error"), click.text)
        XCTAssertTrue(click.text.contains("boom: menu is undefined"), click.text)
        let next = try await engine.perform(.snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000))
        XCTAssertFalse(next.text.contains("console error"), "reported once, at the action that caused it")
        let console = try await engine.perform(.console(level: "error", pattern: "boom", since: nil))
        XCTAssertTrue(console.text.contains("boom: menu is undefined"), console.text)
    }

    func testNavigateReportsTheHTTPStatus() async throws {
        try await open("/index.html")
        let missing = try await engine.perform(.navigate(path: "/missing-page", url: nil, history: nil))
        XCTAssertTrue(missing.text.contains("HTTP 404"), missing.text)
        XCTAssertEqual(page.mainDocumentStatus, 404)
    }

    // MARK: - Viewport

    func testResizeToPhoneInDarkChangesTheProbe() async throws {
        try await open("/probe.html")
        let result = try await engine.perform(.resize(viewport: .preset(.phone, colorScheme: .dark)))
        XCTAssertTrue(result.text.contains("390×844"), result.text)
        XCTAssertTrue(result.text.contains("dark"), result.text)
        try await Task.sleep(for: .milliseconds(200))
        let probe = try await text("probe")
        XCTAssertEqual(probe, "390 dark")
        let agent = try await page.webView.evaluateJavaScript("navigator.userAgent") as? String
        XCTAssertTrue(agent?.contains("iPhone") == true)
        _ = try await engine.perform(.resize(viewport: .preset(.desktop, colorScheme: .light)))
        try await Task.sleep(for: .milliseconds(200))
        let desktop = try await text("probe")
        XCTAssertEqual(desktop, "1440 light")
    }

    // MARK: - wait_for and screenshots

    func testAFailedWaitCarriesAScreenshot() async throws {
        try await open("/index.html")
        let wait = try await engine.perform(.waitFor(.text("never appears"), timeoutSeconds: 0.5))
        XCTAssertTrue(wait.failed)
        XCTAssertEqual(wait.images.count, 1)
        XCTAssertTrue(wait.text.contains("Timed out"), wait.text)
    }

    func testScreenshotsStayWithinTheImageBudget() async throws {
        try await open("/index.html")
        let shot = try await engine.perform(.screenshot(fullPage: true, scale: nil, clipRef: nil))
        let image = try XCTUnwrap(shot.images.first)
        let rep = try XCTUnwrap(NSBitmapImageRep(data: image.data))
        XCTAssertLessThanOrEqual(max(rep.pixelsWide, rep.pixelsHigh), 1_568)
        XCTAssertLessThanOrEqual(rep.pixelsWide * rep.pixelsHigh, 1_150_000)
        XCTAssertEqual(image.mediaType, "image/jpeg")
    }

    func testBatchStopsAtTheFirstFailure() async throws {
        try await open("/index.html")
        let batch = try await engine.perform(.batch([
            .navigate(path: "/menu.html", url: nil, history: nil),
            .waitFor(.text("absent"), timeoutSeconds: 0.3),
            .snapshot(filter: "interactive", ref: nil, depth: nil, includeText: false, maxText: 6_000),
        ]))
        XCTAssertTrue(batch.failed)
        XCTAssertTrue(batch.text.contains("3. snapshot: Not executed: an earlier preview action in this batch failed."), batch.text)
    }

    func testTheReaderCanStopTheAgent() async throws {
        try await open("/menu.html")
        page.stopAgent()
        do {
            _ = try await engine.perform(.click(.point(CGPoint(x: 20, y: 20)), button: .left, count: 1, modifiers: []))
            XCTFail("input after Stop must be refused")
        } catch let error as PreviewBrowserError {
            XCTAssertEqual(error, .stopped)
        }
        page.allowAgent()
        _ = try await engine.perform(.click(.point(CGPoint(x: 20, y: 20)), button: .left, count: 1, modifiers: []))
    }
}

extension PreviewBrowserError: Equatable {
    public static func == (lhs: PreviewBrowserError, rhs: PreviewBrowserError) -> Bool {
        lhs.localizedDescription == rhs.localizedDescription
    }
}
