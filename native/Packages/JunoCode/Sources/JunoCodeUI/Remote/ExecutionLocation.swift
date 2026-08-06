import JunoCodeCore

/// A UI-facing execution target for a Code run.
///
/// `SessionLocation` is the durable, deliberately small value stored in a
/// local `AgentConfiguration`. This type is the richer value the remote
/// composer uses while a user is choosing a target: Cloud carries the selected
/// repository and Remote carries the selected device/workspace.
/// Keeping those details here prevents the UI from passing backend dictionaries
/// around, while leaving the existing persistence model untouched.
public struct CodeExecutionLocation: Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, CaseIterable, Codable, Hashable, Sendable, Identifiable {
        case local
        case cloud
        case remote

        public var id: String { rawValue }
    }

    public enum Target: Equatable, Hashable, Sendable {
        case cloud(repository: RemoteRepositoryReference, baseRef: String?)
        case remote(device: RemoteDeviceReference, workspace: RemoteWorkspaceReference)
    }

    public let kind: Kind
    public let target: Target?

    /// Creates an unconfigured location, suitable for a picker before the
    /// repository/device selection has been made.
    public init(kind: Kind) {
        self.kind = kind
        target = nil
    }

    private init(kind: Kind, target: Target) {
        self.kind = kind
        self.target = target
    }

    public static let local = Self(kind: .local)
    public static let cloud = Self(kind: .cloud)
    public static let remote = Self(kind: .remote)

    public static func cloud(
        repository: RemoteRepositoryReference,
        baseRef: String? = nil
    ) -> Self {
        Self(kind: .cloud, target: .cloud(repository: repository, baseRef: baseRef))
    }

    public static func remote(
        device: RemoteDeviceReference,
        workspace: RemoteWorkspaceReference
    ) -> Self {
        Self(kind: .remote, target: .remote(device: device, workspace: workspace))
    }

    public var id: String {
        switch target {
        case nil:
            kind.rawValue
        case .cloud(let repository, let baseRef):
            "cloud:\(repository.id):\(baseRef ?? repository.defaultBranch)"
        case .remote(let device, let workspace):
            "remote:\(device.id):\(workspace.id)"
        }
    }

    public var displayName: String {
        switch kind {
        case .local: "On this Mac"
        case .cloud: "Juno Cloud"
        case .remote: "Remote computer"
        }
    }

    /// The durable location value used by the existing local session store.
    public var sessionLocation: SessionLocation {
        switch kind {
        case .local: .local
        case .cloud: .cloud
        case .remote: .remote
        }
    }

    public var isRemote: Bool { kind != .local }

    /// A selection can be represented before its repository/device has been
    /// chosen. Providers must reject that state instead of guessing a target.
    public var missingConfigurationDescription: String? {
        switch (kind, target) {
        case (.local, _): nil
        case (.cloud, nil): "Choose a repository before starting a Cloud run."
        case (.remote, nil): "Choose a computer and workspace before starting a Remote run."
        case (.cloud, .some(.cloud(let repository, _))) where !repository.isValid:
            "The selected repository is incomplete."
        case (.cloud, .some(.cloud)):
            nil
        case (.remote, .some(.remote(let device, let workspace)))
            where !device.isValid || !workspace.isValid:
            "The selected computer or workspace is incomplete."
        case (.remote, .some(.remote)):
            nil
        case (.cloud, .some(.remote)), (.remote, .some(.cloud)):
            "The selected target does not match the execution location."
        }
    }
}

/// A repository identity safe to pass across the UI/provider boundary.
public struct RemoteRepositoryReference: Equatable, Hashable, Sendable {
    public let owner: String
    public let name: String
    public let defaultBranch: String

    public init(owner: String, name: String, defaultBranch: String = "main") {
        self.owner = owner
        self.name = name
        self.defaultBranch = defaultBranch
    }

    public var id: String { owner + "/" + name }
    public var isValid: Bool {
        !owner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !defaultBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// A device identity returned by the existing Juno Code device endpoint.
public struct RemoteDeviceReference: Equatable, Hashable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    public var isValid: Bool {
        !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// A workspace registered by a Remote device.
///
/// The path is required by the existing native task endpoint. It is never used
/// for a display identifier and should not be written to a transcript by a
/// caller; the backend already treats it as a device registration detail.
public struct RemoteWorkspaceReference: Equatable, Hashable, Sendable {
    public let key: String?
    public let name: String
    public let path: String

    public init(key: String? = nil, name: String, path: String) {
        self.key = key
        self.name = name
        self.path = path
    }

    public var id: String { key ?? name }
    public var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
