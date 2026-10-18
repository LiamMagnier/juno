import Foundation

/// A system-wide shortcut: one physical key plus modifiers.
///
/// This is the pure half of the Mac's Quick Entry shortcut. The key is a
/// virtual key code (the `kVK_*` numbering a Mac keyboard reports), not a
/// character, because a global shortcut is registered against a key position
/// and must keep meaning the same key when the reader switches input source.
/// The registration itself is the app's (`RegisterEventHotKey`); what a
/// shortcut is allowed to be, and the rule that a refused shortcut leaves the
/// previous one working, are decided here so they can be tested without a Mac.
public struct JunoHotkey: Hashable, Sendable {

    public struct Modifiers: OptionSet, Hashable, Sendable {
        public let rawValue: UInt8
        public init(rawValue: UInt8) { self.rawValue = rawValue }

        public static let control = Modifiers(rawValue: 1 << 0)
        public static let option = Modifiers(rawValue: 1 << 1)
        public static let shift = Modifiers(rawValue: 1 << 2)
        public static let command = Modifiers(rawValue: 1 << 3)
    }

    public let keyCode: UInt16
    public let modifiers: Modifiers

    public init(keyCode: UInt16, modifiers: Modifiers) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    /// ⌥Space: Quick Entry's shortcut until the reader picks another.
    public static let quickEntryDefault = JunoHotkey(keyCode: KeyCode.space, modifiers: [.option])

    // MARK: Keys

    /// The virtual key codes this file names. Positions on an ANSI keyboard.
    public enum KeyCode {
        public static let space: UInt16 = 49
        public static let returnKey: UInt16 = 36
        public static let tab: UInt16 = 48
        public static let delete: UInt16 = 51
        public static let escape: UInt16 = 53
        public static let grave: UInt16 = 50
        public static let forwardDelete: UInt16 = 117
        public static let leftArrow: UInt16 = 123
        public static let rightArrow: UInt16 = 124
        public static let downArrow: UInt16 = 125
        public static let upArrow: UInt16 = 126
    }

    /// Character keys by position, for display and for reading an app chord
    /// (a menu's "⌥⌘P") back into a key code.
    private static let characterKeys: [UInt16: String] = [
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V",
        11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T",
        18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9", 26: "7",
        27: "-", 28: "8", 29: "0", 30: "]", 31: "O", 32: "U", 33: "[", 34: "I", 35: "P",
        37: "L", 38: "J", 39: "'", 40: "K", 41: ";", 42: "\\", 43: ",", 44: "/", 45: "N",
        46: "M", 47: ".", 50: "`",
    ]

    /// Keys a Mac keyboard names with a glyph or a word, as the menu bar and
    /// the Keyboard Shortcuts window draw them.
    private static let namedKeys: [UInt16: String] = [
        KeyCode.space: "Space", KeyCode.returnKey: "↩", KeyCode.tab: "⇥", KeyCode.delete: "⌫",
        KeyCode.escape: "esc", KeyCode.forwardDelete: "⌦",
        KeyCode.leftArrow: "←", KeyCode.rightArrow: "→", KeyCode.downArrow: "↓", KeyCode.upArrow: "↑",
        115: "↖", 119: "↘", 116: "⇞", 121: "⇟",
    ]

    private static let functionKeys: [UInt16: String] = [
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8",
        101: "F9", 109: "F10", 103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15",
        106: "F16", 64: "F17", 79: "F18", 80: "F19", 90: "F20",
    ]

    /// The key code for a character key ("p", "/"), or nil.
    public static func keyCode(forCharacter character: Character) -> UInt16? {
        let wanted = String(character).uppercased()
        if wanted == " " { return KeyCode.space }
        return characterKeys.first(where: { $0.value == wanted })?.key
    }

    public var isFunctionKey: Bool { Self.functionKeys[keyCode] != nil }

    /// A key that types a character when pressed with ⌥ alone: a letter,
    /// digit or punctuation key, but not Space (whose ⌥ form is the default
    /// shortcut, and is consumed once registered).
    public var isCharacterKey: Bool { Self.characterKeys[keyCode] != nil }

    /// Whether the key code is one this type can name. A shortcut on a key it
    /// cannot name could never be shown to the reader, so it is refused.
    public var isKnownKey: Bool {
        Self.characterKeys[keyCode] != nil || Self.namedKeys[keyCode] != nil || isFunctionKey
    }

    /// The key's cap: "Space", "P", "F5".
    public var keyName: String {
        Self.namedKeys[keyCode] ?? Self.characterKeys[keyCode] ?? Self.functionKeys[keyCode] ?? "Key \(keyCode)"
    }

    /// One cap per key, in the Mac's modifier order (⌃ ⌥ ⇧ ⌘): ["⌥", "Space"].
    public var keys: [String] {
        var caps: [String] = []
        if modifiers.contains(.control) { caps.append("⌃") }
        if modifiers.contains(.option) { caps.append("⌥") }
        if modifiers.contains(.shift) { caps.append("⇧") }
        if modifiers.contains(.command) { caps.append("⌘") }
        caps.append(keyName)
        return caps
    }

    /// The chord as one string: "⌥Space".
    public var display: String { keys.joined() }

    // MARK: Storage

    /// A compact, stable form for preferences: "49:2" (key code, modifiers).
    public var storageValue: String { "\(keyCode):\(modifiers.rawValue)" }

    public init?(storageValue: String) {
        let parts = storageValue.split(separator: ":")
        guard parts.count == 2, let code = UInt16(parts[0]), let raw = UInt8(parts[1]),
              raw & ~0b1111 == 0
        else { return nil }
        self.init(keyCode: code, modifiers: Modifiers(rawValue: raw))
    }
}

// MARK: - What a global shortcut may be

/// Why a shortcut cannot be Quick Entry's.
public enum JunoHotkeyProblem: Equatable, Sendable {
    /// A key the app cannot name.
    case unknownKey
    /// No ⌃ or ⌥. A global shortcut consumes its key in every app, and ⌘ or
    /// ⌘⇧ chords are every app's own menu shortcuts.
    case needsControlOrOption
    /// ⌥ (and maybe ⇧) on a letter, digit or punctuation key, which types a
    /// character on a Mac keyboard: taking it would break typing "é".
    case typesCharacter
    /// A shortcut macOS itself answers. Carries what macOS uses it for.
    case reservedBySystem(String)
    /// A shortcut Alevr's own menus use. Carries the command's name.
    case usedByApp(String)
    /// The system refused to register it, usually because another app holds it.
    case unavailable
}

extension JunoHotkey {
    /// Shortcuts macOS answers itself, with what it uses them for. Not every
    /// system binding — only the ones a reader could plausibly pick, and the
    /// ones that would silently never fire if registered.
    public static let systemReserved: [JunoHotkey: String] = {
        let space = KeyCode.space
        var table: [JunoHotkey: String] = [
            JunoHotkey(keyCode: space, modifiers: [.command]): "Spotlight",
            JunoHotkey(keyCode: space, modifiers: [.option, .command]): "Finder search",
            JunoHotkey(keyCode: space, modifiers: [.control]): "switching input sources",
            JunoHotkey(keyCode: space, modifiers: [.control, .option]): "switching input sources",
            JunoHotkey(keyCode: space, modifiers: [.control, .command]): "Emoji & Symbols",
            JunoHotkey(keyCode: KeyCode.tab, modifiers: [.command]): "switching apps",
            JunoHotkey(keyCode: KeyCode.tab, modifiers: [.shift, .command]): "switching apps",
            JunoHotkey(keyCode: KeyCode.grave, modifiers: [.command]): "switching windows",
            JunoHotkey(keyCode: KeyCode.escape, modifiers: [.option, .command]): "Force Quit",
            JunoHotkey(keyCode: 12, modifiers: [.control, .command]): "Lock Screen",
            JunoHotkey(keyCode: 12, modifiers: [.option, .shift, .command]): "Log Out",
            JunoHotkey(keyCode: 4, modifiers: [.option, .command]): "Hide Others",
            JunoHotkey(keyCode: 2, modifiers: [.option, .command]): "showing and hiding the Dock",
            JunoHotkey(keyCode: 3, modifiers: [.control, .command]): "full screen",
            JunoHotkey(keyCode: KeyCode.upArrow, modifiers: [.control]): "Mission Control",
            JunoHotkey(keyCode: KeyCode.downArrow, modifiers: [.control]): "App Exposé",
            JunoHotkey(keyCode: KeyCode.leftArrow, modifiers: [.control]): "moving between Spaces",
            JunoHotkey(keyCode: KeyCode.rightArrow, modifiers: [.control]): "moving between Spaces",
        ]
        // ⇧⌘3, 4 and 5, and the ⌃ forms that copy instead of saving.
        for code: UInt16 in [20, 21, 23] {
            table[JunoHotkey(keyCode: code, modifiers: [.shift, .command])] = "screenshots"
            table[JunoHotkey(keyCode: code, modifiers: [.control, .shift, .command])] = "screenshots"
        }
        return table
    }()

    /// The first reason this shortcut cannot be a global shortcut, or nil.
    /// `appChords` maps the app's own menu chords to their commands' names.
    public func problem(appChords: [JunoHotkey: String] = [:]) -> JunoHotkeyProblem? {
        guard isKnownKey else { return .unknownKey }
        if let use = Self.systemReserved[self] { return .reservedBySystem(use) }
        if let command = appChords[self] { return .usedByApp(command) }
        if !isFunctionKey {
            guard !modifiers.isDisjoint(with: [.control, .option]) else { return .needsControlOrOption }
            if isCharacterKey, modifiers.isSubset(of: [.option, .shift]) { return .typesCharacter }
        }
        return nil
    }
}

// MARK: - Registration that never leaves the reader without a shortcut

/// The system call that registers a global shortcut, behind a seam.
public protocol JunoHotkeyRegistrar: AnyObject {
    associatedtype Registration
    /// Registers the shortcut, or returns nil when the system refuses it.
    func register(_ hotkey: JunoHotkey) -> Registration?
    func unregister(_ registration: Registration)
}

/// Holds at most one registered shortcut and changes it safely.
///
/// A new shortcut is validated, then registered *while the old one is still
/// registered*, and only then is the old one released. Any refusal — a
/// reserved chord, an app chord, a registration the system turned down —
/// returns the problem and leaves the previous shortcut exactly as it was, so
/// a bad choice in Settings can never leave Quick Entry unreachable.
public final class JunoHotkeyBinder<Registrar: JunoHotkeyRegistrar> {
    public private(set) var active: JunoHotkey?
    private var registration: Registrar.Registration?
    private let registrar: Registrar
    private let appChords: [JunoHotkey: String]

    public init(registrar: Registrar, appChords: [JunoHotkey: String] = [:]) {
        self.registrar = registrar
        self.appChords = appChords
    }

    /// Makes `hotkey` the shortcut. Returns nil on success, or why not; on
    /// any problem the current shortcut stays registered.
    @discardableResult
    public func bind(_ hotkey: JunoHotkey) -> JunoHotkeyProblem? {
        if hotkey == active { return nil }
        if let problem = hotkey.problem(appChords: appChords) { return problem }
        guard let fresh = registrar.register(hotkey) else { return .unavailable }
        if let previous = registration { registrar.unregister(previous) }
        registration = fresh
        active = hotkey
        return nil
    }

    /// Releases the shortcut, if one is registered.
    public func unbind() {
        if let previous = registration { registrar.unregister(previous) }
        registration = nil
        active = nil
    }
}
