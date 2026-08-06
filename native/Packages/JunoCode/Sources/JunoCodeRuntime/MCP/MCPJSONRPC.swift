import Foundation
import JunoCodeCore

/// Errors surfaced by the bounded MCP foundation.
public enum MCPError: Error, Equatable, Sendable {
    case malformedMessage(String)
    case invalidProtocol(String)
    case transportFailure(String)
    case transportClosed
    case notConnected
    case alreadyConnected
    case requestInFlight
    case timedOut(method: String)
    case unexpectedResponse(expected: MCPJSONRPCID, received: MCPJSONRPCID?)
    case serverError(MCPJSONRPCError)
    case unsupportedProtocolVersion(String)
    case invalidConfiguration(path: String, reason: String)
    case serverNotFound(String)
    case disabledServer(String)
    case toolNotFound(serverID: String, name: String)
    case invalidToolResult(String)
}

extension MCPError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .malformedMessage(reason):
            "Malformed MCP message: \(reason)"
        case let .invalidProtocol(reason):
            "Invalid MCP protocol state: \(reason)"
        case let .transportFailure(reason):
            "MCP transport failed: \(reason)"
        case .transportClosed:
            "The MCP server closed its transport."
        case .notConnected:
            "The MCP server is not connected."
        case .alreadyConnected:
            "The MCP server is already connected."
        case .requestInFlight:
            "The MCP client only permits one in-flight request per stdio connection."
        case let .timedOut(method):
            "MCP request '\(method)' timed out."
        case let .unexpectedResponse(expected, received):
            "Unexpected MCP response id. Expected \(expected), received \(String(describing: received))."
        case let .serverError(error):
            "MCP server error \(error.code): \(error.message)"
        case let .unsupportedProtocolVersion(version):
            "Unsupported MCP protocol version '\(version)'."
        case let .invalidConfiguration(path, reason):
            "Invalid MCP configuration at \(path): \(reason)"
        case let .serverNotFound(serverID):
            "MCP server '\(serverID)' was not configured."
        case let .disabledServer(serverID):
            "MCP server '\(serverID)' is disabled."
        case let .toolNotFound(serverID, name):
            "MCP tool '\(name)' was not advertised by server '\(serverID)'."
        case let .invalidToolResult(reason):
            "Invalid MCP tool result: \(reason)"
        }
    }
}

/// JSON-RPC identifiers accepted by MCP. Null ids are deliberately rejected
/// because they cannot safely be correlated with a pending request.
public enum MCPJSONRPCID: Hashable, Codable, Sendable, CustomStringConvertible {
    case number(Double)
    case string(String)

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            self = .string(string)
            return
        }
        if let number = try? container.decode(Double.self), number.isFinite {
            self = .number(number)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "MCP JSON-RPC ids must be strings or finite numbers"
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .number(number):
            try container.encode(number)
        case let .string(string):
            try container.encode(string)
        }
    }

    fileprivate init(jsonValue: JSONValue) throws {
        switch jsonValue {
        case let .number(number) where number.isFinite:
            self = .number(number)
        case let .string(string):
            self = .string(string)
        default:
            throw MCPError.malformedMessage("JSON-RPC id must be a string or finite number")
        }
    }

    fileprivate var jsonValue: JSONValue {
        switch self {
        case let .number(number): .number(number)
        case let .string(string): .string(string)
        }
    }

    public var description: String {
        switch self {
        case let .number(number): String(number)
        case let .string(string): "\"\(string)\""
        }
    }
}

public struct MCPJSONRPCError: Error, Equatable, Sendable {
    public let code: Int
    public let message: String
    public let data: JSONValue?

    public init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

/// The line-oriented JSON-RPC messages used by the MCP stdio transport.
public enum MCPJSONRPCMessage: Equatable, Sendable {
    case request(id: MCPJSONRPCID, method: String, params: JSONValue?)
    case notification(method: String, params: JSONValue?)
    case response(id: MCPJSONRPCID, result: JSONValue)
    case error(id: MCPJSONRPCID?, error: MCPJSONRPCError)

    /// Parses exactly one JSON-RPC message. Batches are intentionally rejected:
    /// MCP stdio messages are newline-delimited, so a batch cannot be safely
    /// correlated to the single request allowed by this bounded client.
    public static func parse(line: String) throws -> MCPJSONRPCMessage {
        guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MCPError.malformedMessage("message was empty")
        }

        let value: JSONValue
        do {
            value = try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8))
        } catch {
            throw MCPError.malformedMessage("invalid JSON: \(error.localizedDescription)")
        }

        guard case let .object(fields) = value else {
            throw MCPError.malformedMessage("JSON-RPC messages must be objects, not batches or scalar values")
        }
        guard fields["jsonrpc"] == .string("2.0") else {
            throw MCPError.malformedMessage("jsonrpc must be the string '2.0'")
        }

        let hasID = fields.keys.contains("id")
        let hasMethod = fields.keys.contains("method")
        let hasResult = fields.keys.contains("result")
        let hasError = fields.keys.contains("error")

        if hasMethod {
            guard !hasResult, !hasError else {
                throw MCPError.malformedMessage("a request or notification cannot also contain result or error")
            }
            guard let method = fields["method"]?.stringValue, !method.isEmpty else {
                throw MCPError.malformedMessage("method must be a non-empty string")
            }
            let params = try parseParams(fields["params"])
            if hasID {
                guard let rawID = fields["id"] else {
                    throw MCPError.malformedMessage("request id was missing")
                }
                return .request(
                    id: try MCPJSONRPCID(jsonValue: rawID),
                    method: method,
                    params: params
                )
            }
            return .notification(method: method, params: params)
        }

        guard hasResult != hasError else {
            throw MCPError.malformedMessage("a response must contain exactly one of result or error")
        }
        guard hasID, let rawID = fields["id"] else {
            throw MCPError.malformedMessage("response id was missing")
        }
        let id = try MCPJSONRPCID(jsonValue: rawID)

        if hasResult {
            guard let result = fields["result"] else {
                throw MCPError.malformedMessage("response result was missing")
            }
            return .response(id: id, result: result)
        }

        guard case let .object(errorFields)? = fields["error"] else {
            throw MCPError.malformedMessage("error must be an object")
        }
        guard let code = errorFields["code"]?.intValue else {
            throw MCPError.malformedMessage("error code must be an integer")
        }
        guard let message = errorFields["message"]?.stringValue else {
            throw MCPError.malformedMessage("error message must be a string")
        }
        return .error(
            id: id,
            error: MCPJSONRPCError(code: code, message: message, data: errorFields["data"])
        )
    }

    /// Encodes one message without a trailing newline. Transports own line
    /// framing so callers cannot accidentally send embedded delimiters.
    public func encodedLine() -> String {
        jsonValue.canonicalJSONString()
    }

    fileprivate var jsonValue: JSONValue {
        switch self {
        case let .request(id, method, params):
            var fields: [String: JSONValue] = [
                "jsonrpc": .string("2.0"),
                "id": id.jsonValue,
                "method": .string(method),
            ]
            if let params { fields["params"] = params }
            return .object(fields)
        case let .notification(method, params):
            var fields: [String: JSONValue] = [
                "jsonrpc": .string("2.0"),
                "method": .string(method),
            ]
            if let params { fields["params"] = params }
            return .object(fields)
        case let .response(id, result):
            return .object([
                "jsonrpc": .string("2.0"),
                "id": id.jsonValue,
                "result": result,
            ])
        case let .error(id, error):
            return .object([
                "jsonrpc": .string("2.0"),
                "id": id?.jsonValue ?? .null,
                "error": .object([
                    "code": .number(Double(error.code)),
                    "message": .string(error.message),
                    "data": error.data ?? .null,
                ]),
            ])
        }
    }

    private static func parseParams(_ value: JSONValue?) throws -> JSONValue? {
        guard let value else { return nil }
        switch value {
        case .object, .array, .null:
            return value
        default:
            throw MCPError.malformedMessage("params must be an object, array, or null")
        }
    }
}
