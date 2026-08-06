import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

public struct NativeCodeWorkspaceRegistration: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let key: String?

    public init(name: String, path: String, key: String? = nil) {
        self.name = name
        self.path = path
        self.key = key
    }
}

public struct NativeCodeAgentDevice: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let lastSeenAt: String
    public let online: Bool?
}

public struct NativeCodeAgentRepository: Codable, Identifiable, Equatable, Sendable {
    public var id: String { fullName }
    public let owner: String
    public let name: String
    public let fullName: String
    public let `private`: Bool
    public let defaultBranch: String
    public let updatedAt: String
}

public struct NativeCodeAgentTask: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let deviceId: String?
    public let workspacePath: String
    public let workspaceName: String
    public let workspaceKey: String?
    public let title: String
    public let prompt: String
    public let status: String
    public let lastSeq: Int
    public let conversationId: String?
    public let target: String
    public let repoOwner: String?
    public let repoName: String?
    public let baseRef: String?
    public let prUrl: String?
    public let agentRuntime: CodeAgentRuntime
    public let permissionMode: CodeAgentPermissionMode
    public let modelId: String?
    public let reasoningEffort: String?
    public let computerUse: Bool
    public let subagentsEnabled: Bool
    public let createdAt: String
    public let updatedAt: String
}

public struct NativeCodeTaskEventInput: Codable, Equatable, Sendable {
    public let kind: String
    public let payload: [String: NativeJSONValue]

    public init(kind: String, payload: [String: NativeJSONValue]) {
        self.kind = kind
        self.payload = payload
    }
}

public struct NativeCodeControlEvent: Codable, Equatable, Sendable {
    public let seq: Int
    public let kind: String
    public let payload: [String: NativeJSONValue]
}

public struct NativeCodeTaskEventAck: Equatable, Sendable {
    public let lastSequence: Int
    public let control: [NativeCodeControlEvent]
}

public enum NativeCodeAgentAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidInput
    case malformedResponse
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidInput: "Juno could not safely create this agent task."
        case .malformedResponse: "Juno returned an invalid agent response."
        case .server(_, let message): message
        }
    }
}

/// Existing Juno bearer routes are the sole cross-device source of truth for
/// Code sessions. The macOS shell uses this client for the same tasks the Web
/// and iOS surfaces observe through the sync feed.
public struct NativeCodeAgentClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func registerDevice(
        id: String?,
        name: String,
        workspaces: [NativeCodeWorkspaceRegistration],
        for accountID: AccountID
    ) async throws -> NativeCodeAgentDevice {
        let body = DeviceRequest(
            deviceId: id,
            name: name,
            platform: "macos",
            workspaces: workspaces
        )
        let response = try await request(
            path: "/api/code/devices",
            method: .post,
            body: body,
            accountID: accountID
        )
        return try decode(DeviceResponse.self, from: response).device
    }

    public func repositories(for accountID: AccountID) async throws
        -> [NativeCodeAgentRepository]
    {
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/code/github/repos"),
            for: accountID
        )
        try requireSuccess(response)
        return try decode(RepositoryResponse.self, from: response).repos
    }

    public func createCodeConversation(
        workspace: NativeCodeWorkspaceRegistration?,
        for accountID: AccountID
    ) async throws -> String {
        let body = ConversationRequest(
            kind: "code",
            codeWorkspaceName: workspace?.name,
            codeWorkspacePath: workspace?.path,
            codeWorkspaceKey: workspace?.key
        )
        let response = try await request(
            path: "/api/conversations",
            method: .post,
            body: body,
            accountID: accountID
        )
        let id = try decode(ConversationResponse.self, from: response).conversation.id
        guard !id.isEmpty else { throw NativeCodeAgentAPIError.malformedResponse }
        return id
    }

    public func createDeviceTask(
        deviceID: String,
        workspace: NativeCodeWorkspaceRegistration,
        prompt: String,
        conversationID: String?,
        profile: CodeAgentProfile,
        for accountID: AccountID
    ) async throws -> NativeCodeAgentTask {
        guard !deviceID.isEmpty, !workspace.path.isEmpty, !prompt.isEmpty else {
            throw NativeCodeAgentAPIError.invalidInput
        }
        return try await createTask(
            TaskRequest(
                deviceId: deviceID,
                workspacePath: workspace.path,
                workspaceName: workspace.name,
                workspaceKey: workspace.key,
                prompt: prompt,
                conversationId: conversationID,
                target: "device",
                repo: nil,
                baseRef: nil,
                profile: profile
            ),
            accountID: accountID
        )
    }

    public func createCloudTask(
        repository: NativeCodeAgentRepository,
        baseRef: String?,
        prompt: String,
        conversationID: String?,
        profile: CodeAgentProfile,
        for accountID: AccountID
    ) async throws -> NativeCodeAgentTask {
        guard !prompt.isEmpty else { throw NativeCodeAgentAPIError.invalidInput }
        return try await createTask(
            TaskRequest(
                deviceId: nil,
                workspacePath: nil,
                workspaceName: repository.name,
                workspaceKey: nil,
                prompt: prompt,
                conversationId: conversationID,
                target: "cloud",
                repo: .init(owner: repository.owner, name: repository.name),
                baseRef: baseRef ?? repository.defaultBranch,
                profile: profile
            ),
            accountID: accountID
        )
    }

    public func queuedTask(
        deviceID: String,
        for accountID: AccountID
    ) async throws -> NativeCodeAgentTask? {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/code/queue",
                queryItems: [URLQueryItem(name: "deviceId", value: deviceID)]
            ),
            for: accountID
        )
        try requireSuccess(response)
        return try decode(QueueResponse.self, from: response).task
    }

    public func tasks(
        limit: Int = 30,
        for accountID: AccountID
    ) async throws -> [NativeCodeAgentTask] {
        let safeLimit = min(max(limit, 1), 100)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/code/tasks",
                queryItems: [
                    URLQueryItem(name: "limit", value: String(safeLimit)),
                ]
            ),
            for: accountID
        )
        try requireSuccess(response)
        return try decode(TasksResponse.self, from: response).tasks
    }

    public func claim(
        taskID: String,
        deviceID: String,
        for accountID: AccountID
    ) async throws -> NativeCodeAgentTask {
        let response = try await request(
            path: "/api/code/tasks/\(taskID)/claim",
            method: .post,
            body: ClaimRequest(deviceId: deviceID),
            accountID: accountID
        )
        return try decode(TaskResponse.self, from: response).task
    }

    public func append(
        taskID: String,
        events: [NativeCodeTaskEventInput],
        status: String? = nil,
        afterControlSequence: Int = 0,
        for accountID: AccountID
    ) async throws -> NativeCodeTaskEventAck {
        let response = try await request(
            path: "/api/code/tasks/\(taskID)/events",
            method: .post,
            body: EventsRequest(
                events: events,
                status: status,
                afterControlSeq: afterControlSequence
            ),
            accountID: accountID
        )
        let wire = try decode(EventsResponse.self, from: response)
        return NativeCodeTaskEventAck(
            lastSequence: wire.lastSeq,
            control: wire.control
        )
    }

    private func createTask(
        _ body: TaskRequest,
        accountID: AccountID
    ) async throws -> NativeCodeAgentTask {
        let response = try await request(
            path: "/api/code/tasks",
            method: .post,
            body: body,
            accountID: accountID
        )
        return try decode(TaskResponse.self, from: response).task
    }

    private func request<Body: Encodable>(
        path: String,
        method: HTTPMethod,
        body: Body,
        accountID: AccountID
    ) async throws -> HTTPResponse {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: method,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        try requireSuccess(response)
        return response
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard (200...299).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(
                ErrorResponse.self,
                from: response.body
            ).error) ?? "The agent request failed."
            throw NativeCodeAgentAPIError.server(
                statusCode: response.statusCode,
                message: message
            )
        }
    }

    private func decode<Value: Decodable>(
        _ type: Value.Type,
        from response: HTTPResponse
    ) throws -> Value {
        do { return try JSONDecoder().decode(type, from: response.body) }
        catch { throw NativeCodeAgentAPIError.malformedResponse }
    }
}

private struct DeviceRequest: Encodable {
    let deviceId: String?
    let name: String
    let platform: String
    let workspaces: [NativeCodeWorkspaceRegistration]
}

private struct DeviceResponse: Decodable { let device: NativeCodeAgentDevice }
private struct RepositoryResponse: Decodable { let repos: [NativeCodeAgentRepository] }
private struct ConversationRequest: Encodable {
    let kind: String
    let codeWorkspaceName: String?
    let codeWorkspacePath: String?
    let codeWorkspaceKey: String?
}
private struct ConversationResponse: Decodable {
    struct Conversation: Decodable { let id: String }
    let conversation: Conversation
}
private struct ClaimRequest: Encodable { let deviceId: String }
private struct TaskResponse: Decodable { let task: NativeCodeAgentTask }
private struct TasksResponse: Decodable { let tasks: [NativeCodeAgentTask] }
private struct QueueResponse: Decodable { let task: NativeCodeAgentTask? }
private struct EventsRequest: Encodable {
    let events: [NativeCodeTaskEventInput]
    let status: String?
    let afterControlSeq: Int
}
private struct EventsResponse: Decodable {
    let lastSeq: Int
    let control: [NativeCodeControlEvent]
}
private struct ErrorResponse: Decodable { let error: String }

private struct TaskRequest: Encodable {
    struct Repository: Encodable {
        let owner: String
        let name: String
    }

    let deviceId: String?
    let workspacePath: String?
    let workspaceName: String?
    let workspaceKey: String?
    let prompt: String
    let conversationId: String?
    let target: String
    let repo: Repository?
    let baseRef: String?
    let agentRuntime: CodeAgentRuntime
    let permissionMode: CodeAgentPermissionMode
    let modelId: String?
    let reasoningEffort: String?
    let computerUse: Bool
    let subagentsEnabled: Bool

    init(
        deviceId: String?,
        workspacePath: String?,
        workspaceName: String?,
        workspaceKey: String?,
        prompt: String,
        conversationId: String?,
        target: String,
        repo: Repository?,
        baseRef: String?,
        profile: CodeAgentProfile
    ) {
        self.deviceId = deviceId
        self.workspacePath = workspacePath
        self.workspaceName = workspaceName
        self.workspaceKey = workspaceKey
        self.prompt = prompt
        self.conversationId = conversationId
        self.target = target
        self.repo = repo
        self.baseRef = baseRef
        agentRuntime = profile.runtime
        permissionMode = profile.permissionMode
        modelId = profile.modelID
        reasoningEffort = profile.reasoningEffort
        computerUse = profile.computerUse
        subagentsEnabled = profile.subagentsEnabled
    }
}
