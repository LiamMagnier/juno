import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

public enum NativeAccountDataError: Error, Equatable, LocalizedError, Sendable {
    case server(statusCode: Int, message: String)
    case emailMismatch

    public var errorDescription: String? {
        switch self {
        case .server(_, let message): message
        case .emailMismatch: "The email you typed doesn’t match this account."
        }
    }
}

/// GDPR export and account deletion — the two operations behind the website's
/// **Danger zone**, which the phone app had no equivalent of at all.
///
/// Both are deliberately thin. The server owns every rule that matters: the
/// export's row cap and CSV-injection quoting, the delete's rate limit and its
/// requirement that the account's own email be typed back. Re-deciding any of
/// that on the client would mean two answers to "may this proceed", and the one
/// on the phone would be the one that could be wrong.
public struct NativeAccountDataClient: Sendable {
    public enum ExportFormat: String, Sendable {
        case json
        case csv
        /// Everything, plus the Library's files where they fit: a `.zip` —
        /// or plain JSON when the server has no file storage (Phase 3).
        case juno

        /// What the exported file should be called. The server sets no
        /// `Content-Disposition`, so the name is the client's to choose — and a
        /// share sheet offering "export" with no extension is a file nobody's
        /// spreadsheet will open.
        public func fileName(on date: Date) -> String {
            // Built per call rather than from a shared static. `ISO8601DateFormatter`
            // is a mutable class and not `Sendable`, so a `static let` of one is a
            // concurrency error under Swift 6 — and this runs once per export.
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withFullDate, .withDashSeparatorInDate]
            return "juno-export-\(formatter.string(from: date)).\(defaultExtension)"
        }

        /// The extension a file of this format carries. A Juno package is a
        /// zip; ``export(format:for:)`` corrects it to `json` when the server
        /// answered with JSON instead.
        public var defaultExtension: String {
            switch self {
            case .json: "json"
            case .csv: "csv"
            case .juno: "zip"
            }
        }

        var queryItems: [URLQueryItem] {
            switch self {
            case .json: []
            case .csv: [URLQueryItem(name: "format", value: "csv")]
            case .juno: [URLQueryItem(name: "format", value: "juno")]
            }
        }
    }

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// Downloads the account snapshot and writes it to a temporary file, ready
    /// for a share sheet.
    public func export(
        format: ExportFormat,
        for accountID: AccountID
    ) async throws -> URL {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/account/export",
                queryItems: format.queryItems,
                headers: try HTTPHeaders(["accept": "*/*"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw failure(response, fallback: "Juno could not export your data")
        }
        var url = FileManager.default.temporaryDirectory
            .appendingPathComponent(format.fileName(on: Date()))
        if format == .juno,
            response.headers["content-type"]?.lowercased().contains("application/zip") != true
        {
            url = url.deletingPathExtension().appendingPathExtension("json")
        }
        try response.body.write(to: url, options: .atomic)
        return url
    }

    /// Deletes every conversation on the account and its messages. Memories
    /// and projects stay (`DELETE /api/conversations`, Phase 3).
    public func deleteAllConversations(for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/conversations",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw failure(response, fallback: "Juno could not delete your conversations")
        }
    }

    /// Permanently deletes the account.
    ///
    /// `confirmEmail` is checked here *as well as* on the server — not instead
    /// of. The local check is what stops an obviously-wrong confirmation from
    /// spending one of the three attempts an hour the route allows; the server's
    /// is the one that decides.
    public func deleteAccount(
        confirmEmail: String,
        accountEmail: String,
        for accountID: AccountID
    ) async throws {
        let typed = confirmEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty,
            typed.caseInsensitiveCompare(accountEmail) == .orderedSame
        else { throw NativeAccountDataError.emailMismatch }

        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/account/delete",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(DeleteRequestWire(confirmEmail: typed))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw failure(response, fallback: "Juno could not delete this account")
        }
    }

    /// These routes answer with Next's `{ "error": … }`, not the native
    /// envelope, so the sentence is read from there.
    private func failure(_ response: HTTPResponse, fallback: String) -> NativeAccountDataError {
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return .server(
            statusCode: response.statusCode,
            message: message ?? "\(fallback) (\(response.statusCode))."
        )
    }
}

private struct DeleteRequestWire: Encodable {
    let confirmEmail: String
}
