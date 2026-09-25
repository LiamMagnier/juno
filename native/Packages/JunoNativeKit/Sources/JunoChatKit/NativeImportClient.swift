import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// What one import restored, as `POST /api/import` reports it.
public struct NativeImportResult: Equatable, Sendable {
    public let imported: Int
    public let skipped: Int
    public let projectsImported: Int
    public let memoriesImported: Int
    public let attachmentsImported: Int
    public let attachmentsSkipped: Int
    /// `chatgpt` · `claude` · `gemini` · `juno`, or nil.
    public let format: String?

    public init(
        imported: Int,
        skipped: Int,
        projectsImported: Int,
        memoriesImported: Int,
        attachmentsImported: Int,
        attachmentsSkipped: Int,
        format: String?
    ) {
        self.imported = imported
        self.skipped = skipped
        self.projectsImported = projectsImported
        self.memoriesImported = memoriesImported
        self.attachmentsImported = attachmentsImported
        self.attachmentsSkipped = attachmentsSkipped
        self.format = format
    }

    /// The web's `FORMAT_LABEL`, or "the export".
    public var providerLabel: String {
        switch format {
        case "chatgpt": "ChatGPT"
        case "claude": "Claude"
        case "gemini": "Gemini"
        case "juno": "Juno"
        default: "the export"
        }
    }

    /// Anything at all came in.
    public var restoredAnything: Bool {
        imported + projectsImported + memoriesImported + attachmentsImported > 0
    }
}

/// Imports a chat-history export from ChatGPT, Claude, Gemini or another Juno
/// account (`POST /api/import`, multipart, 100 MB).
///
/// The request goes through the authenticated sender, which returns only when
/// the server has answered, so the caller can say "uploading" but not how far
/// along; a byte-level progress needs a progress-reporting transport (deferred,
/// Stage C notes).
public struct NativeImportClient: Sendable {
    public static let maximumBytes = 100 * 1024 * 1024

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// The web's refusal for a file it would not accept, before any upload;
    /// nil when the file may be sent.
    public static func refusal(fileName: String, byteCount: Int) -> String? {
        let lower = fileName.lowercased()
        guard lower.hasSuffix(".zip") || lower.hasSuffix(".json") else {
            return "Choose a .zip or .json export from ChatGPT, Claude, Gemini or Juno."
        }
        guard byteCount <= maximumBytes else { return "The export must be under 100 MB." }
        return nil
    }

    public func importHistory(
        data: Data,
        fileName: String,
        for accountID: AccountID
    ) async throws -> NativeImportResult {
        if let refusal = Self.refusal(fileName: fileName, byteCount: data.count) {
            throw NativeWebRouteError(statusCode: 400, message: refusal)
        }
        let boundary = "juno-native-\(UUID().uuidString.lowercased())"
        let safeName = fileName.replacingOccurrences(of: "\"", with: "")
        let mime = fileName.lowercased().hasSuffix(".zip") ? "application/zip" : "application/json"
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n".utf8))
        body.append(Data("Content-Type: \(mime)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))

        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/import",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "multipart/form-data; boundary=\(boundary)",
                ]),
                body: body
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: "The import failed. Try again.") { throw error }
        return try Self.decode(response.body)
    }

    /// Reads the route's answer. Public for fixtures.
    public static func decode(_ data: Data) throws -> NativeImportResult {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let imported = object["imported"] as? Int
        else { throw NativeWebRouteError(statusCode: 200, message: "The import failed. Try again.") }
        return NativeImportResult(
            imported: imported,
            skipped: object["skipped"] as? Int ?? 0,
            projectsImported: object["projectsImported"] as? Int ?? 0,
            memoriesImported: object["memoriesImported"] as? Int ?? 0,
            attachmentsImported: object["attachmentsImported"] as? Int ?? 0,
            attachmentsSkipped: object["attachmentsSkipped"] as? Int ?? 0,
            format: object["format"] as? String
        )
    }
}
