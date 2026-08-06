import JunoAuth
import JunoCodeKit
import JunoCore

/// Production adapter for the native Cloud/Remote task routes used by the
/// desktop and unified JunoMac Code composers.
///
/// This adapter does not fabricate a `CodeSession`, bypass approvals, or call a
/// new endpoint. It resolves the selected repository/device through the native
/// client, creates a durable Code conversation, then delegates task creation to
/// NativeCodeTaskClient.createCloudTask or createDeviceTask. The returned task
/// id is the only remote handle exposed by this seam.
public struct NativeCodeTaskRemoteSessionProvider: RemoteSessionProviding {
    private let client: NativeCodeTaskClient
    private let accountID: AccountID

    public init(client: NativeCodeTaskClient, accountID: AccountID) {
        self.client = client
        self.accountID = accountID
    }

    public func repositories() async throws -> [RemoteRepositoryReference] {
        try await client.repositories(for: accountID).map {
            RemoteRepositoryReference(
                owner: $0.owner,
                name: $0.name,
                defaultBranch: $0.defaultBranch
            )
        }
    }

    public func devices() async throws -> [RemoteDeviceTarget] {
        try await client.devices(for: accountID).map { device in
            RemoteDeviceTarget(
                reference: RemoteDeviceReference(id: device.id, name: device.name),
                online: device.online,
                acceptsWork: device.servesQueuedTasks,
                workspaces: device.workspaces.map {
                    RemoteWorkspaceReference(
                        key: $0.key,
                        name: $0.name,
                        path: $0.path
                    )
                }
            )
        }
    }

    public func availability(
        for location: CodeExecutionLocation
    ) async -> RemoteExecutionAvailability {
        guard location.missingConfigurationDescription == nil else {
            switch location.kind {
            case .local:
                return .unavailable(.localExecutionManagedByWorkbench)
            case .cloud:
                return .unavailable(.cloudRepositoryRequired)
            case .remote:
                return .unavailable(.remoteDeviceRequired)
            }
        }

        switch location.target {
        case .cloud(let repository, _):
            do {
                let repositories = try await client.repositories(for: accountID)
                guard repositories.contains(where: { matches(repository, $0) }) else {
                    return .unavailable(.cloudRepositoryNotFound(repository.id))
                }
                return .available
            } catch {
                return availability(for: error)
            }

        case .remote(let device, let workspace):
            do {
                let devices = try await client.devices(for: accountID)
                guard let nativeDevice = devices.first(where: { $0.id == device.id }) else {
                    return .unavailable(.remoteDeviceNotFound(device.name))
                }
                guard nativeDevice.online else {
                    return .unavailable(.remoteDeviceOffline(device.name))
                }
                guard nativeDevice.servesQueuedTasks else {
                    return .unavailable(.remoteDeviceNotAcceptingWork(device.name))
                }
                guard nativeDevice.workspaces.contains(where: { matches(workspace, $0) }) else {
                    return .unavailable(.remoteWorkspaceNotFound(workspace.name))
                }
                return .available
            } catch {
                return availability(for: error)
            }

        case .none:
            // A local selection is handled by WorkbenchModel. A Cloud or
            // Remote selection without a typed target must not be guessed.
            return .unavailable(.localExecutionManagedByWorkbench)
        }
    }

    public func startSession(
        at location: CodeExecutionLocation,
        request: RemoteSessionRequest
    ) async throws -> RemoteSessionHandle {
        guard request.isValid else { throw RemoteSessionProviderError.invalidRequest }
        guard location.isRemote else {
            throw RemoteSessionProviderError.unavailable(
                .localExecutionManagedByWorkbench
            )
        }
        guard location.missingConfigurationDescription == nil else {
            throw RemoteSessionProviderError.unavailable(
                unavailableReason(for: location)
            )
        }

        switch location.target {
        case .cloud(let repository, let baseRef):
            let repositories: [NativeCodeRepository]
            do {
                repositories = try await client.repositories(for: accountID)
            } catch {
                throw providerError(for: error)
            }
            guard let nativeRepository = repositories.first(where: { matches(repository, $0) })
            else {
                throw RemoteSessionProviderError.unavailable(
                    .cloudRepositoryNotFound(repository.id)
                )
            }
            do {
                let conversationID = try await client.createCodeConversation(
                    workspaceName: nativeRepository.name,
                    workspacePath: nil,
                    workspaceKey: nil,
                    for: accountID
                )
                let task = try await client.createCloudTask(
                    prompt: request.prompt,
                    repository: nativeRepository,
                    baseRef: baseRef,
                    for: accountID,
                    conversationID: conversationID
                )
                return RemoteSessionHandle(
                    taskID: task.id,
                    location: location,
                    status: task.status.rawValue
                )
            } catch {
                throw providerError(for: error)
            }

        case .remote(let device, let workspace):
            let devices: [NativeCodeDevice]
            do {
                devices = try await client.devices(for: accountID)
            } catch {
                throw providerError(for: error)
            }
            guard let nativeDevice = devices.first(where: { $0.id == device.id }) else {
                throw RemoteSessionProviderError.unavailable(
                    .remoteDeviceNotFound(device.name)
                )
            }
            guard nativeDevice.online else {
                throw RemoteSessionProviderError.unavailable(
                    .remoteDeviceOffline(device.name)
                )
            }
            guard nativeDevice.servesQueuedTasks else {
                throw RemoteSessionProviderError.unavailable(
                    .remoteDeviceNotAcceptingWork(device.name)
                )
            }
            guard let nativeWorkspace = nativeDevice.workspaces.first(
                where: { matches(workspace, $0) }
            ) else {
                throw RemoteSessionProviderError.unavailable(
                    .remoteWorkspaceNotFound(workspace.name)
                )
            }
            do {
                let conversationID = try await client.createCodeConversation(
                    workspaceName: nativeWorkspace.name,
                    workspacePath: nativeWorkspace.path,
                    workspaceKey: nativeWorkspace.key,
                    for: accountID
                )
                let task = try await client.createDeviceTask(
                    prompt: request.prompt,
                    device: nativeDevice,
                    workspace: nativeWorkspace,
                    for: accountID,
                    conversationID: conversationID
                )
                return RemoteSessionHandle(
                    taskID: task.id,
                    location: location,
                    status: task.status.rawValue
                )
            } catch {
                throw providerError(for: error)
            }

        case .none:
            throw RemoteSessionProviderError.unavailable(
                unavailableReason(for: location)
            )
        }
    }

    private func matches(
        _ reference: RemoteRepositoryReference,
        _ repository: NativeCodeRepository
    ) -> Bool {
        reference.owner == repository.owner && reference.name == repository.name
    }

    private func matches(
        _ reference: RemoteWorkspaceReference,
        _ workspace: NativeCodeDevice.Workspace
    ) -> Bool {
        if let key = reference.key, let nativeKey = workspace.key {
            return key == nativeKey
        }
        return reference.name == workspace.name && reference.path == workspace.path
    }

    private func unavailableReason(
        for location: CodeExecutionLocation
    ) -> RemoteExecutionUnavailableReason {
        switch location.kind {
        case .local: .localExecutionManagedByWorkbench
        case .cloud: .cloudRepositoryRequired
        case .remote: .remoteDeviceRequired
        }
    }

    private func availability(for error: any Error) -> RemoteExecutionAvailability {
        if let providerError = error as? RemoteSessionProviderError {
            switch providerError {
            case .unavailable(let reason): return .unavailable(reason)
            default: return .failed(providerError)
            }
        }
        if let nativeError = error as? NativeCodeError {
            switch nativeError {
            case .repositories(.notConnected):
                return .unavailable(.githubConnectionRequired)
            case .repositories(.unauthorized):
                return .unavailable(.githubAuthorizationRequired)
            case .cloudUnavailable(let message):
                return .unavailable(.backendUnavailable(message))
            default:
                return .failed(providerError(for: nativeError))
            }
        }
        return .failed(.transport(error.localizedDescription))
    }

    private func providerError(for error: any Error) -> RemoteSessionProviderError {
        if let providerError = error as? RemoteSessionProviderError {
            return providerError
        }
        if let nativeError = error as? NativeCodeError {
            switch nativeError {
            case .repositories(.notConnected):
                return .unavailable(.githubConnectionRequired)
            case .repositories(.unauthorized):
                return .unavailable(.githubAuthorizationRequired)
            case .cloudUnavailable(let message):
                return .unavailable(.backendUnavailable(message))
            case .followUpUnavailable:
                return .malformedResponse
            case .malformedResponse:
                return .malformedResponse
            case .server(let statusCode, let message):
                return .server(statusCode: statusCode, message: message)
            case .repositories(.unreachable):
                return .transport(nativeError.localizedDescription)
            }
        }
        return .transport(error.localizedDescription)
    }
}
