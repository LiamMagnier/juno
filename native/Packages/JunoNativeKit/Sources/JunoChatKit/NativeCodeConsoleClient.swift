import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoSync

/// Fetches the console document a code block runs in: `POST /api/code/console`,
/// the web's own document (src/lib/sandbox/console-doc.ts) for JavaScript,
/// TypeScript, Python and SQL, in the reader's theme. Nothing runs on the
/// server; the app runs the document in ``JunoCodeRunOutput``'s web view, on
/// the reader's device, as the website runs it in the reader's browser.
public struct NativeCodeConsoleClient: Sendable {
    public enum Failure: LocalizedError, Equatable {
        case signedOut
        case rateLimited
        case unavailable

        public var errorDescription: String? {
            switch self {
            case .signedOut: "Sign in to run code."
            case .rateLimited: "Too many runs in a minute. Try again shortly."
            case .unavailable: "This code couldn’t be run right now."
            }
        }
    }

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func consoleDocument(language: String, code: String, dark: Bool, for accountID: AccountID) async throws -> String {
        let request = try NativeBearerRequest(
            path: "/api/code/console",
            method: .post,
            headers: try HTTPHeaders([
                "accept": "application/json",
                "content-type": "application/json",
            ]),
            body: try JSONEncoder().encode(RequestWire(language: language, code: code, theme: dark ? "dark" : "light"))
        )
        let response: HTTPResponse
        do {
            response = try await sender.send(request, for: accountID)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw Failure.unavailable
        }
        switch response.statusCode {
        case 200...299: break
        case 401: throw Failure.signedOut
        case 429: throw Failure.rateLimited
        default: throw Failure.unavailable
        }
        guard let wire = try? JSONDecoder().decode(ResponseWire.self, from: response.body), !wire.html.isEmpty else {
            throw Failure.unavailable
        }
        return wire.html
    }

    /// The runner a transcript hands its code blocks and exercises.
    public func runner(for accountID: AccountID) -> JunoCodeRunner {
        JunoCodeRunner { target, code, dark in
            try await consoleDocument(language: target.language, code: code, dark: dark, for: accountID)
        }
    }

    private struct RequestWire: Encodable {
        let language: String
        let code: String
        let theme: String
    }

    private struct ResponseWire: Decodable {
        let html: String
    }
}
