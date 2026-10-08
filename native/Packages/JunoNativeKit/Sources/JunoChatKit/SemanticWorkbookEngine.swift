import Foundation

/// Computes a workbook's formulas for display.
///
/// A stored formula cell carries no value — the web's engine
/// (`workbook/engine.ts`, `formula.ts`) computes it — so a reader that only
/// showed stored values would show a blank wherever a total should be. This
/// is a read-only port of the common core of that language: arithmetic,
/// comparison, `&`, references and ranges across sheets, defined names, and
/// the aggregate, logical, rounding and text functions models actually write.
/// A function outside that core is not guessed at: the cell shows its formula
/// (``SemanticWorkbookEngine/Display/formula``), and an imported opaque
/// formula shows the file's cached value, as the web does.
public final class SemanticWorkbookEngine {
    public enum Value: Equatable, Sendable {
        case empty
        case number(Double)
        case text(String)
        case bool(Bool)
        case error(String)
    }

    /// What a cell shows.
    public struct Display: Equatable, Sendable {
        public let text: String
        public let isNumeric: Bool
        /// The cell's formula could not be computed here; `text` is `=formula`.
        public let isUncomputed: Bool
        public let isError: Bool
    }

    private let workbook: SemanticWorkbook
    private var cache: [Key: Value?] = [:]
    private var visiting: Set<Key> = []

    private struct Key: Hashable {
        let sheet: Int
        let address: SemanticCellAddress
    }

    public init(workbook: SemanticWorkbook) {
        self.workbook = workbook
    }

    /// The text for one cell, formatted with its number format.
    public func display(sheet sheetIndex: Int, address: SemanticCellAddress) -> Display {
        guard workbook.sheets.indices.contains(sheetIndex),
            let cell = workbook.sheets[sheetIndex].cells[address]
        else { return Display(text: "", isNumeric: false, isUncomputed: false, isError: false) }
        guard let value = value(sheet: sheetIndex, address: address) else {
            return Display(text: "=" + (cell.formula ?? ""), isNumeric: false, isUncomputed: true, isError: false)
        }
        switch value {
        case .empty: return Display(text: "", isNumeric: false, isUncomputed: false, isError: false)
        case .text(let text): return Display(text: text, isNumeric: false, isUncomputed: false, isError: false)
        case .bool(let flag): return Display(text: flag ? "TRUE" : "FALSE", isNumeric: false, isUncomputed: false, isError: false)
        case .error(let code): return Display(text: code, isNumeric: false, isUncomputed: false, isError: true)
        case .number(let number):
            return Display(
                text: SemanticNumberFormat.format(number, code: cell.format),
                isNumeric: true, isUncomputed: false, isError: false
            )
        }
    }

    /// The computed value, nil when the formula uses something this port
    /// does not compute.
    public func value(sheet sheetIndex: Int, address: SemanticCellAddress) -> Value? {
        let key = Key(sheet: sheetIndex, address: address)
        if let cached = cache[key] { return cached }
        guard workbook.sheets.indices.contains(sheetIndex),
            let cell = workbook.sheets[sheetIndex].cells[address]
        else { return .empty }
        let result: Value?
        if let formula = cell.formula, !cell.opaque {
            if visiting.contains(key) { return .error("#CYCLE!") }
            visiting.insert(key)
            defer { visiting.remove(key) }
            do {
                var parser = FormulaParser(text: formula)
                let node = try parser.parse()
                result = try evaluate(node, sheet: sheetIndex).scalar
            } catch FormulaFailure.unsupported {
                result = nil
            } catch FormulaFailure.value(let error) {
                result = error
            } catch {
                result = nil
            }
        } else {
            switch cell.value {
            case .text(let text)?: result = .text(text)
            case .number(let number)?: result = .number(number)
            case .bool(let flag)?: result = .bool(flag)
            case nil: result = cell.formula == nil ? .empty : nil
            }
        }
        cache[key] = result
        return result
    }

    // MARK: Evaluation

    private indirect enum Node {
        case number(Double)
        case text(String)
        case bool(Bool)
        case reference(sheet: String?, from: SemanticCellAddress, to: SemanticCellAddress?)
        case name(String)
        case unary(String, Node)
        case percent(Node)
        case binary(String, Node, Node)
        case call(String, [Node])
    }

    private enum FormulaFailure: Error {
        case unsupported
        case value(Value)
    }

    /// A value or a block of values (a range).
    private enum Argument {
        case scalar(Value)
        case range([Value])

        var scalar: Value {
            switch self {
            case .scalar(let value): value
            case .range(let values): values.count == 1 ? values[0] : .error("#VALUE!")
            }
        }

        var values: [Value] {
            switch self {
            case .scalar(let value): [value]
            case .range(let values): values
            }
        }

        var isRange: Bool {
            if case .range = self { return true }
            return false
        }
    }

    private func evaluate(_ node: Node, sheet: Int) throws -> Argument {
        switch node {
        case .number(let number): return .scalar(.number(number))
        case .text(let text): return .scalar(.text(text))
        case .bool(let flag): return .scalar(.bool(flag))
        case .reference(let sheetName, let from, let to):
            let target: Int
            if let sheetName {
                guard let index = workbook.sheets.firstIndex(where: { $0.name.lowercased() == sheetName.lowercased() }) else {
                    throw FormulaFailure.value(.error("#REF!"))
                }
                target = index
            } else {
                target = sheet
            }
            guard let to else { return .scalar(try cellValue(sheet: target, address: from)) }
            let rows = min(from.row, to.row)...max(from.row, to.row)
            let columns = min(from.column, to.column)...max(from.column, to.column)
            guard rows.count * columns.count <= 250_000 else { throw FormulaFailure.unsupported }
            var values: [Value] = []
            for row in rows {
                for column in columns {
                    values.append(try cellValue(sheet: target, address: SemanticCellAddress(row: row, column: column)))
                }
            }
            return .range(values)
        case .name(let name):
            guard let range = workbook.names[name.uppercased()] else { throw FormulaFailure.value(.error("#NAME?")) }
            var parser = FormulaParser(text: range)
            return try evaluate(try parser.parse(), sheet: sheet)
        case .unary(let op, let inner):
            let value = try number(try evaluate(inner, sheet: sheet).scalar)
            return .scalar(.number(op == "-" ? -value : value))
        case .percent(let inner):
            return .scalar(.number(try number(try evaluate(inner, sheet: sheet).scalar) / 100))
        case .binary(let op, let lhs, let rhs):
            let left = try evaluate(lhs, sheet: sheet).scalar
            let right = try evaluate(rhs, sheet: sheet).scalar
            return .scalar(try binary(op, left, right))
        case .call(let name, let arguments):
            return .scalar(try call(name, arguments, sheet: sheet))
        }
    }

    private func cellValue(sheet: Int, address: SemanticCellAddress) throws -> Value {
        guard let value = value(sheet: sheet, address: address) else { throw FormulaFailure.unsupported }
        if case .error = value { throw FormulaFailure.value(value) }
        return value
    }

    private func number(_ value: Value) throws -> Double {
        switch value {
        case .number(let number): return number
        case .bool(let flag): return flag ? 1 : 0
        case .empty: return 0
        case .text(let text):
            if let number = Double(text.trimmingCharacters(in: .whitespaces)) { return number }
            throw FormulaFailure.value(.error("#VALUE!"))
        case .error: throw FormulaFailure.value(value)
        }
    }

    private func text(_ value: Value) throws -> String {
        switch value {
        case .number(let number): return SemanticNumberFormat.general(number)
        case .text(let text): return text
        case .bool(let flag): return flag ? "TRUE" : "FALSE"
        case .empty: return ""
        case .error: throw FormulaFailure.value(value)
        }
    }

    private func truth(_ value: Value) throws -> Bool {
        switch value {
        case .bool(let flag): return flag
        case .number(let number): return number != 0
        case .empty: return false
        case .text(let text):
            if text.uppercased() == "TRUE" { return true }
            if text.uppercased() == "FALSE" { return false }
            throw FormulaFailure.value(.error("#VALUE!"))
        case .error: throw FormulaFailure.value(value)
        }
    }

    private func binary(_ op: String, _ left: Value, _ right: Value) throws -> Value {
        switch op {
        case "+": return .number(try number(left) + number(right))
        case "-": return .number(try number(left) - number(right))
        case "*": return .number(try number(left) * number(right))
        case "/":
            let divisor = try number(right)
            guard divisor != 0 else { throw FormulaFailure.value(.error("#DIV/0!")) }
            return .number(try number(left) / divisor)
        case "^": return .number(pow(try number(left), try number(right)))
        case "&": return .text(try text(left) + text(right))
        default:
            let order = try compare(left, right)
            switch op {
            case "=": return .bool(order == 0)
            case "<>": return .bool(order != 0)
            case "<": return .bool(order < 0)
            case ">": return .bool(order > 0)
            case "<=": return .bool(order <= 0)
            case ">=": return .bool(order >= 0)
            default: throw FormulaFailure.unsupported
            }
        }
    }

    private func compare(_ left: Value, _ right: Value) throws -> Int {
        if case .error = left { throw FormulaFailure.value(left) }
        if case .error = right { throw FormulaFailure.value(right) }
        switch (left, right) {
        case (.text(let a), .text(let b)):
            let x = a.lowercased(), y = b.lowercased()
            return x == y ? 0 : (x < y ? -1 : 1)
        case (.text, _): return 1
        case (_, .text): return -1
        default:
            let a = try number(left), b = try number(right)
            return a == b ? 0 : (a < b ? -1 : 1)
        }
    }

    /// The numbers an aggregate reads: every number in a range (text and
    /// blanks skipped, as Excel does), and each scalar argument coerced.
    private func numbers(_ arguments: [Argument]) throws -> [Double] {
        var out: [Double] = []
        for argument in arguments {
            if argument.isRange {
                for value in argument.values {
                    switch value {
                    case .number(let number): out.append(number)
                    case .error: throw FormulaFailure.value(value)
                    default: continue
                    }
                }
            } else {
                out.append(try number(argument.scalar))
            }
        }
        return out
    }

    private func round(_ value: Double, _ digits: Int, _ rule: FloatingPointRoundingRule) -> Double {
        let scale = pow(10, Double(digits))
        return (value * scale).rounded(rule) / scale
    }

    private func call(_ rawName: String, _ nodes: [Node], sheet: Int) throws -> Value {
        let name = rawName.uppercased()
        // IF and IFERROR evaluate lazily, like Excel.
        if name == "IF" {
            guard (2...3).contains(nodes.count) else { throw FormulaFailure.value(.error("#N/A")) }
            let condition = try truth(try evaluate(nodes[0], sheet: sheet).scalar)
            if condition { return try evaluate(nodes[1], sheet: sheet).scalar }
            return nodes.count == 3 ? try evaluate(nodes[2], sheet: sheet).scalar : .bool(false)
        }
        if name == "IFERROR" {
            guard nodes.count == 2 else { throw FormulaFailure.value(.error("#N/A")) }
            do {
                let value = try evaluate(nodes[0], sheet: sheet).scalar
                if case .error = value { return try evaluate(nodes[1], sheet: sheet).scalar }
                return value
            } catch FormulaFailure.value {
                return try evaluate(nodes[1], sheet: sheet).scalar
            }
        }
        let arguments = try nodes.map { try evaluate($0, sheet: sheet) }
        func scalar(_ index: Int) throws -> Value {
            guard arguments.indices.contains(index) else { throw FormulaFailure.value(.error("#N/A")) }
            return arguments[index].scalar
        }
        switch name {
        case "SUM": return .number(try numbers(arguments).reduce(0, +))
        case "PRODUCT": return .number(try numbers(arguments).reduce(1, *))
        case "AVERAGE":
            let values = try numbers(arguments)
            guard !values.isEmpty else { throw FormulaFailure.value(.error("#DIV/0!")) }
            return .number(values.reduce(0, +) / Double(values.count))
        case "MIN": return .number(try numbers(arguments).min() ?? 0)
        case "MAX": return .number(try numbers(arguments).max() ?? 0)
        case "MEDIAN":
            let values = try numbers(arguments).sorted()
            guard !values.isEmpty else { throw FormulaFailure.value(.error("#NUM!")) }
            let middle = values.count / 2
            return .number(values.count % 2 == 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2)
        case "COUNT":
            return .number(Double(arguments.flatMap(\.values).filter { if case .number = $0 { true } else { false } }.count))
        case "COUNTA":
            return .number(Double(arguments.flatMap(\.values).filter { $0 != .empty }.count))
        case "COUNTBLANK":
            return .number(Double(arguments.flatMap(\.values).filter { $0 == .empty || $0 == .text("") }.count))
        case "AND": return .bool(try arguments.flatMap(\.values).filter { $0 != .empty }.allSatisfy { try truth($0) })
        case "OR": return .bool(try arguments.flatMap(\.values).filter { $0 != .empty }.contains { try truth($0) })
        case "NOT": return .bool(!(try truth(try scalar(0))))
        case "ROUND", "ROUNDUP", "ROUNDDOWN":
            let value = try number(try scalar(0))
            let digits = arguments.count > 1 ? Int(try number(try scalar(1))) : 0
            let rule: FloatingPointRoundingRule = name == "ROUND" ? .toNearestOrAwayFromZero
                : name == "ROUNDUP" ? .awayFromZero : .towardZero
            return .number(round(value, digits, rule))
        case "INT": return .number(floor(try number(try scalar(0))))
        case "ABS": return .number(abs(try number(try scalar(0))))
        case "SQRT":
            let value = try number(try scalar(0))
            guard value >= 0 else { throw FormulaFailure.value(.error("#NUM!")) }
            return .number(value.squareRoot())
        case "POWER": return .number(pow(try number(try scalar(0)), try number(try scalar(1))))
        case "MOD":
            let divisor = try number(try scalar(1))
            guard divisor != 0 else { throw FormulaFailure.value(.error("#DIV/0!")) }
            let value = try number(try scalar(0))
            return .number(value - divisor * floor(value / divisor))
        case "CONCAT", "CONCATENATE":
            return .text(try arguments.flatMap(\.values).map { try text($0) }.joined())
        case "LEN": return .number(Double(try text(try scalar(0)).count))
        case "UPPER": return .text(try text(try scalar(0)).uppercased())
        case "LOWER": return .text(try text(try scalar(0)).lowercased())
        case "TRIM":
            return .text(try text(try scalar(0)).split(separator: " ", omittingEmptySubsequences: true).joined(separator: " "))
        default:
            throw FormulaFailure.unsupported
        }
    }

    // MARK: Parsing

    private struct FormulaParser {
        private let characters: [Character]
        private var index = 0

        init(text: String) {
            var source = text.trimmingCharacters(in: .whitespaces)
            if source.hasPrefix("=") { source.removeFirst() }
            characters = Array(source)
        }

        mutating func parse() throws -> Node {
            let node = try comparison()
            skipSpace()
            guard index == characters.count else { throw FormulaFailure.unsupported }
            return node
        }

        private mutating func skipSpace() {
            while index < characters.count, characters[index] == " " { index += 1 }
        }

        private mutating func take(_ token: String) -> Bool {
            skipSpace()
            let token = Array(token)
            guard index + token.count <= characters.count,
                Array(characters[index..<index + token.count]) == token
            else { return false }
            index += token.count
            return true
        }

        private mutating func comparison() throws -> Node {
            var node = try concatenation()
            while true {
                if let op = ["<>", "<=", ">=", "=", "<", ">"].first(where: { take($0) }) {
                    node = .binary(op, node, try concatenation())
                } else {
                    return node
                }
            }
        }

        private mutating func concatenation() throws -> Node {
            var node = try additive()
            while take("&") { node = .binary("&", node, try additive()) }
            return node
        }

        private mutating func additive() throws -> Node {
            var node = try multiplicative()
            while true {
                if take("+") { node = .binary("+", node, try multiplicative()) }
                else if take("-") { node = .binary("-", node, try multiplicative()) }
                else { return node }
            }
        }

        private mutating func multiplicative() throws -> Node {
            var node = try power()
            while true {
                if take("*") { node = .binary("*", node, try power()) }
                else if take("/") { node = .binary("/", node, try power()) }
                else { return node }
            }
        }

        private mutating func power() throws -> Node {
            var node = try unary()
            while take("^") { node = .binary("^", node, try unary()) }
            return node
        }

        private mutating func unary() throws -> Node {
            if take("-") { return .unary("-", try unary()) }
            if take("+") { return .unary("+", try unary()) }
            var node = try primary()
            while take("%") { node = .percent(node) }
            return node
        }

        private mutating func primary() throws -> Node {
            skipSpace()
            guard index < characters.count else { throw FormulaFailure.unsupported }
            let character = characters[index]
            if take("(") {
                let node = try comparison()
                guard take(")") else { throw FormulaFailure.unsupported }
                return node
            }
            if character == "\"" {
                index += 1
                var text = ""
                while index < characters.count {
                    if characters[index] == "\"" {
                        if index + 1 < characters.count, characters[index + 1] == "\"" {
                            text.append("\"")
                            index += 2
                            continue
                        }
                        index += 1
                        return .text(text)
                    }
                    text.append(characters[index])
                    index += 1
                }
                throw FormulaFailure.unsupported
            }
            if character.isNumber || character == "." {
                var digits = ""
                while index < characters.count, characters[index].isNumber || characters[index] == "." {
                    digits.append(characters[index])
                    index += 1
                }
                if index < characters.count, characters[index] == "E" || characters[index] == "e" {
                    var exponent = "e"
                    var probe = index + 1
                    if probe < characters.count, characters[probe] == "+" || characters[probe] == "-" {
                        exponent.append(characters[probe])
                        probe += 1
                    }
                    var hasDigits = false
                    while probe < characters.count, characters[probe].isNumber {
                        exponent.append(characters[probe])
                        probe += 1
                        hasDigits = true
                    }
                    if hasDigits {
                        digits += exponent
                        index = probe
                    }
                }
                guard let number = Double(digits) else { throw FormulaFailure.unsupported }
                return .number(number)
            }
            // A quoted sheet: 'Sheet name'!A1
            if character == "'" {
                index += 1
                var sheet = ""
                while index < characters.count {
                    if characters[index] == "'" {
                        if index + 1 < characters.count, characters[index + 1] == "'" {
                            sheet.append("'")
                            index += 2
                            continue
                        }
                        index += 1
                        break
                    }
                    sheet.append(characters[index])
                    index += 1
                }
                guard take("!") else { throw FormulaFailure.unsupported }
                return try reference(sheet: sheet)
            }
            // A word: function, boolean, name, cell, or Sheet!cell.
            var word = ""
            while index < characters.count,
                characters[index].isLetter || characters[index].isNumber || "_.$".contains(characters[index])
            {
                word.append(characters[index])
                index += 1
            }
            guard !word.isEmpty else { throw FormulaFailure.unsupported }
            if take("!") { return try reference(sheet: word) }
            if take("(") {
                var arguments: [Node] = []
                if !take(")") {
                    repeat { arguments.append(try comparison()) } while take(",")
                    guard take(")") else { throw FormulaFailure.unsupported }
                }
                return .call(word, arguments)
            }
            switch word.uppercased() {
            case "TRUE": return .bool(true)
            case "FALSE": return .bool(false)
            default: break
            }
            if let address = SemanticCellAddress(word) {
                if take(":") {
                    let end = try cellToken()
                    return .reference(sheet: nil, from: address, to: end)
                }
                return .reference(sheet: nil, from: address, to: nil)
            }
            return .name(word)
        }

        private mutating func reference(sheet: String) throws -> Node {
            let from = try cellToken()
            if take(":") { return .reference(sheet: sheet, from: from, to: try cellToken()) }
            return .reference(sheet: sheet, from: from, to: nil)
        }

        private mutating func cellToken() throws -> SemanticCellAddress {
            skipSpace()
            var word = ""
            while index < characters.count, characters[index].isLetter || characters[index].isNumber || characters[index] == "$" {
                word.append(characters[index])
                index += 1
            }
            guard let address = SemanticCellAddress(word) else { throw FormulaFailure.unsupported }
            return address
        }
    }
}

