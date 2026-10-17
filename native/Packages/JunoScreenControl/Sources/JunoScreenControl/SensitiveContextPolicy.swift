import Foundation

/// The kinds of place in a browser where every click and keystroke asks.
public enum SensitiveContextKind: String, Hashable, Codable, Sendable, CaseIterable {
    case banking
    case brokerage
    case crypto
    case health
    case governmentID = "government_id"
    case passwordVault = "password_vault"
    case webmailCompose = "webmail_compose"

    /// "a banking site", for the floor sentence "This is a banking site, so
    /// Alevr asks before every click and keystroke."
    public var phrase: String {
        switch self {
        case .banking: "a banking site"
        case .brokerage: "a brokerage site"
        case .crypto: "a crypto site"
        case .health: "a health portal"
        case .governmentID: "a government ID site"
        case .passwordVault: "a password manager's web vault"
        case .webmailCompose: "a webmail compose window"
        }
    }
}

/// What a browser window is showing, as Accessibility reports it: the web
/// area's `AXURL`, and the window's title for when there is no URL (a
/// browser that keeps its web content out of the tree).
public struct BrowserPageContext: Hashable, Sendable {
    public var url: String?
    public var windowTitle: String?

    public init(url: String? = nil, windowTitle: String? = nil) {
        self.url = url
        self.windowTitle = windowTitle
    }
}

/// A match: which kind, and what matched (a host or the title's words).
public struct SensitiveContext: Hashable, Sendable {
    public var kind: SensitiveContextKind
    public var evidence: String

    public init(kind: SensitiveContextKind, evidence: String) {
        self.kind = kind
        self.evidence = evidence
    }
}

/// The sensitive-context floor for browsers (the leaders' "watch mode").
///
/// A browser is granted at full tier, so on its own the floor asks only when
/// the control under the point says "Send", "Pay" or "Sign in". On a bank,
/// a brokerage, a crypto exchange, a health portal, a government ID service,
/// a password manager's web vault or a webmail compose window that is not
/// enough: a "Continue" or a "Next" there moves money, files a form or sends
/// mail. So in those places every click and keystroke asks, even in Full
/// access, and screen control pauses when the reader has walked away.
///
/// Deterministic on purpose: a fixed list of hosts and title words, read
/// from what Accessibility reports, never from what the model says. Eager
/// like the credential test: a false positive costs one question.
public enum SensitiveContextPolicy {
    /// How long the reader may be away (no keyboard, mouse or trackpad input
    /// at the HID level) before screen control pauses in a sensitive place.
    public static let idleLimit: TimeInterval = 120

    /// The actions the floor covers: every click and keystroke. Pointing and
    /// scrolling change nothing and stay free.
    public static func applies(to kind: ScreenActionKind) -> Bool {
        switch kind {
        case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .leftClickDrag,
             .leftMouseDown, .leftMouseUp, .type, .key, .holdKey:
            true
        case .screenshot, .zoom, .mouseMove, .cursorPosition, .scroll, .wait:
            false
        }
    }

    /// The sensitive context a browser window is in, or nil.
    public static func classify(_ page: BrowserPageContext) -> SensitiveContext? {
        let title = page.windowTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw = page.url?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
           let url = parse(raw), let host = url.host?.lowercased(), !host.isEmpty
        {
            if let match = classify(host: host, url: url) { return match }
            // Some webmail composers are a sheet over the inbox and leave
            // the address alone: the title says "New message".
            if isWebmailHost(host), let title, titleSaysCompose(title) {
                return SensitiveContext(kind: .webmailCompose, evidence: host)
            }
            return nil
        }
        guard let title, !title.isEmpty else { return nil }
        return classify(title: title)
    }

    // MARK: - Hosts

    static func parse(_ raw: String) -> URL? {
        if let url = URL(string: raw), url.scheme != nil, url.host != nil { return url }
        return URL(string: "https://" + raw)
    }

    static let hosts: [(SensitiveContextKind, [String])] = [
        (.passwordVault, [
            "1password.com", "1password.eu", "1password.ca", "bitwarden.com", "bitwarden.eu", "lastpass.com",
            "dashlane.com", "pass.proton.me", "keepersecurity.com", "keepersecurity.eu", "nordpass.com",
            "roboform.com",
        ]),
        (.governmentID, [
            "irs.gov", "ssa.gov", "login.gov", "id.me", "uscis.gov", "travel.state.gov", "healthcare.gov",
            "impots.gouv.fr", "franceconnect.gouv.fr", "ants.gouv.fr", "service-public.fr", "account.gov.uk",
            "signin.service.gov.uk", "tax.service.gov.uk", "passport.service.gov.uk", "elster.de", "my.gov.au",
        ]),
        (.health, [
            "mychart.org", "mychart.com", "followmyhealth.com", "kaiserpermanente.org", "kp.org", "doctolib.fr",
            "doctolib.de", "doctolib.it", "ameli.fr", "nhs.uk", "onemedical.com", "zocdoc.com", "teladoc.com",
            "athenahealth.com", "healow.com", "myuhc.com", "patient.info", "anthem.com", "aetna.com", "cigna.com",
        ]),
        (.crypto, [
            "coinbase.com", "binance.com", "binance.us", "kraken.com", "crypto.com", "gemini.com", "bitstamp.net",
            "kucoin.com", "okx.com", "bybit.com", "metamask.io", "uniswap.org", "opensea.io", "blockchain.com",
            "ledger.com", "exodus.com",
        ]),
        (.brokerage, [
            "robinhood.com", "fidelity.com", "schwab.com", "vanguard.com", "etrade.com", "tdameritrade.com",
            "interactivebrokers.com", "ibkr.com", "webull.com", "sofi.com", "merrilledge.com", "degiro.com",
            "degiro.fr", "trading212.com", "etoro.com", "saxobank.com", "boursedirect.fr", "tradingview.com",
        ]),
        (.banking, [
            "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com",
            "capitalone.com", "pnc.com", "td.com", "tdbank.com", "hsbc.com", "hsbc.co.uk", "barclays.co.uk",
            "barclays.com", "lloydsbank.com", "natwest.com", "santander.com", "santander.co.uk", "monzo.com",
            "revolut.com", "n26.com", "wise.com", "paypal.com", "venmo.com", "ing.com", "ing.fr", "ing.de",
            "bnpparibas", "mabanque.bnpparibas", "credit-agricole.fr", "particuliers.sg.fr",
            "societegenerale.fr", "labanquepostale.fr", "boursorama.com", "boursobank.com", "lcl.fr",
            "caisse-epargne.fr", "creditmutuel.fr", "banquepopulaire.fr", "fortuneo.fr", "hellobank.fr",
            "deutsche-bank.de", "commerzbank.de", "sparkasse.de", "ally.com", "discover.com",
            "americanexpress.com", "chime.com", "stripe.com",
        ]),
    ]

    /// Mail sites, for the compose check.
    static let webmailHosts = [
        "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com",
        "mail.proton.me", "mail.protonmail.com", "icloud.com", "fastmail.com", "app.fastmail.com", "mail.aol.com",
        "mail.zoho.com", "mail.zoho.eu", "app.hey.com",
    ]

    static func matches(_ host: String, _ domain: String) -> Bool {
        host == domain || host.hasSuffix("." + domain)
    }

    static func isWebmailHost(_ host: String) -> Bool {
        webmailHosts.contains { matches(host, $0) }
    }

    static func classify(host rawHost: String, url: URL) -> SensitiveContext? {
        let host = rawHost.hasPrefix("www.") ? String(rawHost.dropFirst(4)) : rawHost
        for (kind, domains) in hosts where domains.contains(where: { matches(host, $0) }) {
            return SensitiveContext(kind: kind, evidence: host)
        }
        let labels = host.split(separator: ".").map(String.init)
        // A host named for what it is: "onlinebanking.example", "mybank.example",
        // "mychart.hospital.org", "patientportal.clinic.org".
        if labels.dropLast().contains(where: { $0.hasPrefix("bank") || $0.hasSuffix("bank") || $0.contains("banking") || $0.hasPrefix("banque") }) {
            return SensitiveContext(kind: .banking, evidence: host)
        }
        if labels.dropLast().contains(where: { $0.contains("mychart") || $0.contains("patientportal") || $0 == "patient-portal" }) {
            return SensitiveContext(kind: .health, evidence: host)
        }
        if isWebmailHost(host), urlSaysCompose(url) {
            return SensitiveContext(kind: .webmailCompose, evidence: host)
        }
        return nil
    }

    /// Gmail's `#inbox?compose=new` and `?compose=…`, Outlook's
    /// `/mail/deeplink/compose`, Yahoo's `/d/compose`, Fastmail's `/compose`.
    static func urlSaysCompose(_ url: URL) -> Bool {
        let parts = [url.path, url.query ?? "", url.fragment ?? ""].map { $0.lowercased() }
        return parts.contains { $0.contains("compose") || $0.contains("/new-message") }
    }

    // MARK: - Titles

    static let titlePhrases: [(SensitiveContextKind, [String])] = [
        (.passwordVault, ["1password", "bitwarden", "lastpass", "dashlane", "proton pass", "keeper vault", "nordpass", "roboform"]),
        (.governmentID, [
            "internal revenue service", "social security administration", "my social security", "login gov", "id me",
            "uscis", "impots gouv", "franceconnect", "service public fr", "hmrc", "gov uk one login", "elster", "mygov",
        ]),
        (.health, ["mychart", "patient portal", "doctolib", "ameli", "follow my health", "kaiser permanente", "nhs app", "zocdoc", "teladoc"]),
        (.crypto, ["coinbase", "binance", "kraken", "metamask", "crypto com", "ledger live", "opensea", "uniswap", "bitstamp", "kucoin", "bybit", "okx"]),
        (.brokerage, [
            "robinhood", "fidelity investments", "charles schwab", "vanguard", "e trade", "interactive brokers", "webull",
            "degiro", "trading 212", "etoro", "merrill edge", "td ameritrade", "thinkorswim",
        ]),
        (.banking, [
            "online banking", "bank of america", "wells fargo", "chase online", "chase bank", "citibank", "capital one",
            "barclays", "hsbc", "natwest", "lloyds bank", "santander", "revolut", "monzo", "paypal", "boursorama",
            "boursobank", "credit agricole", "societe generale", "bnp paribas", "la banque postale", "caisse d'epargne",
            "credit mutuel", "banque populaire", "sparkasse", "deutsche bank", "commerzbank",
        ]),
    ]

    static let composeWords = ["compose", "new message", "nouveau message", "neue e mail", "nuevo mensaje", "nuovo messaggio"]
    static let webmailBrands = ["gmail", "outlook", "yahoo mail", "proton mail", "icloud mail", "fastmail", "zoho mail", "aol mail", "hey"]

    static func classify(title: String) -> SensitiveContext? {
        let joined = padded(title)
        for (kind, phrases) in titlePhrases {
            if let phrase = phrases.first(where: { joined.contains(padded($0)) }) {
                return SensitiveContext(kind: kind, evidence: phrase)
            }
        }
        if titleSaysCompose(title), let brand = webmailBrands.first(where: { joined.contains(padded($0)) }) {
            return SensitiveContext(kind: .webmailCompose, evidence: brand)
        }
        return nil
    }

    static func titleSaysCompose(_ title: String) -> Bool {
        let joined = padded(title)
        return composeWords.contains { joined.contains(padded($0)) }
    }

    /// " word word ", lowercased and accent-free, for whole-word matching.
    static func padded(_ text: String) -> String {
        " " + ConsequentialActionFloor.tokenize(text).joined(separator: " ") + " "
    }
}

// MARK: - Reading the page

/// Reads what a browser's front window is showing, for the sensitive-context
/// floor. A separate seam from ``AccessibilityInspecting`` so an inspector
/// that cannot read pages (a test fake, an inert preview) simply has none:
/// the floor then falls back to the captured window's title.
public protocol BrowserPageReading: Sendable {
    /// The focused window's `AXURL` (from its `AXWebArea`) and title, or nil
    /// when the app shows no window to Accessibility.
    func browserPage(pid: Int32) async -> BrowserPageContext?
}

// MARK: - Who moved last

/// When the reader last touched the keyboard, mouse or trackpad, from the
/// HID idle reading, with screen control's own input taken out.
///
/// macOS reports one number: seconds since the last input event at the HID
/// level. Whether an event screen control posts resets it depends on how it
/// was posted (one posted to the HID tap in takeover may; one posted to a
/// process in background mode should not), so this never trusts the reading
/// on its own. Every stretch of time screen control was sending input is
/// recorded, and a last event that falls inside one of them is screen
/// control's, not the reader's. The reader's last activity therefore only
/// moves forward on an event screen control could not have caused, and an
/// agent clicking steadily on a banking site cannot keep the reader "present".
///
/// Errs towards pausing: a reader's event that happens to land inside one of
/// screen control's own input windows is not counted, which costs at most one
/// Resume.
public struct ReaderActivityTracker: Sendable {
    /// How far either side of an input window an event still counts as
    /// screen control's: the HID clock and this one are read separately.
    public static let tolerance: TimeInterval = 0.3
    /// Input windows kept; older ones are long past any idle limit.
    static let windowLimit = 64

    public private(set) var lastReaderActivity: Date
    private var windows: [ClosedRange<Date>] = []
    private var open: [UUID: Date] = [:]

    public init(lastReaderActivity: Date) {
        self.lastReaderActivity = lastReaderActivity
    }

    /// A gesture only the reader makes: starting screen control, Resume.
    public mutating func readerActed(at date: Date) {
        lastReaderActivity = max(lastReaderActivity, date)
    }

    /// Screen control starts sending input.
    public mutating func beginAgentInput(_ id: UUID, at date: Date) {
        open[id] = date
    }

    /// Screen control stopped sending that input.
    public mutating func endAgentInput(_ id: UUID, at date: Date) {
        guard let start = open.removeValue(forKey: id) else { return }
        windows.append(start...max(start, date))
        if windows.count > Self.windowLimit { windows.removeFirst(windows.count - Self.windowLimit) }
    }

    /// Whether an event at `date` could have been screen control's own.
    public func isAgentInput(at date: Date) -> Bool {
        let slack = Self.tolerance
        if open.values.contains(where: { date >= $0.addingTimeInterval(-slack) }) { return true }
        return windows.contains {
            date >= $0.lowerBound.addingTimeInterval(-slack) && date <= $0.upperBound.addingTimeInterval(slack)
        }
    }

    /// Seconds since the reader's own last input, given the HID reading
    /// (seconds since any input event) at `now`.
    public mutating func idleSeconds(hidIdle: TimeInterval, now: Date) -> TimeInterval {
        let lastEvent = now.addingTimeInterval(-max(0, hidIdle))
        if !isAgentInput(at: lastEvent) { readerActed(at: lastEvent) }
        return max(0, now.timeIntervalSince(lastReaderActivity))
    }
}
