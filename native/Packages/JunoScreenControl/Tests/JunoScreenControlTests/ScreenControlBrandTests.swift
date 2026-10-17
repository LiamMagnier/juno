import Foundation
import XCTest
@testable import JunoScreenControl

/// The codename never reaches a screen: every sentence screen control shows a
/// person goes through ``ScreenControlBrand``.
///
/// Reads the package's own sources and fails on any string literal that
/// spells the codename as a word. Comments and identifiers are not string
/// literals, and bundle ids are lowercase or glued to the next word
/// (`com.liammagnier.JunoDesktop`), so neither trips it.
final class ScreenControlBrandTests: XCTestCase {
    func testNoUserFacingStringLiteralSpellsTheCodename() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // JunoScreenControlTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // JunoScreenControl package
            .appendingPathComponent("Sources/JunoScreenControl", isDirectory: true)
        let files = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 10, "the sources were found")
        var leaks: [String] = []
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let text = try String(contentsOf: file, encoding: .utf8)
            for literal in SwiftStringLiterals.extract(from: text) where SwiftStringLiterals.spellsCodename(literal.text) {
                leaks.append("\(file.lastPathComponent):\(literal.line): \(literal.text)")
            }
        }
        XCTAssertEqual(leaks, [], "route these through ScreenControlBrand.productName")
    }

    func testTheScannerFindsTheCodenameInLiteralsButNotInCommentsOrIdentifiers() {
        let sample = #"""
        // Juno in a comment is fine.
        /// So is a doc comment about Juno.
        /* and a block comment: Juno */
        let JunoThing = "com.liammagnier.JunoDesktop"
        let a = "Juno is using \(app)"
        let b = "Let \(ScreenControlBrand.productName) use \(names.map { "\($0) (Juno)" })"
        let c = """
            Juno's own window
            """
        let d = "juno-screen-control"
        """#
        let found = SwiftStringLiterals.extract(from: sample).filter { SwiftStringLiterals.spellsCodename($0.text) }
        XCTAssertEqual(found.map(\.line), [5, 6, 7], found.map(\.text).joined(separator: " | "))
    }

    func testThePresenceCaptionSaysTheProductName() {
        let state = ScreenPresenceState(holder: ScreenControlHolder(id: "s", kind: .codeSession, title: "t", appName: "TextEdit"))
        XCTAssertEqual(state.caption, "Alevr is using TextEdit · Esc to stop")
        var paused = state
        paused.paused = true
        XCTAssertEqual(paused.caption, "You took over · Alevr is waiting")
        XCTAssertEqual(ScreenControlBrand.productName, "Alevr")
    }
}

/// A small Swift lexer: just enough to find string literals (with their
/// interpolations) and skip comments.
enum SwiftStringLiterals {
    struct Literal: Equatable {
        var text: String
        var line: Int
    }

    static func spellsCodename(_ text: String) -> Bool {
        text.range(of: #"\bJuno\b"#, options: .regularExpression) != nil
    }

    static func extract(from source: String) -> [Literal] {
        let chars = Array(source)
        var literals: [Literal] = []
        var index = 0
        var line = 1
        lexCode(chars, &index, &line, &literals, untilParen: false)
        return literals
    }

    /// Code, until the end (or, inside an interpolation, the closing paren).
    private static func lexCode(_ c: [Character], _ i: inout Int, _ line: inout Int, _ out: inout [Literal], untilParen: Bool) {
        var depth = 0
        while i < c.count {
            let ch = c[i]
            if ch == "\n" { line += 1; i += 1; continue }
            if ch == "/", i + 1 < c.count, c[i + 1] == "/" {
                while i < c.count, c[i] != "\n" { i += 1 }
                continue
            }
            if ch == "/", i + 1 < c.count, c[i + 1] == "*" {
                var nesting = 1
                i += 2
                while i < c.count, nesting > 0 {
                    if c[i] == "\n" { line += 1 }
                    if c[i] == "/", i + 1 < c.count, c[i + 1] == "*" { nesting += 1; i += 2; continue }
                    if c[i] == "*", i + 1 < c.count, c[i + 1] == "/" { nesting -= 1; i += 2; continue }
                    i += 1
                }
                continue
            }
            if ch == "#" || ch == "\"" {
                var hashes = 0
                var j = i
                while j < c.count, c[j] == "#" { hashes += 1; j += 1 }
                if j < c.count, c[j] == "\"" {
                    i = j
                    lexString(c, &i, &line, &out, hashes: hashes)
                    continue
                }
            }
            if untilParen {
                if ch == "(" { depth += 1 }
                if ch == ")" {
                    if depth == 0 { i += 1; return }
                    depth -= 1
                }
            }
            i += 1
        }
    }

    /// A string literal starting at its opening quote, with `hashes` raw
    /// delimiters. Interpolations are lexed as code, so a literal nested in
    /// one is found too; the outer literal's text keeps only its own parts.
    private static func lexString(_ c: [Character], _ i: inout Int, _ line: inout Int, _ out: inout [Literal], hashes: Int) {
        let startLine = line
        let multiline = i + 2 < c.count && c[i + 1] == "\"" && c[i + 2] == "\""
        i += multiline ? 3 : 1
        let closer = String(repeating: "\"", count: multiline ? 3 : 1) + String(repeating: "#", count: hashes)
        let escape = "\\" + String(repeating: "#", count: hashes)
        var text = ""
        while i < c.count {
            if matches(c, i, closer) {
                i += closer.count
                out.append(Literal(text: text, line: startLine))
                return
            }
            if matches(c, i, escape) {
                let after = i + escape.count
                if after < c.count, c[after] == "(" {
                    i = after + 1
                    lexCode(c, &i, &line, &out, untilParen: true)
                    text += "{}"
                    continue
                }
                if after < c.count {
                    text.append(c[after])
                    i = after + 1
                    continue
                }
            }
            if c[i] == "\n" {
                line += 1
                if !multiline {
                    out.append(Literal(text: text, line: startLine))
                    i += 1
                    return
                }
            }
            text.append(c[i])
            i += 1
        }
        out.append(Literal(text: text, line: startLine))
    }

    private static func matches(_ c: [Character], _ i: Int, _ token: String) -> Bool {
        var k = i
        for t in token {
            guard k < c.count, c[k] == t else { return false }
            k += 1
        }
        return true
    }
}
