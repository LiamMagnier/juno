import Foundation

/// What kind of app something is, for the most it may ever be granted
/// (CODE_AGENT_SPEC §3.3). Bundle-id lists first, then the app's own
/// `LSApplicationCategoryType`.
public enum AppCategory: String, Hashable, Codable, Sendable, CaseIterable {
    /// Juno itself, the login window, security and permission prompts,
    /// Keychain Access and password managers. Never granted.
    case refused
    /// Terminals: click only, because typing into a shell gets past the
    /// command policy. Shell work goes through Juno's own shell tools.
    case terminal
    /// IDEs: click only, for the same reason (their terminals, their task
    /// runners).
    case ide
    /// Browsers: view only. Web work goes through the Preview browser.
    case browser
    /// Finance, trading and crypto: view only, and denied by default.
    case finance
    /// Finder and System Settings: full, with a warning line.
    case systemReach
    /// Mail, messaging and social apps: full, but Return after typing always
    /// asks (it sends).
    case messaging
    case other

    /// The most this category may be granted. Nil means refused outright.
    public var cap: AppTier? {
        switch self {
        case .refused: nil
        case .terminal, .ide: .click
        case .browser, .finance: .view
        case .systemReach, .messaging, .other: .full
        }
    }

    /// Denied unless the reader allows it in Settings, even inside the cap.
    public var deniedByDefault: Bool { self == .finance }
}

/// The category lists, and the one function that reads them.
public enum AppCategories {
    /// Juno's own bundle ids share this prefix: the Mac app in every channel,
    /// Juno Code, and their helpers.
    public static let junoBundlePrefix = "com.liammagnier.juno"

    public static let refused: Set<String> = [
        "com.apple.loginwindow",
        "com.apple.securityagent",
        "com.apple.coreautha",
        "com.apple.coreauthd",
        "com.apple.localauthentication.uiagent",
        "com.apple.usernotificationcenter",
        "com.apple.keychainaccess",
        "com.apple.passwords",
        "com.apple.screensaver.engine",
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.agilebits.onepassword8",
        "com.agilebits.onepassword-osx",
        "com.bitwarden.desktop",
        "com.dashlane.dashlanephonefinal",
        "com.dashlane.dashlane",
        "com.lastpass.lastpass",
        "com.lastpass.lastpassmacdesktop",
        "com.keepassxc.keepassxc",
        "org.keepassxc.keepassxc",
        "com.nordpass.macos.nordpass",
        "me.proton.pass.electron",
    ]

    public static let terminals: Set<String> = [
        "com.apple.terminal",
        "com.googlecode.iterm2",
        "dev.warp.warp-stable",
        "dev.warp.warp",
        "com.mitchellh.ghostty",
        "net.kovidgoyal.kitty",
        "org.alacritty",
        "io.alacritty",
        "co.zeit.hyper",
        "com.github.wez.wezterm",
        "com.panic.prompt3",
    ]

    public static let ides: Set<String> = [
        "com.apple.dt.xcode",
        "com.microsoft.vscode",
        "com.microsoft.vscodeinsiders",
        "com.todesktop.230313mzl4w4u92",
        "com.exafunction.windsurf",
        "dev.zed.zed",
        "dev.zed.zed-preview",
        "com.sublimetext.4",
        "com.sublimetext.3",
        "com.panic.nova",
        "com.google.android.studio",
        "com.vscodium",
    ]

    /// JetBrains ships one bundle id per product; the prefix covers them all.
    public static let idePrefixes = ["com.jetbrains."]

    public static let browsers: Set<String> = [
        "com.apple.safari",
        "com.apple.safaritechnologypreview",
        "com.google.chrome",
        "com.google.chrome.canary",
        "company.thebrowser.browser",
        "company.thebrowser.dia",
        "org.mozilla.firefox",
        "org.mozilla.firefoxdeveloperedition",
        "com.microsoft.edgemac",
        "com.brave.browser",
        "com.operasoftware.opera",
        "com.vivaldi.vivaldi",
        "org.chromium.chromium",
    ]

    public static let finance: Set<String> = [
        "com.robinhood.desktop",
        "com.coinbase.coinbase",
        "com.binance.binancedesktop",
        "com.kraken.desktop",
        "com.etrade.etradepro",
        "com.tdameritrade.thinkorswim",
        "com.interactivebrokers.tws",
        "com.intuit.quicken",
        "com.intuit.quickbooks",
        "com.moneymoney-app.retail",
        "com.ledger.live",
        "io.exodus.exodus",
        "com.tradingview.tradingviewapp.desktop",
    ]

    public static let systemReach: Set<String> = [
        "com.apple.finder",
        "com.apple.systempreferences",
        "com.apple.settings",
    ]

    public static let messaging: Set<String> = [
        "com.apple.mail",
        "com.apple.mobilesms",
        "com.apple.ichat",
        "com.apple.facetime",
        "com.tinyspeck.slackmacgap",
        "com.hnc.discord",
        "net.whatsapp.whatsapp",
        "desktop.whatsapp",
        "ru.keepcoder.telegram",
        "org.telegram.desktop",
        "org.whispersystems.signal-desktop",
        "com.microsoft.outlook",
        "com.microsoft.teams2",
        "com.microsoft.teams",
        "com.readdle.smartemail-mac",
        "com.mimestream.mimestream",
        "com.superhuman.electron",
        "com.facebook.archon",
        "com.linkedin.linkedin",
        "com.twitter.twitter-mac",
        "com.zoom.xos",
        "com.google.chat",
    ]

    /// A bundle id's category. `appStoreCategory` is the app's
    /// `LSApplicationCategoryType`, when it declares one.
    public static func category(bundleID: String, appStoreCategory: String? = nil) -> AppCategory {
        let id = bundleID.lowercased()
        if id.hasPrefix(junoBundlePrefix) || refused.contains(id) { return .refused }
        if terminals.contains(id) { return .terminal }
        if ides.contains(id) || idePrefixes.contains(where: id.hasPrefix) { return .ide }
        if browsers.contains(id) { return .browser }
        if finance.contains(id) { return .finance }
        if systemReach.contains(id) { return .systemReach }
        if messaging.contains(id) { return .messaging }
        switch appStoreCategory?.lowercased() {
        case "public.app-category.finance": return .finance
        case "public.app-category.social-networking": return .messaging
        case "public.app-category.developer-tools":
            // Developer tools are not all IDEs, so this caps nothing on its
            // own; the IDE list above is what does.
            return .other
        default: return .other
        }
    }

    /// The warning line on the grant sheet, where one is owed.
    public static func warning(for category: AppCategory) -> String? {
        switch category {
        case .refused: "Juno never controls this app."
        case .terminal: "Juno uses its own shell for commands, where your command rules apply."
        case .ide: "Typing into an editor's terminal or task runner would get past your command rules."
        case .browser: "Juno uses its Preview browser for web pages."
        case .finance: "Only if you allow it in Settings."
        case .systemReach: nil
        case .messaging: "Sending a message always asks first."
        case .other: nil
        }
    }

    /// Extra lines for apps whose reach is wider than they look.
    public static func reachWarning(bundleID: String) -> String? {
        switch bundleID.lowercased() {
        case "com.apple.finder": "Can read or write any file."
        case "com.apple.systempreferences", "com.apple.settings": "Can change system settings."
        default: nil
        }
    }
}
