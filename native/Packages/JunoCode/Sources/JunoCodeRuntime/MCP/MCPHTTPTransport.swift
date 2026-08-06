import Foundation

/// Streamable HTTP MCP transport. Each JSON-RPC request is an HTTP POST; JSON
/// responses and SSE `data:` frames are normalized into the same line inbox the
/// stdio client consumes. The transport retains the MCP session header returned
/// by an initialize response and sends it on subsequent requests.
public actor MCPHTTPTransport: MCPLineTransport {
    private let configuration: MCPServerConfiguration
    private var inbox: MCPHTTPLineInbox?
    private var isStarted = false
    private var sessionID: String?

    public init(configuration: MCPServerConfiguration) {
        self.configuration = configuration
    }

    public func start() async throws {
        guard configuration.transport == .streamableHTTP,
              configuration.url != nil
        else {
            throw MCPError.invalidConfiguration(
                path: configuration.name,
                reason: "HTTP transport needs an http(s) URL"
            )
        }
        guard !isStarted else { throw MCPError.alreadyConnected }
        inbox = MCPHTTPLineInbox()
        isStarted = true
    }

    public func send(line: String) async throws {
        guard isStarted, let inbox, let url = configuration.url else {
            throw MCPError.notConnected
        }
        guard !line.contains("\n"), !line.contains("\r") else {
            throw MCPError.malformedMessage("HTTP MCP messages may not contain embedded newlines")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(line.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("2025-06-18", forHTTPHeaderField: "Mcp-Protocol-Version")
        if let sessionID {
            request.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id")
        }
        for (key, value) in configuration.headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode)
            else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                throw MCPError.transportFailure("HTTP MCP server returned status \(status)")
            }
            if let returnedSession = http.value(forHTTPHeaderField: "Mcp-Session-Id"),
               !returnedSession.isEmpty
            {
                sessionID = returnedSession
            }
            guard !data.isEmpty else { return }

            let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? ""
            for message in Self.messages(from: data, contentType: contentType) {
                // A notification in an HTTP response must not sit in the inbox
                // and become the response to the next request.
                if let parsed = try? MCPJSONRPCMessage.parse(line: message),
                   case .notification = parsed
                {
                    continue
                }
                await inbox.yield(message)
            }
        } catch let error as MCPError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MCPError.transportFailure(error.localizedDescription)
        }
    }

    public func receiveLine() async throws -> String? {
        guard isStarted, let inbox else { throw MCPError.notConnected }
        return try await inbox.next()
    }

    public func close() async {
        isStarted = false
        sessionID = nil
        await inbox?.finish()
        inbox = nil
    }

    private static func messages(from data: Data, contentType: String) -> [String] {
        guard let text = String(data: data, encoding: .utf8), !text.isEmpty else {
            return []
        }
        if contentType.lowercased().contains("text/event-stream") {
            var messages: [String] = []
            var dataLines: [String] = []
            func flush() {
                guard !dataLines.isEmpty else { return }
                messages.append(dataLines.joined(separator: "\n"))
                dataLines.removeAll(keepingCapacity: true)
            }
            for line in text.components(separatedBy: .newlines) {
                if line.isEmpty {
                    flush()
                } else if line.hasPrefix("data:") {
                    let value = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    if value != "[DONE]" { dataLines.append(value) }
                }
            }
            flush()
            return messages
        }
        return text
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

private actor MCPHTTPLineInbox {
    private var bufferedLines: [String] = []
    private var waiters: [CheckedContinuation<String?, Error>] = []
    private var isFinished = false

    func yield(_ line: String) {
        guard !isFinished else { return }
        if let waiter = waiters.first {
            waiters.removeFirst()
            waiter.resume(returning: line)
        } else {
            bufferedLines.append(line)
        }
    }

    func next() async throws -> String? {
        if !bufferedLines.isEmpty { return bufferedLines.removeFirst() }
        if isFinished { return nil }
        return try await withCheckedThrowingContinuation { continuation in
            if isFinished {
                continuation.resume(returning: nil)
            } else {
                waiters.append(continuation)
            }
        }
    }

    func finish() {
        guard !isFinished else { return }
        isFinished = true
        let pending = waiters
        waiters.removeAll(keepingCapacity: false)
        for waiter in pending { waiter.resume(returning: nil) }
    }
}
