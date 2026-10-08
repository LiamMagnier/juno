import Foundation

/// The Live UI expression language (docs/design/LIVE_UI.md §3) — the Swift
/// twin of `src/lib/live-ui/expr.ts`, held to the same fixtures in
/// `contracts/live-ui/fixtures/expr.json`.
///
/// A hand-written parser into a tiny AST and a tree-walking evaluator that
/// never throws to its caller, runs on a step budget, and has no door to the
/// host: no selectors, no key paths, no I/O.
public indirect enum LiveValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case list([LiveValue])
    case object([String: LiveValue])

    public var number: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    public var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var list: [LiveValue]? {
        if case .list(let l) = self { return l }
        return nil
    }

    public init(json: LiveJSON, depth: Int = 0) {
        switch json {
        case .null: self = .null
        case .bool(let b): self = .bool(b)
        case .number(let n): self = .number(n)
        case .string(let s): self = .string(s)
        case .array(let items, _):
            self = depth >= 4 ? .null : .list(items.prefix(200).map { LiveValue(json: $0, depth: depth + 1) })
        case .object(let object, _):
            if depth >= 4 { self = .null; return }
            var out: [String: LiveValue] = [:]
            for (k, v) in object.pairs { out[k] = LiveValue(json: v, depth: depth + 1) }
            self = .object(out)
        }
    }
}

public enum LiveExprLimits {
    public static let length = 400
    public static let nodes = 160
    public static let depth = 32
    public static let steps = 50_000
    public static let range = 500
    public static let string = 2_000
    static let scopeBudget = 2_000_000
}

struct LiveExprError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

indirect enum LiveNode: Sendable {
    case num(Double)
    case str(String)
    case lit(LiveValue)
    case list([LiveNode])
    case id(String)
    case unary(String, LiveNode)
    case binary(String, LiveNode, LiveNode)
    case ternary(LiveNode, LiveNode, LiveNode)
    case member(LiveNode, String)
    case index(LiveNode, LiveNode)
    case call(String, [LiveNode])
}

private enum Tok: Equatable {
    case num(Double)
    case str(String)
    case id(String)
    case op(String)
}

let liveFunctions: Set<String> = [
    "if", "sum", "avg", "min", "max", "count", "len", "round", "floor", "ceil", "abs", "sqrt", "exp", "ln",
    "log10", "pow", "clamp", "range", "pmt", "fv", "normpdf", "normcdf", "days", "addDays", "fmt",
]

enum LiveParser {
    private static let ops = ["&&", "||", "==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", "[", "]", ",", "."]
    private static let binaryPrecedence: [String: Int] = [
        "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
    ]

    private static func isDigit(_ c: UInt16) -> Bool { c >= 48 && c <= 57 }
    private static func isIdentStart(_ c: UInt16) -> Bool { (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 }
    private static func isIdent(_ c: UInt16) -> Bool { isIdentStart(c) || isDigit(c) }

    private static func tokenize(_ src: String) throws -> [Tok] {
        let s = Array(src.utf16)
        var out: [Tok] = []
        var i = 0
        while i < s.count {
            let c = s[i]
            if c == 32 || c == 9 || c == 10 || c == 13 { i += 1; continue }
            if isDigit(c) || (c == 46 && i + 1 < s.count && isDigit(s[i + 1])) {
                // (\d+\.?\d*|\.\d+)([eE][+-]?\d+)?
                let start = i
                if c == 46 {
                    i += 1
                    while i < s.count, isDigit(s[i]) { i += 1 }
                } else {
                    while i < s.count, isDigit(s[i]) { i += 1 }
                    if i < s.count, s[i] == 46 {
                        i += 1
                        while i < s.count, isDigit(s[i]) { i += 1 }
                    }
                }
                if i < s.count, s[i] == 101 || s[i] == 69 {
                    var j = i + 1
                    if j < s.count, s[j] == 43 || s[j] == 45 { j += 1 }
                    if j < s.count, isDigit(s[j]) {
                        while j < s.count, isDigit(s[j]) { j += 1 }
                        i = j
                    }
                }
                guard let value = Double(String(decoding: s[start..<i], as: UTF16.self)) else { throw LiveExprError("Bad number") }
                out.append(.num(value))
                continue
            }
            if c == 39 || c == 34 {
                var j = i + 1
                var str: [UInt16] = []
                while j < s.count, s[j] != c {
                    if s[j] == 92, j + 1 < s.count {
                        str.append(s[j + 1])
                        j += 2
                    } else {
                        str.append(s[j])
                        j += 1
                    }
                }
                if j >= s.count { throw LiveExprError("Unterminated string") }
                out.append(.str(String(decoding: str, as: UTF16.self)))
                i = j + 1
                continue
            }
            if isIdentStart(c) {
                let start = i
                while i < s.count, isIdent(s[i]) { i += 1 }
                out.append(.id(String(decoding: s[start..<i], as: UTF16.self)))
                continue
            }
            guard let op = ops.first(where: { o in
                let u = Array(o.utf16)
                return i + u.count <= s.count && Array(s[i..<(i + u.count)]) == u
            }) else {
                throw LiveExprError("Unexpected character")
            }
            out.append(.op(op))
            i += op.utf16.count
        }
        return out
    }

    static func parse(_ src: String) throws -> LiveNode {
        if src.utf16.count > LiveExprLimits.length { throw LiveExprError("Expression is too long") }
        let toks = try tokenize(src)
        var p = 0
        var nodes = 0

        func isOp(_ v: String) -> Bool {
            if p < toks.count, case .op(let o) = toks[p] { return o == v }
            return false
        }
        func expect(_ v: String) throws {
            guard isOp(v) else { throw LiveExprError("Expected \"\(v)\"") }
            p += 1
        }
        func mk(_ node: LiveNode, _ depth: Int) throws -> LiveNode {
            nodes += 1
            if nodes > LiveExprLimits.nodes { throw LiveExprError("Expression is too complex") }
            if depth > LiveExprLimits.depth { throw LiveExprError("Expression is too deep") }
            return node
        }

        func ternary(_ d: Int) throws -> LiveNode {
            let c = try binary(1, d + 1)
            if isOp("?") {
                p += 1
                let a = try ternary(d + 1)
                try expect(":")
                let b = try ternary(d + 1)
                return try mk(.ternary(c, a, b), d)
            }
            return c
        }

        func binary(_ minPrec: Int, _ d: Int) throws -> LiveNode {
            var left = try unary(d + 1)
            while p < toks.count, case .op(let o) = toks[p], let prec = binaryPrecedence[o], prec >= minPrec {
                p += 1
                let right = try binary(prec + 1, d + 1)
                left = try mk(.binary(o, left, right), d)
            }
            return left
        }

        func unary(_ d: Int) throws -> LiveNode {
            if isOp("-") || isOp("!") || isOp("+") {
                guard case .op(let o) = toks[p] else { throw LiveExprError("Unexpected") }
                p += 1
                return try mk(.unary(o, try unary(d + 1)), d)
            }
            return try power(d)
        }

        func power(_ d: Int) throws -> LiveNode {
            let base = try postfix(d + 1)
            if isOp("^") {
                p += 1
                return try mk(.binary("^", base, try unary(d + 1)), d)
            }
            return base
        }

        func postfix(_ d: Int) throws -> LiveNode {
            var node = try primary(d + 1)
            while true {
                if isOp(".") {
                    p += 1
                    guard p < toks.count, case .id(let name) = toks[p] else { throw LiveExprError("Expected a field name") }
                    p += 1
                    node = try mk(.member(node, name), d)
                } else if isOp("[") {
                    p += 1
                    let i = try ternary(d + 1)
                    try expect("]")
                    node = try mk(.index(node, i), d)
                } else {
                    break
                }
            }
            return node
        }

        func primary(_ d: Int) throws -> LiveNode {
            guard p < toks.count else { throw LiveExprError("Unexpected end of expression") }
            let t = toks[p]
            p += 1
            switch t {
            case .num(let v): return try mk(.num(v), d)
            case .str(let v): return try mk(.str(v), d)
            case .id(let name):
                if name == "true" || name == "false" { return try mk(.lit(.bool(name == "true")), d) }
                if name == "null" { return try mk(.lit(.null), d) }
                if isOp("(") {
                    p += 1
                    var args: [LiveNode] = []
                    if !isOp(")") {
                        while true {
                            args.append(try ternary(d + 1))
                            if isOp(",") { p += 1; continue }
                            break
                        }
                    }
                    try expect(")")
                    guard liveFunctions.contains(name) else { throw LiveExprError("Unknown function \(name)") }
                    return try mk(.call(name, args), d)
                }
                return try mk(.id(name), d)
            case .op("("):
                let inner = try ternary(d + 1)
                try expect(")")
                return inner
            case .op("["):
                var items: [LiveNode] = []
                if !isOp("]") {
                    while true {
                        items.append(try ternary(d + 1))
                        if isOp(",") {
                            p += 1
                            if isOp("]") { break }
                            continue
                        }
                        break
                    }
                }
                try expect("]")
                return try mk(.list(items), d)
            case .op(let o):
                throw LiveExprError("Unexpected \"\(o)\"")
            }
        }

        let root = try ternary(0)
        if p < toks.count { throw LiveExprError("Unexpected trailing input") }
        return root
    }
}

// MARK: Scope

/// One evaluation context: inputs, lazily-memoised lets, constant data. Not
/// thread-safe; a view builds one per render on the main actor.
public final class LiveScope {
    public let formatter: LiveFormatting
    public let currency: String
    let inputs: [String: LiveValue]
    let lets: [String: String]
    let letOrder: [String]
    let data: [String: LiveValue]
    private var memo: [String: LiveValue] = [:]
    private var letErrors: [String: String] = [:]
    private var visiting: [String] = []
    private var spent = 0
    private var parseCache: [String: Result<LiveNode, LiveExprError>] = [:]

    public init(
        inputs: [String: LiveValue],
        lets: [(String, String)],
        data: [String: LiveValue],
        formatter: LiveFormatting = LiveCanonicalFormatter(),
        currency: String = "USD"
    ) {
        self.inputs = inputs
        var dict: [String: String] = [:]
        var order: [String] = []
        for (k, v) in lets where dict[k] == nil {
            dict[k] = v
            order.append(k)
        }
        self.lets = dict
        self.letOrder = order
        self.data = data
        self.formatter = formatter
        self.currency = currency
    }

    func parsed(_ src: String) throws -> LiveNode {
        if let cached = parseCache[src] { return try cached.get() }
        let result: Result<LiveNode, LiveExprError>
        do {
            result = .success(try LiveParser.parse(src))
        } catch let e as LiveExprError {
            result = .failure(e)
        } catch {
            result = .failure(LiveExprError("Invalid expression"))
        }
        if parseCache.count > 500 { parseCache.removeAll() }
        parseCache[src] = result
        return try result.get()
    }

    /// Evaluate `src` with optional row or chart locals. Never throws.
    public func evaluate(_ src: String, locals: [String: LiveValue]? = nil) -> (value: LiveValue, error: String?) {
        let run = LiveRun(scope: self, locals: locals, parent: nil)
        defer { spent += run.steps }
        do {
            return (liveClean(try run.eval(try parsed(src))), nil)
        } catch let e as LiveExprError {
            return (.null, e.message)
        } catch {
            return (.null, "Error")
        }
    }

    /// Every let's value (errors as null) and the errors — the fixture form.
    public func allLets() -> (values: [String: LiveValue], errors: [String: String]) {
        var values: [String: LiveValue] = [:]
        for name in letOrder {
            do {
                values[name] = liveClean(try resolveLet(name, run: LiveRun(scope: self, locals: nil, parent: nil)))
            } catch let e as LiveExprError {
                values[name] = .null
                if letErrors[name] == nil { letErrors[name] = e.message }
            } catch {
                values[name] = .null
            }
        }
        return (values, letErrors)
    }

    var budgetLeft: Int { LiveExprLimits.scopeBudget - spent }

    func lookup(_ name: String, run: LiveRun) throws -> LiveValue {
        if let v = inputs[name] { return v }
        if lets[name] != nil { return try resolveLet(name, run: run) }
        if let v = data[name] { return v }
        if name == "pi" { return .number(Double.pi) }
        if name == "e" { return .number(M_E) }
        throw LiveExprError("Unknown name \(name)")
    }

    private func resolveLet(_ name: String, run: LiveRun) throws -> LiveValue {
        if let v = memo[name] { return v }
        if let failed = letErrors[name] { throw LiveExprError(failed) }
        if visiting.contains(name) {
            for member in visiting { letErrors[member] = "Circular formula" }
            throw LiveExprError("Circular formula")
        }
        visiting.append(name)
        defer { visiting.removeAll { $0 == name } }
        do {
            let inner = LiveRun(scope: self, locals: nil, parent: run)
            defer { run.steps += inner.steps }
            let value = liveClean(try inner.eval(try parsed(lets[name] ?? "")))
            memo[name] = value
            return value
        } catch let e as LiveExprError {
            if letErrors[name] == nil { letErrors[name] = e.message }
            throw LiveExprError(letErrors[name] ?? e.message)
        }
    }
}

func liveClean(_ value: LiveValue) -> LiveValue {
    switch value {
    case .number(let n): return n.isFinite ? .number(n == 0 ? 0 : n) : .null
    case .string(let s):
        let u = s.utf16
        return u.count > LiveExprLimits.string ? .string(String(decoding: u.prefix(LiveExprLimits.string), as: UTF16.self)) : value
    default: return value
    }
}

public func liveTruthy(_ v: LiveValue) -> Bool {
    switch v {
    case .null: false
    case .bool(let b): b
    case .number(let n): n != 0
    case .string(let s): !s.isEmpty
    case .list(let l): !l.isEmpty
    case .object: true
    }
}

public func liveValueString(_ v: LiveValue) -> String {
    switch v {
    case .null: ""
    case .number(let n): liveCanonicalNumberString(n)
    case .bool(let b): b ? "true" : "false"
    case .string(let s): s
    case .list(let l): l.map(liveValueString).joined(separator: ", ")
    case .object: ""
    }
}

private func liveEqual(_ a: LiveValue, _ b: LiveValue) -> Bool {
    switch (a, b) {
    case (.null, .null): true
    case (.number(let x), .number(let y)): x == y
    case (.bool(let x), .bool(let y)): x == y
    case (.string(let x), .string(let y)): x.utf16.elementsEqual(y.utf16)
    default: false
    }
}

private func liveErf(_ x: Double) -> Double {
    let sign: Double = x < 0 ? -1 : 1
    let ax = abs(x)
    let t = 1 / (1 + 0.3275911 * ax)
    let y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-ax * ax)
    return sign * y
}

/// from, from+step, … up to `to` inclusive (1e-9 slack), at most 500 values.
public func liveRange(_ from: Double, _ to: Double, _ step: Double) -> [Double]? {
    guard step != 0, step.isFinite else { return nil }
    if (to - from) / step < -1e-9 { return [] }
    let count = Int(((to - from) / step + 1e-9).rounded(.down)) + 1
    if count > LiveExprLimits.range { return nil }
    return (0..<count).map { from + Double($0) * step }
}

final class LiveRun {
    var steps = 0
    let scope: LiveScope
    let locals: [String: LiveValue]?
    let parent: LiveRun?
    let cap: Int

    init(scope: LiveScope, locals: [String: LiveValue]?, parent: LiveRun?) {
        self.scope = scope
        self.locals = locals
        self.parent = parent
        self.cap = min(LiveExprLimits.steps, scope.budgetLeft)
    }

    func tick(_ n: Int = 1) throws {
        steps += n
        var total = steps
        var r = parent
        while let run = r {
            total += run.steps
            r = run.parent
        }
        if total > cap { throw LiveExprError("Too much work") }
    }

    func eval(_ node: LiveNode) throws -> LiveValue {
        try tick()
        switch node {
        case .num(let v): return .number(v)
        case .str(let v): return .string(v)
        case .lit(let v): return v
        case .list(let items):
            if items.count > LiveExprLimits.range { throw LiveExprError("List is too long") }
            return .list(try items.map { try eval($0) })
        case .id(let name):
            if let locals, let v = locals[name] { return v }
            return try scope.lookup(name, run: self)
        case .unary(let op, let a):
            let v = try eval(a)
            if op == "!" { return .bool(!liveTruthy(v)) }
            return try arith(op == "-" ? "neg" : "pos", v, .null)
        case .ternary(let c, let a, let b):
            return liveTruthy(try eval(c)) ? try eval(a) : try eval(b)
        case .binary(let op, let a, let b):
            return try binary(op, a, b)
        case .member(let o, let name):
            return try member(try eval(o), name)
        case .index(let o, let i):
            let ov = try eval(o)
            let iv = try eval(i)
            if case .list(let l) = ov, case .number(let n) = iv {
                let k = Int(n.rounded(.towardZero))
                return k >= 0 && k < l.count ? l[k] : .null
            }
            if case .object = ov, case .string(let key) = iv { return try member(ov, key) }
            return .null
        case .call(let fn, let args):
            return try call(fn, args)
        }
    }

    private func member(_ o: LiveValue, _ name: String) throws -> LiveValue {
        switch o {
        case .object(let dict): return dict[name] ?? .null
        case .list(let l):
            if name == "length" { return .number(Double(l.count)) }
            try tick(l.count)
            return .list(l.map { row in
                if case .object(let d) = row { return d[name] ?? .null }
                return .null
            })
        default: return .null
        }
    }

    private func binary(_ op: String, _ an: LiveNode, _ bn: LiveNode) throws -> LiveValue {
        if op == "&&" {
            guard liveTruthy(try eval(an)) else { return .bool(false) }
            return .bool(liveTruthy(try eval(bn)))
        }
        if op == "||" {
            if liveTruthy(try eval(an)) { return .bool(true) }
            return .bool(liveTruthy(try eval(bn)))
        }
        let a = try eval(an)
        let b = try eval(bn)
        switch op {
        case "==": return .bool(liveEqual(a, b))
        case "!=": return .bool(!liveEqual(a, b))
        case "<", "<=", ">", ">=":
            if case .number(let x) = a, case .number(let y) = b { return .bool(compare(op, x, y)) }
            if case .string(let x) = a, case .string(let y) = b {
                let c: Double = x.utf16.lexicographicallyPrecedes(y.utf16) ? -1 : (y.utf16.lexicographicallyPrecedes(x.utf16) ? 1 : 0)
                return .bool(compare(op, c, 0))
            }
            return .null
        case "+":
            let aIsString = a.string != nil, bIsString = b.string != nil
            if aIsString || bIsString {
                if a.list != nil || b.list != nil { return .null }
                let joined = liveValueString(a) + liveValueString(b)
                return .string(String(decoding: joined.utf16.prefix(LiveExprLimits.string), as: UTF16.self))
            }
            return try arith(op, a, b)
        default:
            return try arith(op, a, b)
        }
    }

    private func compare(_ op: String, _ a: Double, _ b: Double) -> Bool {
        switch op {
        case "<": a < b
        case "<=": a <= b
        case ">": a > b
        default: a >= b
        }
    }

    func arith(_ op: String, _ a: LiveValue, _ b: LiveValue) throws -> LiveValue {
        if case .list(let la) = a {
            if op == "neg" || op == "pos" {
                try tick(la.count)
                return .list(try la.map { try arith(op, $0, .null) })
            }
            if case .list(let lb) = b {
                if la.count != lb.count { throw LiveExprError("Lists differ in length") }
                try tick(la.count)
                return .list(try zip(la, lb).map { try arith(op, $0, $1) })
            }
            try tick(la.count)
            return .list(try la.map { try arith(op, $0, b) })
        }
        if case .list(let lb) = b {
            try tick(lb.count)
            return .list(try lb.map { try arith(op, a, $0) })
        }
        if op == "neg" { if case .number(let x) = a { return .number(-x) }; return .null }
        if op == "pos" { if case .number = a { return a }; return .null }
        guard case .number(let x) = a, case .number(let y) = b else { return .null }
        let r: Double
        switch op {
        case "+": r = x + y
        case "-": r = x - y
        case "*": r = x * y
        case "/":
            if y == 0 { return .null }
            r = x / y
        case "%":
            if y == 0 { return .null }
            r = x.truncatingRemainder(dividingBy: y)
        case "^": r = pow(x, y)
        default: throw LiveExprError("Unknown operator \(op)")
        }
        return r.isFinite ? .number(r) : .null
    }

    private func numbers(_ args: [LiveValue]) throws -> [Double]? {
        let flat: [LiveValue]
        if args.count == 1, case .list(let l) = args[0] { flat = l } else { flat = args }
        try tick(flat.count)
        var out: [Double] = []
        for v in flat {
            if case .null = v { continue }
            guard case .number(let n) = v else { return nil }
            out.append(n)
        }
        return out
    }

    private func call(_ fn: String, _ argNodes: [LiveNode]) throws -> LiveValue {
        if fn == "if" {
            if argNodes.count < 2 { throw LiveExprError("if needs a condition and a value") }
            if liveTruthy(try eval(argNodes[0])) { return try eval(argNodes[1]) }
            return argNodes.count > 2 ? try eval(argNodes[2]) : .null
        }
        let args = try argNodes.map { try eval($0) }
        func num(_ i: Int) -> Double? { i < args.count ? args[i].number : nil }
        func need(_ count: Int) throws {
            if args.count < count { throw LiveExprError("\(fn) needs \(count) argument\(count == 1 ? "" : "s")") }
        }
        func unaryMath(_ f: (Double) -> Double, _ ok: (Double) -> Bool = { _ in true }) throws -> LiveValue {
            try need(1)
            if case .list(let l) = args[0] {
                try tick(l.count)
                return .list(l.map { v in
                    if case .number(let x) = v, ok(x) { return .number(f(x)) }
                    return .null
                })
            }
            if case .number(let x) = args[0], ok(x) { return .number(f(x)) }
            return .null
        }
        switch fn {
        case "sum":
            guard let xs = try numbers(args) else { return .null }
            return .number(xs.reduce(0, +))
        case "avg":
            guard let xs = try numbers(args), !xs.isEmpty else { return .null }
            return .number(xs.reduce(0, +) / Double(xs.count))
        case "min", "max":
            guard let xs = try numbers(args), var m = xs.first else { return .null }
            for x in xs.dropFirst() { m = fn == "min" ? (x < m ? x : m) : (x > m ? x : m) }
            return .number(m)
        case "count":
            try need(1)
            if case .list(let l) = args[0] { return .number(Double(l.count)) }
            if case .null = args[0] { return .number(0) }
            return .number(1)
        case "len":
            try need(1)
            if case .list(let l) = args[0] { return .number(Double(l.count)) }
            if case .string(let s) = args[0] { return .number(Double(s.unicodeScalars.count)) }
            return .null
        case "round":
            try need(1)
            let d: Double? = args.count > 1 ? num(1) : 0
            guard let d else { return .null }
            return try unaryMath { liveRoundHalfAway($0, d) }
        case "floor": return try unaryMath { $0.rounded(.down) }
        case "ceil": return try unaryMath { $0.rounded(.up) }
        case "abs": return try unaryMath { Swift.abs($0) }
        case "sqrt": return try unaryMath(Foundation.sqrt, { $0 >= 0 })
        case "exp": return try unaryMath(Foundation.exp)
        case "ln": return try unaryMath(Foundation.log, { $0 > 0 })
        case "log10": return try unaryMath(Foundation.log10, { $0 > 0 })
        case "pow":
            try need(2)
            return try arith("^", args[0], args[1])
        case "clamp":
            try need(3)
            guard let x = num(0), let lo = num(1), let hi = num(2) else { return .null }
            return .number(Swift.min(Swift.max(x, lo), hi))
        case "range":
            try need(2)
            guard let from = num(0), let to = num(1) else { return .null }
            let step: Double? = args.count > 2 ? num(2) : 1
            guard let step, step != 0, step.isFinite else { return .null }
            if (to - from) / step < -1e-9 { return .list([]) }
            let count = Int(((to - from) / step + 1e-9).rounded(.down)) + 1
            if count > LiveExprLimits.range { throw LiveExprError("Range is too long") }
            try tick(count)
            return .list((0..<count).map { .number(from + Double($0) * step) })
        case "pmt":
            try need(3)
            guard let r = num(0), let nper = num(1), let pv = num(2), nper > 0 else { return .null }
            if r == 0 { return .number(pv / nper) }
            return .number((pv * r) / (1 - pow(1 + r, -nper)))
        case "fv":
            try need(3)
            guard let r = num(0), let nper = num(1), let payment = num(2) else { return .null }
            let pv: Double? = args.count > 3 ? num(3) : 0
            guard let pv else { return .null }
            if r == 0 { return .number(pv + payment * nper) }
            let g = pow(1 + r, nper)
            return .number(pv * g + (payment * (g - 1)) / r)
        case "normpdf":
            try need(3)
            guard let mean = num(1), let sd = num(2), sd > 0 else { return .null }
            let f = { (v: Double) in exp(-0.5 * pow((v - mean) / sd, 2)) / (sd * (2 * Double.pi).squareRoot()) }
            if case .list(let l) = args[0] {
                try tick(l.count)
                return .list(l.map { $0.number.map { .number(f($0)) } ?? .null })
            }
            if let x = num(0) { return .number(f(x)) }
            return .null
        case "normcdf":
            try need(3)
            guard let x = num(0), let mean = num(1), let sd = num(2), sd > 0 else { return .null }
            return .number(0.5 * (1 + liveErf((x - mean) / (sd * 2.0.squareRoot()))))
        case "days":
            try need(2)
            guard let a = args[0].string.flatMap(LiveDates.parse), let b = args[1].string.flatMap(LiveDates.parse) else { return .null }
            return .number(Double(LiveDates.daysFromCivil(b.year, b.month, b.day) - LiveDates.daysFromCivil(a.year, a.month, a.day)))
        case "addDays":
            try need(2)
            guard let a = args[0].string.flatMap(LiveDates.parse), let n = num(1) else { return .null }
            return .string(LiveDates.civilFromDays(LiveDates.daysFromCivil(a.year, a.month, a.day) + Int(n.rounded(.towardZero))))
        case "fmt":
            try need(1)
            let kind = args.count > 1 ? (args[1].string.flatMap(LiveFormat.init(rawValue:)) ?? .number) : .number
            let digits = args.count > 2 ? num(2).map { Int($0.rounded(.towardZero)) } : nil
            if kind == .date { return args[0].string.map { .string(scope.formatter.date($0)) } ?? .null }
            guard let x = num(0) else { return .null }
            return .string(scope.formatter.number(x, format: kind, currency: scope.currency, digits: digits))
        default:
            throw LiveExprError("Unknown function \(fn)")
        }
    }
}

/// `{{expr}}` interpolation, scanning exactly like the TypeScript regex
/// `/\{\{([^{}]{1,400})\}\}/g`: numbers through the scope's formatter, null as
/// the muted dash, an unclosed `{{` left as text.
public func liveInterpolate(_ text: String, scope: LiveScope, locals: [String: LiveValue]? = nil) -> String {
    let s = Array(text.utf16)
    guard s.count > 1 else { return text }
    var out: [UInt16] = []
    var i = 0
    while i < s.count {
        if i + 1 < s.count, s[i] == 123, s[i + 1] == 123 {
            var j = i + 2
            while j < s.count, j - (i + 2) <= 400, s[j] != 123, s[j] != 125 { j += 1 }
            let len = j - (i + 2)
            if len >= 1, len <= 400, j + 1 < s.count, s[j] == 125, s[j + 1] == 125 {
                let src = String(decoding: s[(i + 2)..<j], as: UTF16.self).trimmingCharacters(in: .whitespacesAndNewlines)
                let value = scope.evaluate(src, locals: locals).value
                let rendered: String
                switch value {
                case .null: rendered = liveNullText
                case .number(let n): rendered = scope.formatter.number(n, format: .number, currency: nil, digits: nil)
                default: rendered = liveValueString(value)
                }
                out.append(contentsOf: rendered.utf16)
                i = j + 2
                continue
            }
        }
        out.append(s[i])
        i += 1
    }
    return String(decoding: out, as: UTF16.self)
}
