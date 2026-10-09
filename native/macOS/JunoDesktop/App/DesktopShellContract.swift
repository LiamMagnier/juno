import JunoDesignSystem

// The Mac's side of the shell contract (§A4.2 of the redesign).
//
// `Generated/JunoShellContract.swift` is the web's shell as Swift enums —
// products, each sidebar, the `+` menu, the primary action's faces and the
// Settings rail — generated from contracts/product/juno-shell-v1.json, which
// tests/shell-contract.test.ts holds to the web. This file is where each of
// those enums meets the Mac's own, and every `switch` here is exhaustive on
// purpose: a destination, product, section or face added on the web arrives
// as a new generated case and stops this file compiling until somebody
// decides what the Mac does with it. The drift that used to pass silently
// (the Work merge, Design moving into Artifacts) is a build failure now.
//
// The Mac's enums keep their raw values, which are stored in window and scene
// state: they map onto the contract's cases rather than being replaced by
// them, and the few cases the web has no counterpart for (Chat's stored
// `search` and `design`, the Mac-only Settings › Code) say so with `nil`.

// MARK: - Products

extension DesktopProductMode {
    /// The mode that shows the contract's product.
    init(_ product: JunoShellProduct) {
        switch product {
        case .chat: self = .chat
        case .code: self = .code
        }
    }

    /// The contract's product this mode shows.
    var shell: JunoShellProduct {
        switch self {
        case .chat: .chat
        case .code: .code
        }
    }
}

// MARK: - Destinations

extension DesktopDestination {
    /// The Chat window's page for one of the web's destinations, or nil for
    /// Code's own rows (Customize, Pull requests), which the Code column draws.
    init?(_ destination: JunoShellDestination) {
        switch destination {
        case .library: self = .library
        case .projects: self = .projects
        case .artifacts: self = .artifacts
        case .agents: self = .agents
        case .assistants: self = .assistants
        case .skills: self = .skills
        case .automations: self = .automations
        case .connections, .accountCustomize: self = .connections
        case .customize, .pulls: return nil
        }
    }

    /// The web destination this page is, or nil for a value the web has no
    /// sidebar row for: the conversation route, the retired Search page and
    /// Design (both stored values only), and Memory and Permissions, which
    /// the web reaches from Settings and ⌘K.
    var shell: JunoShellDestination? {
        switch self {
        case .library: .library
        case .projects: .projects
        case .artifacts: .artifacts
        case .agents: .agents
        case .assistants: .assistants
        case .skills: .skills
        case .automations: .automations
        case .connections: .accountCustomize
        case .chat, .search, .design, .memory, .permissions, .profile, .instructions: nil
        }
    }
}

// MARK: - Settings

extension DesktopSettingsSection {
    /// The Settings pane for one of the web's sections.
    init(_ section: JunoShellSettingsSection) {
        switch section {
        case .general: self = .general
        case .personalization: self = .personalization
        case .memory: self = .memory
        case .models: self = .models
        case .connectors: self = .connectors
        case .devices: self = .devices
        case .voice: self = .voice
        case .data: self = .data
        case .account: self = .account
        case .billing: self = .billing
        }
    }

    /// The web's section this pane is, or nil for Code, which is the Mac's
    /// own until Code's redesign (P3-3).
    var shell: JunoShellSettingsSection? {
        switch self {
        case .general: .general
        case .personalization: .personalization
        case .memory: .memory
        case .models: .models
        case .connectors: .connectors
        case .devices: .devices
        case .voice: .voice
        case .data: .data
        case .account: .account
        case .billing: .billing
        case .code: nil
        }
    }
}

// MARK: - The composer's primary action

extension ChatComposerFace {
    /// The web's face this one is, or nil for the Mac's disabled face: the
    /// web draws a disabled Send there, on the quiet disc.
    var shell: JunoShellPrimaryFace? {
        switch self {
        case .voice: .voice
        case .send: .send
        case .stop: .stop
        case .busy: .busy
        case .disabled: nil
        }
    }
}
