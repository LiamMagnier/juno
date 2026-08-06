import Foundation

/// Parsing the structured output of `xcodebuild` and `simctl`.
///
/// Kept apart from every process launch so it is testable against captured
/// fixtures — which is the only way to have confidence in it, because the real
/// commands need Xcode, a runtime, and several seconds each.
///
/// The parsers are deliberately tolerant of *extra* fields and intolerant of
/// missing ones: Apple adds keys between Xcode releases, and a parser that
/// invents a default for an absent bundle identifier produces an install that
/// fails much later with a much worse message.
public enum SimulatorParsing {
    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case notJSON
        case missing(String)
        case noApplicationScheme
        case noIOSRuntime

        public var description: String {
            switch self {
            case .notJSON: "Xcode returned output Juno could not read as JSON."
            case .missing(let field): "Xcode's output is missing “\(field)”."
            case .noApplicationScheme: "This project has no shared scheme that builds an iOS app."
            case .noIOSRuntime: "No iOS simulator runtime is installed. Install one in Xcode ▸ Settings ▸ Components."
            }
        }
    }

    // MARK: xcodebuild -list -json

    public struct SchemeList: Equatable, Sendable {
        public let name: String
        public let schemes: [String]
        public let targets: [String]
        public let configurations: [String]
    }

    /// `xcodebuild -list -json` nests under `workspace` or `project`; a Swift
    /// package answers under `project` too. All three are handled here rather
    /// than by three near-identical callers.
    public static func parseSchemeList(_ data: Data) throws -> SchemeList {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ParseError.notJSON
        }
        let container = (root["workspace"] as? [String: Any]) ?? (root["project"] as? [String: Any])
        guard let container else { throw ParseError.missing("workspace/project") }
        guard let schemes = container["schemes"] as? [String] else { throw ParseError.missing("schemes") }
        return SchemeList(
            name: (container["name"] as? String) ?? "",
            schemes: schemes,
            targets: (container["targets"] as? [String]) ?? [],
            configurations: (container["configurations"] as? [String]) ?? []
        )
    }

    // MARK: xcodebuild -showBuildSettings -json

    /// Read the settings for one scheme and assemble the `.app` path from them.
    ///
    /// `TARGET_BUILD_DIR` + `FULL_PRODUCT_NAME` is the answer Xcode itself uses;
    /// reconstructing `…/Build/Products/Debug-iphonesimulator/Name.app` by hand
    /// is the thing that breaks the moment a project sets a custom configuration
    /// name or a per-target build directory.
    public static func parseBuildSettings(_ data: Data) throws -> XcodeTargetSettings {
        guard let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw ParseError.notJSON
        }

        // A scheme can build several targets; the app is the one whose product
        // type is an application (or, failing that, the one producing a `.app`).
        let candidates = entries.compactMap { $0["buildSettings"] as? [String: Any] }
        let appSettings =
            candidates.first { ($0["PRODUCT_TYPE"] as? String) == "com.apple.product-type.application" }
            ?? candidates.first { ($0["FULL_PRODUCT_NAME"] as? String)?.hasSuffix(".app") == true }

        guard let settings = appSettings else { throw ParseError.noApplicationScheme }
        guard let bundleID = settings["PRODUCT_BUNDLE_IDENTIFIER"] as? String, !bundleID.isEmpty else {
            throw ParseError.missing("PRODUCT_BUNDLE_IDENTIFIER")
        }
        guard let buildDir = settings["TARGET_BUILD_DIR"] as? String else {
            throw ParseError.missing("TARGET_BUILD_DIR")
        }
        guard let productName = settings["FULL_PRODUCT_NAME"] as? String else {
            throw ParseError.missing("FULL_PRODUCT_NAME")
        }

        let platforms = (settings["SUPPORTED_PLATFORMS"] as? String)?
            .split(separator: " ")
            .map(String.init) ?? []

        return XcodeTargetSettings(
            bundleIdentifier: bundleID,
            productName: productName,
            appPath: (buildDir as NSString).appendingPathComponent(productName),
            deploymentTarget: settings["IPHONEOS_DEPLOYMENT_TARGET"] as? String,
            supportedPlatforms: platforms
        )
    }

    // MARK: simctl list runtimes --json

    public static func parseRuntimes(_ data: Data) throws -> [SimulatorRuntime] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let runtimes = root["runtimes"] as? [[String: Any]]
        else { throw ParseError.notJSON }

        return runtimes.compactMap { entry -> SimulatorRuntime? in
            guard let id = entry["identifier"] as? String else { return nil }
            let name = (entry["name"] as? String) ?? id
            let version = (entry["version"] as? String) ?? ""
            // `platform` appeared in newer Xcodes; older output only has the
            // identifier, so derive it rather than dropping the runtime.
            let platform = (entry["platform"] as? String) ?? platformFromIdentifier(id)
            let available = (entry["isAvailable"] as? Bool) ?? (entry["availability"] as? String == "(available)")
            return SimulatorRuntime(id: id, name: name, version: version, platform: platform, isAvailable: available)
        }
    }

    private static func platformFromIdentifier(_ identifier: String) -> String {
        // com.apple.CoreSimulator.SimRuntime.iOS-27-0 → iOS
        guard let last = identifier.split(separator: ".").last else { return "" }
        return String(last.split(separator: "-").first ?? "")
    }

    // MARK: simctl list devices --json

    public static func parseDevices(_ data: Data) throws -> [SimulatorDevice] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let byRuntime = root["devices"] as? [String: Any]
        else { throw ParseError.notJSON }

        var out: [SimulatorDevice] = []
        for (runtimeID, value) in byRuntime {
            guard let devices = value as? [[String: Any]] else { continue }
            for device in devices {
                guard let udid = device["udid"] as? String, let name = device["name"] as? String else { continue }
                out.append(
                    SimulatorDevice(
                        udid: udid,
                        name: name,
                        state: SimulatorDeviceState(wire: (device["state"] as? String) ?? "Unknown"),
                        runtimeID: runtimeID,
                        deviceTypeID: device["deviceTypeIdentifier"] as? String,
                        isAvailable: (device["isAvailable"] as? Bool) ?? true
                    )
                )
            }
        }
        // Stable order: newest runtime first, then device name. Dictionary
        // iteration order is not stable, and a picker that reshuffles itself
        // between refreshes is a picker nobody can use.
        return out.sorted { lhs, rhs in
            lhs.runtimeID == rhs.runtimeID ? lhs.name < rhs.name : lhs.runtimeID > rhs.runtimeID
        }
    }

    /// The best default device for a runtime: a booted one if there is one,
    /// otherwise the newest available iPhone, otherwise anything available.
    public static func preferredDevice(in devices: [SimulatorDevice], runtimeID: String) -> SimulatorDevice? {
        let candidates = devices.filter { $0.runtimeID == runtimeID && $0.isAvailable }
        if let booted = candidates.first(where: { $0.state == .booted }) { return booted }
        if let iPhone = candidates.filter({ $0.name.hasPrefix("iPhone") }).sorted(by: { $0.name > $1.name }).first {
            return iPhone
        }
        return candidates.first
    }

    public static func preferredRuntime(in runtimes: [SimulatorRuntime]) throws -> SimulatorRuntime {
        let ios = runtimes.filter { $0.isIOS && $0.isAvailable }
        guard let newest = ios.sorted(by: { compareVersions($0.version, $1.version) == .orderedDescending }).first else {
            throw ParseError.noIOSRuntime
        }
        return newest
    }

    /// Numeric, component-wise version compare. String comparison puts "9.0"
    /// above "27.0", which would default every project to an ancient runtime.
    public static func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let a = lhs.split(separator: ".").map { Int($0) ?? 0 }
        let b = rhs.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(a.count, b.count) {
            let left = index < a.count ? a[index] : 0
            let right = index < b.count ? b[index] : 0
            if left != right { return left < right ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    // MARK: Build diagnostics

    public struct BuildDiagnostic: Equatable, Sendable, Identifiable {
        public enum Severity: String, Equatable, Sendable { case error, warning, note }

        public let id: String
        public let severity: Severity
        public let file: String?
        public let line: Int?
        public let column: Int?
        public let message: String

        public init(severity: Severity, file: String?, line: Int?, column: Int?, message: String) {
            self.id = "\(file ?? "")\(line ?? 0):\(column ?? 0):\(message)"
            self.severity = severity
            self.file = file
            self.line = line
            self.column = column
            self.message = message
        }
    }

    /// Pull readable diagnostics out of raw `xcodebuild` output.
    ///
    /// Handles both the clang/swift form (`/path/File.swift:12:5: error: …`) and
    /// the bare form xcodebuild prints for its own failures (`error: …`), so a
    /// missing scheme is reported as clearly as a syntax error.
    public static func parseDiagnostics(_ output: String) -> [BuildDiagnostic] {
        var out: [BuildDiagnostic] = []
        var seen = Set<String>()

        for rawLine in output.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            guard let range = line.range(of: ": error: ")
                ?? line.range(of: ": warning: ")
                ?? line.range(of: ": note: ")
            else {
                // xcodebuild's own diagnostics have no file prefix at all —
                // "error: Signing for … requires a development team." is the
                // most common build failure there is, and it arrives this way.
                for prefix in ["error: ", "warning: ", "note: "] where line.hasPrefix(prefix) {
                    let diagnostic = BuildDiagnostic(
                        severity: BuildDiagnostic.Severity(rawValue: String(prefix.dropLast(2))) ?? .note,
                        file: nil, line: nil, column: nil,
                        message: String(line.dropFirst(prefix.count))
                    )
                    if seen.insert(diagnostic.id).inserted { out.append(diagnostic) }
                    break
                }
                continue
            }

            let severityToken = line[range].trimmingCharacters(in: CharacterSet(charactersIn: ": "))
            let severity = BuildDiagnostic.Severity(rawValue: severityToken) ?? .note
            let location = String(line[line.startIndex..<range.lowerBound])
            let message = String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)

            // "/path/File.swift:12:5" — split from the right so a Windows-style
            // or colon-containing path does not confuse the line number.
            let parts = location.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            var file: String?
            var lineNumber: Int?
            var column: Int?
            if parts.count >= 3, let l = Int(parts[parts.count - 2]), let c = Int(parts[parts.count - 1]) {
                lineNumber = l
                column = c
                file = parts[0..<(parts.count - 2)].joined(separator: ":")
            } else if parts.count >= 2, let l = Int(parts[parts.count - 1]) {
                lineNumber = l
                file = parts[0..<(parts.count - 1)].joined(separator: ":")
            } else if !location.isEmpty {
                file = location
            }

            let diagnostic = BuildDiagnostic(severity: severity, file: file, line: lineNumber, column: column, message: message)
            if seen.insert(diagnostic.id).inserted { out.append(diagnostic) }
        }
        return out
    }

    /// `simctl launch` prints `com.example.App: 12345`.
    public static func parseLaunchPID(_ output: String) -> Int32? {
        for line in output.split(separator: "\n") {
            guard let colon = line.lastIndex(of: ":") else { continue }
            let tail = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if let pid = Int32(tail), pid > 0 { return pid }
        }
        return nil
    }

    /// `xcodebuild -version` → ("16.2", "23507a")
    public static func parseXcodeVersion(_ output: String) -> (version: String, build: String)? {
        var version: String?
        var build: String?
        for line in output.split(separator: "\n") {
            if line.hasPrefix("Xcode ") {
                version = String(line.dropFirst("Xcode ".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("Build version ") {
                build = String(line.dropFirst("Build version ".count)).trimmingCharacters(in: .whitespaces)
            }
        }
        guard let version else { return nil }
        return (version, build ?? "")
    }
}
