import Foundation
import JunoCodeCore

/// A skill is an instruction document, not an executable plugin. This local
/// foundation discovers the portable `.claude/skills/<name>/SKILL.md` and
/// `.juno/skills/<name>/SKILL.md` layouts and only returns the document after a
/// caller explicitly activates its ID. Scripts, hooks, and assets are not
/// implicitly loaded or run.
public struct SkillDefinition: Identifiable, Equatable, Codable, Sendable {
    /// Derived from where the skill lives, not what it says: an edited skill
    /// is the same skill, so switching it off in Settings keeps it off. (It
    /// used to hash the instructions too, and an edit re-enabled a skill the
    /// reader had disabled.) Whether the edit is *trusted* is a separate
    /// question, answered by ``contentDigest``.
    public let id: String
    public let name: String
    /// When to use it, from the `description:` line of the file's front
    /// matter, or its first line of prose.
    public let description: String?
    /// The instructions, front matter removed.
    public let instructions: String
    public let source: ExtensibilitySource
    public let path: String
    public let trust: ExtensibilityTrust
    /// SHA-256 of the whole file as read. The reader's trust is bound to it,
    /// so a skill edited after it was trusted waits to be trusted again.
    public let contentDigest: String

    public init(
        id: String? = nil,
        name: String,
        description: String? = nil,
        instructions: String,
        source: ExtensibilitySource,
        path: String,
        trust: ExtensibilityTrust = .untrustedWorkspace,
        contentDigest: String? = nil
    ) {
        self.name = name.lowercased()
        self.description = description
        self.instructions = instructions
        self.source = source
        self.path = path
        self.trust = trust
        self.id = id ?? Self.identifier(source: source, path: path)
        self.contentDigest = contentDigest ?? Digests.sha256Hex(instructions)
    }

    /// The path-based identifier every surface agrees on.
    public static func identifier(source: ExtensibilitySource, path: String) -> String {
        "skill-" + Digests.sha256Hex([source.rawValue, path].joined(separator: "\u{1f}"))
    }

    /// The id earlier builds gave this skill, from its content, which the
    /// reader's saved switches may still name.
    public var legacyContentID: String {
        "skill-" + Digests.sha256Hex([source.rawValue, path, instructions].joined(separator: "\u{1f}"))
    }

    public var isUntrusted: Bool {
        trust == .untrustedWorkspace
    }
}

public struct SkillDiagnostic: Equatable, Codable, Sendable {
    public let path: String
    public let message: String

    public init(path: String, message: String) {
        self.path = path
        self.message = message
    }
}

public struct SkillDiscoveryResult: Equatable, Sendable {
    public let skills: [SkillDefinition]
    public let diagnostics: [SkillDiagnostic]

    public init(
        skills: [SkillDefinition] = [],
        diagnostics: [SkillDiagnostic] = []
    ) {
        self.skills = skills
        self.diagnostics = diagnostics
    }
}

/// Workspace-bounded discovery for instruction-only skills.
public struct SkillDiscovery: Sendable {
    private let access: any WorkspaceAccessing

    public init(access: any WorkspaceAccessing) {
        self.access = access
    }

    public func discover() -> SkillDiscoveryResult {
        var byName: [String: SkillDefinition] = [:]
        var diagnostics: [SkillDiagnostic] = []

        // Keep the same precedence as SlashCommands: .juno can override a
        // same-named Claude skill while a repository migrates conventions.
        for source in [ExtensibilitySource.claude, .juno] {
            let directory = source.skillsDirectory
            guard let directoryPath = try? WorkspacePath(directory),
                  let directoryURL = try? access.resolveForReading(directoryPath),
                  let entries = try? FileManager.default.contentsOfDirectory(
                      at: directoryURL,
                      includingPropertiesForKeys: [.isDirectoryKey]
                  )
            else { continue }

            for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
                else { continue }
                guard SkillDiscovery.isSafeSkillName(entry.lastPathComponent) else {
                    diagnostics.append(
                        SkillDiagnostic(
                            path: directory,
                            message: "A skill with an invalid directory name was ignored."
                        )
                    )
                    continue
                }

                let name = entry.lastPathComponent
                let relative = directory + "/" + name + "/SKILL.md"
                guard let skillPath = try? WorkspacePath(relative),
                      let skillURL = try? access.resolveForReading(skillPath),
                      FileManager.default.fileExists(atPath: skillURL.path)
                else { continue }

                do {
                    let contents = try Self.readBoundedText(from: skillURL)
                    let parsed = Self.parse(contents)
                    let instructions = parsed.body
                    guard !instructions.isEmpty else {
                        diagnostics.append(
                            SkillDiagnostic(
                                path: relative,
                                message: "An empty SKILL.md was ignored."
                            )
                        )
                        continue
                    }
                    let skill = SkillDefinition(
                        name: name,
                        description: parsed.description,
                        instructions: instructions,
                        source: source,
                        path: relative,
                        contentDigest: Digests.sha256Hex(contents)
                    )
                    byName[skill.name] = skill
                } catch {
                    diagnostics.append(
                        SkillDiagnostic(
                            path: relative,
                            message: "The skill instructions could not be read or exceed Juno's size limit."
                        )
                    )
                }
            }
        }

        let skills = byName.values.sorted { $0.name < $1.name }
        return SkillDiscoveryResult(skills: skills, diagnostics: diagnostics)
    }

    /// Splits a SKILL.md into its front matter's description and its body.
    ///
    /// Only the `description:` line is read, as `key: value` with optional
    /// quotes — the portable format's one field Juno needs. Without front
    /// matter the first line of prose stands in.
    static func parse(_ text: String) -> (description: String?, body: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var description: String?
        var body = trimmed
        if trimmed.hasPrefix("---") {
            let lines = trimmed.components(separatedBy: "\n")
            if let close = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
                for line in lines[1..<close] {
                    let parts = line.split(separator: ":", maxSplits: 1).map {
                        $0.trimmingCharacters(in: .whitespaces)
                    }
                    guard parts.count == 2, parts[0].lowercased() == "description" else { continue }
                    var value = parts[1]
                    if value.count >= 2, let first = value.first, first == "\"" || first == "'", value.last == first {
                        value = String(value.dropFirst().dropLast())
                    }
                    description = value.isEmpty ? nil : value
                }
                body = lines[(close + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if description == nil {
            description = body.components(separatedBy: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .first { !$0.isEmpty && !$0.hasPrefix("#") }
        }
        return (description.map { String($0.prefix(300)) }, body)
    }

    private static func isSafeSkillName(_ name: String) -> Bool {
        guard !name.isEmpty, name.utf8.count <= 128 else { return false }
        return name.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar)
                || scalar == "-"
                || scalar == "_"
                || scalar == "."
        }
    }

    private static func readBoundedText(from url: URL) throws -> String {
        if let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
           let size = values.fileSize,
           size > HookExecutionLimits.maximumSkillBytes
        {
            throw SkillReadError.tooLarge
        }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard data.count <= HookExecutionLimits.maximumSkillBytes else {
            throw SkillReadError.tooLarge
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw SkillReadError.notUTF8
        }
        return text
    }
}

private enum SkillReadError: Error {
    case tooLarge
    case notUTF8
}

public struct ActivatedSkill: Equatable, Sendable {
    public let definition: SkillDefinition
    public let instructions: String

    public init(definition: SkillDefinition) {
        self.definition = definition
        self.instructions = definition.instructions
    }
}

public enum SkillActivationDecision: Equatable, Sendable {
    case activated(ActivatedSkill)
    case denied(reason: String)
}

/// Explicit activation policy for skills. It is separate from hook policy so
/// merely opening a skill menu cannot authorize any executable repository
/// content.
public struct SkillActivationPolicy: Equatable, Codable, Sendable {
    public static let denyAll = SkillActivationPolicy()

    public let allowedSkillIDs: Set<String>
    public let allowUntrustedSkills: Bool

    public init(
        allowedSkillIDs: Set<String> = [],
        allowUntrustedSkills: Bool = false
    ) {
        self.allowedSkillIDs = allowedSkillIDs
        self.allowUntrustedSkills = allowUntrustedSkills
    }

    public func activate(_ skill: SkillDefinition) -> SkillActivationDecision {
        guard allowedSkillIDs.contains(skill.id) else {
            return .denied(reason: "The skill is not explicitly allowlisted.")
        }
        guard !skill.isUntrusted || allowUntrustedSkills else {
            return .denied(reason: "The skill comes from untrusted workspace configuration.")
        }
        return .activated(ActivatedSkill(definition: skill))
    }
}
