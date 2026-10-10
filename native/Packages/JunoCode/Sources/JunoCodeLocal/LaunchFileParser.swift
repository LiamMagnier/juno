import Foundation

/// Reads a launch file the way people actually write one.
///
/// Three shapes are accepted, all as JSONC (comments and trailing commas):
///
/// - Alevr's own `.juno/launch.json` or `.alevr/launch.json`, and Claude
///   Code's `.claude/launch.json`: `{ "version", "configurations": [ { "name",
///   "runtimeExecutable", "runtimeArgs", "port", "url", "cwd", "env" } ] }`.
/// - A VS Code `launch.json`: `type`/`request` configurations. Node and
///   Python launches become commands, browser launches attach to their `url`,
///   and debugger attaches are skipped. Their `port` is a debugger port, so
///   it is never used as the server's.
/// - The shortcuts a hand-written or model-written file takes: a bare list of
///   configurations, one configuration at the root, `configurations` as an
///   object keyed by name, a `command` string, a port written as text.
///
/// A configuration with a field of the wrong type is skipped with a sentence
/// naming the file, the key path, what was expected and what was found; the
/// others in the file still load.
public enum LaunchFileParser {
    public struct Result: Hashable, Sendable {
        /// Nil when the file as a whole could not be read.
        public var file: PreviewLaunchFile?
        public var issues: [String]
    }

    public static func parse(_ data: Data, fileName: String) -> Result {
        var text = String(decoding: data, as: UTF8.self)
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        let cleaned = JSONC.strip(text)
        if cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Result(file: nil, issues: ["\(fileName) is empty. Add a \"configurations\" list, or choose a server Alevr found in the project."])
        }
        let root: Any
        do {
            root = try JSONSerialization.jsonObject(with: Data(cleaned.utf8), options: [.fragmentsAllowed])
        } catch {
            return Result(file: nil, issues: ["\(fileName) is not valid JSON\(location(of: error)). Check for a missing comma, quote or bracket."])
        }

        var issues: [String] = []
        var version: String?
        var autoVerify: Bool?
        let entries: [(path: String, value: Any)]

        switch root {
        case let list as [Any]:
            entries = list.enumerated().map { ("[\($0.offset)]", $0.element) }
        case let object as [String: Any]:
            if let value = object["version"], !(value is NSNull) {
                version = (value as? String) ?? (value as? NSNumber).map(\.stringValue)
            }
            if let value = object["autoVerify"] {
                switch Field.bool(value) {
                case let .some(flag): autoVerify = flag
                case .none: issues.append("\(fileName): autoVerify should be true or false, but it is \(describe(value)). It is treated as true.")
                }
            }
            if let configurations = object["configurations"] {
                switch configurations {
                case let list as [Any]:
                    entries = list.enumerated().map { ("configurations[\($0.offset)]", $0.element) }
                case let keyed as [String: Any]:
                    // `{ "configurations": { "web": { ... } } }`: the key is the name.
                    entries = keyed.keys.sorted().map { key -> (path: String, value: Any) in
                        let value = keyed[key] ?? NSNull()
                        guard var entry = value as? [String: Any] else { return ("configurations.\(key)", value) }
                        if entry["name"] == nil { entry["name"] = key }
                        return ("configurations.\(key)", entry)
                    }
                default:
                    return Result(file: nil, issues: issues + [
                        "\(fileName): \"configurations\" should be a list of configurations, but it is \(describe(configurations)).",
                    ])
                }
            } else if looksLikeConfiguration(object) {
                entries = [("the file", object)]
            } else {
                return Result(file: nil, issues: issues + [
                    "\(fileName) has no \"configurations\" list. Add one, for example { \"configurations\": [ { \"name\": \"web\", \"runtimeExecutable\": \"npm\", \"runtimeArgs\": [\"run\", \"dev\"] } ] }.",
                ])
            }
        default:
            return Result(file: nil, issues: [
                "\(fileName) should be a JSON object with a \"configurations\" list, but the file holds \(describe(root)).",
            ])
        }

        var configurations: [PreviewLaunchConfiguration] = []
        var skippedDebuggerOnly = 0
        for (path, value) in entries {
            guard let object = value as? [String: Any] else {
                issues.append("\(fileName): \(path) should be an object with a name and a command, but it is \(describe(value)).")
                continue
            }
            switch configuration(object, path: path, fileName: fileName) {
            case let .success(parsed): configurations.append(parsed)
            case .skipped: skippedDebuggerOnly += 1
            case let .failure(message): issues.append(message)
            }
        }
        if configurations.isEmpty, skippedDebuggerOnly > 0 {
            issues.append("\(fileName) only has debugger configurations (\(skippedDebuggerOnly)); none of them starts a server the Preview can open.")
        }
        return Result(
            file: PreviewLaunchFile(version: version, autoVerify: autoVerify, configurations: configurations),
            issues: issues
        )
    }

    // MARK: - One configuration

    enum ConfigurationResult {
        case success(PreviewLaunchConfiguration)
        /// A VS Code configuration that debugs rather than serves.
        case skipped
        case failure(String)
    }

    static func configuration(_ object: [String: Any], path: String, fileName: String) -> ConfigurationResult {
        let label = (object["name"] as? String).map { " (\"\($0)\")" } ?? ""
        func fail(_ key: String, _ expected: String, _ value: Any) -> ConfigurationResult {
            .failure("\(fileName): \(path == "the file" ? key : "\(path).\(key)")\(label) should be \(expected), but it is \(describe(value)).")
        }

        let vsCodeType = (object["type"] as? String)?.lowercased()
        let request = (object["request"] as? String)?.lowercased()
        let isVSCode = vsCodeType != nil && request != nil
        if isVSCode, request == "attach" { return .skipped }

        var configuration = PreviewLaunchConfiguration(name: "")

        if let value = object["name"] ?? object["label"] {
            guard let name = Field.text(value) else { return fail("name", "text", value) }
            configuration.name = name
        }

        var argvPrefix: [String] = []
        if let value = object["runtimeExecutable"], !(value is NSNull) {
            if let text = value as? String {
                configuration.runtimeExecutable = text
            } else if let words = Field.words(value), let first = words.first {
                configuration.runtimeExecutable = first
                argvPrefix = Array(words.dropFirst())
            } else {
                return fail("runtimeExecutable", "the program to run, as text like \"npm\"", value)
            }
        }
        for key in ["runtimeArgs", "args"] {
            guard let value = object[key], !(value is NSNull) else { continue }
            guard let words = Field.words(value) else {
                return fail(key, "a list of text arguments like [\"run\", \"dev\"]", value)
            }
            if key == "runtimeArgs" { configuration.runtimeArgs = argvPrefix + words } else { configuration.args = words }
        }
        if configuration.runtimeArgs == nil, !argvPrefix.isEmpty { configuration.runtimeArgs = argvPrefix }

        if let value = object["program"], !(value is NSNull) {
            guard let text = value as? String else { return fail("program", "a path as text", value) }
            configuration.program = text
        }

        // `"command": "npm run dev"`: the way most people write it by hand.
        if let value = object["command"] ?? object["script"], configuration.runtimeExecutable == nil, configuration.program == nil {
            guard let text = value as? String, !text.trimmingCharacters(in: .whitespaces).isEmpty else {
                return fail(object["command"] != nil ? "command" : "script", "a command line as text like \"npm run dev\"", value)
            }
            let argv = commandWords(text)
            configuration.runtimeExecutable = argv.first
            configuration.runtimeArgs = Array(argv.dropFirst()) + (configuration.runtimeArgs ?? [])
        }

        if let value = object["cwd"], !(value is NSNull) {
            guard let text = value as? String else { return fail("cwd", "a folder path as text", value) }
            configuration.cwd = text
        }
        if let value = object["env"], !(value is NSNull) {
            guard let dictionary = value as? [String: Any] else {
                return fail("env", "an object of variable names to text values", value)
            }
            var environment: [String: String] = [:]
            for (key, raw) in dictionary where !(raw is NSNull) {
                guard let text = Field.text(raw) else {
                    return fail("env.\(key)", "text", raw)
                }
                environment[key] = text
            }
            configuration.env = environment
        }
        // VS Code's `port` is the debugger's, never the server's.
        if !isVSCode, let value = object["port"], !(value is NSNull) {
            guard let port = Field.integer(value) else { return fail("port", "a port number like 3000", value) }
            configuration.port = port
        }
        if let value = object["autoPort"], !(value is NSNull) {
            guard let flag = Field.bool(value) else { return fail("autoPort", "true or false", value) }
            configuration.autoPort = flag
        }
        if let value = object["url"], !(value is NSNull) {
            guard let text = value as? String else { return fail("url", "an address as text like \"http://localhost:3000\"", value) }
            // A browser launch often opens a route; the Preview opens the
            // origin and the reader moves to the route from there.
            configuration.url = isVSCode ? origin(of: text) : text
        }
        if let value = object["network"], !(value is NSNull) {
            guard let text = value as? String, let policy = PreviewNetworkPolicy(rawValue: text.lowercased()) else {
                return fail("network", "\"loopback\" or \"internet\"", value)
            }
            configuration.network = policy
        }
        if let value = object["ready"], !(value is NSNull) {
            guard let ready = value as? [String: Any] else {
                return fail("ready", "an object like { \"path\": \"/\", \"timeoutSeconds\": 90 }", value)
            }
            var readiness = PreviewReadiness()
            if let raw = ready["path"], !(raw is NSNull) {
                guard let text = raw as? String else { return fail("ready.path", "a path as text like \"/health\"", raw) }
                readiness.path = text
            }
            if let raw = ready["timeoutSeconds"], !(raw is NSNull) {
                guard let seconds = Field.integer(raw) else { return fail("ready.timeoutSeconds", "a number of seconds", raw) }
                readiness.timeoutSeconds = seconds
            }
            configuration.ready = readiness
        }
        if let value = object["allowedExternalOrigins"], !(value is NSNull) {
            guard let list = Field.words(value) else {
                return fail("allowedExternalOrigins", "a list of origins as text", value)
            }
            configuration.allowedExternalOrigins = list
        }

        if isVSCode, let type = vsCodeType {
            switch type {
            case "node", "pwa-node", "node2":
                if configuration.runtimeExecutable == nil, configuration.program != nil {
                    configuration.runtimeExecutable = "node"
                }
            case "python", "debugpy":
                if configuration.runtimeExecutable == nil {
                    if let module = object["module"] as? String {
                        configuration.runtimeExecutable = "python3"
                        configuration.runtimeArgs = ["-m", module]
                    } else if configuration.program != nil {
                        configuration.runtimeExecutable = "python3"
                    }
                }
            case "chrome", "pwa-chrome", "msedge", "pwa-msedge", "firefox":
                // Opens a browser on a server something else starts.
                break
            default:
                break
            }
            if configuration.runtimeExecutable == nil, configuration.program == nil, configuration.url == nil {
                return .skipped
            }
        }

        if configuration.name.trimmingCharacters(in: .whitespaces).isEmpty {
            // A configuration with a command and no name still runs; it is
            // called by what it runs.
            let argv = [configuration.runtimeExecutable ?? configuration.program].compactMap { $0 }
                + (configuration.runtimeArgs ?? []) + (configuration.args ?? [])
            if !argv.isEmpty {
                configuration.name = String(argv.joined(separator: " ").prefix(60))
            } else if let url = configuration.url {
                configuration.name = url
            }
        }
        return .success(configuration)
    }

    // MARK: - Helpers

    /// Whether a root object is one configuration rather than a file.
    static func looksLikeConfiguration(_ object: [String: Any]) -> Bool {
        ["runtimeExecutable", "program", "command", "script", "url"].contains { object[$0] != nil }
    }

    /// A command line as argv: plain words split, anything a shell must
    /// read (`&&`, pipes, variables) handed to `sh -c` whole.
    static func commandWords(_ text: String) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let shellOnly = CharacterSet(charactersIn: "&|;<>$`()*?~\\\"'")
        if trimmed.unicodeScalars.contains(where: { shellOnly.contains($0) }) {
            return ["sh", "-c", trimmed]
        }
        return trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// `http://localhost:3000/app?x` → `http://localhost:3000`.
    static func origin(of text: String) -> String {
        guard var components = URLComponents(string: text), components.host != nil else { return text }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.string ?? text
    }

    /// "around line 3, column 5" from Foundation's parse error.
    static func location(of error: Error) -> String {
        let description = ((error as NSError).userInfo[NSDebugDescriptionErrorKey] as? String) ?? "\(error)"
        guard let range = description.range(of: #"line \d+, column \d+"#, options: .regularExpression) else { return "" }
        return " (around \(description[range]))"
    }

    /// What a JSON value is, in words, for "but it is …".
    static func describe(_ value: Any) -> String {
        switch value {
        case is NSNull: return "null"
        case let text as String:
            let shown = text.count > 40 ? String(text.prefix(40)) + "…" : text
            return "the text \"\(shown)\""
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            return "the number \(number)"
        case let list as [Any]: return list.isEmpty ? "an empty list" : "a list"
        case is [String: Any]: return "an object"
        default: return "something else"
        }
    }

    enum Field {
        static func isBool(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }

        static func text(_ value: Any) -> String? {
            if let text = value as? String { return text }
            if let number = value as? NSNumber { return isBool(number) ? (number.boolValue ? "true" : "false") : number.stringValue }
            return nil
        }

        static func integer(_ value: Any) -> Int? {
            if let number = value as? NSNumber, !isBool(number) {
                let double = number.doubleValue
                return double == double.rounded() ? Int(exactly: double) : nil
            }
            if let text = value as? String { return Int(text.trimmingCharacters(in: .whitespaces)) }
            return nil
        }

        static func bool(_ value: Any) -> Bool? {
            if let number = value as? NSNumber, isBool(number) { return number.boolValue }
            if let text = value as? String {
                switch text.lowercased() {
                case "true", "yes": return true
                case "false", "no": return false
                default: return nil
                }
            }
            return nil
        }

        /// A list of words; a single string is split as a command line.
        static func words(_ value: Any) -> [String]? {
            if let list = value as? [Any] {
                var words: [String] = []
                for item in list {
                    guard let text = text(item) else { return nil }
                    words.append(text)
                }
                return words
            }
            if let text = value as? String {
                return text.split(whereSeparator: \.isWhitespace).map(String.init)
            }
            return nil
        }
    }
}

/// JSON with comments and trailing commas, as VS Code and Claude Code write
/// it, turned into JSON. Strings are left exactly as they are.
public enum JSONC {
    public static func strip(_ text: String) -> String {
        var output: [Character] = []
        output.reserveCapacity(text.count)
        let characters = Array(text)
        var index = 0
        var inString = false
        while index < characters.count {
            let character = characters[index]
            let next: Character? = index + 1 < characters.count ? characters[index + 1] : nil
            if inString {
                output.append(character)
                if character == "\\", let next {
                    output.append(next)
                    index += 2
                    continue
                }
                if character == "\"" { inString = false }
                index += 1
                continue
            }
            if character == "\"" {
                inString = true
                output.append(character)
                index += 1
                continue
            }
            if character == "/", next == "/" {
                while index < characters.count, characters[index] != "\n" { index += 1 }
                continue
            }
            if character == "/", next == "*" {
                index += 2
                while index < characters.count, !(characters[index] == "*" && index + 1 < characters.count && characters[index + 1] == "/") {
                    // Keep line breaks so a parse error's line number still
                    // matches the file.
                    if characters[index] == "\n" { output.append("\n") }
                    index += 1
                }
                index += 2
                continue
            }
            if character == "]" || character == "}" {
                // Drop a trailing comma before the closer.
                var back = output.count - 1
                while back >= 0, output[back].isWhitespace { back -= 1 }
                if back >= 0, output[back] == "," { output.remove(at: back) }
            }
            output.append(character)
            index += 1
        }
        return String(output)
    }
}
