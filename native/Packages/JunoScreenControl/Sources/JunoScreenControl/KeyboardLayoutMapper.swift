import Foundation
#if os(macOS)
import Carbon.HIToolbox
#endif

/// Modifier keys, as a set.
public struct KeyModifiers: OptionSet, Hashable, Codable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let shift = KeyModifiers(rawValue: 1 << 0)
    public static let control = KeyModifiers(rawValue: 1 << 1)
    public static let option = KeyModifiers(rawValue: 1 << 2)
    public static let command = KeyModifiers(rawValue: 1 << 3)
    public static let function = KeyModifiers(rawValue: 1 << 4)

    /// "⌘⇧" order, for summaries.
    public var symbols: String {
        var text = ""
        if contains(.control) { text += "⌃" }
        if contains(.option) { text += "⌥" }
        if contains(.shift) { text += "⇧" }
        if contains(.command) { text += "⌘" }
        if contains(.function) { text += "fn " }
        return text
    }
}

/// A key on the keyboard and the modifiers that make it type one character.
public struct KeyStroke: Hashable, Codable, Sendable {
    /// The virtual key code: a physical position, not a letter.
    public var keyCode: UInt16
    public var modifiers: KeyModifiers

    public init(keyCode: UInt16, modifiers: KeyModifiers = []) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }
}

/// Keys that are named, not typed: they sit at the same place on every
/// layout, so their physical codes are right everywhere (CODE_AGENT_SPEC
/// §3.6). Characters never resolve through this table — that was CU-02.
public enum NamedKey: String, CaseIterable, Hashable, Sendable {
    case `return`, tab, space, delete, forwardDelete, escape
    case left, right, up, down, home, end, pageUp, pageDown
    case f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12
    case command, shift, option, control, capsLock, function

    /// `kVK_*` codes from HIToolbox/Events.h.
    public var keyCode: UInt16 {
        switch self {
        case .return: 36
        case .tab: 48
        case .space: 49
        case .delete: 51
        case .forwardDelete: 117
        case .escape: 53
        case .left: 123
        case .right: 124
        case .down: 125
        case .up: 126
        case .home: 115
        case .end: 119
        case .pageUp: 116
        case .pageDown: 121
        case .f1: 122
        case .f2: 120
        case .f3: 99
        case .f4: 118
        case .f5: 96
        case .f6: 97
        case .f7: 98
        case .f8: 100
        case .f9: 101
        case .f10: 109
        case .f11: 103
        case .f12: 111
        case .command: 55
        case .shift: 56
        case .option: 58
        case .control: 59
        case .capsLock: 57
        case .function: 63
        }
    }

    /// Every spelling a model writes, xdotool's keysyms included (Anthropic's
    /// models were trained on them): `Return`, `BackSpace`, `Page_Down`,
    /// `KP_Enter`. On a Mac "delete" is the key above Return, which xdotool
    /// calls BackSpace; xdotool's `Delete` is forward delete, so it is spelt
    /// out here as `forward_delete` and `del` to avoid the clash.
    static let aliases: [String: NamedKey] = {
        var table: [String: NamedKey] = [
            "return": .return, "enter": .return, "kp_enter": .return, "linefeed": .return,
            "tab": .tab, "iso_left_tab": .tab,
            "space": .space, "spacebar": .space,
            "delete": .delete, "backspace": .delete, "back_space": .delete,
            "forwarddelete": .forwardDelete, "forward_delete": .forwardDelete, "del": .forwardDelete,
            "escape": .escape, "esc": .escape,
            "left": .left, "leftarrow": .left, "arrowleft": .left,
            "right": .right, "rightarrow": .right, "arrowright": .right,
            "up": .up, "uparrow": .up, "arrowup": .up,
            "down": .down, "downarrow": .down, "arrowdown": .down,
            "home": .home, "end": .end,
            "pageup": .pageUp, "page_up": .pageUp, "prior": .pageUp,
            "pagedown": .pageDown, "page_down": .pageDown, "next": .pageDown,
            "cmd": .command, "command": .command, "super": .command, "meta": .command,
            "shift": .shift, "shift_l": .shift, "shift_r": .shift,
            "opt": .option, "option": .option, "alt": .option, "alt_l": .option,
            "ctrl": .control, "control": .control, "control_l": .control,
            "capslock": .capsLock, "caps_lock": .capsLock,
            "fn": .function,
        ]
        for number in 1...12 {
            table["f\(number)"] = NamedKey(rawValue: "f\(number)")
        }
        return table
    }()

    public static func named(_ text: String) -> NamedKey? {
        aliases[text.lowercased()]
    }
}

/// A parsed key chord: modifiers and one key.
///
/// `cmd+shift+s`, `ctrl+Return`, `cmd+-`, `cmd++` and a bare `a` all parse.
/// Only `+` separates; the old parser also split on `-`, so `cmd+-` (zoom
/// out) could not be pressed at all (CU-17).
public struct KeyChord: Hashable, Sendable {
    public enum Key: Hashable, Sendable {
        case named(NamedKey)
        case character(Character)
    }

    public var modifiers: KeyModifiers
    public var key: Key

    public init(modifiers: KeyModifiers, key: Key) {
        self.modifiers = modifiers
        self.key = key
    }

    static let modifierNames: [String: KeyModifiers] = [
        "cmd": .command, "command": .command, "super": .command, "meta": .command, "win": .command,
        "shift": .shift,
        "opt": .option, "option": .option, "alt": .option,
        "ctrl": .control, "control": .control,
        "fn": .function,
    ]

    public static func parse(_ text: String) throws -> KeyChord {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw KeyboardLayoutError.emptyChord }
        // A trailing "+" after a separator is the plus key: "cmd++".
        var parts = trimmed.components(separatedBy: "+")
        if trimmed.hasSuffix("++") {
            parts = Array(parts.dropLast(2)) + ["+"]
        } else if trimmed == "+" {
            parts = ["+"]
        }
        parts = parts.map { $0.trimmingCharacters(in: .whitespaces) }
        guard let last = parts.last, !last.isEmpty, !parts.dropLast().contains(where: \.isEmpty) else {
            throw KeyboardLayoutError.unknownKey(trimmed)
        }
        var modifiers: KeyModifiers = []
        for name in parts.dropLast() {
            guard let modifier = modifierNames[name.lowercased()] else {
                throw KeyboardLayoutError.unknownModifier(name)
            }
            modifiers.insert(modifier)
        }
        if let named = NamedKey.named(last), last.count > 1 || named == .space {
            return KeyChord(modifiers: modifiers, key: .named(named))
        }
        guard last.count == 1, let character = last.first else {
            throw KeyboardLayoutError.unknownKey(last)
        }
        // Letters in a chord are case-free: `cmd+A` is ⌘A. Shift is said, not
        // implied by a capital.
        let lowered = Character(String(character).lowercased())
        return KeyChord(modifiers: modifiers, key: .character(lowered.isLetter ? lowered : character))
    }

    /// The modifiers named anywhere in `text`, for "shift" held during a click.
    public static func modifiers(in text: String) -> KeyModifiers {
        var result: KeyModifiers = []
        for part in text.lowercased().components(separatedBy: CharacterSet(charactersIn: "+ ,")) {
            if let modifier = modifierNames[part] { result.insert(modifier) }
        }
        return result
    }
}

public enum KeyboardLayoutError: Error, Equatable, Sendable, LocalizedError {
    case emptyChord
    case unknownKey(String)
    case unknownModifier(String)
    /// The character has no key on the active layout.
    case unmappable(character: String, layout: String)
    case layoutUnavailable(String)

    public var errorDescription: String? {
        switch self {
        case .emptyChord:
            "No key was given. Name a key like return or a chord like cmd+s."
        case let .unknownKey(key):
            "'\(key)' is not a key Juno knows. Use a character, or a name like return, tab, escape, delete, forward_delete, up, page_down or f5."
        case let .unknownModifier(modifier):
            "'\(modifier)' is not a modifier. Use cmd, shift, option, ctrl or fn."
        case let .unmappable(character, layout):
            "The character '\(character)' has no key on the \(layout) keyboard layout, so it cannot be part of a shortcut. Type it with the type action instead."
        case let .layoutUnavailable(id):
            "The keyboard layout \(id) could not be read."
        }
    }
}

/// One keyboard layout's map from characters to keys, built once and then
/// read from anywhere.
///
/// On the owner's French layout the key at the US "A" position types "q":
/// sending key code 0 for `cmd+a`, as the old table did, pressed ⌘Q and quit
/// the app (CU-02). Characters resolve through this map instead.
public struct KeyboardLayout: Hashable, Sendable {
    public var identifier: String
    public var displayName: String
    /// The cheapest stroke for each character: no modifier first, then shift,
    /// then option, then shift-option.
    public var strokes: [Character: KeyStroke]

    public init(identifier: String, displayName: String, strokes: [Character: KeyStroke]) {
        self.identifier = identifier
        self.displayName = displayName
        self.strokes = strokes
    }

    public func stroke(for character: Character) -> KeyStroke? {
        strokes[character]
    }

    /// A chord as key code and full modifier set, resolved on this layout.
    public func resolve(_ chord: KeyChord) throws -> KeyStroke {
        switch chord.key {
        case let .named(named):
            return KeyStroke(keyCode: named.keyCode, modifiers: chord.modifiers)
        case let .character(character):
            // A character the layout types with shift (a "?" on US, a "." on
            // French) keeps the shift it needs; one typed with option keeps
            // that too. The chord's own modifiers go on top.
            if let stroke = strokes[character] {
                return KeyStroke(keyCode: stroke.keyCode, modifiers: stroke.modifiers.union(chord.modifiers))
            }
            if let upper = String(character).uppercased().first, upper != character, let stroke = strokes[upper] {
                return KeyStroke(keyCode: stroke.keyCode, modifiers: stroke.modifiers.union(chord.modifiers))
            }
            throw KeyboardLayoutError.unmappable(character: String(character), layout: displayName)
        }
    }

    public func resolve(chord text: String) throws -> KeyStroke {
        try resolve(KeyChord.parse(text))
    }

    /// US ANSI, as a fallback when no layout can be read (and for tests).
    /// Never the answer on a Mac that can say what its layout is.
    public static let usANSI: KeyboardLayout = {
        let unshifted: [(Character, UInt16)] = [
            ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7),
            ("c", 8), ("v", 9), ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16),
            ("t", 17), ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("=", 24),
            ("9", 25), ("7", 26), ("-", 27), ("8", 28), ("0", 29), ("]", 30), ("o", 31), ("u", 32),
            ("[", 33), ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("'", 39), ("k", 40), (";", 41),
            ("\\", 42), (",", 43), ("/", 44), ("n", 45), ("m", 46), (".", 47), ("`", 50), (" ", 49),
        ]
        let shifted: [(Character, UInt16)] = [
            ("!", 18), ("@", 19), ("#", 20), ("$", 21), ("^", 22), ("%", 23), ("+", 24), ("(", 25),
            ("&", 26), ("_", 27), ("*", 28), (")", 29), ("}", 30), ("{", 33), ("\"", 39), (":", 41),
            ("|", 42), ("<", 43), ("?", 44), (">", 47), ("~", 50),
        ]
        var strokes: [Character: KeyStroke] = [:]
        for (character, code) in unshifted {
            strokes[character] = KeyStroke(keyCode: code)
            if character.isLetter, let upper = String(character).uppercased().first {
                strokes[upper] = KeyStroke(keyCode: code, modifiers: .shift)
            }
        }
        for (character, code) in shifted {
            strokes[character] = KeyStroke(keyCode: code, modifiers: .shift)
        }
        return KeyboardLayout(identifier: "com.apple.keylayout.US", displayName: "U.S.", strokes: strokes)
    }()
}

#if os(macOS)

/// Reads keyboard layouts from the Text Input Sources the Mac has installed.
///
/// Main actor only: since macOS 14 the TIS calls assert they run on the main
/// thread. The map they produce is a plain value and travels anywhere.
@MainActor
public enum KeyboardLayoutMapper {
    /// The layout the reader is typing with now.
    public static func current() -> KeyboardLayout? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return nil }
        return layout(of: source)
    }

    /// A layout by input-source id (`com.apple.keylayout.French`), read from
    /// the installed list without switching the system to it.
    public static func layout(inputSourceID: String) throws -> KeyboardLayout {
        let filter = [kTISPropertyInputSourceID as String: inputSourceID] as CFDictionary
        guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue(),
              CFArrayGetCount(list) > 0,
              let raw = CFArrayGetValueAtIndex(list, 0)
        else {
            throw KeyboardLayoutError.layoutUnavailable(inputSourceID)
        }
        let source = Unmanaged<TISInputSource>.fromOpaque(raw).takeUnretainedValue()
        guard let layout = layout(of: source) else {
            throw KeyboardLayoutError.layoutUnavailable(inputSourceID)
        }
        return layout
    }

    private static func string(_ source: TISInputSource, _ key: CFString) -> String? {
        guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
        return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
    }

    private static func layout(of source: TISInputSource) -> KeyboardLayout? {
        guard let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
        let identifier = string(source, kTISPropertyInputSourceID) ?? "unknown"
        let name = string(source, kTISPropertyLocalizedName) ?? identifier
        return KeyboardLayout(identifier: identifier, displayName: name, strokes: strokes(from: data))
    }

    /// The reverse map: every key code under each modifier state, asked
    /// what it types with dead keys off. The first state that types a
    /// character wins, so a character reachable without modifiers never
    /// picks up a shift.
    static func strokes(from layoutData: Data) -> [Character: KeyStroke] {
        let states: [(KeyModifiers, UInt32)] = [
            ([], 0),
            (.shift, UInt32(shiftKey >> 8) & 0xFF),
            (.option, UInt32(optionKey >> 8) & 0xFF),
            ([.shift, .option], UInt32((shiftKey | optionKey) >> 8) & 0xFF),
        ]
        var strokes: [Character: KeyStroke] = [:]
        let keyboardType = UInt32(LMGetKbdType())
        layoutData.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            for (modifiers, state) in states {
                for code in UInt16(0)..<128 {
                    // Keypad keys type the same digits as the main row on
                    // every layout; the main row is what a shortcut means.
                    if Self.keypadCodes.contains(code) { continue }
                    var deadKeyState: UInt32 = 0
                    var length = 0
                    var characters = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(
                        base,
                        code,
                        UInt16(kUCKeyActionDown),
                        state,
                        keyboardType,
                        OptionBits(kUCKeyTranslateNoDeadKeysBit),
                        &deadKeyState,
                        characters.count,
                        &length,
                        &characters
                    )
                    guard status == noErr, length > 0 else { continue }
                    let string = String(utf16CodeUnits: characters, count: length)
                    guard string.count == 1, let character = string.first else { continue }
                    // Control characters are what Return, Tab and Escape
                    // type; those are named keys, not characters.
                    if character.unicodeScalars.allSatisfy({ $0.value < 0x20 || $0.value == 0x7F }) { continue }
                    if strokes[character] == nil {
                        strokes[character] = KeyStroke(keyCode: code, modifiers: modifiers)
                    }
                }
            }
        }
        return strokes
    }

    private static let keypadCodes: Set<UInt16> = [
        65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92,
    ]
}

#endif
