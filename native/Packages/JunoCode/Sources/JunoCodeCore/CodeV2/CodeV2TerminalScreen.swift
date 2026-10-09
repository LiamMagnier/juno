import Foundation

/// A small terminal screen for the env server's `terminal.output` stream
/// (Dock › Terminal on the Mac).
///
/// Not an emulator: it keeps scrollback lines and a cursor, applies the
/// control characters a shell and most CLIs actually send (CR, LF, BS, TAB,
/// erase-in-line, clear-screen, cursor left/right/column), and drops every
/// other escape sequence (colours, titles, cursor save/restore, modes)
/// instead of printing it. Escape sequences split across chunks are carried
/// over, so feeding the stream in any slicing gives the same screen.
public struct CodeV2TerminalScreen: Equatable, Sendable {
    public let maximumLines: Int
    public private(set) var lines: [[Character]] = [[]]
    public private(set) var row = 0
    public private(set) var column = 0
    /// Lines dropped from the top to stay under ``maximumLines``.
    public private(set) var droppedLines = 0

    private enum Mode: Equatable, Sendable {
        case text
        case escape
        case csi(String)
        /// OSC/DCS/APC/PM string: runs to BEL or ESC \.
        case string(sawEscape: Bool)
        /// ESC followed by a charset designator (`ESC ( B`): one more char.
        case designator
    }

    private var mode: Mode = .text

    public init(maximumLines: Int = 5_000) {
        self.maximumLines = max(10, maximumLines)
    }

    /// Everything on screen, one string per line, trailing blanks trimmed at
    /// the end of the buffer.
    public var text: String {
        var rendered = lines.map { String($0) }
        while rendered.count > 1, rendered.last?.isEmpty == true { rendered.removeLast() }
        return rendered.joined(separator: "\n")
    }

    public mutating func clear() {
        lines = [[]]
        row = 0
        column = 0
    }

    public mutating func feed(_ chunk: String) {
        for character in chunk {
            consume(character)
        }
    }

    private mutating func consume(_ character: Character) {
        switch mode {
        case .text:
            text(character)
        case .escape:
            switch character {
            case "[": mode = .csi("")
            case "]", "P", "_", "^", "X": mode = .string(sawEscape: false)
            case "(", ")", "*", "+", "#", "%": mode = .designator
            case "c":
                clear()
                mode = .text
            default:
                // ESC 7 / ESC 8 / ESC = / ESC > / ESC M …: nothing to draw.
                mode = .text
            }
        case let .csi(parameters):
            guard let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1 else {
                mode = .text
                return
            }
            if (0x40...0x7E).contains(scalar.value) {
                mode = .text
                csi(final: character, parameters: parameters)
            } else if parameters.count > 64 {
                // A runaway sequence: drop it rather than buffer forever.
                mode = .text
            } else {
                mode = .csi(parameters + String(character))
            }
        case let .string(sawEscape):
            if character == "\u{07}" || (sawEscape && character == "\\") {
                mode = .text
            } else {
                mode = .string(sawEscape: character == "\u{1B}")
            }
        case .designator:
            mode = .text
        }
    }

    private mutating func text(_ character: Character) {
        switch character {
        case "\u{1B}":
            mode = .escape
        case "\r\n":
            column = 0
            lineFeed()
        case "\r":
            column = 0
        case "\n":
            lineFeed()
        case "\u{08}":
            column = max(0, column - 1)
        case "\t":
            let next = (column / 8 + 1) * 8
            while column < next { put(" ") }
        case "\u{07}":
            break
        default:
            if let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1,
               scalar.value < 0x20 || scalar.value == 0x7F {
                return
            }
            put(character)
        }
    }

    private mutating func put(_ character: Character) {
        var line = lines[row]
        if column < line.count {
            line[column] = character
        } else {
            if column > line.count { line.append(contentsOf: Array(repeating: " ", count: column - line.count)) }
            line.append(character)
        }
        lines[row] = line
        column += 1
    }

    private mutating func lineFeed() {
        row += 1
        if row == lines.count { lines.append([]) }
        if lines.count > maximumLines {
            let excess = lines.count - maximumLines
            lines.removeFirst(excess)
            row -= excess
            droppedLines += excess
        }
    }

    private mutating func csi(final: Character, parameters: String) {
        // Private-mode prefixes (`?`, `>`, `=`) never move text here.
        let isPrivate = parameters.first.map { "?>=<".contains($0) } ?? false
        let numbers = parameters.drop { "?>=<".contains($0) }
            .split(separator: ";", omittingEmptySubsequences: false)
            .map { Int($0) }
        func value(_ index: Int, default fallback: Int) -> Int {
            guard index < numbers.count, let number = numbers[index] else { return fallback }
            return number
        }
        guard !isPrivate else { return }
        switch final {
        case "K":
            var line = lines[row]
            switch value(0, default: 0) {
            case 0: if column < line.count { line.removeSubrange(column...) }
            case 1: for index in 0..<min(column + 1, line.count) { line[index] = " " }
            default: line = []
            }
            lines[row] = line
        case "J":
            switch value(0, default: 0) {
            case 2, 3:
                clear()
            case 0:
                if column < lines[row].count { lines[row].removeSubrange(column...) }
                if row + 1 < lines.count { lines.removeSubrange((row + 1)...) }
            default:
                break
            }
        case "C":
            column += max(1, value(0, default: 1))
        case "D":
            column = max(0, column - max(1, value(0, default: 1)))
        case "G":
            column = max(0, value(0, default: 1) - 1)
        case "H", "f":
            // Absolute positioning: a home with no row is the usual
            // "clear then home"; anything else keeps the current line.
            if value(0, default: 1) <= 1 { column = max(0, value(1, default: 1) - 1) }
        case "P":
            let count = max(1, value(0, default: 1))
            if column < lines[row].count {
                lines[row].removeSubrange(column..<min(lines[row].count, column + count))
            }
        default:
            // SGR colours, scroll regions, cursor up/down: nothing to draw.
            break
        }
    }
}
