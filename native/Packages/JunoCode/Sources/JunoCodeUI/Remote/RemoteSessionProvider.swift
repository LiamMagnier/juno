import Foundation

/// The smallest request a remote task provider needs to start work.
///
/// Model, permission and tool configuration remain owned by the runtime that
/// executes the task. This seam intentionally does not invent a second copy of
/// those contracts or silently drop them into a remote request.
public struct RemoteSessionRequest: Equatable, Sendable {
    public let prompt: String

    public init(prompt: String) {
        self.prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var isValid: Bool { !prompt.isEmpty }
}

/// A remote computer offered by the authenticated task service.
///
/// The UI needs more than a name to make a safe dispatch decision: an online
/// computer that is not claiming queued work must not be presented as usable,
/// and a device with no registered workspace cannot receive a task. Keeping
/// those facts in the provider boundary avoids a second, optimistic copy in
/// the session sheet.
public struct RemoteDeviceTarget: Equatable, Hashable, Sendable, Identifiable {
    public let reference: RemoteDeviceReference
    public let online: Bool
    public let acceptsWork: Bool
    public let workspaces: [RemoteWorkspaceReference]

    public var id: String { reference.id }
    public var name: String { reference.name }
    public var canAcceptWork: Bool { online && acceptsWork }

    public init(
        reference: RemoteDeviceReference,
        online: Bool,
        acceptsWork: Bool,
        workspaces: [RemoteWorkspaceReference]
    ) {
        self.reference = reference
        self.online = online
        self.acceptsWork = acceptsWork
        self.workspaces = workspaces
    }
}

/// The handle returned by a real remote task endpoint.
///
/// Juno's current Cloud/Remote API calls these records tasks. The UI calls the
/// returned value a session because it is the thing the user follows, but the
/// task id is retained explicitly so no fake local `CodeSession` is created.
public struct RemoteSessionHandle: Equatable, Sendable, Identifiable {
    public let taskID: String
    public let location: CodeExecutionLocation
    public let status: String

    public var id: String { taskID }

    public init(taskID: String, location: CodeExecutionLocation, status: String) {
        self.taskID = taskID
        self.location = location
        self.status = status
    }
}

public enum RemoteExecutionUnavailableReason: Equatable, Sendable {
    case localExecutionManagedByWorkbench
    case cloudRepositoryRequired
    case cloudRepositoryNotFound(String)
    case githubConnectionRequired
    case githubAuthorizationRequired
    case remoteDeviceRequired
    case remoteDeviceNotFound(String)
    case remoteDeviceOffline(String)
    case remoteDeviceNotAcceptingWork(String)
    case remoteWorkspaceRequired
    case remoteWorkspaceNotFound(String)
    case backendUnavailable(String)
    case integrationNotComposed

    public var message: String {
        switch self {
        case .localExecutionManagedByWorkbench:
            "Local sessions are executed by the Workbench runtime."
        case .cloudRepositoryRequired:
            "Choose a repository before starting a Cloud run."
        case .cloudRepositoryNotFound(let repository):
            "The repository \(repository) is not available to this account."
        case .githubConnectionRequired:
            "Connect GitHub before starting a Cloud run."
        case .githubAuthorizationRequired:
            "Re-authorize GitHub before starting a Cloud run."
        case .remoteDeviceRequired:
            "Choose a remote computer before starting a Remote run."
        case .remoteDeviceNotFound(let device):
            "The remote computer \(device) is not available."
        case .remoteDeviceOffline(let device):
            "The remote computer \(device) is offline."
        case .remoteDeviceNotAcceptingWork(let device):
            "The remote computer \(device) is online but is not accepting queued work."
        case .remoteWorkspaceRequired:
            "Choose a workspace on the remote computer."
        case .remoteWorkspaceNotFound(let workspace):
            "The workspace \(workspace) is no longer registered on that computer."
        case .backendUnavailable(let message):
            message
        case .integrationNotComposed:
            "Cloud and Remote execution are not connected to this session composer yet."
        }
    }
}

public enum RemoteSessionProviderError: Error, Equatable, LocalizedError, Sendable {
    case invalidRequest
    case unavailable(RemoteExecutionUnavailableReason)
    case transport(String)
    case server(statusCode: Int, message: String)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Enter a prompt before starting a remote run."
        case .unavailable(let reason):
            reason.message
        case .transport(let message):
            message
        case .server(_, let message):
            message
        case .malformedResponse:
            "Juno returned an invalid remote task response."
        }
    }
}

/// An availability result is not a Boolean: a target can be usable, known to
/// be unavailable, or have failed to answer. Keeping those states typed lets a
/// future picker show the right action instead of offering a retry for a missing
/// GitHub connection or showing a disabled control for a transient outage.
public enum RemoteExecutionAvailability: Equatable, Sendable {
    case available
    case unavailable(RemoteExecutionUnavailableReason)
    case failed(RemoteSessionProviderError)
}

/// Injectable boundary for Cloud/Remote task creation.
///
/// The production adapter in this module calls the already-authenticated
/// `NativeCodeTaskClient`. Test and preview compositions can inject a scripted
/// implementation without pretending that a backend exists.
public protocol RemoteSessionProviding: Sendable {
    /// Lists the repositories a Cloud run can target. The list is intentionally
    /// a typed identity rather than a backend response dictionary.
    func repositories() async throws -> [RemoteRepositoryReference]

    /// Lists signed-in computers and their registered workspaces.
    func devices() async throws -> [RemoteDeviceTarget]

    func availability(
        for location: CodeExecutionLocation
    ) async -> RemoteExecutionAvailability

    func startSession(
        at location: CodeExecutionLocation,
        request: RemoteSessionRequest
    ) async throws -> RemoteSessionHandle
}

/// Explicit fallback for compositions that have not supplied an authenticated
/// provider. It is intentionally not a fake success provider.
public struct UnavailableRemoteSessionProvider: RemoteSessionProviding {
    public let reason: RemoteExecutionUnavailableReason

    public init(
        reason: RemoteExecutionUnavailableReason = .integrationNotComposed
    ) {
        self.reason = reason
    }

    public func repositories() async throws -> [RemoteRepositoryReference] {
        throw RemoteSessionProviderError.unavailable(reason)
    }

    public func devices() async throws -> [RemoteDeviceTarget] {
        throw RemoteSessionProviderError.unavailable(reason)
    }

    public func availability(
        for _: CodeExecutionLocation
    ) async -> RemoteExecutionAvailability {
        .unavailable(reason)
    }

    public func startSession(
        at _: CodeExecutionLocation,
        request _: RemoteSessionRequest
    ) async throws -> RemoteSessionHandle {
        throw RemoteSessionProviderError.unavailable(reason)
    }
}
