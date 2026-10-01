import Foundation
import JunoCodeCore

/// Sends one HTTP hook's POST. A protocol so tests can answer in process and
/// a host can route through its own session.
public protocol HookHTTPPosting: Sendable {
    /// POSTs `body` to `url` and returns the status code and the body,
    /// bounded by `maximumBytes`. Throws on a transport failure or timeout.
    func post(
        url: URL,
        headers: [String: String],
        body: Data,
        timeoutSeconds: Double,
        maximumBytes: Int
    ) async throws -> (status: Int, body: Data)
}

/// The production poster: an ephemeral `URLSession` with no cookies, no
/// cache and no credential store, so a hook endpoint never sees anything the
/// app's other requests carry.
public struct URLSessionHookPoster: HookHTTPPosting {
    public init() {}

    public func post(
        url: URL,
        headers: [String: String],
        body: Data,
        timeoutSeconds: Double,
        maximumBytes: Int
    ) async throws -> (status: Int, body: Data) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = timeoutSeconds
        configuration.timeoutIntervalForResource = timeoutSeconds
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, timeoutInterval: timeoutSeconds)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Juno-Hooks/1", forHTTPHeaderField: "User-Agent")
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.httpBody = body
        let (bytes, response) = try await session.bytes(for: request)
        var collected = Data()
        for try await byte in bytes {
            collected.append(byte)
            if collected.count > maximumBytes { break }
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (status, collected)
    }

    /// A hook endpoint answers where it was asked. Following a redirect would
    /// let a loopback endpoint a project is allowed to post to bounce the
    /// session's data to a host it is not.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(
            _: URLSession,
            task _: URLSessionTask,
            willPerformHTTPRedirection _: HTTPURLResponse,
            newRequest _: URLRequest,
            completionHandler: @escaping @Sendable (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}

/// Runs `http` hooks: the event's JSON as the POST body, the answer read with
/// the same output contract as a command's standard output.
///
/// Claude Code's rules: a 2xx answer is success, and its JSON body is read
/// for `decision`, `continue`, `hookSpecificOutput` and the rest; any other
/// status, a connection failure or a timeout is a non-blocking error. There
/// is no exit code 2: an HTTP hook blocks by answering `"decision": "block"`
/// (or `permissionDecision: "deny"`).
struct HookHTTPRunner: Sendable {
    let poster: any HookHTTPPosting

    func run(hook: HookDefinition, event: HookLifecycleEvent, body: Data) async -> HookExecutionResult {
        guard let url = hook.url else {
            return HookExecutionResult(
                hookID: hook.id,
                hookName: hook.displayName,
                event: event,
                status: .denied(reason: "The hook has no URL.")
            )
        }
        do {
            let answer = try await poster.post(
                url: url,
                headers: hook.headers,
                body: body,
                timeoutSeconds: hook.timeoutSeconds,
                maximumBytes: HookExecutionLimits.maximumOutputBytes
            )
            let text = String(decoding: answer.body.prefix(HookExecutionLimits.maximumOutputBytes), as: UTF8.self)
            guard (200..<300).contains(answer.status) else {
                return HookExecutionResult(
                    hookID: hook.id,
                    hookName: hook.displayName,
                    event: event,
                    status: .failed(exitCode: Int32(clamping: answer.status), reason: "The hook answered HTTP \(answer.status)."),
                    stdout: "",
                    stderr: text
                )
            }
            return HookExecutionResult(
                hookID: hook.id,
                hookName: hook.displayName,
                event: event,
                status: .succeeded(exitCode: 0),
                stdout: text,
                output: HookOutput(stdout: text, event: event)
            )
        } catch {
            let timedOut = (error as? URLError)?.code == .timedOut
            return HookExecutionResult(
                hookID: hook.id,
                hookName: hook.displayName,
                event: event,
                status: .failed(
                    exitCode: -1,
                    reason: timedOut
                        ? "The hook did not answer within \(Int(hook.timeoutSeconds))s."
                        : "The hook could not be reached."
                ),
                stderr: timedOut ? "" : String(describing: error)
            )
        }
    }
}
