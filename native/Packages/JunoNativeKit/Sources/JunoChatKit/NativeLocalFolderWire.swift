import Foundation
import JunoAPI
import JunoAuth
import JunoCore

// Work in a folder, on the chat wire (src/lib/chat/local-folder.ts).
//
// The Mac names a folder the person picked — its display name and the access
// they chose, never a path — and the server offers the chat model the folder
// tools. Each call comes back down the turn's own stream as a `local_tool`
// frame; the app runs it on the Mac (asking first where it must) and posts the
// outcome to `/api/chat/local-tools/{id}`, which the waiting turn reads.
//
// Only a client that runs the tools says so: `local_folder` joins the
// request's `clientFeatures` only on a turn that names a folder, which only
// the Mac does. The phone never sets a host, so it never names one.

/// The folder a turn works in, as the server is told about it.
public struct NativeLocalFolderContext: Equatable, Sendable, Encodable {
    public enum Access: String, Equatable, Sendable, Encodable {
        case read
        case readWrite = "read_write"
    }

    /// The folder's display name. Never a path.
    public let name: String
    public let access: Access

    public init(name: String, access: Access) {
        self.name = name
        self.access = access
    }
}

/// One folder call the server asks this Mac to run (the `local_tool` frame).
public struct NativeLocalToolCall: Equatable, Sendable {
    /// Unique per call; the outcome is posted under it, and each id runs once.
    public let id: String
    /// The folder tool: `folder_read_file`, `folder_run_command`, …
    public let tool: String
    /// The checked arguments, as the server sent them.
    public let args: [String: JunoJSONValue]

    public init(id: String, tool: String, args: [String: JunoJSONValue]) {
        self.id = id
        self.tool = tool
        self.args = args
    }

    /// A string argument, or nil.
    public func string(_ key: String) -> String? {
        guard case .string(let value)? = args[key] else { return nil }
        return value
    }

    /// An integer argument, or nil.
    public func integer(_ key: String) -> Int? {
        switch args[key] {
        case .number(let value)?: return Int(value)
        case .string(let value)?: return Int(value)
        default: return nil
        }
    }

    /// A boolean argument, false when absent.
    public func flag(_ key: String) -> Bool {
        if case .bool(let value)? = args[key] { return value }
        return false
    }
}

/// How a folder call ended on the Mac.
public enum NativeLocalToolOutcome: String, Equatable, Sendable, Encodable {
    case succeeded
    case failed
    /// The person said no on the approval card.
    case denied
}

/// What the Mac reports for one call.
public struct NativeLocalToolResult: Equatable, Sendable {
    public let outcome: NativeLocalToolOutcome
    /// The listing, the file's text, the command's output, or why not.
    public let output: String

    public init(outcome: NativeLocalToolOutcome, output: String) {
        self.outcome = outcome
        self.output = output
    }

    public static func failed(_ output: String) -> Self { Self(outcome: .failed, output: output) }
}

/// Where the conversation store hands a folder call. The Mac sets one; the
/// phone never does, so a phone neither names a folder nor runs a call.
@MainActor
public protocol NativeLocalToolHosting: AnyObject {
    /// The folder this conversation works in, or nil when it has none.
    func folderContext(for conversationID: String) -> NativeLocalFolderContext?
    /// Runs one call for this conversation and reports how it ended. Never
    /// throws: every way a call can end is an outcome the model reads.
    func perform(_ call: NativeLocalToolCall, conversationID: String) async -> NativeLocalToolResult
    /// The conversation's turn ended: a card still asking can only be
    /// answered no, because nothing waits for the call any more.
    func turnEnded(conversationID: String)
}

extension NativeChatClientFeatures {
    /// What a turn declares: the standing list, plus `local_folder` on a turn
    /// that names a folder.
    public static func declared(localFolder: NativeLocalFolderContext?) -> [String] {
        localFolder == nil ? declared : declared + ["local_folder"]
    }
}

/// `{type: "local_tool", call: ClientLocalToolCall}` (`src/types/chat.ts`).
struct LocalToolFrameWire: Decodable {
    struct Call: Decodable {
        let id: String
        let tool: String
        let args: [String: JunoJSONValue]?
    }

    let call: Call
}

struct LocalToolResultWire: Encodable {
    let outcome: String
    let output: String
    let generationId: String?
}

extension NativeChatAPIClient {
    /// The most text one result carries back; the server cuts at the same size.
    public static let maximumLocalToolOutputCharacters = 60_000

    /// Posts how a folder call ended. A 404 means the turn stopped waiting
    /// (it was stopped, or the call timed out): nothing more can be done.
    public func submitLocalToolResult(
        callID: String,
        result: NativeLocalToolResult,
        generationID: String?,
        for accountID: AccountID
    ) async throws {
        guard Self.isLocalToolCallID(callID) else { throw NativeChatAPIError.malformedResponse }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/chat/local-tools/\(callID)",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(LocalToolResultWire(
                    outcome: result.outcome.rawValue,
                    output: String(result.output.prefix(Self.maximumLocalToolOutputCharacters)),
                    generationId: generationID
                ))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw NativeChatAPIError.malformedResponse
        }
    }

    /// `lft_` and a lowercase UUID: the only ids the server issues, and the
    /// only ones this client will put in a path.
    static func isLocalToolCallID(_ value: String) -> Bool {
        guard value.hasPrefix("lft_") else { return false }
        let rest = value.dropFirst(4)
        return rest.count == 36 && rest.allSatisfy { $0 == "-" || $0.isHexDigit }
    }

    /// `{type: "local_tool", call: {id, tool, args}}`. A call this build cannot
    /// read is skipped rather than failing the reply; the server's wait then
    /// ends in its timeout and the model hears so.
    func decodeLocalToolFrame(_ payload: Data) -> NativeChatServerEvent {
        guard let frame = try? JSONDecoder().decode(LocalToolFrameWire.self, from: payload),
            Self.isLocalToolCallID(frame.call.id),
            validText(frame.call.tool, maximum: 64)
        else { return .ping }
        return .localTool(NativeLocalToolCall(id: frame.call.id, tool: frame.call.tool, args: frame.call.args ?? [:]))
    }
}
