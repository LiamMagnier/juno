import Foundation

/// A newline-framed transport seam. Keeping this protocol small makes the
/// JSON-RPC client testable without launching an arbitrary process and leaves
/// room for a future streamable-HTTP transport.
public protocol MCPLineTransport: AnyObject, Sendable {
    func start() async throws
    func send(line: String) async throws
    func receiveLine() async throws -> String?
    func close() async
}
