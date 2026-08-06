import Foundation
import JunoWorkCore
import JunoWorkRuntime

#if os(macOS)
import AppKit
import CoreServices

// MARK: - The browsers this driver knows

/// A browser Juno has been taught to speak to, and the vocabulary it answers in.
///
/// Two entries, and the list is closed on purpose. Safari and Chrome publish
/// scripting dictionaries with documented terms for the three things this driver
/// needs — the front page's address, its title, and a way to run a snippet in
/// it — and every other browser either publishes a different dictionary or none
/// at all. Guessing that Brave or Arc will answer Chrome's terms because they
/// share an engine is the kind of guess that half-works: the address reads back
/// fine and the click lands nowhere, on somebody's real signed-in session.
/// ``SystemBrowserDriver`` therefore refuses a browser that is not in here
/// rather than trying Chrome's terms on it.
public enum AutomatableBrowser: String, CaseIterable, Sendable {
    case safari
    case chrome

    /// The identifier the permission lists are written in, in its shipping
    /// spelling. Every comparison against it goes through
    /// ``AutomationPermission/normalizeIdentifier(_:)``, never `==` on the raw
    /// string — see ``SystemBrowserDriver/choose(from:frontmost:preferred:permission:)``.
    public var bundleIdentifier: String {
        switch self {
        case .safari: "com.apple.Safari"
        case .chrome: "com.google.Chrome"
        }
    }

    /// The name an `tell application` block addresses it by.
    var applicationName: String {
        switch self {
        case .safari: "Safari"
        case .chrome: "Google Chrome"
        }
    }

    /// What a person is told to switch on when the browser refuses to run a
    /// snippet. The two menus are in different places and are worth naming
    /// exactly, because "enable JavaScript from Apple Events" sends somebody to
    /// the wrong preference pane in both apps.
    var javaScriptConsentHint: String {
        switch self {
        case .safari:
            "Safari → Settings → Advanced → Show features for web developers, then Develop → Allow JavaScript from Apple Events"
        case .chrome:
            "Chrome → View → Developer → Allow JavaScript from Apple Events"
        }
    }

    /// The browser this identifier names, or nil for one Juno cannot drive.
    ///
    /// Public because the settings card needs the same answer this driver uses —
    /// it tells somebody which identifiers to put on the allow list — and two
    /// copies of "is this a browser Juno knows" would eventually disagree about
    /// spelling or case.
    public static func named(bundleIdentifier: String) -> AutomatableBrowser? {
        let target = AutomationPermission.normalizeIdentifier(bundleIdentifier)
        return allCases.first {
            AutomationPermission.normalizeIdentifier($0.bundleIdentifier) == target
        }
    }
}

// MARK: - The driver

/// Drives Safari or Chrome by sending them Apple events.
///
/// ### Why Apple events and not a debug port
///
/// The alternative drivers all cost something this one does not. A Chrome
/// DevTools Protocol client needs the browser relaunched with
/// `--remote-debugging-port`, which drops the person's running session and opens
/// a port that anything on the machine can drive. `safaridriver` needs "Allow
/// Remote Automation" and hands the run a *fresh* profile, so the signed-in
/// session — the entire point of driving somebody's own browser — is not there.
/// Apple events need neither: Juno for Mac is not sandboxed and already declares
/// `com.apple.security.automation.apple-events` in
/// `native/macOS/JunoDesktop/Resources/JunoDesktop.entitlements`, with
/// `NSAppleEventsUsageDescription` in its Info.plist, both of which were added
/// for `osascript` and are exactly what this needs.
///
/// ### What macOS still asks
///
/// The entitlement lets the event be *sent*. Whether it is *delivered* is TCC's
/// decision, made per target application and asked of the person the first time.
/// ``appleEventConsent(forBundleIdentifier:)`` reads that decision without
/// prompting, so ``isAvailable()`` can report the tier unhealthy — and the
/// lattice route elsewhere — instead of raising a consent sheet behind whatever
/// the person was looking at. A denial comes back as `errAEEventNotPermitted`
/// and is turned into a refusal naming the pane that fixes it, because a run
/// that stops with "the browser did not respond" is a run nobody can act on.
///
/// ### Elements
///
/// An element id is `e` followed by the element's index in
/// ``interactiveSelector``'s match list. The same selector runs for the outline
/// and for every action taken from it, so index *n* means the same node in both
/// — as long as the page has not rebuilt itself in between, which is the same
/// bound ``SystemAccessibilityDriver``'s index paths carry and the reason
/// ``BrowserControl`` re-reads the host before it acts.
public struct SystemBrowserDriver: BrowserDriving {
    /// The most elements an outline will describe.
    ///
    /// A search-results page can match several thousand nodes, and an outline
    /// that size is both a slow Apple event and a context window spent on link
    /// text nobody will read.
    public static let maximumFields = 250

    private let permission: AutomationPermission
    /// The browser to drive when more than one is running and none is in front.
    /// Nil means "work it out", and working it out refuses rather than guesses.
    private let preferred: AutomatableBrowser?
    /// TCC's answer for one target, asked without prompting. Injected so the
    /// refusal paths are testable on a machine that has never been asked.
    private let consent: @Sendable (String) -> OSStatus
    private let runningBundleIdentifiers: @Sendable () -> [String]
    private let frontmostBundleIdentifier: @Sendable () -> String?

    public init(
        permission: AutomationPermission,
        preferred: AutomatableBrowser? = nil,
        consent: @escaping @Sendable (String) -> OSStatus = SystemBrowserDriver
            .appleEventConsent(forBundleIdentifier:),
        runningBundleIdentifiers: @escaping @Sendable () -> [String] = {
            NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier)
        },
        frontmostBundleIdentifier: @escaping @Sendable () -> String? = {
            NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        }
    ) {
        self.permission = permission
        self.preferred = preferred
        self.consent = consent
        self.runningBundleIdentifiers = runningBundleIdentifiers
        self.frontmostBundleIdentifier = frontmostBundleIdentifier
    }

    // MARK: BrowserDriving

    public func isAvailable() async -> Bool {
        guard case .success(let browser) = resolve() else { return false }
        return consent(browser.bundleIdentifier) == noErr
    }

    public func currentHost() async throws -> String {
        let browser = try resolved()
        return try Self.host(ofPageAddress: await address(in: browser))
    }

    public func outline() async throws -> BrowserPageOutline {
        let browser = try resolved()
        let json = try await evaluate(Self.outlineScript, in: browser)
        return try Self.parseOutline(json)
    }

    public func navigate(toHost host: String, path: String) async throws {
        let browser = try resolved()
        let destination = try Self.address(host: host, path: path)
        // Checked here as well as at the gate. This is the one call that chooses
        // a destination rather than acting on the page already in front, so a
        // driver used directly — a future tool, a debug harness — must not be a
        // way to reach a site the person never allowed.
        if let refusal = permission.permits(domain: host).refusal { throw refusal }
        _ = try await Self.execute(Self.navigateScript(browser, to: destination))
    }

    public func activate(elementID: String) async throws {
        let browser = try resolved()
        let index = try Self.index(ofElementID: elementID)
        try await requirePermittedPage(in: browser)
        let outcome = try await evaluate(Self.activateScript(index: index), in: browser)
        try Self.check(outcome, elementID: elementID)
    }

    public func enterText(_ text: String, intoElementID elementID: String) async throws {
        let browser = try resolved()
        let index = try Self.index(ofElementID: elementID)
        try await requirePermittedPage(in: browser)
        let outcome = try await evaluate(
            Self.enterTextScript(index: index, text: text),
            in: browser
        )
        try Self.check(outcome, elementID: elementID)
    }

    // MARK: - Which browser

    /// The browser this driver will drive, or why it will not drive one.
    ///
    /// Pure and static so the whole decision — the closed list, the allow list,
    /// the block list, and the case folding all three are compared under — is
    /// testable without a browser on the machine.
    ///
    /// The comparison is deliberately case-folded at every step. Commit e0bb1e8
    /// records the version of this rule that compared bundle identifiers
    /// literally: `WorkHostPolicy`'s block list held `com.apple.Terminal` and a
    /// process reporting `com.apple.terminal` walked straight past it, so the
    /// block list refused nothing at all. macOS treats bundle identifiers
    /// case-insensitively, so the literal comparison was the bug.
    static func choose(
        from running: [String],
        frontmost: String?,
        preferred: AutomatableBrowser?,
        permission: AutomationPermission
    ) -> Result<AutomatableBrowser, AutomationRefusal> {
        let live = running.compactMap(AutomatableBrowser.named(bundleIdentifier:))
        guard !live.isEmpty else {
            return .failure(
                AutomationRefusal(
                    .driverUnavailable,
                    "Neither Safari nor Chrome is open, and those are the browsers Juno can drive."
                )
            )
        }

        let candidate: AutomatableBrowser
        if let preferred {
            guard live.contains(preferred) else {
                return .failure(
                    AutomationRefusal(
                        .driverUnavailable,
                        "\(preferred.applicationName) is not open."
                    )
                )
            }
            candidate = preferred
        } else if let frontmost, let front = AutomatableBrowser.named(bundleIdentifier: frontmost),
            live.contains(front)
        {
            candidate = front
        } else {
            // Two browsers open and neither in front is genuinely ambiguous, and
            // the wrong answer types into somebody's other session. Refusing
            // gives them something to do about it — bring one to the front —
            // which picking the alphabetically first one does not.
            let distinct = Set(live)
            guard distinct.count == 1, let only = distinct.first else {
                return .failure(
                    AutomationRefusal(
                        .notConsidered,
                        "More than one browser is open and none is in front, so Juno did not guess which one you meant."
                    )
                )
            }
            candidate = only
        }

        if let refusal = permission.permits(app: candidate.bundleIdentifier).refusal {
            return .failure(refusal)
        }
        return .success(candidate)
    }

    private func resolve() -> Result<AutomatableBrowser, AutomationRefusal> {
        Self.choose(
            from: runningBundleIdentifiers(),
            frontmost: frontmostBundleIdentifier(),
            preferred: preferred,
            permission: permission
        )
    }

    private func resolved() throws -> AutomatableBrowser {
        switch resolve() {
        case .success(let browser):
            // Read again at the moment of acting rather than trusted from
            // `isAvailable`. Consent is revocable in System Settings while Juno
            // is open, and a driver that cached a yes is a driver whose first
            // sign of trouble is an event that silently does nothing.
            let status = consent(browser.bundleIdentifier)
            guard status == noErr else { throw Self.consentRefusal(status, browser: browser) }
            return browser
        case .failure(let refusal):
            throw refusal
        }
    }

    /// Refuses to act on a page the permission does not cover.
    ///
    /// ``BrowserControl`` already compares the live host against the request's
    /// target, and the gate already ruled on that target. This is the third
    /// check and it is the only one that is the driver's own: it is what makes
    /// "this driver never touches a site the person did not allow" true of the
    /// driver rather than of one particular caller.
    private func requirePermittedPage(in browser: AutomatableBrowser) async throws {
        let host = try Self.host(ofPageAddress: await address(in: browser))
        if let refusal = permission.permits(domain: host).refusal { throw refusal }
    }

    // MARK: - TCC

    /// Whether macOS will deliver an Apple event to this target, asked without
    /// prompting.
    ///
    /// `askUserIfNeeded: false` is the whole point. A preflight that prompted
    /// would raise a consent sheet from inside a health check — behind whatever
    /// the person was looking at, at a moment they did not ask for anything —
    /// and a sheet dismissed that way is remembered as a denial forever.
    public static func appleEventConsent(forBundleIdentifier bundleIdentifier: String) -> OSStatus {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleIdentifier)
        guard let descriptor = target.aeDesc else { return OSStatus(errAEEventNotPermitted) }
        return AEDeterminePermissionToAutomateTarget(
            descriptor,
            AEEventClass(typeWildCard),
            AEEventID(typeWildCard),
            false
        )
    }

    private static func consentRefusal(
        _ status: OSStatus,
        browser: AutomatableBrowser
    ) -> AutomationRefusal {
        switch Int(status) {
        case errAEEventNotPermitted:
            return AutomationRefusal(
                .driverUnavailable,
                "macOS is not letting Juno control \(browser.applicationName). Turn Juno on for it in System Settings → Privacy & Security → Automation."
            )
        case errAEEventWouldRequireUserConsent:
            return AutomationRefusal(
                .driverUnavailable,
                "macOS has not yet asked whether Juno may control \(browser.applicationName). It will ask the first time you run this from the Mac."
            )
        case procNotFound:
            return AutomationRefusal(
                .driverUnavailable,
                "\(browser.applicationName) is not running."
            )
        default:
            return AutomationRefusal(
                .driverUnavailable,
                "Juno could not reach \(browser.applicationName) on this Mac."
            )
        }
    }

    // MARK: - Talking to the browser

    /// Runs one script and hands back whatever it returned as a string.
    ///
    /// On the main actor, and that is not a style choice. An Apple event sent
    /// with a reply expected is dispatched through the sending thread's run
    /// loop; a Swift concurrency cooperative-pool thread has none, so the
    /// failure mode there is the send never completing rather than an error
    /// anyone can catch. `NSAppleScript` is also documented as not thread-safe.
    /// One actor for every call is the version of this with no such hazard.
    @MainActor
    private static func execute(_ source: String) throws -> String {
        guard let script = NSAppleScript(source: source) else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno could not build the instruction it was going to send the browser."
            )
        }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error { throw refusal(from: error) }
        return result.stringValue ?? ""
    }

    private func address(in browser: AutomatableBrowser) async throws -> String {
        try await Self.execute(Self.addressScript(browser))
    }

    /// Runs a snippet in the front page and returns what it evaluated to.
    private func evaluate(_ javaScript: String, in browser: AutomatableBrowser) async throws -> String {
        do {
            return try await Self.execute(Self.javaScriptScript(browser, javaScript))
        } catch let refusal as AutomationRefusal
        where refusal.message.lowercased().contains("javascript") {
            // Both browsers ship with "Allow JavaScript from Apple Events" off,
            // and both report it as an ordinary script error whose text is the
            // only thing distinguishing it. Passing that text through unchanged
            // would tell somebody their page failed; naming the menu tells them
            // what to switch on.
            throw AutomationRefusal(
                .driverUnavailable,
                "\(browser.applicationName) will not let Juno run anything in a page until you turn on \(browser.javaScriptConsentHint)."
            )
        }
    }

    /// Turns `NSAppleScript`'s error dictionary into a refusal a person can act
    /// on.
    private static func refusal(from error: NSDictionary) -> AutomationRefusal {
        let number = (error[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
        let message = (error[NSAppleScript.errorMessage] as? String) ?? ""
        switch number {
        case errAEEventNotPermitted:
            return AutomationRefusal(
                .driverUnavailable,
                "macOS refused to let Juno control the browser. Turn Juno on for it in System Settings → Privacy & Security → Automation."
            )
        case errAENoSuchObject:
            return AutomationRefusal(
                .driverUnavailable,
                "There is no page open in the browser for Juno to act on."
            )
        case procNotFound:
            return AutomationRefusal(.driverUnavailable, "The browser is no longer running.")
        default:
            // The browser's own wording, carried through. It is the only thing
            // that distinguishes "JavaScript from Apple Events is off" from
            // anything else, and `evaluate` reads it for exactly that.
            return AutomationRefusal(
                .driverUnavailable,
                message.isEmpty ? "The browser did not do what Juno asked." : message
            )
        }
    }

    // MARK: - The scripts

    private static func addressScript(_ browser: AutomatableBrowser) -> String {
        switch browser {
        case .safari:
            return "tell application \"Safari\" to return URL of front document"
        case .chrome:
            return "tell application \"Google Chrome\" to return URL of active tab of front window"
        }
    }

    private static func navigateScript(_ browser: AutomatableBrowser, to address: String) -> String {
        let target = appleScriptString(address)
        switch browser {
        case .safari:
            // A window with no document is the state Safari is in after the last
            // tab is closed, and `set URL of front document` there is
            // `errAENoSuchObject`. Making one is the same thing a person does by
            // pressing Command-N, not a wider capability.
            return """
                tell application "Safari"
                    if (count of documents) is 0 then
                        make new document with properties {URL:\(target)}
                    else
                        set URL of front document to \(target)
                    end if
                end tell
                """
        case .chrome:
            return """
                tell application "Google Chrome"
                    if (count of windows) is 0 then
                        make new window
                    end if
                    set URL of active tab of front window to \(target)
                end tell
                """
        }
    }

    private static func javaScriptScript(
        _ browser: AutomatableBrowser,
        _ javaScript: String
    ) -> String {
        let snippet = appleScriptString(javaScript)
        switch browser {
        case .safari:
            return "tell application \"Safari\" to do JavaScript \(snippet) in front document"
        case .chrome:
            return
                "tell application \"Google Chrome\" to execute active tab of front window javascript \(snippet)"
        }
    }

    /// The one selector every script in this file uses.
    ///
    /// Shared deliberately: an element id is an index into this selector's match
    /// list, so an outline built from one selector and a click resolved through
    /// another would address different nodes under the same name. Anything that
    /// widens it widens all three at once.
    static let interactiveSelector = """
        a[href],button,input,select,textarea,summary,\
        [role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="tab"],\
        [contenteditable="true"]
        """

    /// Describes the page's controls, and only its controls.
    ///
    /// Roles, labels and identities — never the page's prose. The reason is on
    /// ``BrowserPageOutline``: a model choosing which button to press does not
    /// need the article, and handing it over puts somebody's correspondence in a
    /// context window for the sake of finding Send. The label falls back to the
    /// element's own text because an icon-only button has nothing else, and it
    /// is clipped because a link whose text is a paragraph is still just a link.
    static let outlineScript = """
        (function(){var s=\(javaScriptLiteral(interactiveSelector));\
        var n=document.querySelectorAll(s),o=[];\
        for(var i=0;i<n.length&&o.length<\(maximumFields);i++){var e=n[i];\
        var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)continue;\
        var t=e.tagName.toLowerCase(),y=(e.getAttribute('type')||'').toLowerCase();\
        var l=e.getAttribute('aria-label')||e.getAttribute('placeholder')||\
        e.getAttribute('title')||e.getAttribute('name')||(e.innerText||'').trim().slice(0,80);\
        o.push({id:'e'+i,role:e.getAttribute('role')||(t==='input'?'input:'+(y||'text'):t),\
        label:l,secure:(t==='input'&&y==='password')?1:0,\
        hint:e.getAttribute('autocomplete')||''});}\
        return JSON.stringify({host:location.hostname,title:document.title,fields:o});})()
        """

    static func activateScript(index: Int) -> String {
        """
        (function(){var n=document.querySelectorAll(\(javaScriptLiteral(interactiveSelector)))[\(index)];\
        if(!n)return 'missing';n.scrollIntoView({block:'center'});n.click();return 'ok';})()
        """
    }

    /// Fills a field the way a person would, then says so.
    ///
    /// The native value setter rather than `element.value =` because a React or
    /// Vue input keeps its own copy of the value: assigning the property
    /// directly updates what is on screen and leaves the framework's state
    /// holding the old string, so the form submits empty. Calling the prototype
    /// setter and then dispatching `input` is what those frameworks listen for.
    ///
    /// A password box is refused here as well as in ``BrowserControl``, because
    /// the page can become a different page between the outline and the
    /// keystroke and this check runs against the node actually being typed into.
    static func enterTextScript(index: Int, text: String) -> String {
        """
        (function(){var n=document.querySelectorAll(\(javaScriptLiteral(interactiveSelector)))[\(index)];\
        if(!n)return 'missing';var t=n.tagName.toLowerCase();\
        var y=(n.getAttribute('type')||'').toLowerCase();if(y==='password')return 'secure';\
        if(t!=='input'&&t!=='textarea'&&n.getAttribute('contenteditable')!=='true')return 'notafield';\
        var v=\(javaScriptLiteral(text));n.focus();\
        if(t==='input'||t==='textarea'){var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n),'value');\
        if(d&&d.set){d.set.call(n,v);}else{n.value=v;}}else{n.textContent=v;}\
        n.dispatchEvent(new Event('input',{bubbles:true}));\
        n.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()
        """
    }

    /// Turns the one-word answer the snippets return into a refusal or nothing.
    static func check(_ outcome: String, elementID: String) throws {
        switch outcome.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "ok":
            return
        case "missing":
            throw AutomationRefusal(
                .focusMoved,
                "The page changed before Juno could act, so the control it was told about is no longer there."
            )
        case "secure":
            throw AutomationRefusal(
                .sensitiveSurface,
                "That field is for a password, and Juno does not fill those in."
            )
        case "notafield":
            throw AutomationRefusal(
                .intentNotServed,
                "That is not something Juno can type into."
            )
        default:
            throw AutomationRefusal(
                .driverUnavailable,
                "The browser did not say whether it acted on that control, so Juno treated it as a failure."
            )
        }
    }

    // MARK: - Values

    /// Builds the address to navigate to, and proves it still names the host
    /// that was allowed.
    ///
    /// The re-parse at the end is the point. The host was ruled on by
    /// ``AutomationPermission``; the string handed to the browser is host and
    /// path concatenated, and anything in the path that could move the host —
    /// or make the result unparseable — has to fail here rather than at the
    /// browser, which would happily open whatever it managed to read.
    static func address(host: String, path: String) throws -> String {
        let normalized = AutomationPermission.normalizeHost(host)
        guard !normalized.isEmpty, !normalized.hasPrefix(".") else {
            throw AutomationRefusal(
                .malformedIdentifier,
                "Juno could not tell which site that was."
            )
        }
        var tail = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if tail.isEmpty { tail = "/" }
        if !tail.hasPrefix("/") && !tail.hasPrefix("?") && !tail.hasPrefix("#") {
            tail = "/" + tail
        }
        let candidate = "https://" + normalized + tail
        guard let components = URLComponents(string: candidate),
            let parsed = components.host,
            AutomationPermission.normalizeHost(parsed) == normalized,
            components.user == nil, components.password == nil
        else {
            throw AutomationRefusal(
                .malformedIdentifier,
                "That address does not point at the site Juno was allowed to use, so it did not open it."
            )
        }
        return candidate
    }

    static func host(ofPageAddress address: String) throws -> String {
        guard let components = URLComponents(string: address), let host = components.host,
            !host.isEmpty
        else {
            throw AutomationRefusal(
                .malformedIdentifier,
                "Juno could not tell which site the browser is showing."
            )
        }
        return AutomationPermission.normalizeHost(host)
    }

    static func index(ofElementID elementID: String) throws -> Int {
        guard elementID.hasPrefix("e"), let index = Int(elementID.dropFirst()), index >= 0 else {
            throw AutomationRefusal(
                .malformedIdentifier,
                "Juno could not tell which control on the page that was."
            )
        }
        return index
    }

    static func parseOutline(_ json: String) throws -> BrowserPageOutline {
        guard let data = json.data(using: .utf8),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw AutomationRefusal(
                .driverUnavailable,
                "The browser did not describe the page in a way Juno could read."
            )
        }
        let entries = (root["fields"] as? [[String: Any]]) ?? []
        let fields = entries.compactMap { entry -> AccessibilityFieldDescriptor? in
            guard let elementID = entry["id"] as? String, let role = entry["role"] as? String
            else { return nil }
            let label = (entry["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let hint = (entry["hint"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return AccessibilityFieldDescriptor(
                elementID: elementID,
                role: role,
                subrole: nil,
                label: label,
                isSecureTextEntry: (entry["secure"] as? NSNumber)?.intValue == 1,
                contentHint: hint,
                // Deliberately nil. A rectangle from `getBoundingClientRect` is
                // in CSS pixels inside the viewport, and the only consumer of
                // this field is the redaction plan for a screen capture, which
                // is in screen points. Handing over the first as if it were the
                // second would paint the black box somewhere other than over the
                // password.
                bounds: nil
            )
        }
        return BrowserPageOutline(
            host: AutomationPermission.normalizeHost((root["host"] as? String) ?? ""),
            title: (root["title"] as? String) ?? "",
            fields: fields
        )
    }

    // MARK: - Escaping

    /// A Swift string as an AppleScript string literal.
    ///
    /// Every value that reaches a script goes through here or through
    /// ``javaScriptLiteral(_:)``. A page title, an element label or a person's
    /// typed text containing a quote would otherwise close the literal early and
    /// leave the rest of it being read as AppleScript.
    static func appleScriptString(_ value: String) -> String {
        var escaped = "\""
        for character in value {
            switch character {
            case "\\": escaped += "\\\\"
            case "\"": escaped += "\\\""
            case "\n": escaped += "\\n"
            case "\r": escaped += "\\r"
            case "\t": escaped += "\\t"
            default: escaped.append(character)
            }
        }
        return escaped + "\""
    }

    /// A Swift string as a JavaScript string literal.
    ///
    /// Produced by the JSON encoder rather than by hand, so quotes, backslashes
    /// and control characters are escaped by something that already knows how
    /// and cannot be got wrong one case at a time.
    static func javaScriptLiteral(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
            let text = String(data: data, encoding: .utf8),
            text.count >= 2
        else {
            return "\"\""
        }
        return String(text.dropFirst().dropLast())
    }
}
#endif
