import Foundation

/// The tolerant JSON reader behind Live UI (docs/design/LIVE_UI.md §5), the
/// Swift twin of `src/lib/live-ui/json.ts`.
///
/// A Live UI block is read while the model is still writing it, so this reader
/// returns everything that has fully *arrived* and marks every container that
/// has not closed. The rules match the TypeScript byte for byte and are held to
/// `contracts/live-ui/fixtures/json.json`:
///
/// 1. A string, number or literal still being written at the end of input is
///    dropped, never surfaced half-typed.
/// 2. An object key whose value has not arrived is dropped.
/// 3. Every object and array without its closing bracket is `open`.
///
/// Trailing commas and raw newlines inside strings are accepted. It reads the
/// source as UTF-16, exactly as JavaScript indexes it, so limits and escapes
/// agree on both platforms.
public indirect enum LiveJSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([LiveJSON], open: Bool)
    case object(LiveJSONObject, open: Bool)

    public var isOpen: Bool {
        switch self {
        case .array(_, let open), .object(_, let open): open
        default: false
        }
    }

    public subscript(key: String) -> LiveJSON? {
        if case .object(let object, _) = self { return object[key] }
        return nil
    }

    public var arrayValue: [LiveJSON]? {
        if case .array(let items, _) = self { return items }
        return nil
    }

    public var objectValue: LiveJSONObject? {
        if case .object(let object, _) = self { return object }
        return nil
    }

    /// The same value with every container marked closed — the fixture form.
    public var closed: LiveJSON {
        switch self {
        case .array(let items, _): .array(items.map(\.closed), open: false)
        case .object(let object, _):
            .object(LiveJSONObject(pairs: object.pairs.map { ($0.0, $0.1.closed) }), open: false)
        default: self
        }
    }

    /// JSON paths ("$", "$.ui", "$.ui[1]") of every open container.
    public func openPaths(_ path: String = "$") -> [String] {
        var out: [String] = []
        switch self {
        case .array(let items, let open):
            if open { out.append(path) }
            for (index, item) in items.enumerated() { out += item.openPaths("\(path)[\(index)]") }
        case .object(let object, let open):
            if open { out.append(path) }
            for (key, value) in object.pairs { out += value.openPaths("\(path).\(key)") }
        default:
            break
        }
        return out
    }
}

/// An object that keeps its keys in source order (later duplicates replace).
public struct LiveJSONObject: Equatable, Sendable {
    public private(set) var pairs: [(String, LiveJSON)]

    public init(pairs: [(String, LiveJSON)] = []) {
        self.pairs = []
        for (key, value) in pairs { self[key] = value }
    }

    public var keys: [String] { pairs.map(\.0) }

    public subscript(key: String) -> LiveJSON? {
        get { pairs.first { $0.0 == key }?.1 }
        set {
            if let index = pairs.firstIndex(where: { $0.0 == key }) {
                if let newValue { pairs[index].1 = newValue } else { pairs.remove(at: index) }
            } else if let newValue {
                pairs.append((key, newValue))
            }
        }
    }

    public static func == (lhs: LiveJSONObject, rhs: LiveJSONObject) -> Bool {
        lhs.pairs.count == rhs.pairs.count
            && zip(lhs.pairs, rhs.pairs).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    }
}

public struct LiveJSONResult: Sendable {
    public var value: LiveJSON?
    public var complete: Bool
    public var error: String?
}

public enum LiveJSONReader {
    public static let maxSource = 24_000
    static let maxDepth = 64

    private struct Failure: Error { let message: String }
    private enum Read { case value(LiveJSON), incomplete }

    public static func read(_ source: String) -> LiveJSONResult {
        let s = Array(source.utf16)
        if s.count > maxSource { return LiveJSONResult(value: nil, complete: false, error: "Block is too large.") }
        var i = 0
        let n = s.count

        func ws() {
            while i < n, s[i] == 32 || s[i] == 9 || s[i] == 10 || s[i] == 13 { i += 1 }
        }

        func readString() throws -> String? {
            i += 1
            var out: [UInt16] = []
            while i < n {
                let c = s[i]
                if c == 34 {  // "
                    i += 1
                    return String(decoding: out, as: UTF16.self)
                }
                if c == 92 {  // backslash
                    if i + 1 >= n { i = n; return nil }
                    let e = s[i + 1]
                    i += 2
                    switch e {
                    case 34: out.append(34)
                    case 92: out.append(92)
                    case 47: out.append(47)
                    case 98: out.append(8)
                    case 102: out.append(12)
                    case 110: out.append(10)
                    case 114: out.append(13)
                    case 116: out.append(9)
                    case 117:  // u
                        if i + 4 > n { i = n; return nil }
                        let hex = String(decoding: s[i..<(i + 4)], as: UTF16.self)
                        guard hex.count == 4, hex.allSatisfy(\.isHexDigit), let code = UInt16(hex, radix: 16) else {
                            throw Failure(message: "Bad unicode escape at \(i)")
                        }
                        out.append(code)
                        i += 4
                    default:
                        throw Failure(message: "Bad escape at \(i)")
                    }
                    continue
                }
                out.append(c)
                i += 1
            }
            return nil
        }

        func isNumberChar(_ c: UInt16) -> Bool {
            (c >= 48 && c <= 57) || c == 46 || c == 101 || c == 69 || c == 43 || c == 45
        }

        func readNumber() throws -> Double? {
            let start = i
            if s[i] == 45 { i += 1 }
            while i < n, isNumberChar(s[i]) { i += 1 }
            if i >= n { return nil }
            let text = String(decoding: s[start..<i], as: UTF16.self)
            guard isStrictJSONNumber(text), let value = Double(text), value.isFinite else {
                throw Failure(message: "Bad number at \(i)")
            }
            return value
        }

        func readLiteral() throws -> Read {
            let words: [(String, LiveJSON)] = [("true", .bool(true)), ("false", .bool(false)), ("null", .null)]
            for (word, value) in words {
                let w = Array(word.utf16)
                if i + w.count <= n, Array(s[i..<(i + w.count)]) == w {
                    i += w.count
                    return .value(value)
                }
                let rest = Array(s[i..<n])
                if rest.count < w.count, Array(w.prefix(rest.count)) == rest {
                    i = n
                    return .incomplete
                }
            }
            throw Failure(message: "Unexpected character at \(i)")
        }

        func readValue(_ depth: Int) throws -> Read {
            if depth > maxDepth { throw Failure(message: "Too deeply nested at \(i)") }
            ws()
            if i >= n { return .incomplete }
            let c = s[i]
            if c == 123 { return .value(try readObject(depth)) }
            if c == 91 { return .value(try readArray(depth)) }
            if c == 34 {
                guard let string = try readString() else { return .incomplete }
                return .value(.string(string))
            }
            if c == 45 || (c >= 48 && c <= 57) {
                guard let number = try readNumber() else { return .incomplete }
                return .value(.number(number))
            }
            return try readLiteral()
        }

        func readObject(_ depth: Int) throws -> LiveJSON {
            i += 1
            var out = LiveJSONObject()
            while true {
                ws()
                if i >= n { return .object(out, open: true) }
                if s[i] == 125 { i += 1; return .object(out, open: false) }
                if s[i] != 34 { throw Failure(message: "Expected key at \(i)") }
                guard let key = try readString() else { return .object(out, open: true) }
                ws()
                if i >= n { return .object(out, open: true) }
                if s[i] != 58 { throw Failure(message: "Expected colon at \(i)") }
                i += 1
                guard case .value(let value) = try readValue(depth + 1) else { return .object(out, open: true) }
                if key != "__proto__" { out[key] = value }
                ws()
                if i >= n { return .object(out, open: true) }
                if s[i] == 44 { i += 1; continue }
                if s[i] == 125 { i += 1; return .object(out, open: false) }
                throw Failure(message: "Expected comma or } at \(i)")
            }
        }

        func readArray(_ depth: Int) throws -> LiveJSON {
            i += 1
            var out: [LiveJSON] = []
            while true {
                ws()
                if i >= n { return .array(out, open: true) }
                if s[i] == 93 { i += 1; return .array(out, open: false) }
                guard case .value(let value) = try readValue(depth + 1) else { return .array(out, open: true) }
                out.append(value)
                ws()
                if i >= n { return .array(out, open: true) }
                if s[i] == 44 { i += 1; continue }
                if s[i] == 93 { i += 1; return .array(out, open: false) }
                throw Failure(message: "Expected comma or ] at \(i)")
            }
        }

        do {
            guard case .value(let value) = try readValue(0) else {
                return LiveJSONResult(value: nil, complete: false, error: nil)
            }
            ws()
            if i < n { throw Failure(message: "Unexpected trailing content at \(i)") }
            return LiveJSONResult(value: value, complete: !value.isOpen, error: nil)
        } catch let failure as Failure {
            return LiveJSONResult(value: nil, complete: false, error: failure.message)
        } catch {
            return LiveJSONResult(value: nil, complete: false, error: "Malformed block.")
        }
    }

    /// `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`, without a regex engine.
    static func isStrictJSONNumber(_ text: String) -> Bool {
        var chars = Array(text.utf8)[...]
        func digits() -> Int {
            var count = 0
            while let c = chars.first, c >= 48, c <= 57 { chars = chars.dropFirst(); count += 1 }
            return count
        }
        if chars.first == 45 { chars = chars.dropFirst() }
        guard let first = chars.first else { return false }
        if first == 48 {
            chars = chars.dropFirst()
        } else if first >= 49, first <= 57 {
            _ = digits()
        } else {
            return false
        }
        if chars.first == 46 {
            chars = chars.dropFirst()
            if digits() == 0 { return false }
        }
        if chars.first == 101 || chars.first == 69 {
            chars = chars.dropFirst()
            if chars.first == 43 || chars.first == 45 { chars = chars.dropFirst() }
            if digits() == 0 { return false }
        }
        return chars.isEmpty
    }
}
