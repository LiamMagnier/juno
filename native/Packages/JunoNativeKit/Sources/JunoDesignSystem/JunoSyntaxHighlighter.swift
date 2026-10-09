import SwiftUI

/// A small, honest syntax highlighter for the transcript's code blocks.
///
/// The web's reading of `highlight.js` on VS Code's palette (`globals.css`,
/// `.hljs-*` over `--code-*`: Light+ in light, Dark+ in dark): keywords blue,
/// built-in types and SQL functions teal, called names in the function ink,
/// strings in `--code-string`, numbers in `--code-number`, comments green and
/// italic. Everything else keeps the block's foreground. It is a scanner, not
/// a parser: it knows each family's comment and string delimiters, its
/// keywords and types, which is all the colours need, and it never fails — an
/// unknown language is scanned as a C-like one, and text it cannot classify
/// stays plain.
public enum JunoSyntaxHighlighter {
    public enum Token: Equatable, Sendable {
        case keyword, type, function, string, number, comment
    }

    /// The source, coloured. One `AttributedString` for the whole block, so a
    /// selection can run across its lines.
    public static func highlighted(_ source: String, language: String?) -> AttributedString {
        // Built piece by piece, in order: indexing into an attributed string by
        // offset is linear, and a long listing has thousands of tokens.
        var result = AttributedString()
        var cursor = source.startIndex
        for (range, token) in tokens(in: source, language: language) {
            if cursor < range.lowerBound {
                result += AttributedString(String(source[cursor..<range.lowerBound]))
            }
            var piece = AttributedString(String(source[range]))
            switch token {
            case .keyword:
                piece.foregroundColor = Color.junoCodeKeyword
            case .type:
                piece.foregroundColor = Color.junoCodeType
            case .function:
                piece.foregroundColor = Color.junoCodeFunction
            case .string:
                piece.foregroundColor = Color.junoCodeString
            case .number:
                piece.foregroundColor = Color.junoCodeNumber
            case .comment:
                piece.foregroundColor = Color.junoCodeComment
                // Relative, like the prose's maths: the italic of whatever
                // face and size the block is set in.
                piece.inlinePresentationIntent = .emphasized
            }
            result += piece
            cursor = range.upperBound
        }
        if cursor < source.endIndex {
            result += AttributedString(String(source[cursor...]))
        }
        return result
    }

    /// The classified ranges of `source`, in order and without overlaps.
    public static func tokens(in source: String, language: String?) -> [(Range<String.Index>, Token)] {
        let grammar = Grammar.for(language)
        guard grammar != .plain else { return [] }
        var found: [(Range<String.Index>, Token)] = []
        var index = source.startIndex
        let end = source.endIndex
        var previous: Character?

        func starts(with marker: String, at position: String.Index) -> Bool {
            source[position...].hasPrefix(marker)
        }

        while index < end {
            let character = source[index]

            // Line comments.
            if grammar.lineComments.contains(where: { starts(with: $0, at: index) }),
                grammar.lineCommentAllowed(after: previous)
            {
                let stop = source[index...].firstIndex(of: "\n") ?? end
                found.append((index..<stop, .comment))
                index = stop
                previous = nil
                continue
            }

            // Block comments.
            if let block = grammar.blockComments.first(where: { starts(with: $0.open, at: index) }) {
                let bodyStart = source.index(index, offsetBy: block.open.count)
                let stop: String.Index
                if let close = source.range(of: block.close, range: bodyStart..<end) {
                    stop = close.upperBound
                } else {
                    stop = end
                }
                found.append((index..<stop, .comment))
                index = stop
                previous = nil
                continue
            }

            // Strings, triple-quoted first.
            if let triple = grammar.tripleQuotes.first(where: { starts(with: $0, at: index) }) {
                let bodyStart = source.index(index, offsetBy: triple.count)
                let stop = source.range(of: triple, range: bodyStart..<end)?.upperBound ?? end
                found.append((index..<stop, .string))
                index = stop
                previous = "\""
                continue
            }
            if grammar.quotes.contains(character) {
                let multiline = grammar.multilineQuotes.contains(character)
                var cursor = source.index(after: index)
                var escaped = false
                while cursor < end {
                    let next = source[cursor]
                    if escaped {
                        escaped = false
                    } else if next == "\\" {
                        escaped = true
                    } else if next == character {
                        cursor = source.index(after: cursor)
                        break
                    } else if next == "\n", !multiline {
                        break
                    }
                    cursor = source.index(after: cursor)
                }
                found.append((index..<cursor, .string))
                index = cursor
                previous = character
                continue
            }

            // Numbers: a digit that does not continue an identifier.
            if character.isASCII, character.isNumber, !isIdentifierCharacter(previous) {
                var cursor = source.index(after: index)
                while cursor < end {
                    let next = source[cursor]
                    guard next.isASCII, next.isHexDigit || next == "." || next == "_" || next == "x"
                        || next == "X" || next == "o" || next == "b"
                    else { break }
                    // A range operator, not a decimal point.
                    if next == ".", source[cursor...].hasPrefix("..") { break }
                    cursor = source.index(after: cursor)
                }
                found.append((index..<cursor, .number))
                previous = source[source.index(before: cursor)]
                index = cursor
                continue
            }

            // Words.
            if isIdentifierStart(character, grammar: grammar), !isIdentifierCharacter(previous) {
                var cursor = source.index(after: index)
                while cursor < end, isIdentifierCharacter(source[cursor]) || source[cursor] == "$" {
                    cursor = source.index(after: cursor)
                }
                let word = String(source[index..<cursor])
                let lookup = grammar == .sql ? word.lowercased() : word
                if grammar.keywords.contains(lookup) {
                    found.append((index..<cursor, .keyword))
                } else if grammar.types.contains(lookup) {
                    found.append((index..<cursor, .type))
                } else if grammar.callsAreWords, isCall(source, after: cursor) {
                    // SQL's functions are hljs `built_in` (teal); elsewhere a
                    // call is `title.function_`.
                    found.append((index..<cursor, grammar == .sql ? .type : .function))
                } else if grammar.capitalisedAreTypes, isTypeName(word) {
                    found.append((index..<cursor, .type))
                }
                previous = source[source.index(before: cursor)]
                index = cursor
                continue
            }

            previous = character
            index = source.index(after: index)
        }
        return found
    }

    /// A name followed, past any spaces, by an opening parenthesis.
    private static func isCall(_ source: String, after position: String.Index) -> Bool {
        var cursor = position
        while cursor < source.endIndex, source[cursor] == " " { cursor = source.index(after: cursor) }
        return cursor < source.endIndex && source[cursor] == "("
    }

    /// `String`, `HashMap`, `Promise`: capitalised with a lower-case letter, so
    /// `MAX_SIZE` and `ID` stay plain.
    private static func isTypeName(_ word: String) -> Bool {
        guard let first = word.first, first.isUppercase else { return false }
        return word.contains { $0.isLowercase }
    }

    private static func isIdentifierCharacter(_ character: Character?) -> Bool {
        guard let character else { return false }
        return character == "_" || character.isLetter || character.isNumber
    }

    private static func isIdentifierStart(_ character: Character, grammar: Grammar) -> Bool {
        character == "_" || character.isLetter || (grammar.attributesAreWords && character == "@")
    }

    /// A family of languages that share their comment and string syntax.
    enum Grammar: Equatable {
        case cLike(Set<String>)
        case hash(Set<String>)
        case shell
        case sql
        case css
        case markup
        case json
        case plain

        static func `for`(_ language: String?) -> Grammar {
            switch (language ?? "").lowercased().trimmingCharacters(in: .whitespaces) {
            case "swift": .cLike(swiftKeywords)
            case "js", "javascript", "jsx", "mjs", "cjs", "ts", "typescript", "tsx": .cLike(scriptKeywords)
            case "java", "kotlin", "kt", "scala", "dart", "c#", "csharp", "cs": .cLike(jvmKeywords)
            case "c", "cpp", "c++", "h", "hpp", "objc", "objective-c", "m", "mm": .cLike(cKeywords)
            case "go", "golang": .cLike(goKeywords)
            case "rust", "rs": .cLike(rustKeywords)
            case "php": .cLike(scriptKeywords.union(["function", "echo", "public", "private", "protected", "namespace", "use"]))
            case "python", "py": .hash(pythonKeywords)
            case "ruby", "rb": .hash(rubyKeywords)
            case "yaml", "yml", "toml", "ini", "r", "perl", "pl", "makefile", "make", "dockerfile", "conf":
                .hash(["true", "false", "null", "yes", "no", "on", "off"])
            case "bash", "sh", "zsh", "shell", "console", "terminal", "fish", "powershell", "ps1": .shell
            case "sql", "postgres", "postgresql", "mysql", "sqlite": .sql
            case "css", "scss", "sass", "less": .css
            case "html", "xml", "svg", "vue", "svelte": .markup
            case "json", "jsonc", "json5": .json
            case "text", "txt", "plaintext", "output", "log", "diff", "patch", "markdown", "md": .plain
            default: .cLike(genericKeywords)
            }
        }

        var lineComments: [String] {
            switch self {
            case .cLike: ["//"]
            case .hash, .shell: ["#"]
            case .sql: ["--"]
            case .css, .markup, .json, .plain: []
            }
        }

        /// A `#` opens a comment only at the start of a word in a shell —
        /// `${#array}` and `a#b` are not comments.
        func lineCommentAllowed(after previous: Character?) -> Bool {
            guard self == .shell else { return true }
            guard let previous else { return true }
            return previous == " " || previous == "\t" || previous == "\n" || previous == ";"
        }

        var blockComments: [(open: String, close: String)] {
            switch self {
            case .cLike, .css, .sql: [("/*", "*/")]
            case .markup: [("<!--", "-->")]
            case .hash, .shell, .json, .plain: []
            }
        }

        var tripleQuotes: [String] {
            switch self {
            case .hash(let keywords) where keywords.contains("def"): ["\"\"\"", "'''"]
            case .cLike(let keywords) where keywords.contains("guard"): ["\"\"\""]
            default: []
            }
        }

        var quotes: Set<Character> {
            switch self {
            case .cLike(let keywords) where keywords.contains("const"): ["\"", "'", "`"]
            case .cLike(let keywords) where keywords.contains("guard"): ["\""]
            case .cLike(let keywords) where keywords.contains("fn"): ["\""]
            case .json: ["\""]
            default: ["\"", "'"]
            }
        }

        var multilineQuotes: Set<Character> {
            switch self {
            case .cLike(let keywords) where keywords.contains("const"): ["`"]
            case .shell: ["\"", "'"]
            default: []
            }
        }

        var keywords: Set<String> {
            switch self {
            case .cLike(let words), .hash(let words): words
            case .shell: shellKeywords
            case .sql: sqlKeywords
            case .json: ["true", "false", "null"]
            case .css, .markup, .plain: []
            }
        }

        /// Built-in types (hljs `type` / `built_in`), teal.
        var types: Set<String> {
            switch self {
            case .cLike(let words) where words.contains("const") && words.contains("typeof"):
                ["string", "number", "boolean", "any", "unknown", "never", "bigint", "symbol", "object",
                 "console", "Math", "JSON", "Promise", "Array", "Object", "Map", "Set", "Date", "Error"]
            case .cLike(let words) where words.contains("fn"):
                ["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
                 "f32", "f64", "bool", "char", "str", "String", "Vec", "Option", "Result", "Box"]
            case .cLike(let words) where words.contains("chan"):
                ["int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64",
                 "float32", "float64", "string", "bool", "byte", "rune", "error", "any"]
            case .hash(let words) where words.contains("def") && words.contains("lambda"):
                ["int", "str", "float", "bool", "list", "dict", "tuple", "set", "bytes", "object",
                 "print", "len", "range", "enumerate", "zip", "map", "filter", "sorted", "sum", "min",
                 "max", "abs", "round", "open", "isinstance", "type", "input", "super"]
            case .sql: Self.sqlTypes
            default: []
            }
        }

        /// Whether `name(` marks a call worth colouring.
        var callsAreWords: Bool {
            switch self {
            case .cLike, .hash, .sql: true
            default: false
            }
        }

        var capitalisedAreTypes: Bool {
            switch self {
            case .cLike, .hash: true
            default: false
            }
        }

        static let sqlTypes: Set<String> = [
            "varchar", "varchar2", "nvarchar2", "char", "nchar", "number", "integer", "int", "smallint",
            "bigint", "decimal", "numeric", "float", "real", "double", "precision", "date", "time",
            "timestamp", "interval", "text", "clob", "blob", "boolean", "serial", "uuid", "json", "jsonb",
        ]

        var attributesAreWords: Bool {
            if case .cLike(let words) = self { return words.contains("guard") }
            return false
        }
    }

    // MARK: Keyword lists

    static let swiftKeywords: Set<String> = [
        "actor", "any", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
        "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough",
        "false", "fileprivate", "for", "func", "guard", "if", "import", "in", "init", "inout",
        "internal", "is", "let", "mutating", "nil", "nonisolated", "open", "operator", "private",
        "protocol", "public", "repeat", "rethrows", "return", "self", "Self", "some", "static",
        "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias",
        "var", "where", "while", "@MainActor", "@State", "@Binding", "@Observable", "@escaping",
        "@discardableResult", "@available", "@objc", "@main", "@Environment", "@Published",
    ]

    static let scriptKeywords: Set<String> = [
        "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
        "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends",
        "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in",
        "instanceof", "interface", "keyof", "let", "new", "null", "of", "private", "protected",
        "public", "readonly", "return", "satisfies", "set", "static", "super", "switch", "this",
        "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
    ]

    static let jvmKeywords: Set<String> = [
        "abstract", "as", "break", "case", "catch", "class", "const", "continue", "data", "default",
        "do", "else", "enum", "extends", "false", "final", "finally", "for", "fun", "if",
        "implements", "import", "in", "interface", "is", "new", "null", "object", "override",
        "package", "private", "protected", "public", "return", "static", "super", "switch", "this",
        "throw", "throws", "true", "try", "val", "var", "void", "when", "while", "namespace",
        "using", "async", "await", "string", "int", "bool",
    ]

    static let cKeywords: Set<String> = [
        "auto", "bool", "break", "case", "char", "class", "const", "constexpr", "continue",
        "default", "delete", "do", "double", "else", "enum", "extern", "false", "float", "for",
        "if", "include", "inline", "int", "long", "namespace", "new", "nullptr", "private",
        "protected", "public", "return", "short", "signed", "sizeof", "static", "struct", "switch",
        "template", "this", "true", "typedef", "typename", "union", "unsigned", "using", "virtual",
        "void", "volatile", "while", "NULL", "define",
    ]

    static let goKeywords: Set<String> = [
        "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
        "false", "for", "func", "go", "goto", "if", "import", "interface", "map", "nil", "package",
        "range", "return", "select", "struct", "switch", "true", "type", "var",
    ]

    static let rustKeywords: Set<String> = [
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
        "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move",
        "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
        "type", "unsafe", "use", "where", "while", "Some", "None", "Ok", "Err",
    ]

    static let pythonKeywords: Set<String> = [
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
        "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
        "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "self", "True", "try",
        "while", "with", "yield",
    ]

    static let rubyKeywords: Set<String> = [
        "alias", "and", "begin", "break", "case", "class", "def", "do", "else", "elsif", "end",
        "ensure", "false", "for", "if", "in", "module", "next", "nil", "not", "or", "redo",
        "rescue", "retry", "return", "self", "super", "then", "true", "undef", "unless", "until",
        "when", "while", "yield", "require", "attr_reader", "attr_accessor",
    ]

    static let shellKeywords: Set<String> = [
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
        "in", "function", "return", "export", "local", "readonly", "set", "unset", "source",
        "echo", "exit", "cd", "sudo",
    ]

    /// Lower-case: SQL is matched case-insensitively. The aggregate and string
    /// functions are not here — they are coloured as calls (`COUNT(`).
    static let sqlKeywords: Set<String> = [
        "select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set",
        "delete", "create", "table", "index", "view", "drop", "alter", "add", "column", "primary",
        "key", "foreign", "references", "join", "left", "right", "inner", "outer", "full", "cross",
        "natural", "using", "on", "as", "group", "by", "order", "having", "limit", "offset",
        "distinct", "union", "intersect", "minus", "except", "all", "any", "some", "null", "nulls",
        "is", "in", "like", "between", "exists", "case", "when", "then", "else", "end", "with",
        "returning", "default", "unique", "constraint", "check", "asc", "desc", "true", "false",
        "begin", "commit", "rollback", "fetch", "first", "next", "rows", "row", "only", "connect",
        "prior", "start", "level", "rownum", "sysdate", "replace", "sequence", "trigger",
        "procedure", "function", "declare", "exception", "loop", "if", "elsif", "return",
        "returns", "grant", "revoke", "truncate", "merge", "matched", "over", "partition", "escape",
        "cascade", "temporary", "recursive",
    ]

    static let genericKeywords: Set<String> = scriptKeywords
        .union(["def", "fn", "func", "fun", "struct", "impl", "let", "var", "val", "nil", "None", "True", "False"])
}
