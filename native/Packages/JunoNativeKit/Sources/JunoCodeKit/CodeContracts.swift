import Foundation
import JunoCore

public enum CodeExecutionLocation: String, Codable, CaseIterable, Sendable {
    case local
    case cloud
    case remote
}

public enum CodeInteractionMode: String, Codable, CaseIterable, Sendable {
    case ask
    case plan
    case code
}

public enum CodePermissionMode: String, Codable, CaseIterable, Sendable {
    case readOnly
    case acceptEdits
    case fullAccess
}

public enum WorkspaceRelativePathError: Error, Equatable, Sendable {
    case empty
    case absolute
    case traversal
    case invalidComponent
    case tooLong
}

/// A display-safe workspace-relative path, never an authorization capability.
public struct WorkspaceRelativePath: Hashable, Codable, Sendable, CustomStringConvertible {
    public let value: String

    public init(_ value: String) throws {
        guard !value.isEmpty else { throw WorkspaceRelativePathError.empty }
        guard value.utf8.count <= 4_096 else { throw WorkspaceRelativePathError.tooLong }
        guard !value.hasPrefix("/"), !value.hasPrefix("~"), !value.contains("\\") else {
            throw WorkspaceRelativePathError.absolute
        }
        let components = value.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains(where: { $0 == ".." }) else {
            throw WorkspaceRelativePathError.traversal
        }
        guard !components.contains(where: { component in
            component.isEmpty || component == "." || component.unicodeScalars.contains {
                CharacterSet.controlCharacters.contains($0)
            }
        }) else {
            throw WorkspaceRelativePathError.invalidComponent
        }
        self.value = value
    }

    public var description: String { value }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        do {
            try self.init(value)
        } catch {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsafe workspace-relative path"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

public enum CodeTaskConfigurationError: Error, Equatable, Sendable {
    case invalidField(BoundedValueError)
}

public struct CodeTaskConfiguration: Equatable, Sendable {
    public let repositoryID: String
    public let baseBranch: String
    public let prompt: String
    public let location: CodeExecutionLocation
    public let mode: CodeInteractionMode
    public let permission: CodePermissionMode
    public let modelID: String
    public let reasoningEffort: String

    public init(
        repositoryID: String,
        baseBranch: String,
        prompt: String,
        location: CodeExecutionLocation,
        mode: CodeInteractionMode,
        permission: CodePermissionMode,
        modelID: String,
        reasoningEffort: String
    ) throws {
        do {
            try BoundedValue.validateText(repositoryID, field: "repositoryID", maximumUTF8Bytes: 256)
            try BoundedValue.validateText(baseBranch, field: "baseBranch", maximumUTF8Bytes: 256)
            try BoundedValue.validateText(
                prompt,
                field: "prompt",
                maximumUTF8Bytes: 1_024 * 1_024,
                allowsNewlines: true
            )
            try BoundedValue.validateText(modelID, field: "modelID", maximumUTF8Bytes: 256)
            try BoundedValue.validateText(reasoningEffort, field: "reasoningEffort", maximumUTF8Bytes: 64)
        } catch let error as BoundedValueError {
            throw CodeTaskConfigurationError.invalidField(error)
        }
        self.repositoryID = repositoryID
        self.baseBranch = baseBranch
        self.prompt = prompt
        self.location = location
        self.mode = mode
        self.permission = permission
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
    }
}

public enum ActionDigestError: Error, Equatable, Sendable {
    case invalid
}

/// SHA-256 digest binding approval to the exact proposed action.
public struct ActionDigest: Hashable, Codable, Sendable {
    public let value: String

    public init(_ value: String) throws {
        guard value.utf8.count == 64,
              value.unicodeScalars.allSatisfy({ scalar in
                  (48...57).contains(scalar.value) || (97...102).contains(scalar.value)
              })
        else {
            throw ActionDigestError.invalid
        }
        self.value = value
    }
}

public struct CodeApprovalRequest: Equatable, Sendable {
    public let id: String
    public let actionDigest: ActionDigest
    public let summary: String
    public let expiresAt: Date

    public init(id: String, actionDigest: ActionDigest, summary: String, expiresAt: Date) {
        self.id = id
        self.actionDigest = actionDigest
        self.summary = summary
        self.expiresAt = expiresAt
    }

    public func authorizes(_ digest: ActionDigest, at date: Date) -> Bool {
        digest == actionDigest && date < expiresAt
    }
}
