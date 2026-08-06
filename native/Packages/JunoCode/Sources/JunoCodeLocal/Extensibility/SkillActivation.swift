import Foundation
import JunoCodeCore

/// A skill is an instruction document, not an executable plugin. This local
/// foundation discovers the portable `.claude/skills/<name>/SKILL.md` and
/// `.juno/skills/<name>/SKILL.md` layouts and only returns the document after a
/// caller explicitly activates its ID. Scripts, hooks, and assets are not
/// implicitly loaded or run.
public struct SkillDefinition: Identifiable, Equatable, Codable, Sendable {
    public let id: String
    public let name: String
    public let instructions: String
    public let source: ExtensibilitySource
    public let path: String
    public let trust: ExtensibilityTrust

    public init(
        id: String? = nil,
        name: String,
        instructions: String,
        source: ExtensibilitySource,
        path: String,
        trust: ExtensibilityTrust = .untrustedWorkspace
    ) {
        self.name = name.lowercased()
        self.instructions = instructions
        self.source = source
        self.path = path
        self.trust = trust
        self.id = id ?? "skill-" + Digests.sha256Hex(
            [source.rawValue, path, instructions].joined(separator: "\u{1f}")
        )
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
                    let instructions = contents.trimmingCharacters(in: .whitespacesAndNewlines)
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
                        instructions: instructions,
                        source: source,
                        path: relative
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
