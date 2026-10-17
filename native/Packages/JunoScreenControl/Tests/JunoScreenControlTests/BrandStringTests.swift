import Foundation
import XCTest
@testable import JunoScreenControl

/// The repository's codename never reaches a person: not in the caption under
/// the menu bar, not on an approval card, not in a refusal the model relays.
///
/// Reads every string literal in screen control's sources and in Work's
/// automation module, which share the screen and its sentences, and fails on
/// the codename in any of them. Comments and code identifiers are not string
/// literals, so they never count; inside a literal, a dotted identifier
/// (`com.liammagnier.JunoDesktop`) or a CamelCase type name (`JunoDesktop`)
/// is an identifier, not a word anyone reads. A bare word, or one with an
/// apostrophe ("Juno's"), is the brand, and fails.
final class BrandStringTests: XCTestCase {
    /// The codename, spelled so this file does not trip its own scan.
    static let codename = "Ju" + "no"

    func testNoUserFacingStringInScreenControlOrWorkAutomationSaysTheCodename() throws {
        let packages = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // JunoScreenControlTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // JunoScreenControl
            .deletingLastPathComponent() // Packages
        let folders = [
            packages.appendingPathComponent("JunoScreenControl/Sources/JunoScreenControl"),
            packages.appendingPathComponent("JunoWork/Sources/JunoWorkAutomation"),
        ]
        var scanned = 0
        var violations: [String] = []
        for folder in folders {
            let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "swift" }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            XCTAssertFalse(files.isEmpty, "no sources found in \(folder.path)")
            for file in files {
                let source = try String(contentsOf: file, encoding: .utf8)
                scanned += 1
                for literal in SwiftStringLiterals.literals(in: source) where BrandScan.saysCodename(literal.text) {
                    violations.append("\(folder.lastPathComponent)/\(file.lastPathComponent):\(literal.line): \(literal.text)")
                }
            }
        }
        XCTAssertGreaterThan(scanned, 20, "both modules were read")
        XCTAssertTrue(
            violations.isEmpty,
            "Say ScreenControlBrand.productName (or AutomationBrand.productName in Work) instead:\n"
                + violations.joined(separator: "\n")
        )
    }

    func testTheProductNameIsAlevr() {
        XCTAssertEqual(ScreenControlBrand.productName, "Alevr")
    }

    // MARK: - The scanner itself

    /// The old caption, the one this test exists for, is caught.
    func testTheOldCaptionWouldFail() {
        let old = #"let app = holder.appName.map { "\#(Self.codename) is using \($0)" } ?? "\#(Self.codename) is using apps""#
        let literals = SwiftStringLiterals.literals(in: old)
        XCTAssertEqual(literals.map(\.text), ["\(Self.codename) is using ", "\(Self.codename) is using apps"])
        XCTAssertTrue(literals.allSatisfy { BrandScan.saysCodename($0.text) })
    }

    func testCommentsIdentifiersAndBundleIDsDoNotCount() {
        let name = Self.codename
        let source = """
        // \(name) is in a comment.
        /* \(name) in a block /* nested \(name) */ still a comment */
        /// \(name) in documentation.
        let \(name)Thing = \(name)Desktop.shared
        let bundle = "com.liammagnier.\(name)Desktop.debug"
        let module = "\(name)ScreenControl"
        let thread = "juno-screen-control"
        """
        let flagged = SwiftStringLiterals.literals(in: source).filter { BrandScan.saysCodename($0.text) }
        XCTAssertEqual(flagged.map(\.text), [])
    }

    func testEveryKindOfLiteralIsRead() {
        let name = Self.codename
        let source = """
        let a = "plain \(name) here"
        let b = "\\(value) then \(name)'s word"
        let c = \"\"\"
            A multi-line literal
            where \(name) speaks.
            \"\"\"
        let d = #"raw \(name) "quoted" text"#
        let e = "outer \\(f("inner \(name)")) end"
        """
        let flagged = SwiftStringLiterals.literals(in: source).filter { BrandScan.saysCodename($0.text) }
        XCTAssertEqual(flagged.count, 5, flagged.map(\.text).joined(separator: " | "))
        XCTAssertEqual(SwiftStringLiterals.literals(in: source).first { $0.text.contains("speaks") }?.line, 3)
    }
}

// MARK: - A small Swift literal reader

/// The text segments of every string literal in a Swift source, with the line
/// each starts on. Interpolated code is not text; string literals inside it
/// are literals of their own.
enum SwiftStringLiterals {
    struct Literal: Equatable {
        var line: Int
        var text: String
    }

    static func literals(in source: String) -> [Literal] {
        var reader = Reader(Array(source))
        reader.scanCode(untilCloseParen: false)
        return reader.found
    }

    private struct Reader {
        let chars: [Character]
        var index = 0
        var line = 1
        var found: [Literal] = []

        init(_ chars: [Character]) {
            self.chars = chars
        }

        func peek(_ offset: Int = 0) -> Character? {
            let at = index + offset
            return at < chars.count ? chars[at] : nil
        }

        mutating func advance(_ count: Int = 1) {
            for _ in 0..<count where index < chars.count {
                if chars[index] == "\n" { line += 1 }
                index += 1
            }
        }

        /// Code: skips comments, reads literals. Stops at the `)` that closes
        /// an interpolation when asked to.
        mutating func scanCode(untilCloseParen: Bool) {
            var depth = 0
            while let c = peek() {
                if c == "/", peek(1) == "/" {
                    while let n = peek(), n != "\n" { advance() }
                } else if c == "/", peek(1) == "*" {
                    skipBlockComment()
                } else if c == "#" || c == "\"" {
                    var hashes = 0
                    while peek(hashes) == "#" { hashes += 1 }
                    if peek(hashes) == "\"" {
                        advance(hashes)
                        scanLiteral(hashes: hashes)
                    } else {
                        advance(max(hashes, 1))
                    }
                } else if untilCloseParen, c == "(" {
                    depth += 1
                    advance()
                } else if untilCloseParen, c == ")" {
                    if depth == 0 {
                        advance()
                        return
                    }
                    depth -= 1
                    advance()
                } else {
                    advance()
                }
            }
        }

        mutating func skipBlockComment() {
            advance(2)
            var depth = 1
            while depth > 0, let c = peek() {
                if c == "/", peek(1) == "*" {
                    depth += 1
                    advance(2)
                } else if c == "*", peek(1) == "/" {
                    depth -= 1
                    advance(2)
                } else {
                    advance()
                }
            }
        }

        /// At the opening quote, after any `#`s.
        mutating func scanLiteral(hashes: Int) {
            let multiline = peek() == "\"" && peek(1) == "\"" && peek(2) == "\""
            advance(multiline ? 3 : 1)
            let quotes = multiline ? 3 : 1
            var text = ""
            var startLine = line
            func closes(_ reader: Reader) -> Bool {
                for offset in 0..<quotes where reader.peek(offset) != "\"" { return false }
                for offset in 0..<hashes where reader.peek(quotes + offset) != "#" { return false }
                return true
            }
            while let c = peek() {
                if closes(self) {
                    advance(quotes + hashes)
                    break
                }
                if c == "\\", (0..<hashes).allSatisfy({ peek(1 + $0) == "#" }) {
                    let after = peek(1 + hashes)
                    if after == "(" {
                        // Interpolation: the text so far is one segment.
                        if !text.isEmpty { found.append(Literal(line: startLine, text: text)) }
                        text = ""
                        advance(2 + hashes)
                        scanCode(untilCloseParen: true)
                        startLine = line
                        continue
                    }
                    // An escape stands for one character; a space keeps words apart.
                    text.append(after == "n" || after == "t" ? " " : (after ?? " "))
                    advance(2 + hashes)
                    continue
                }
                if !multiline, c == "\n" { break }
                text.append(c)
                advance()
            }
            if !text.isEmpty { found.append(Literal(line: startLine, text: text)) }
        }
    }
}

/// Whether a literal's text says the codename as a word.
enum BrandScan {
    static func saysCodename(_ text: String) -> Bool {
        let name = BrandStringTests.codename
        guard text.contains(name) else { return false }
        let tokens = text.split(whereSeparator: { $0.isWhitespace })
        return tokens.contains { token in
            guard token.contains(name) else { return false }
            return !isIdentifier(String(token), name: name)
        }
    }

    /// `com.liammagnier.JunoDesktop`, `JunoScreenControl`, `JunoDesktop.app`:
    /// identifiers, not words. Every occurrence in the token must be one.
    static func isIdentifier(_ token: String, name: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’()[]{},;:!?"))
        // A dotted identifier: no spaces, a dot between word characters.
        let dotted = trimmed.contains(".") && !trimmed.hasSuffix(".")
            && trimmed.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_" }
        if dotted { return true }
        // Every occurrence glued to another word character on its right, as in
        // a CamelCase type name; a bare word or a possessive is the brand.
        var rest = Substring(trimmed)
        while let range = rest.range(of: name) {
            let next = rest[range.upperBound...].first
            guard let next, next.isLetter || next.isNumber || next == "_" else { return false }
            rest = rest[range.upperBound...]
        }
        return true
    }
}
