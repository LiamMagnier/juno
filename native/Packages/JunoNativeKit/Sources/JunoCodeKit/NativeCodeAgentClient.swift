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

public struct NativeCodeAgentTask: Decodable, Identifiable, Equatable, Sendable {
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
    public let permissionMode: CodeAgentPermissionMode
    /// The model the submitter picked, or nil for "no preference".
    public let modelId: String?
    public let reasoningEffort: String?
    /// The canonical agent protocol version this server stores as `protocol`
    /// task events, or nil for a server that predates it (and would refuse
    /// the whole batch that carried one).
    public let agentProtocol: String?
    public let createdAt: String
    public let updatedAt: String

    /// Whether this server takes canonical agent protocol rows (major 1).
    public var acceptsAgentProtocol: Bool {
        agentProtocol?.split(separator: ".").first == "1"
    }

    /// Every key here is one `serializeTask` (src/lib/code-task-wire.ts)
    /// sends, except `modelId`, which no server has ever sent and is read only
    /// as a fallback. `tests/code-task-wire.test.ts` holds this list to the
    /// server's key set, so a field the Mac waits for that the server never
    /// writes fails there instead of silently decoding as nil.
    private enum CodingKeys: String, CodingKey {
        case id, deviceId, workspacePath, workspaceName, workspaceKey, title, prompt
        case status, lastSeq, conversationId, target, repoOwner, repoName, baseRef, prUrl
        case permissionMode, model, modelId, reasoningEffort, agentProtocol, createdAt, updatedAt
    }

    /// Lenient where the server is: `serializeTask` leaves `permissionMode`,
    /// `model` and `reasoningEffort` null on a task created without them and
    /// omits `prompt` on list responses. Decoding those strictly failed every
    /// queued task, so none ever started on the Mac.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId)
        workspacePath = try container.decodeIfPresent(String.self, forKey: .workspacePath) ?? ""
        workspaceName = try container.decodeIfPresent(String.self, forKey: .workspaceName) ?? ""
        workspaceKey = try container.decodeIfPresent(String.self, forKey: .workspaceKey)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        status = try container.decode(String.self, forKey: .status)
        lastSeq = try container.decodeIfPresent(Int.self, forKey: .lastSeq) ?? 0
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
        target = try container.decodeIfPresent(String.self, forKey: .target) ?? "device"
        repoOwner = try container.decodeIfPresent(String.self, forKey: .repoOwner)
        repoName = try container.decodeIfPresent(String.self, forKey: .repoName)
        baseRef = try container.decodeIfPresent(String.self, forKey: .baseRef)
        prUrl = try container.decodeIfPresent(String.self, forKey: .prUrl)
        // Null means "no preference": the Mac's own gating, which asks.
        permissionMode = (try? container.decodeIfPresent(CodeAgentPermissionMode.self, forKey: .permissionMode)) ?? .ask
        // `model` is the server's key. `modelId` is what this decoder used to
        // read, and what no server ever wrote; it stays only as a fallback.
        modelId = try container.decodeIfPresent(String.self, forKey: .model)
            ?? container.decodeIfPresent(String.self, forKey: .modelId)
        reasoningEffort = try container.decodeIfPresent(String.self, forKey: .reasoningEffort)
        agentProtocol = try? container.decodeIfPresent(String.self, forKey: .agentProtocol)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    }
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

/// The host half of the device-task queue: register this Mac, take a queued
/// task, claim it, and stream its events back. Creating tasks is the task
/// store's (`NativeCodeTaskClient`), which is what every composer calls; the
/// create, repository and list methods that used to live here too were called
/// only by a provider no app composed, and are gone with it.
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
private struct ClaimRequest: Encodable { let deviceId: String }
private struct TaskResponse: Decodable { let task: NativeCodeAgentTask }
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
