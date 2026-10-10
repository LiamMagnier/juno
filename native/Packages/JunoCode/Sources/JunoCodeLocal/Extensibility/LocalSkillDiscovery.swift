import Foundation
import JunoCodeCore

/// The skills installed on this Mac, for Alevr Code's Skills selector and
/// `/name` commands (skills lane, `skills.list`). The Swift twin of the env
/// server's `runner/env-server/src/skills/discovery.ts`: same folders, same
/// front matter, same precedence, so a thread on the in-process engine and one
/// on the env server offer the same list.
///
///     project  <cwd>/.alevr/skills, <cwd>/.juno/skills, <cwd>/.claude/skills
///     user     ~/.alevr/skills, ~/.juno/skills, ~/.claude/skills, ~/.codex/skills
///     plugin   each enabled Claude Code plugin's skills (installed_plugins.json)
///
/// A same-named skill resolves to the nearest one: project over user over
/// plugin. Listing reads only the head of each SKILL.md; the body is read when
/// a turn runs under the skill (`instructions(for:)`), here on the Mac.
public struct LocalSkillDiscovery: Sendable {
    public struct Root: Equatable, Sendable {
        public let directory: URL
        public let source: CodeV2.SkillSource
        public let origin: CodeV2.SkillOrigin
        public let plugin: String?

        public init(directory: URL, source: CodeV2.SkillSource, origin: CodeV2.SkillOrigin, plugin: String? = nil) {
            self.directory = directory
            self.source = source
            self.origin = origin
            self.plugin = plugin
        }
    }

    /// Front matter is read from the head of the file; a larger SKILL.md is not a skill.
    public static let maximumBytes = 256 * 1_024
    static let headBytes = 16 * 1_024
    public static let descriptionLimit = 500

    public let home: URL
    public let projectRoot: URL?

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser, projectRoot: URL? = nil) {
        self.home = home
        self.projectRoot = projectRoot
    }

    // MARK: Front matter

    public struct Parsed: Equatable, Sendable {
        public var name: String?
        public var description: String?
        public var body: String
    }

    /// Splits a SKILL.md into its front matter's `name` and `description` and
    /// its body: `key: value`, quoted values and `>` / `|` block scalars.
    /// Without front matter the first line of prose is the description.
    public static func parse(_ text: String) -> Parsed {
        var normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        if normalized.hasPrefix("\u{FEFF}") { normalized.removeFirst() }
        let lines = normalized.components(separatedBy: "\n")
        var fields: [String: String] = [:]
        var body = normalized
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
           let close = lines.indices.dropFirst().first(where: { lines[$0].trimmingCharacters(in: .whitespaces) == "---" }) {
            var i = 1
            while i < close {
                let line = lines[i]
                guard let colon = line.firstIndex(of: ":"),
                      let first = line.first, first.isLetter || first == "_"
                else { i += 1; continue }
                let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                var value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                let isIndented: (String) -> Bool = { $0.first == " " || $0.first == "\t" }
                if value.hasPrefix(">") || value.hasPrefix("|"), value.count <= 2 {
                    var parts: [String] = []
                    while i + 1 < close, isIndented(lines[i + 1]) || lines[i + 1].trimmingCharacters(in: .whitespaces).isEmpty {
                        i += 1
                        parts.append(lines[i].trimmingCharacters(in: .whitespaces))
                    }
                    value = value.hasPrefix("|")
                        ? parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                        : parts.filter { !$0.isEmpty }.joined(separator: " ")
                } else {
                    value = unquote(value)
                    while i + 1 < close, isIndented(lines[i + 1]), !lines[i + 1].contains(":") {
                        i += 1
                        value += " " + lines[i].trimmingCharacters(in: .whitespaces)
                    }
                }
                if fields[key] == nil { fields[key] = value }
                i += 1
            }
            body = lines[(close + 1)...].joined(separator: "\n")
        }
        body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        var description = fields["description"]?.trimmingCharacters(in: .whitespaces)
        if description?.isEmpty ?? true {
            description = body.components(separatedBy: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .first { !$0.isEmpty && !$0.hasPrefix("#") && !$0.hasPrefix("---") }
        }
        let collapsed = description.map {
            String($0.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(descriptionLimit))
        }
        let name = fields["name"]?.trimmingCharacters(in: .whitespaces)
        return Parsed(name: (name?.isEmpty ?? true) ? nil : name, description: collapsed, body: body)
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2, let first = value.first, first == "\"" || first == "'", value.last == first else { return value }
        let inner = String(value.dropFirst().dropLast())
        return first == "\"" ? inner.replacingOccurrences(of: "\\\"", with: "\"") : inner.replacingOccurrences(of: "''", with: "'")
    }

    /// The `/name` a skill answers to: its front matter's name, else its folder's.
    public static func skillName(_ parsed: Parsed, folder: String) -> String? {
        for candidate in [parsed.name, folder] {
            guard let candidate else { continue }
            let name = candidate.trimmingCharacters(in: .whitespaces).lowercased()
                .split(whereSeparator: { $0.isWhitespace }).joined(separator: "-")
            if isValidName(name) { return name }
        }
        return nil
    }

    static func isValidName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, name.utf8.count <= 128 else { return false }
        let lower = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789")
        guard lower.contains(first) else { return false }
        return name.unicodeScalars.allSatisfy { lower.contains($0) || $0 == "-" || $0 == "_" || $0 == "." }
    }

    // MARK: Folders

    /// Every folder skills are read from, nearest first.
    public func roots() -> [Root] {
        var roots: [Root] = []
        if let projectRoot, projectRoot.standardizedFileURL.path != home.standardizedFileURL.path {
            roots += [
                Root(directory: projectRoot.appendingPathComponent(".alevr/skills", isDirectory: true), source: .project, origin: .alevr),
                Root(directory: projectRoot.appendingPathComponent(".juno/skills", isDirectory: true), source: .project, origin: .juno),
                Root(directory: projectRoot.appendingPathComponent(".claude/skills", isDirectory: true), source: .project, origin: .claude),
            ]
        }
        roots += [
            Root(directory: home.appendingPathComponent(".alevr/skills", isDirectory: true), source: .user, origin: .alevr),
            Root(directory: home.appendingPathComponent(".juno/skills", isDirectory: true), source: .user, origin: .juno),
            Root(directory: home.appendingPathComponent(".claude/skills", isDirectory: true), source: .user, origin: .claude),
            Root(directory: home.appendingPathComponent(".codex/skills", isDirectory: true), source: .user, origin: .codex),
        ]
        roots += pluginRoots()
        return roots
    }

    /// Each enabled Claude Code plugin's skills folders, from its own records.
    public func pluginRoots() -> [Root] {
        let plugins = home.appendingPathComponent(".claude/plugins", isDirectory: true)
        guard let data = try? Data(contentsOf: plugins.appendingPathComponent("installed_plugins.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let installed = object["plugins"] as? [String: Any]
        else { return [] }
        var enabled: [String: Bool] = [:]
        if let settings = try? Data(contentsOf: home.appendingPathComponent(".claude/settings.json")),
           let parsed = try? JSONSerialization.jsonObject(with: settings) as? [String: Any],
           let map = parsed["enabledPlugins"] as? [String: Bool] {
            enabled = map
        }
        var roots: [Root] = []
        for key in installed.keys.sorted() {
            if enabled[key] == false { continue }
            let entries: [[String: Any]] = (installed[key] as? [[String: Any]]) ?? ((installed[key] as? [String: Any]).map { [$0] } ?? [])
            let newest = entries.max { ($0["lastUpdated"] as? String ?? "") < ($1["lastUpdated"] as? String ?? "") }
            guard let path = newest?["installPath"] as? String, path.hasPrefix("/") else { continue }
            let install = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
            let plugin = key.split(separator: "@").first.map(String.init) ?? key
            var dirs = [install.appendingPathComponent("skills", isDirectory: true)]
            if let manifest = try? Data(contentsOf: install.appendingPathComponent(".claude-plugin/plugin.json")),
               let parsed = try? JSONSerialization.jsonObject(with: manifest) as? [String: Any] {
                let declared = (parsed["skills"] as? [String]) ?? ((parsed["skills"] as? String).map { [$0] } ?? [])
                for relative in declared {
                    let dir = URL(fileURLWithPath: relative, relativeTo: install).standardizedFileURL
                    // A manifest names folders inside its own plugin, nothing else.
                    if dir.path.hasPrefix(install.path + "/"), !dirs.contains(dir) { dirs.append(dir) }
                }
            }
            roots += dirs.map { Root(directory: $0, source: .plugin, origin: .claude, plugin: plugin) }
        }
        return roots
    }

    // MARK: Discovery

    /// Every skill, shadowed ones included, nearest first.
    public func discoverAll() -> [CodeV2.LocalSkillSummary] {
        roots().flatMap(Self.read)
    }

    /// One skill per name, the nearest winning.
    public func discover() -> [CodeV2.LocalSkillSummary] {
        Self.dedupe(discoverAll())
    }

    public static func dedupe(_ skills: [CodeV2.LocalSkillSummary]) -> [CodeV2.LocalSkillSummary] {
        var seen = Set<String>()
        return skills.filter { seen.insert($0.name).inserted }
    }

    static func read(_ root: Root) -> [CodeV2.LocalSkillSummary] {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: root.directory, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        ) else { return [] }
        return entries.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { entry in
            // Symlinked skill folders are the reader's own (dotfiles linked in).
            guard (try? entry.resolvingSymlinksInPath().resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return nil }
            let file = entry.appendingPathComponent("SKILL.md")
            guard let head = readHead(file) else { return nil }
            let parsed = parse(head)
            guard let name = skillName(parsed, folder: entry.lastPathComponent) else { return nil }
            return CodeV2.LocalSkillSummary(
                name: name, description: parsed.description ?? "", source: root.source,
                origin: root.origin, path: file.path, plugin: root.plugin
            )
        }
    }

    static func readHead(_ file: URL) -> String? {
        guard let values = try? file.resolvingSymlinksInPath().resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, (values.fileSize ?? 0) <= maximumBytes,
              let handle = try? FileHandle(forReadingFrom: file)
        else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: headBytes) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: Activation

    /// A skill a turn runs under, its instructions read.
    public struct Resolved: Equatable, Sendable {
        public let name: String
        public let source: CodeV2.SkillSource
        public let path: String?
        public let instructions: String
        public let once: Bool
    }

    /// The instructions of the skills a turn runs under. A local skill is
    /// resolved by NAME among the skills found here; a client's `path` only
    /// picks a shadowed copy that was also found, never opens a file as given.
    public func resolve(_ activations: [CodeV2.SkillActivation]) -> (skills: [Resolved], missing: [String]) {
        let discovered = activations.contains { $0.source != .account } ? discoverAll() : []
        var skills: [Resolved] = []
        var missing: [String] = []
        var seen = Set<String>()
        for activation in activations {
            let name = activation.name.trimmingCharacters(in: .whitespaces).lowercased()
            guard !name.isEmpty, seen.insert("\(activation.source.rawValue):\(name)").inserted else { continue }
            let once = activation.once == true
            if activation.source == .account {
                let text = (activation.instructions ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { missing.append(name) } else {
                    skills.append(Resolved(name: name, source: .account, path: nil, instructions: String(text.prefix(Self.maximumBytes)), once: once))
                }
                continue
            }
            let named = discovered.filter { $0.name == name }
            let match = named.first { $0.path == activation.path } ?? named.first
            guard let match, let body = Self.instructions(at: match.path) else { missing.append(name); continue }
            skills.append(Resolved(name: name, source: match.source, path: match.path, instructions: body, once: once))
        }
        return (skills, missing)
    }

    /// A discovered skill's body, front matter removed.
    public static func instructions(at path: String) -> String? {
        let url = URL(fileURLWithPath: path)
        guard let values = try? url.resolvingSymlinksInPath().resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, (values.fileSize ?? 0) <= maximumBytes,
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        let body = parse(text).body
        return body.isEmpty ? nil : body
    }

    /// The block a turn's instructions carry: one `<skill>` per skill, with
    /// the folder its files live in. Byte-for-byte the env server's wording.
    public static func render(_ skills: [Resolved]) -> String {
        guard !skills.isEmpty else { return "" }
        let blocks = skills.map { skill -> String in
            var attrs = "name=\"\(skill.name)\""
            var lead = ""
            if let path = skill.path {
                let folder = (path as NSString).deletingLastPathComponent
                attrs += " folder=\"\(folder)\""
                lead = "Files this skill mentions are relative to \(folder); read them from there when it tells you to.\n\n"
            }
            return "<skill \(attrs)>\n\(lead)\(skill.instructions)\n</skill>"
        }
        let names = skills.map(\.name).joined(separator: ", ")
        return ([
            "The user turned on \(skills.count == 1 ? "a skill" : "skills") for this work: \(names).",
            "Follow the instructions in each <skill> block below for this request; they take precedence over your general habits where they conflict, but not over the user's own words.",
        ] + blocks).joined(separator: "\n\n")
    }
}

/// The Mac's skills, cached per project and dropped whenever a skills folder
/// (or Claude Code's plugin records) changes on disk.
public final class LocalSkillCatalog: @unchecked Sendable {
    private let home: URL
    private let lock = NSLock()
    private var cache: [String: [CodeV2.LocalSkillSummary]] = [:]
    private var sources: [String: DispatchSourceFileSystemObject] = [:]
    private var listeners: [UUID: @Sendable () -> Void] = [:]
    private let queue = DispatchQueue(label: "alevr.code.skills.watch")

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home
    }

    deinit {
        for source in sources.values { source.cancel() }
    }

    /// Called on a background queue whenever a watched folder changes.
    @discardableResult
    public func onChange(_ listener: @escaping @Sendable () -> Void) -> UUID {
        let id = UUID()
        lock.withLock { listeners[id] = listener }
        return id
    }

    public func removeListener(_ id: UUID) {
        _ = lock.withLock { listeners.removeValue(forKey: id) }
    }

    /// The `skills.list` answer for a project folder (or none).
    public func list(projectRoot: URL?) -> [CodeV2.LocalSkillSummary] {
        let key = projectRoot?.standardizedFileURL.path ?? ""
        if let hit = lock.withLock({ cache[key] }) { return hit }
        let discovery = LocalSkillDiscovery(home: home, projectRoot: projectRoot)
        let roots = discovery.roots()
        watch(roots.map(\.directory) + [home.appendingPathComponent(".claude/plugins", isDirectory: true)])
        let skills = discovery.discover()
        lock.withLock { cache[key] = skills }
        return skills
    }

    public func invalidate() {
        let callbacks = lock.withLock { () -> [@Sendable () -> Void] in
            cache.removeAll()
            return Array(listeners.values)
        }
        callbacks.forEach { $0() }
    }

    private func watch(_ directories: [URL]) {
        for directory in directories {
            // A folder that does not exist yet is watched through its parent.
            var target = directory
            if !FileManager.default.fileExists(atPath: target.path) { target = directory.deletingLastPathComponent() }
            let path = target.standardizedFileURL.path
            guard lock.withLock({ sources[path] == nil }), FileManager.default.fileExists(atPath: path) else { continue }
            let fd = open(path, O_EVTONLY)
            guard fd >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd, eventMask: [.write, .rename, .delete, .link], queue: queue
            )
            source.setEventHandler { [weak self] in self?.invalidate() }
            source.setCancelHandler { close(fd) }
            lock.withLock { sources[path] = source }
            source.resume()
        }
    }
}
