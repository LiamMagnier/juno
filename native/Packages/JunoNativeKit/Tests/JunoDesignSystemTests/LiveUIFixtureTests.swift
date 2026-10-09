import Foundation
import XCTest
@testable import JunoDesignSystem

/// The Swift half of Live UI, held to the shared fixtures in
/// `contracts/live-ui/fixtures` — the same files `tests/live-ui.test.ts` runs
/// the TypeScript against. Read by path, so there is one set and no copy to
/// drift: a formula, a streaming prefix or a repaired component must mean the
/// same thing on a phone as in a browser.
final class LiveUIFixtureTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // …/JunoDesignSystemTests
        .deletingLastPathComponent()  // …/Tests
        .deletingLastPathComponent()  // …/JunoNativeKit
        .deletingLastPathComponent()  // …/Packages
        .deletingLastPathComponent()  // …/native
        .deletingLastPathComponent()  // the repository
        .appendingPathComponent("contracts/live-ui/fixtures")

    private func cases(_ name: String) throws -> [[String: Any]] {
        let data = try Data(contentsOf: Self.fixtures.appendingPathComponent(name))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any])
        return try XCTUnwrap(root["cases"] as? [[String: Any]])
    }

    /// Foundation JSON → LiveJSON (all closed), booleans told apart from numbers.
    private func json(_ any: Any) -> LiveJSON {
        if any is NSNull { return .null }
        if let n = any as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            return .number(n.doubleValue)
        }
        if let s = any as? String { return .string(s) }
        if let a = any as? [Any] { return .array(a.map(json), open: false) }
        if let o = any as? [String: Any] {
            // Fixture objects compare by content, so order them like the reader would not matter.
            return .object(LiveJSONObject(pairs: o.keys.sorted().map { ($0, json(o[$0]!)) }), open: false)
        }
        return .null
    }

    private func sortedKeys(_ v: LiveJSON) -> LiveJSON {
        switch v {
        case .array(let items, let open): .array(items.map(sortedKeys), open: open)
        case .object(let o, let open):
            .object(LiveJSONObject(pairs: o.pairs.sorted { $0.0 < $1.0 }.map { ($0.0, sortedKeys($0.1)) }), open: open)
        default: v
        }
    }

    private func value(_ any: Any) -> LiveValue {
        LiveValue(json: json(any))
    }

    private func assertClose(_ actual: LiveValue, _ expected: LiveValue, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        switch (actual, expected) {
        case (.number(let a), .number(let e)):
            XCTAssertLessThanOrEqual(abs(a - e), max(1e-9, abs(e) * 1e-9), "\(message): \(a) != \(e)", file: file, line: line)
        case (.list(let a), .list(let e)):
            XCTAssertEqual(a.count, e.count, "\(message): length", file: file, line: line)
            for (index, pair) in zip(a, e).enumerated() { assertClose(pair.0, pair.1, "\(message)[\(index)]", file: file, line: line) }
        default:
            XCTAssertEqual(actual, expected, message, file: file, line: line)
        }
    }

    func testTolerantJSONReader() throws {
        for c in try cases("json.json") {
            let source = try XCTUnwrap(c["source"] as? String)
            let result = LiveJSONReader.read(source)
            if c["error"] as? Bool == true {
                XCTAssertNotNil(result.error, "expected an error for \(source)")
                continue
            }
            XCTAssertNil(result.error, source)
            let hasValue = try XCTUnwrap(c["hasValue"] as? Bool)
            XCTAssertEqual(result.value != nil, hasValue, "hasValue \(source)")
            if hasValue, let v = result.value {
                XCTAssertEqual(sortedKeys(v.closed), json(c["value"]!), source)
                XCTAssertEqual(v.openPaths(), c["open"] as? [String], "open \(source)")
            }
            XCTAssertEqual(result.complete, c["complete"] as? Bool, "complete \(source)")
        }
    }

    func testExpressionsLetsAndCanonicalFormatting() throws {
        for c in try cases("expr.json") {
            let name = c["name"] as? String ?? "?"
            let inputs = (c["inputs"] as? [String: Any] ?? [:]).mapValues(value)
            let data = (c["data"] as? [String: Any] ?? [:]).mapValues(value)
            let letDict = c["let"] as? [String: String] ?? [:]
            // Order is irrelevant to results; lets are lazy.
            let scope = LiveScope(inputs: inputs, lets: letDict.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }, data: data, currency: c["currency"] as? String ?? "USD")
            if let expectLets = c["expectLets"] as? [String: [String: Any]] {
                let lets = scope.allLets()
                for (letName, expected) in expectLets {
                    if expected["error"] as? Bool == true {
                        XCTAssertNotNil(lets.errors[letName], "\(name): let \(letName) should fail")
                    } else {
                        assertClose(lets.values[letName] ?? .null, value(expected["value"] ?? NSNull()), "\(name): let \(letName)")
                    }
                }
            }
            for e in c["exprs"] as? [[String: Any]] ?? [] {
                let src = try XCTUnwrap(e["expr"] as? String)
                let result = scope.evaluate(src)
                if e["error"] as? Bool == true {
                    XCTAssertEqual(result.value, .null, "\(name): \(src)")
                    XCTAssertNotNil(result.error, "\(name): \(src) should report an error")
                } else {
                    XCTAssertNil(result.error, "\(name): \(src) → \(result.error ?? "")")
                    assertClose(result.value, value(e["value"] ?? NSNull()), "\(name): \(src)")
                }
            }
        }
    }

    private func summarize(_ c: LiveComponent) -> [String: Any] {
        var o: [String: Any] = ["key": c.key, "type": c.typeName]
        func any(_ v: LiveValue) -> Any {
            switch v {
            case .null: NSNull()
            case .bool(let b): b
            case .number(let n): n
            case .string(let s): s
            default: NSNull()
            }
        }
        switch c {
        case .layout(let l):
            o["pending"] = l.pending
            o["children"] = l.children.map(summarize)
        case .input(let i):
            o["id"] = i.id
            o["value"] = any(i.value)
            if i.kind == .select {
                o["style"] = i.segmented ? "segmented" : "menu"
                o["options"] = i.options.map { any($0.value) }
            }
            if i.kind == .slider || i.kind == .stepper {
                o["min"] = i.min
                o["max"] = i.max
                o["step"] = i.step
            }
        case .metric(let m): o["expr"] = m.value
        case .progress(let p): o["expr"] = p.value
        case .text(let t): o["tone"] = t.tone.rawValue
        case .chart(let ch):
            o["kind"] = ch.kind.rawValue
            o["series"] = ch.series.count
            o["range"] = ch.x != nil
        case .explorer(let ex):
            o["parts"] = ex.parts.map(\.id)
            o["placed"] = ex.parts.allSatisfy { $0.at != nil }
            o["links"] = ex.links.count
        case .checklist(let cl): o["id"] = cl.id
        case .steps(let st):
            o["steps"] = st.steps.map { ["title": $0.title, "notice": $0.notice != nil, "children": $0.ui.map(summarize)] as [String: Any] }
            o["takeaway"] = st.takeaway != nil
        case .quiz(let q): o["answers"] = q.questions.map(\.answer)
        case .callout(let c):
            o["tone"] = c.tone.rawValue
            o["more"] = c.more != nil
        case .timeline(let t): o["items"] = t.items.count
        case .table(let t):
            if t.rowHeader { o["rowHeader"] = true }
            if let h = t.highlight { o["highlight"] = h }
        default: break
        }
        return o
    }

    func testSpecNormalisationStreamingAndRepairs() throws {
        for c in try cases("spec.json") {
            let name = c["name"] as? String ?? "?"
            let source = try XCTUnwrap(c["source"] as? String)
            let parsed = LiveSpecParser.parse(source)
            if c["error"] as? Bool == true {
                XCTAssertNil(parsed.spec, name)
                continue
            }
            let spec = try XCTUnwrap(parsed.spec, "\(name): \(parsed.error ?? "")")
            let expect = try XCTUnwrap(c["expect"] as? [String: Any])
            let actual: [String: Any] = [
                "title": spec.title ?? NSNull(),
                "currency": spec.currency,
                "streaming": spec.streaming,
                "lets": spec.lets.map(\.0),
                "data": spec.dataKeys,
                "ui": spec.ui.map(summarize),
            ]
            XCTAssertEqual(json(actual), json(expect), name)
        }
    }

    func testEveryPrefixOfABlockParses() throws {
        let source = try XCTUnwrap(try cases("spec.json").first?["source"] as? String)
        var last = 0
        let units = Array(source.utf16)
        for n in 0...units.count {
            let prefix = String(decoding: units[0..<n], as: UTF16.self)
            let parsed = LiveSpecParser.parse(prefix)
            let spec = try XCTUnwrap(parsed.spec, "prefix \(n): \(parsed.error ?? "")")
            XCTAssertGreaterThanOrEqual(spec.inputs.count, last, "inputs shrank at \(n)")
            last = spec.inputs.count
        }
        XCTAssertEqual(last, 2)
    }

    func testSafetyBounds() {
        let scope = LiveScope(inputs: [:], lets: [], data: ["o": .object(["a": .number(1)])])
        for src in ["constructor", "o.constructor", "o.__proto__", "toString", "process"] {
            XCTAssertEqual(scope.evaluate(src).value, .null, src)
        }
        XCTAssertNotNil(scope.evaluate(String(repeating: "1+", count: 250) + "1").error)
        XCTAssertNotNil(scope.evaluate(String(repeating: "(", count: 40) + "1" + String(repeating: ")", count: 40)).error)
        let times = { (name: String) in Array(repeating: name, count: 20).joined(separator: " * ") }
        let heavy = LiveScope(
            inputs: [:],
            lets: [("r", "range(1, 500) / 500"), ("l1", times("r")), ("l2", times("l1")), ("l3", times("l2")), ("l4", times("l3")), ("l5", times("l4")), ("l6", times("l5"))],
            data: [:]
        )
        XCTAssertEqual(heavy.evaluate("sum(l6)").value, .null)
    }

    func testInterpolationHashAndFence() {
        let scope = LiveScope(inputs: ["n": .number(1234.5)], lets: [], data: [:])
        XCTAssertEqual(liveInterpolate("Total {{n}} and {{fmt(n,'currency')}}", scope: scope), "Total 1,234.5 and $1,234.50")
        XCTAssertEqual(liveInterpolate("Missing {{nope}} here", scope: scope), "Missing – here")
        XCTAssertEqual(liveInterpolate("Literal {{ not closed", scope: scope), "Literal {{ not closed")
        XCTAssertEqual(LiveSpecParser.hash(""), "811c9dc5")
        XCTAssertEqual(LiveSpecParser.hash("a"), "e40c292c")
        XCTAssertTrue(JunoLiveUIMarkup.isLiveFence(info: "live-ui"))
        XCTAssertTrue(JunoLiveUIMarkup.isLiveFence(info: "LIVE"))
        XCTAssertFalse(JunoLiveUIMarkup.isLiveFence(info: "json"))
        XCTAssertEqual(liveCanonicalNumberString(1.0 / 3.0), "0.3333333333")
        XCTAssertEqual(liveCanonicalNumberString(2e21), "2.000e+21")
        XCTAssertEqual(LiveSpecParser.snap(0.30000000000000004, min: 0, max: 1, step: 0.1), 0.3)
    }
}
