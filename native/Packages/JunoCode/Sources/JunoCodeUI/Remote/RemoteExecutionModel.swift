import Observation

/// UI state for Cloud/Remote target discovery and task creation.
///
/// This model is deliberately independent of `NewSessionSheet` and
/// `WorkbenchModel`: the sheet uses it to discover typed targets and submit a
/// server-owned task, while the native task list remains responsible for live
/// remote history and event streaming.
public enum RemoteExecutionState: Equatable, Sendable {
    case idle
    case checking(CodeExecutionLocation)
    case available(CodeExecutionLocation)
    case unavailable(CodeExecutionLocation, RemoteExecutionUnavailableReason)
    case starting(CodeExecutionLocation)
    case started(RemoteSessionHandle)
    case failed(CodeExecutionLocation, RemoteSessionProviderError)
}

@MainActor
@Observable
public final class RemoteExecutionModel {
    public private(set) var state: RemoteExecutionState = .idle

    private let provider: any RemoteSessionProviding
    private var operationRevision = 0

    public init(provider: any RemoteSessionProviding) {
        self.provider = provider
    }

    /// Loads the current Cloud repository choices for a session composer.
    ///
    /// This is deliberately a one-shot result rather than cached global state:
    /// GitHub authorization can change while the sheet is open, and a fresh
    /// request lets the UI distinguish an empty account from a stale list.
    public func loadRepositories() async -> Result<
        [RemoteRepositoryReference], RemoteSessionProviderError
    > {
        do {
            return .success(try await provider.repositories())
        } catch {
            return .failure(providerError(for: error))
        }
    }

    /// Loads the current remote computers and their registered workspaces.
    public func loadDevices() async -> Result<
        [RemoteDeviceTarget], RemoteSessionProviderError
    > {
        do {
            return .success(try await provider.devices())
        } catch {
            return .failure(providerError(for: error))
        }
    }

    /// Reads backend/device capability without attempting to start anything.
    public func refreshAvailability(for location: CodeExecutionLocation) async {
        let revision = beginOperation(with: .checking(location))
        guard location.isRemote else {
            state = .unavailable(location, .localExecutionManagedByWorkbench)
            return
        }

        let availability = await provider.availability(for: location)
        guard revision == operationRevision else { return }
        switch availability {
        case .available:
            state = .available(location)
        case .unavailable(let reason):
            state = .unavailable(location, reason)
        case .failed(let error):
            state = .failed(location, error)
        }
    }

    /// Starts a real provider task. The result is a remote task handle, not a
    /// local `CodeSession`; the caller must decide how/where to display it.
    @discardableResult
    public func start(
        prompt: String,
        at location: CodeExecutionLocation
    ) async -> RemoteSessionHandle? {
        let revision = beginOperation(with: .starting(location))
        guard location.isRemote else {
            state = .unavailable(location, .localExecutionManagedByWorkbench)
            return nil
        }
        let request = RemoteSessionRequest(prompt: prompt)
        guard request.isValid else {
            let error = RemoteSessionProviderError.invalidRequest
            state = .failed(location, error)
            return nil
        }

        do {
            let handle = try await provider.startSession(at: location, request: request)
            guard revision == operationRevision else { return nil }
            state = .started(handle)
            return handle
        } catch let error as RemoteSessionProviderError {
            guard revision == operationRevision else { return nil }
            state = .failed(location, error)
            return nil
        } catch {
            guard revision == operationRevision else { return nil }
            let providerError = RemoteSessionProviderError.transport(error.localizedDescription)
            state = .failed(location, providerError)
            return nil
        }
    }

    public func reset() {
        operationRevision += 1
        state = .idle
    }

    private func beginOperation(with nextState: RemoteExecutionState) -> Int {
        operationRevision += 1
        state = nextState
        return operationRevision
    }

    private func providerError(for error: any Error) -> RemoteSessionProviderError {
        if let typed = error as? RemoteSessionProviderError {
            return typed
        }
        return .transport(error.localizedDescription)
    }
}
