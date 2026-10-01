import AppKit
import WebKit

/// Real input for the Preview: synthesized `NSEvent`s delivered to the web
/// view, so the page receives trusted `pointerdown`, `mousedown`, `keydown`
/// and `input` events (CODE_AGENT_SPEC §4.3, PV-19). `el.click()` fires one
/// untrusted `click` and nothing a Radix menu listens for.
///
/// Events go to the web view itself, never to the window server: nothing here
/// moves the reader's pointer or reaches another app. The offscreen-host
/// spike (docs/rework/PROGRESS.md) measured that a page in a window that is
/// never ordered front receives these as trusted events.
@MainActor
enum PreviewInput {
    enum Button: String, Sendable {
        case left, right, middle
    }

    /// A key and its modifiers, from `Enter`, `Meta+K`, `Shift+Tab`.
    struct Chord: Equatable, Sendable {
        var key: String
        var modifiers: NSEvent.ModifierFlags

        static func == (lhs: Chord, rhs: Chord) -> Bool {
            lhs.key == rhs.key && lhs.modifiers.rawValue == rhs.modifiers.rawValue
        }
    }

    nonisolated static func parseChord(_ text: String) -> Chord? {
        let parts = text.split(separator: "+", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard let last = parts.last, !last.isEmpty || text.hasSuffix("++") else { return nil }
        var modifiers: NSEvent.ModifierFlags = []
        for part in parts.dropLast() {
            switch part.lowercased() {
            case "meta", "cmd", "command": modifiers.insert(.command)
            case "control", "ctrl": modifiers.insert(.control)
            case "alt", "option", "opt": modifiers.insert(.option)
            case "shift": modifiers.insert(.shift)
            case "": continue
            default: return nil
            }
        }
        let key = last.isEmpty ? "+" : last
        guard namedKeys[key.lowercased()] != nil || key.count == 1 else { return nil }
        return Chord(key: key, modifiers: modifiers)
    }

    // MARK: - Mouse

    /// A click at `point` (CSS pixels from the page's top-left, which are the
    /// web view's own points): a move first, so hover-revealed controls exist,
    /// then down and up `count` times.
    static func click(
        _ webView: WKWebView,
        at point: CGPoint,
        button: Button = .left,
        count: Int = 1,
        modifiers: NSEvent.ModifierFlags = []
    ) {
        move(webView, to: point, modifiers: modifiers)
        for index in 1...max(1, min(count, 3)) {
            send(webView, type: downType(button), at: point, clickCount: index, modifiers: modifiers)
            send(webView, type: upType(button), at: point, clickCount: index, modifiers: modifiers)
        }
    }

    static func move(_ webView: WKWebView, to point: CGPoint, modifiers: NSEvent.ModifierFlags = []) {
        send(webView, type: .mouseMoved, at: point, clickCount: 0, modifiers: modifiers)
    }

    static func drag(_ webView: WKWebView, from start: CGPoint, to end: CGPoint, steps: Int = 12) {
        move(webView, to: start)
        send(webView, type: .leftMouseDown, at: start, clickCount: 1, modifiers: [])
        let count = max(2, steps)
        for step in 1...count {
            let fraction = CGFloat(step) / CGFloat(count)
            let point = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
            send(webView, type: .leftMouseDragged, at: point, clickCount: 1, modifiers: [])
        }
        send(webView, type: .leftMouseUp, at: end, clickCount: 1, modifiers: [])
    }

    private static func downType(_ button: Button) -> NSEvent.EventType {
        switch button {
        case .left: .leftMouseDown
        case .right: .rightMouseDown
        case .middle: .otherMouseDown
        }
    }

    private static func upType(_ button: Button) -> NSEvent.EventType {
        switch button {
        case .left: .leftMouseUp
        case .right: .rightMouseUp
        case .middle: .otherMouseUp
        }
    }

    private static func send(
        _ webView: WKWebView,
        type: NSEvent.EventType,
        at point: CGPoint,
        clickCount: Int,
        modifiers: NSEvent.ModifierFlags
    ) {
        guard let window = webView.window else { return }
        let location = webView.convert(point, to: nil)
        guard let event = NSEvent.mouseEvent(
            with: type,
            location: location,
            modifierFlags: modifiers,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: clickCount,
            pressure: type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp ? 0 : 1
        ) else { return }
        switch type {
        case .leftMouseDown: webView.mouseDown(with: event)
        case .leftMouseUp: webView.mouseUp(with: event)
        case .rightMouseDown: webView.rightMouseDown(with: event)
        case .rightMouseUp: webView.rightMouseUp(with: event)
        case .otherMouseDown: webView.otherMouseDown(with: event)
        case .otherMouseUp: webView.otherMouseUp(with: event)
        case .leftMouseDragged: webView.mouseDragged(with: event)
        default: webView.mouseMoved(with: event)
        }
    }

    // MARK: - Keys

    /// Presses `chord` `repeat` times.
    static func press(_ webView: WKWebView, _ chord: Chord, repeat count: Int = 1) {
        withFirstResponder(webView) {
            for _ in 0..<max(1, min(count, 100)) {
                sendKey(webView, chord.key, modifiers: chord.modifiers)
            }
        }
    }

    /// Types `text` one character at a time as key events, so `keydown`,
    /// `beforeinput`, `input` and `keyup` all fire as they do for a person.
    static func type(_ webView: WKWebView, _ text: String) {
        withFirstResponder(webView) {
            for character in text {
                if character == "\n" {
                    sendKey(webView, "Enter", modifiers: [])
                } else {
                    sendKey(webView, String(character), modifiers: [])
                }
            }
        }
    }

    /// The web view takes keyboard focus for the keystrokes and gives it back,
    /// so a visible Preview does not keep the reader's focus.
    private static func withFirstResponder(_ webView: WKWebView, _ body: () -> Void) {
        guard let window = webView.window else { return }
        let previous = window.firstResponder
        if previous !== webView { window.makeFirstResponder(webView) }
        body()
        if let previous, previous !== webView, previous !== window.firstResponder {
            window.makeFirstResponder(previous)
        }
    }

    private struct KeySpec {
        var keyCode: UInt16
        var characters: String
        var ignoringModifiers: String
        var shift: Bool
    }

    private static func sendKey(_ webView: WKWebView, _ key: String, modifiers: NSEvent.ModifierFlags) {
        guard let window = webView.window else { return }
        let spec = keySpec(for: key)
        var flags = modifiers
        if spec.shift { flags.insert(.shift) }
        let characters = flags.contains(.command) || flags.contains(.control) ? spec.ignoringModifiers : spec.characters
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(
                with: type,
                location: .zero,
                modifierFlags: flags,
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                characters: characters,
                charactersIgnoringModifiers: spec.ignoringModifiers,
                isARepeat: false,
                keyCode: spec.keyCode
            ) else { continue }
            if type == .keyDown { webView.keyDown(with: event) } else { webView.keyUp(with: event) }
        }
    }

    private static func keySpec(for key: String) -> KeySpec {
        if let named = namedKeys[key.lowercased()] {
            return KeySpec(keyCode: named.code, characters: named.characters, ignoringModifiers: named.characters, shift: false)
        }
        let character = key
        if let code = usKeyCodes[character.lowercased()], character.lowercased() == character {
            return KeySpec(keyCode: code, characters: character, ignoringModifiers: character, shift: false)
        }
        if character.count == 1, let lower = character.first?.lowercased(), let code = usKeyCodes[lower], character != lower {
            // An uppercase letter.
            return KeySpec(keyCode: code, characters: character, ignoringModifiers: lower, shift: true)
        }
        if let base = shiftedSymbols[character], let code = usKeyCodes[base] {
            return KeySpec(keyCode: code, characters: character, ignoringModifiers: base, shift: true)
        }
        // Accents, emoji and other scripts: no physical key; WebKit inserts
        // the event's characters.
        return KeySpec(keyCode: 0, characters: character, ignoringModifiers: character, shift: false)
    }

    nonisolated private static let namedKeys: [String: (code: UInt16, characters: String)] = {
        func function(_ value: Int) -> String { String(UnicodeScalar(value).map(Character.init) ?? " ") }
        var keys: [String: (UInt16, String)] = [
            "enter": (36, "\r"), "return": (36, "\r"), "tab": (48, "\t"), "space": (49, " "), " ": (49, " "),
            "backspace": (51, "\u{7F}"), "escape": (53, "\u{1B}"), "esc": (53, "\u{1B}"),
            "delete": (117, function(0xF728)), "home": (115, function(0xF729)), "end": (119, function(0xF72B)),
            "pageup": (116, function(0xF72C)), "pagedown": (121, function(0xF72D)),
            "arrowleft": (123, function(0xF702)), "arrowright": (124, function(0xF703)),
            "arrowdown": (125, function(0xF701)), "arrowup": (126, function(0xF700)),
            "left": (123, function(0xF702)), "right": (124, function(0xF703)),
            "down": (125, function(0xF701)), "up": (126, function(0xF700)),
        ]
        let functionCodes: [UInt16] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
        for (index, code) in functionCodes.enumerated() {
            keys["f\(index + 1)"] = (code, function(0xF704 + index))
        }
        return keys.mapValues { (code: $0.0, characters: $0.1) }
    }()

    private static let usKeyCodes: [String: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
        "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
        "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
        ".": 47, "`": 50, " ": 49,
    ]

    private static let shiftedSymbols: [String: String] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]
}
